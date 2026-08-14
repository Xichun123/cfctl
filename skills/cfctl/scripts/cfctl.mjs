#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://mcp.cloudflare.com/mcp";
const CLIENT_INFO = { name: "cfctl", version: "1.0.0" };
const REQUESTED_PROTOCOL_VERSION = "2025-03-26";

function usage() {
  return `Cloudflare remote MCP client

Usage:
  cfctl doctor
  cfctl tools
  cfctl zones list [--json]
  cfctl call <tool-name> --args '<json-object>'
  cfctl call <tool-name> --args-file <path>
  cfctl call <tool-name> --stdin

Environment:
  CLOUDFLARE_MCP_TOKEN          Raw Cloudflare API token (preferred)
  CLOUDFLARE_MCP_AUTHORIZATION  Complete Authorization header value
  CLOUDFLARE_MCP_URL            MCP endpoint (default: ${DEFAULT_URL})
  CLOUDFLARE_MCP_HEADERS_JSON   Optional JSON object of additional HTTP headers

Notes:
  - Node.js 18+ is required.
  - Credentials are read only from environment variables, never CLI arguments.
  - Tool output is written as formatted JSON to stdout.
`;
}

function fail(message, exitCode = 1) {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

function authorizationHeader() {
  if (process.env.CLOUDFLARE_MCP_AUTHORIZATION) {
    return process.env.CLOUDFLARE_MCP_AUTHORIZATION;
  }
  if (process.env.CLOUDFLARE_MCP_TOKEN) {
    return `Bearer ${process.env.CLOUDFLARE_MCP_TOKEN}`;
  }
  fail(
    "missing credentials. Set CLOUDFLARE_MCP_TOKEN to a raw API token, " +
      "or CLOUDFLARE_MCP_AUTHORIZATION to the complete Authorization value."
  );
}

function additionalHeaders() {
  const value = process.env.CLOUDFLARE_MCP_HEADERS_JSON;
  if (!value) return {};

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    fail(`CLOUDFLARE_MCP_HEADERS_JSON is not valid JSON: ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    fail("CLOUDFLARE_MCP_HEADERS_JSON must be a JSON object.");
  }

  const headers = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      fail(`additional header ${name} must have a string value.`);
    }
    if (name.toLowerCase() === "authorization") {
      fail(
        "do not place Authorization in CLOUDFLARE_MCP_HEADERS_JSON; use " +
          "CLOUDFLARE_MCP_TOKEN or CLOUDFLARE_MCP_AUTHORIZATION."
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseSse(text) {
  const messages = [];
  const events = text.split(/\r?\n\r?\n/);

  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON SSE events such as keepalives.
    }
  }

  if (messages.length === 0) {
    throw new Error("the server returned SSE without a JSON-RPC message");
  }

  return (
    [...messages].reverse().find((message) => message?.result || message?.error) ??
    messages.at(-1)
  );
}

function parseResponseBody(contentType, text) {
  if (!text.trim()) return null;
  if (contentType.includes("text/event-stream") || text.trimStart().startsWith("event:")) {
    return parseSse(text);
  }
  return JSON.parse(text);
}

class McpClient {
  constructor() {
    this.url = process.env.CLOUDFLARE_MCP_URL || DEFAULT_URL;
    this.sessionId = null;
    this.protocolVersion = null;
    this.nextId = 1;
    this.baseHeaders = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: authorizationHeader(),
      ...additionalHeaders(),
    };
  }

  async post(payload, { allowEmpty = false } = {}) {
    const headers = { ...this.baseHeaders };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;

    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(`unable to reach ${this.url}: ${error.message}`);
    }

    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) this.sessionId = returnedSessionId;

    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 2000);
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`
      );
    }

    if (!text.trim() && allowEmpty) return null;

    let message;
    try {
      message = parseResponseBody(response.headers.get("content-type") || "", text);
    } catch (error) {
      throw new Error(`cannot parse MCP response: ${error.message}`);
    }

    if (message?.error) {
      const code = message.error.code ?? "unknown";
      const data = message.error.data ? ` ${JSON.stringify(message.error.data)}` : "";
      throw new Error(`MCP error ${code}: ${message.error.message}${data}`);
    }

    return message;
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const message = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!message || message.id !== id) {
      throw new Error(`unexpected JSON-RPC response for ${method}`);
    }
    return message.result;
  }

  async notify(method, params = {}) {
    await this.post({ jsonrpc: "2.0", method, params }, { allowEmpty: true });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.protocolVersion = result?.protocolVersion || REQUESTED_PROTOCOL_VERSION;
    await this.notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const params = cursor ? { cursor } : {};
      const page = await this.request("tools/list", params);
      tools.push(...(page?.tools || []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
}

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  if (index === -1) return undefined;
  if (index === argv.length - 1) fail(`${option} requires a value.`);
  return argv[index + 1];
}

async function readArguments(argv) {
  const inline = optionValue(argv, "--args");
  const filePath = optionValue(argv, "--args-file");
  const fromStdin = argv.includes("--stdin");
  const selected = [inline !== undefined, filePath !== undefined, fromStdin].filter(Boolean).length;

  if (selected > 1) {
    fail("choose exactly one of --args, --args-file, or --stdin.");
  }

  let text = "{}";
  if (inline !== undefined) {
    text = inline;
  } else if (filePath !== undefined) {
    text = await readFile(filePath, "utf8");
  } else if (fromStdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString("utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`tool arguments are not valid JSON: ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    fail("tool arguments must be a JSON object.");
  }
  return parsed;
}

export function parseToolJson(result) {
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === "text")?.text || "tool failed");
  }

  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("tool returned no JSON text");

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool returned invalid JSON: ${error.message}`);
  }
}

export function formatZones(zones) {
  const columns = [
    ["NAME", (zone) => zone.name],
    ["STATUS", (zone) => zone.status],
    ["PAUSED", (zone) => String(zone.paused)],
    ["TYPE", (zone) => zone.type],
    ["PLAN", (zone) => zone.plan || ""],
  ];
  const widths = columns.map(([heading, value]) =>
    Math.max(heading.length, ...zones.map((zone) => String(value(zone) ?? "").length))
  );
  const row = (values) =>
    values.map((value, index) => String(value ?? "").padEnd(widths[index])).join("  ");
  return [
    row(columns.map(([heading]) => heading)),
    ...zones.map((zone) => row(columns.map(([, value]) => value(zone)))),
  ].join("\n");
}

async function listZones(client) {
  const code = `async () => {
    const zones = [];
    let page = 1;
    while (true) {
      const response = await cloudflare.request({
        method: "GET",
        path: "/zones",
        query: { page, per_page: 50, order: "name", direction: "asc" }
      });
      if (!response.success || response.status !== 200) {
        return { success: false, status: response.status, errors: response.errors, messages: response.messages, failed_page: page };
      }
      zones.push(...(response.result || []).map((zone) => ({
        name: zone.name,
        status: zone.status,
        paused: zone.paused,
        type: zone.type,
        account: zone.account?.name || null,
        plan: zone.plan?.name || null,
        created_on: zone.created_on
      })));
      if (page >= (response.result_info?.total_pages || 1)) {
        return { success: true, status: response.status, total: zones.length, zones };
      }
      page++;
    }
  }`;
  return parseToolJson(await client.callTool("execute", { code }));
}

function assertApiSuccess(response) {
  if (response?.success && response.status === 200) return;
  const details = response?.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
  throw new Error(
    `Cloudflare API failed with HTTP ${response?.status ?? "unknown"}${details ? `: ${details}` : ""}`
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (!["doctor", "tools", "zones", "call"].includes(command)) {
    fail(`unknown command: ${command}\n\n${usage()}`, 2);
  }

  const client = new McpClient();
  const server = await client.initialize();

  if (command === "doctor") {
    const tools = await client.listTools();
    console.log(
      JSON.stringify(
        {
          ok: true,
          endpoint: client.url,
          protocolVersion: client.protocolVersion,
          serverInfo: server?.serverInfo || null,
          capabilities: server?.capabilities || {},
          tools: tools.map((tool) => tool.name),
        },
        null,
        2
      )
    );
    return;
  }

  if (command === "tools") {
    console.log(JSON.stringify(await client.listTools(), null, 2));
    return;
  }

  if (command === "zones") {
    const [subcommand, ...zoneArgv] = argv;
    if (subcommand !== "list") fail("zones currently supports only: zones list [--json]", 2);
    const unknownOption = zoneArgv.find((arg) => arg !== "--json");
    if (unknownOption) fail(`unknown zones list option: ${unknownOption}`, 2);

    const response = await listZones(client);
    assertApiSuccess(response);
    if (zoneArgv.includes("--json")) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.log(formatZones(response.zones));
      console.log(`\n${response.total} zone(s)`);
    }
    return;
  }

  const [toolName, ...toolArgv] = argv;
  if (!toolName || toolName.startsWith("--")) {
    fail("call requires a tool name.", 2);
  }
  const args = await readArguments(toolArgv);
  const result = await client.callTool(toolName, args);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.message));
}
