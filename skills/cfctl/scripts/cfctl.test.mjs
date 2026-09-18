import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { run } from "./cfctl.mjs";
import { configuration, McpClient } from "./lib/mcp.mjs";

const ZONE = "a".repeat(32), RECORD = "b".repeat(32);
const TOKEN = "test-token-never-print";
const original = { id: RECORD, type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 1, proxied: false, modified_on: "2026-01-01T00:00:00Z" };
const apiOk = (result, extra = {}) => ({ success: true, status: 200, result, errors: [], messages: [], ...extra });
const missing = { success: false, status: 404, result: null, errors: [{ code: 81044, message: "Record not found" }], messages: [] };

async function fixture(t, hooks = {}) {
  const rpc = [], requests = [];
  let current = structuredClone(original), writes = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      rpc.push({ message, headers: req.headers });
      if (await hooks.http?.({ message, req, res })) return;
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "test-cloudflare", version: "1" }, capabilities: { tools: {} } };
      else if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      else if (message.method === "tools/list") result = hooks.tools ? hooks.tools(message.params) : { tools: [{ name: "execute", inputSchema: { type: "object" } }] };
      else if (message.method === "tools/call") {
        result = await hooks.tool?.(message.params);
        if (result === undefined) {
          const value = await runInNewContext(`(${message.params.arguments.code})()`, { cloudflare: { request: async (request) => {
            request = JSON.parse(JSON.stringify(request));
            requests.push(request);
            const override = await hooks.api?.(request, { writes, current });
            if (override !== undefined) return override;
            if (request.method === "GET" && request.path === `/zones/${ZONE}`) return apiOk({ id: ZONE, name: "example.com" });
            if (request.method === "GET" && request.path.endsWith(`/dns_records/${RECORD}`)) return current ? apiOk(current) : missing;
            if (["POST", "PATCH", "DELETE"].includes(request.method)) {
              writes++;
              if (request.method === "DELETE") { current = null; return apiOk({ id: RECORD }); }
              current = { ...(request.method === "PATCH" ? current : {}), ...request.body, id: RECORD, modified_on: "2026-01-02T00:00:00Z" };
              if (hooks.afterWrite) current = hooks.afterWrite(current);
              return apiOk(current);
            }
            throw new Error(`Unhandled API request ${JSON.stringify(request)}`);
          } } }, { timeout: 1000 });
          result = { content: [{ type: "text", text: JSON.stringify(value) }] };
        }
      } else throw new Error(`Unhandled MCP method ${message.method}`);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const env = { CLOUDFLARE_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`, CLOUDFLARE_MCP_TOKEN: TOKEN, CLOUDFLARE_MCP_TIMEOUT_MS: "1500" };
  return { env, rpc, requests, writes: () => writes, invoke: (operation, input = {}) => run([operation, "--input", JSON.stringify(input)], { env }) };
}

const update = (extra = {}) => ({ zone_id: ZONE, record_id: RECORD, if_modified_on: original.modified_on, mode: "apply", patch: { content: "192.0.2.2" }, ...extra });
const create = (extra = {}) => ({ zone_id: ZONE, mode: "apply", record: { type: "A", name: "www.example.com", content: "192.0.2.2", ttl: 1, proxied: false }, ...extra });

test("offline schema and invalid inputs never instantiate a client", async () => {
  const options = { env: {}, clientFactory: () => { assert.fail("network must not be initialized"); } };
  const schema = await run(["schema", "dns.update"], options);
  assert.equal(schema.exitCode, 0);
  assert.equal(schema.result.data.operations["dns.update"].inputSchema.additionalProperties, false);
  assert.equal(schema.result.data.outputSchema.properties.schema_version.const, 1);
  for (const argv of [
    ["dns.create", "--input", JSON.stringify(create({ mode: undefined }))],
    ["dns.create", "--input", JSON.stringify(create({ typo: true }))],
    ["dns.update", "--input", JSON.stringify(update({ patch: {} }))],
    ["dns.get", "--input", "null"],
    ["dns.get", "--input", "[]"],
    ["dns.get", "--input", "{"],
    ["zones", "list"],
    ["zones.list", "--yes"],
    ["zones.list", "--input", "{}", "--stdin"],
    ["dns.list", "--input", JSON.stringify({ zone_id: "../bad" })],
    ["zones.list", "--input", JSON.stringify({ page: 0 })],
    ["dns.list", "--input", JSON.stringify({ zone_id: ZONE, per_page: 101 })],
    ["dns.create", "--input", JSON.stringify(create({ record: { ...create().record, content: "bad-ip" } }))],
    ["dns.create", "--input", JSON.stringify(create({ record: { ...create().record, type: "a" } }))],
    ["dns.create", "--input", JSON.stringify(create({ record: { ...create().record, ttl: 2 } }))],
    ["dns.create", "--input", JSON.stringify(create({ record: { ...create().record, name: "例子.com" } }))],
    ["dns.create", "--input", JSON.stringify(create({ record: { ...create().record, name: "a..example.com" } }))],
    ["dns.create", "--input", JSON.stringify(create({ record: { ...create().record, type: "MX", content: "mail.example.com" } }))],
  ]) {
    const output = await run(argv, options);
    assert.equal(output.exitCode, 2, JSON.stringify(argv));
    assert.equal(output.result.mutation.state, "none");
  }
});

test("file, stdin and inline JSON have the same contract; CLI emits one JSON line", async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "cfctl-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "input.json");
  await writeFile(file, "{}");
  for (const [argv, stdin] of [[["doctor", "--file", file]], [["doctor", "--stdin"], Readable.from(["{", "}"])]]) {
    const output = await run(argv, { env: f.env, stdin });
    assert.equal(output.exitCode, 0);
    assert.equal(output.result.data.server.name, "test-cloudflare");
  }
  const child = spawnSync(process.execPath, [new URL("cfctl.mjs", import.meta.url).pathname, "dns.get", "--stdin"], { input: "{bad", encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(child.status, 2);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(child.stdout).error.code, "INVALID_JSON");
});

test("raw MCP tool names preserve case and paginated tool discovery", async (t) => {
  const f = await fixture(t, { tools: ({ cursor }) => cursor ? { tools: [{ name: "execute" }, { name: "CaseSensitiveTool" }] } : { tools: [{ name: "search" }], nextCursor: "second" }, tool: (params) => params.name === "CaseSensitiveTool" ? { content: [{ type: "text", text: "{\"called\":true}" }] } : undefined });
  const output = await f.invoke("mcp.tools");
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.result.data.tools.map((tool) => tool.name), ["search", "execute", "CaseSensitiveTool"]);
  const raw = await f.invoke("mcp.call", { name: "CaseSensitiveTool", arguments: {}, effect: "read" });
  assert.equal(raw.exitCode, 0);
  assert.equal(f.rpc.at(-1).message.params.name, "CaseSensitiveTool");
  assert.equal(f.rpc[1].headers["mcp-session-id"], "test-session");
  assert.equal(f.rpc[1].headers["mcp-protocol-version"], "2025-03-26");
  assert.equal(f.rpc.length, 7);
});

test("repeated tool cursors fail instead of looping", async (t) => {
  const f = await fixture(t, { tools: () => ({ tools: [], nextCursor: "same" }) });
  const output = await f.invoke("mcp.tools");
  assert.equal(output.result.error.code, "PAGINATION_ERROR");
  assert.equal(f.rpc.length, 4);
});

test("list results preserve IDs, long content and executable next-page input", async (t) => {
  const longText = "x".repeat(2000);
  const f = await fixture(t, { api: (request) => apiOk([{ ...original, type: "CAA", content: longText }], { result_info: { page: request.query.page, per_page: 1, total_pages: 2, total_count: 2 } }) });
  const output = await f.invoke("dns.list", { zone_id: ZONE, type: "caa", per_page: 1 });
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.data.items[0].id, RECORD);
  assert.equal(output.result.data.items[0].content, longText);
  assert.equal(output.result.pagination.has_more, true);
  const next = output.result.pagination.next;
  assert.equal(next.input.type, "CAA");
  const end = await f.invoke(next.operation, next.input);
  assert.equal(end.result.pagination.next, null);
  assert.equal(f.requests[0].query.type, "CAA");
});

test("missing pagination metadata is an error, not an apparently complete list", async (t) => {
  const f = await fixture(t, { api: () => apiOk([]) });
  const output = await f.invoke("zones.list");
  assert.equal(output.exitCode, 3);
  assert.equal(output.result.error.code, "PAGINATION_ERROR");
});

test("plan modes make only GET requests and show the exact write request", async (t) => {
  const f = await fixture(t);
  for (const [operation, input, method] of [["dns.create", create({ mode: "plan" }), "POST"], ["dns.update", update({ mode: "plan" }), "PATCH"], ["dns.delete", { ...update({ mode: "plan", patch: undefined }) }, "DELETE"]]) {
    const output = await f.invoke(operation, input);
    assert.equal(output.exitCode, 0);
    assert.equal(output.result.mutation.state, "planned");
    assert.equal(output.result.data.request.method, method);
  }
  assert.equal(f.writes(), 0);
  assert.ok(f.requests.every((request) => request.method === "GET"));
});

test("stale modified_on and names outside the zone prevent writes", async (t) => {
  const f = await fixture(t);
  for (const operation of ["dns.update", "dns.delete"]) {
    const input = update({ if_modified_on: "stale" });
    if (operation === "dns.delete") delete input.patch;
    const output = await f.invoke(operation, input);
    assert.equal(output.exitCode, 4);
    assert.equal(output.result.data.before.modified_on, original.modified_on);
  }
  const outside = await f.invoke("dns.create", create({ record: { ...create().record, name: "www.other.com" } }));
  assert.equal(outside.exitCode, 2);
  assert.equal(f.writes(), 0);
});

test("create and PATCH are verified and preserve untouched fields", async (t) => {
  const f = await fixture(t);
  const output = await f.invoke("dns.update", update());
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.result.mutation, { state: "applied", verification: "passed" });
  assert.equal(output.result.data.before.content, original.content);
  assert.equal(output.result.data.record.name, original.name);
  assert.deepEqual(f.requests[1].body, { content: "192.0.2.2" });
  assert.equal(f.writes(), 1);
  const created = await f.invoke("dns.create", create());
  assert.equal(created.exitCode, 0);
  assert.equal(created.result.mutation.verification, "passed");
  assert.equal(created.result.data.target.record_id, RECORD);
});

test("delete verifies a 404 and retains the previous record", async (t) => {
  const f = await fixture(t);
  const input = update();
  delete input.patch;
  const output = await f.invoke("dns.delete", input);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.result.mutation, { state: "applied", verification: "passed" });
  assert.deepEqual(output.result.data.before, original);
  assert.equal(output.result.data.record, null);
});

test("readback mismatch reports applied, failure and no safe retry", async (t) => {
  const f = await fixture(t, { afterWrite: (record) => ({ ...record, content: "192.0.2.99" }) });
  const output = await f.invoke("dns.update", update());
  assert.equal(output.exitCode, 5);
  assert.deepEqual(output.result.mutation, { state: "applied", verification: "failed" });
  assert.equal(output.result.error.code, "VERIFICATION_FAILED");
  assert.equal(output.result.error.retryable, false);
  assert.equal(output.result.error.details.differences[0].field, "content");
  assert.equal(f.writes(), 1);
});

test("successful write followed by forbidden read stays applied with unknown verification", async (t) => {
  const f = await fixture(t, { api: (request, state) => state.writes && request.method === "GET" ? { success: false, status: 403, errors: [{ message: "Forbidden" }] } : undefined });
  const output = await f.invoke("dns.update", update());
  assert.equal(output.exitCode, 5);
  assert.deepEqual(output.result.mutation, { state: "applied", verification: "unknown" });
  assert.equal(output.result.error.details.cause, "API_ERROR");
  assert.equal(f.writes(), 1);
});

test("known API rejection is distinguished from uncertain submission", async (t) => {
  const f = await fixture(t, { api: (request) => request.method === "PATCH" ? { success: false, status: 403, errors: [{ code: 10000, message: "Denied" }] } : undefined });
  const output = await f.invoke("dns.update", update());
  assert.equal(output.exitCode, 3);
  assert.equal(output.result.mutation.state, "none");
  assert.equal(output.result.error.retryable, false);
});

test("timeout after write submission is unknown and is never retried", async (t) => {
  let submissions = 0;
  const f = await fixture(t, { http: ({ message }) => {
    if (message.method === "tools/call" && message.params.arguments.code.includes('"method":"PATCH"')) { submissions++; return true; }
    return false;
  } });
  f.env.CLOUDFLARE_MCP_TIMEOUT_MS = "80";
  const output = await f.invoke("dns.update", update());
  assert.equal(output.exitCode, 5);
  assert.equal(output.result.error.code, "TIMEOUT");
  assert.equal(output.result.mutation.state, "unknown");
  assert.equal(output.result.error.retryable, false);
  assert.equal(submissions, 1);
});

test("raw tool errors and API failures produce nonzero exit codes and redact secrets", async (t) => {
  let response = { isError: true, content: [{ type: "text", text: `Denied Bearer ${TOKEN}` }] };
  const f = await fixture(t, { tool: () => response });
  const input = { name: "execute", arguments: { code: "async () => {}" }, effect: "read" };
  const failed = await f.invoke("mcp.call", input);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.result.error.code, "TOOL_ERROR");
  assert.ok(!JSON.stringify(failed).includes(TOKEN));
  response = { structuredContent: { success: false, status: 403, errors: [{ message: "denied" }] } };
  const apiFailure = await f.invoke("mcp.call", input);
  assert.equal(apiFailure.result.error.code, "API_ERROR");
  response = { content: [{ type: "text", text: '{"done":true}' }] };
  const rawWrite = await f.invoke("mcp.call", { ...input, effect: "write" });
  assert.equal(rawWrite.exitCode, 0);
  assert.equal(rawWrite.result.ok, true);
  assert.deepEqual(rawWrite.result.mutation, { state: "unknown", verification: "not_performed" });
});

test("SSE matches request IDs and completes while the connection remains open", async (t) => {
  const f = await fixture(t, { http: ({ message, res }) => {
    if (message.method !== "tools/list") return false;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n');
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id + 100, result: {} })}\n\n`);
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "execute" }] } })}\r`);
    setImmediate(() => res.write("\n\r\n"));
    return true;
  } });
  const output = await f.invoke("mcp.tools");
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.data.tools[0].name, "execute");
});

test("transport rejects JSON-RPC ID mismatches", async (t) => {
  const f = await fixture(t, { http: ({ message, res }) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id + 1, result: {} }));
    return true;
  } });
  const output = await f.invoke("doctor");
  assert.equal(output.result.error.code, "PROTOCOL_ERROR");
});

test("proxy updates normalize TTL and DNS readback accepts canonical equivalent values", async (t) => {
  const f = await fixture(t);
  const proxy = await f.invoke("dns.update", update({ patch: { proxied: true } }));
  assert.equal(proxy.exitCode, 0);
  assert.deepEqual(proxy.result.data.request.body, { proxied: true, ttl: 1 });
  const cnameFixture = await fixture(t, { afterWrite: (record) => ({ ...record, content: record.content.toLowerCase().replace(/\.$/, "") }) });
  const cname = await cnameFixture.invoke("dns.create", create({ record: { type: "CNAME", name: "Alias.Example.Com.", content: "Target.Example.Com.", ttl: 1, proxied: false } }));
  assert.equal(cname.exitCode, 0);
  assert.equal(cname.result.data.record.name, "alias.example.com");
  const ipv6Fixture = await fixture(t, { afterWrite: (record) => ({ ...record, content: "2001:db8::1" }) });
  const ipv6 = await ipv6Fixture.invoke("dns.create", create({ record: { type: "AAAA", name: "www.example.com", content: "2001:0db8:0:0:0:0:0:1", ttl: 1, proxied: false } }));
  assert.equal(ipv6.exitCode, 0);
});

test("delete readback that still contains a record is a verification failure", async (t) => {
  const f = await fixture(t, { api: (request, { writes }) => writes && request.method === "GET" ? apiOk(original) : undefined });
  const input = update();
  delete input.patch;
  const output = await f.invoke("dns.delete", input);
  assert.equal(output.exitCode, 5);
  assert.deepEqual(output.result.mutation, { state: "applied", verification: "failed" });
  assert.equal(output.result.data.record.id, RECORD);
});

test("a transport deadline also covers a stalled response body", async (t) => {
  const f = await fixture(t, { http: ({ res }) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"jsonrpc":"2.0",');
    return true;
  } });
  f.env.CLOUDFLARE_MCP_TIMEOUT_MS = "80";
  const output = await f.invoke("doctor");
  assert.equal(output.exitCode, 3);
  assert.equal(output.result.error.code, "TIMEOUT");
  assert.equal(output.result.error.retryable, true);
});

test("oversized responses fail explicitly without silently truncating data", async () => {
  const client = new McpClient(configuration({ CLOUDFLARE_MCP_TOKEN: TOKEN }), async () => new Response("x".repeat(8 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(() => client.initialize(), { code: "RESPONSE_TOO_LARGE" });
});

test("configuration rejects ambiguous credentials and reserved headers", () => {
  const env = { CLOUDFLARE_MCP_TOKEN: TOKEN };
  assert.throws(() => configuration({ ...env, CLOUDFLARE_MCP_AUTHORIZATION: "Bearer other" }), { code: "INVALID_CONFIG" });
  assert.throws(() => configuration({ ...env, CLOUDFLARE_MCP_HEADERS_JSON: '{"AUTHORIZATION":"secret"}' }), { code: "INVALID_CONFIG" });
  assert.throws(() => configuration({ ...env, CLOUDFLARE_MCP_URL: "http://example.com/mcp" }), { code: "INVALID_CONFIG" });
  assert.throws(() => configuration({ ...env, CLOUDFLARE_MCP_TIMEOUT_MS: "oops" }), { code: "INVALID_CONFIG" });
});

test("HTTP throttling preserves retry metadata for reads and makes one request", async () => {
  let calls = 0;
  const client = new McpClient(configuration({ CLOUDFLARE_MCP_TOKEN: TOKEN }), async () => {
    calls++;
    return new Response("busy", { status: 429, headers: { "Retry-After": "3" } });
  });
  await assert.rejects(() => client.initialize(), (error) => error.code === "HTTP_ERROR" && error.retryable && error.details.retry_after === "3");
  assert.equal(calls, 1);
});
