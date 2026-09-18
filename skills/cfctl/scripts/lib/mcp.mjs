import { AgentError } from "./errors.mjs";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROTOCOL = "2025-03-26";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL, "2025-06-18", "2025-11-25"]);
const own = (value, key) => value && Object.hasOwn(value, key);

export function configuration(env = process.env) {
  const invalid = (message) => { throw new AgentError("INVALID_CONFIG", message, { exitCode: 2 }); };
  let url;
  try { url = new URL(env.CLOUDFLARE_MCP_URL || "https://mcp.cloudflare.com/mcp"); } catch { invalid("CLOUDFLARE_MCP_URL must be a valid URL."); }
  if (url.username || url.password || url.search || url.hash) invalid("MCP URL must not contain credentials, query parameters or a fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) invalid("MCP requires HTTPS (HTTP is allowed only for loopback tests).");
  if (env.CLOUDFLARE_MCP_TOKEN && env.CLOUDFLARE_MCP_AUTHORIZATION) invalid("Set only one of CLOUDFLARE_MCP_TOKEN and CLOUDFLARE_MCP_AUTHORIZATION.");
  const authorization = env.CLOUDFLARE_MCP_AUTHORIZATION || (env.CLOUDFLARE_MCP_TOKEN ? `Bearer ${env.CLOUDFLARE_MCP_TOKEN}` : null);
  if (!authorization) invalid("Set CLOUDFLARE_MCP_TOKEN or CLOUDFLARE_MCP_AUTHORIZATION in the environment.");
  const timeout = Number(env.CLOUDFLARE_MCP_TIMEOUT_MS || 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) invalid("CLOUDFLARE_MCP_TIMEOUT_MS must be an integer from 1 to 300000.");
  let extra;
  try { extra = JSON.parse(env.CLOUDFLARE_MCP_HEADERS_JSON || "{}"); } catch { invalid("CLOUDFLARE_MCP_HEADERS_JSON must be valid JSON."); }
  if (!extra || Array.isArray(extra) || typeof extra !== "object") invalid("Additional headers must be a JSON object.");
  const reserved = new Set(["authorization", "accept", "content-type", "host", "content-length", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version"]);
  const headers = new Headers({ Accept: "application/json, text/event-stream", "Content-Type": "application/json" });
  try {
    headers.set("Authorization", authorization);
    for (const [key, value] of Object.entries(extra)) {
      if (reserved.has(key.toLowerCase()) || typeof value !== "string") invalid("Additional headers must have string values and must not override authentication or protocol headers.");
      headers.set(key, value);
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    invalid("Invalid HTTP header name or value.");
  }
  return { url: url.href, headers, timeout };
}

async function readResponse(response, expectedId) {
  if (!response.body) return null;
  const sse = response.headers.get("content-type")?.includes("text/event-stream") && response.ok;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, eventLines = [];
  const event = () => {
    const data = eventLines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    eventLines = [];
    if (!data || data === "[DONE]") return null;
    let message;
    try { message = JSON.parse(data); } catch { throw new AgentError("PROTOCOL_ERROR", "Invalid JSON in MCP event stream."); }
    return message?.id === expectedId && (own(message, "result") || own(message, "error")) ? message : null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new AgentError("RESPONSE_TOO_LARGE", "MCP response exceeded 8 MiB. Narrow the request or reduce page size.");
      }
      buffer += decoder.decode(value, { stream: !done });
      if (sse) {
        // Read complete SSE lines, including CR, LF and CRLF split across chunks.
        while (true) {
          const match = /[\r\n]/.exec(buffer);
          if (!match || (!done && match[0] === "\r" && match.index === buffer.length - 1)) break;
          const line = buffer.slice(0, match.index);
          const width = buffer.slice(match.index, match.index + 2) === "\r\n" ? 2 : 1;
          buffer = buffer.slice(match.index + width);
          if (line === "") {
            const message = event();
            if (message) return message;
          } else eventLines.push(line);
        }
      }
      if (done) break;
    }
    if (sse) throw new AgentError("PROTOCOL_ERROR", "MCP stream ended without the matching response.");
    if (!response.ok) return buffer;
    if (!buffer.trim()) return null;
    try { return JSON.parse(buffer); } catch { throw new AgentError("PROTOCOL_ERROR", "MCP returned invalid JSON."); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class McpClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.sessionId = null;
    this.protocol = null;
    this.nextId = 1;
  }

  async post(payload) {
    const headers = new Headers(this.config.headers);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (this.protocol) headers.set("MCP-Protocol-Version", this.protocol);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);
    try {
      const response = await this.fetch(this.config.url, { method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal: controller.signal });
      if (response.headers.has("mcp-session-id")) this.sessionId = response.headers.get("mcp-session-id");
      if (!own(payload, "id") && response.ok) {
        await response.body?.cancel();
        return null;
      }
      const message = await readResponse(response, payload.id);
      if (!response.ok) throw new AgentError("HTTP_ERROR", `MCP HTTP request failed (${response.status}).`, { retryable: response.status === 429 || response.status >= 500, details: { status: response.status, body: message, retry_after: response.headers.get("retry-after") } });
      if (message?.jsonrpc !== "2.0" || message.id !== payload.id || (!own(message, "result") && !own(message, "error"))) throw new AgentError("PROTOCOL_ERROR", "MCP response does not match the JSON-RPC request.");
      if (own(message, "error")) throw new AgentError("MCP_ERROR", "MCP rejected the request.", { details: message.error });
      return message.result;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (controller.signal.aborted) throw new AgentError("TIMEOUT", "MCP request exceeded its deadline.", { retryable: true, details: { timeout_ms: this.config.timeout } });
      throw new AgentError("NETWORK_ERROR", "MCP request could not be completed.", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  request(method, params = {}) { return this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }); }

  async initialize() {
    const result = await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "cfctl", version: "2.0.0" } });
    if (!SUPPORTED_PROTOCOLS.has(result?.protocolVersion)) throw new AgentError("PROTOCOL_ERROR", "Server selected an unsupported MCP protocol version.", { details: { protocol_version: result?.protocolVersion ?? null } });
    this.protocol = result.protocolVersion;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return result;
  }

  async listTools() {
    const tools = [], cursors = new Set();
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new AgentError("PROTOCOL_ERROR", "tools/list did not return a tools array.");
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor !== undefined && cursor !== null && typeof cursor !== "string") throw new AgentError("PROTOCOL_ERROR", "Invalid tools/list cursor.");
      if (cursor && cursors.has(cursor)) throw new AgentError("PAGINATION_ERROR", "MCP repeated a tools/list cursor.");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 1000) throw new AgentError("PAGINATION_ERROR", "MCP tool pagination exceeded 1000 pages.");
    } while (cursor);
    return tools;
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (!result || typeof result !== "object") throw new AgentError("PROTOCOL_ERROR", "Invalid tools/call result.");
    if (result.isError) throw new AgentError("TOOL_ERROR", `MCP tool ${name} reported failure.`, { details: result });
    return result;
  }
}

export function toolData(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.content?.length === 1 && result.content[0]?.type === "text") {
    try { return JSON.parse(result.content[0].text); } catch { /* preserve non-JSON text and multimodal results */ }
  }
  return result;
}

export function assertApi(response) {
  if (response?.success === true && Number.isInteger(response.status) && response.status >= 200 && response.status < 300 && (!Array.isArray(response.errors) || response.errors.length === 0)) return response;
  throw new AgentError("API_ERROR", "Cloudflare API request failed or returned an invalid result.", { retryable: response?.status === 429 || response?.status >= 500, details: response });
}

export function api(client, request) {
  return client.callTool("execute", { code: `async () => { return await cloudflare.request(${JSON.stringify(request)}); }` }).then(toolData);
}
