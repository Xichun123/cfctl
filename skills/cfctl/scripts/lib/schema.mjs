// This registry is both the offline discovery document and the input validator.
import { isIP } from "node:net";
import { AgentError } from "./errors.mjs";

const string = (description, extra = {}) => ({ type: "string", minLength: 1, description, ...extra });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const id = string("Cloudflare resource ID; obtain it from a read operation.", { pattern: "^[a-fA-F0-9]{32}$" });
const name = string("Full DNS name, ASCII/punycode. No @ or relative names; trailing dot accepted.", { pattern: "^(?:\\*\\.)?(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.?$", maxLength: 254 });
const page = { type: "integer", minimum: 1, maximum: 1000000, default: 1 };
const perPage = { type: "integer", minimum: 1, maximum: 100, default: 50 };
const mode = { type: "string", enum: ["plan", "apply"], description: "Required. plan performs reads only; apply submits the mutation. Existing user authorization is sufficient." };
const record = {
  type: { type: "string", enum: ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] },
  name,
  content: string("Record content. Preserve TXT values verbatim."),
  ttl: { type: "integer", minimum: 1, maximum: 86400, description: "1 = automatic; otherwise 30–86400, subject to plan limits. Proxied records require 1." },
  proxied: { type: "boolean", description: "Only A, AAAA and CNAME can be proxied." },
  priority: { type: "integer", minimum: 0, maximum: 65535, description: "Required for MX; omit for other supported types." },
  comment: { type: "string", maxLength: 500 },
};
const target = { zone_id: id, record_id: id };
const precondition = string("Exact modified_on from dns.get/list. Checked immediately before write; not an atomic compare-and-swap.");

export const operations = {
  doctor: { description: "Initialize MCP and report server capabilities; does not change resources.", effect: "read", inputSchema: object({}) },
  "mcp.tools": { description: "Retrieve all live MCP tool definitions (including input schemas).", effect: "read", inputSchema: object({}) },
  "mcp.call": {
    description: "Call a discovered MCP tool. effect is an agent declaration, not a sandbox. Raw writes are never automatically verified.", effect: "declared",
    inputSchema: object({ name: string("Exact tool name from mcp.tools."), arguments: { type: "object", additionalProperties: true }, effect: { type: "string", enum: ["read", "write"] } }, ["name", "arguments", "effect"]),
  },
  "zones.list": {
    description: "Read one page of compact zone summaries; IDs and account IDs are preserved. Follow pagination.next until null.", effect: "read",
    inputSchema: object({ name: string("Exact zone name filter."), account_id: id, page, per_page: perPage }),
  },
  "dns.list": {
    description: "Read one page of DNS records of any type. Values are not clipped. Follow pagination.next until null.", effect: "read",
    inputSchema: object({ zone_id: id, name, type: string("Any DNS type, e.g. SRV or CAA.", { pattern: "^[A-Za-z][A-Za-z0-9]*$" }), page, per_page: perPage }, ["zone_id"]),
  },
  "dns.get": { description: "Read a DNS record, including modified_on for a later precondition.", effect: "read", inputSchema: object(target, ["zone_id", "record_id"]) },
  "dns.create": {
    description: "Plan or create a DNS record, then verify requested fields. No automatic retries or duplicate suppression.", effect: "write",
    inputSchema: object({ zone_id: id, mode, record: object(record, ["type", "name", "content", "ttl", "proxied"]) }, ["zone_id", "mode", "record"]),
  },
  "dns.update": {
    description: "Plan or PATCH only the supplied fields; check modified_on and verify the result. Type changes use raw MCP.", effect: "write",
    inputSchema: object({ ...target, mode, if_modified_on: precondition, patch: { ...object(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "type"))), minProperties: 1 } }, ["zone_id", "record_id", "mode", "if_modified_on", "patch"]),
  },
  "dns.delete": {
    description: "Plan or delete one record; check modified_on and verify that a subsequent GET returns 404.", effect: "write",
    inputSchema: object({ ...target, mode, if_modified_on: precondition }, ["zone_id", "record_id", "mode", "if_modified_on"]),
  },
};

export function validate(schema, value, path = "input") {
  const invalid = (reason) => { throw new AgentError("INVALID_INPUT", `${path}: ${reason}`, { exitCode: 2 }); };
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type === "integer" ? !Number.isSafeInteger(value) : schema.type && type !== schema.type) invalid(`expected ${schema.type}`);
  if (schema.const !== undefined && value !== schema.const) invalid(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) invalid(`expected one of ${schema.enum.join(", ")}`);
  if (type === "string") {
    if (schema.minLength && value.length < schema.minLength) invalid("must not be empty");
    if (schema.maxLength && value.length > schema.maxLength) invalid(`maximum length is ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid("does not match the schema pattern");
  }
  if (type === "number" || type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) invalid(`minimum is ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) invalid(`maximum is ${schema.maximum}`);
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => { try { validate(candidate, value, path); return true; } catch { return false; } })) invalid("does not match any allowed schema");
  if (type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) invalid(`missing required field ${key}`);
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) invalid("must contain at least one field");
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(schema.properties[key], entry, `${path}.${key}`);
      else if (schema.additionalProperties === false) invalid(`unknown field ${key}`);
    }
  }
}

export function normalizeInput(operation, input) {
  if (!Object.hasOwn(operations, operation)) throw new AgentError("UNKNOWN_OPERATION", "Use cfctl schema to discover operations.", { exitCode: 2 });
  validate(operations[operation].inputSchema, input);
  const result = structuredClone(input);
  for (const field of ["zone_id", "record_id", "account_id"]) if (result[field]) result[field] = result[field].toLowerCase();
  if (operation === "dns.list" && result.type) result.type = result.type.toUpperCase();
  if (operation.endsWith(".list")) {
    result.page ??= 1;
    result.per_page ??= 50;
  }
  if (operation !== "mcp.call" && result.name) result.name = result.name.toLowerCase().replace(/\.$/, "");
  if (result.record || result.patch) {
    const fields = result.record || result.patch;
    if (fields.name) fields.name = fields.name.toLowerCase().replace(/\.$/, "");
    validateRecord(fields, { partial: operation === "dns.update" });
  }
  return result;
}

export function validateRecord(fields, { partial = false } = {}) {
  const invalid = (message) => { throw new AgentError("INVALID_INPUT", message, { exitCode: 2 }); };
  if (fields.ttl !== undefined && fields.ttl !== 1 && fields.ttl < 30) invalid("ttl must be 1 or 30–86400.");
  if (fields.proxied && fields.ttl !== undefined && fields.ttl !== 1) invalid("Proxied records require ttl: 1.");
  if (fields.type && !record.type.enum.includes(fields.type)) invalid("This DNS type requires mcp.call.");
  if (fields.proxied && fields.type && !["A", "AAAA", "CNAME"].includes(fields.type)) invalid("Only A, AAAA and CNAME support proxied: true.");
  if (["A", "AAAA"].includes(fields.type) && fields.content !== undefined && isIP(fields.content) !== (fields.type === "A" ? 4 : 6)) invalid(`content must be a valid ${fields.type} address.`);
  if (!partial && fields.type === "MX" && fields.priority === undefined) invalid("MX records require priority.");
  if (fields.type && fields.type !== "MX" && fields.priority !== undefined) invalid("priority is only valid for MX records.");
}

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const errorSchema = object({ code: string("Stable error code."), message: string("Diagnostic message; do not parse for control flow."), retryable: { type: "boolean" }, next_action: string("Suggested recovery step."), details: {} }, ["code", "message", "retryable", "next_action", "details"]);
const paginationSchema = object({
  page: { type: "integer", minimum: 1 }, per_page: { type: "integer", minimum: 1 },
  total_count: nullable({ type: "integer", minimum: 0 }), total_pages: { type: "integer", minimum: 0 }, has_more: { type: "boolean" },
  next: nullable(object({ operation: { type: "string", enum: ["zones.list", "dns.list"] }, input: { type: "object" } }, ["operation", "input"])),
}, ["page", "per_page", "total_count", "total_pages", "has_more", "next"]);
export const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...object({
    schema_version: { const: 1 }, operation: { type: "string" }, ok: { type: "boolean" }, data: {}, pagination: nullable(paginationSchema),
    mutation: object({ state: { type: "string", enum: ["none", "planned", "applied", "unknown"] }, verification: { type: "string", enum: ["not_applicable", "not_performed", "passed", "failed", "unknown"] } }, ["state", "verification"]),
    error: nullable(errorSchema),
  }, ["schema_version", "operation", "ok", "data", "pagination", "mutation", "error"]),
};

export function describe(operation) {
  if (operation && !Object.hasOwn(operations, operation)) throw new AgentError("UNKNOWN_OPERATION", "Unknown schema operation.", { exitCode: 2 });
  return {
    cli_version: "2.0.0",
    usage: "cfctl schema [operation] | cfctl <operation> [--input '<JSON>' | --file <path> | --stdin]",
    input: "Exactly one JSON object. No input means {}. Validation occurs before authentication/network access.",
    outputSchema,
    exit_codes: { 0: "Success; inspect mutation for raw writes", 2: "Invalid input or configuration; no write submitted", 3: "Upstream/protocol failure", 4: "Precondition failed; no write submitted", 5: "Write outcome unknown or write verification failed; read before any retry" },
    guarantees: ["One JSON envelope on stdout; no prompts, tables, or implicit retries.", "Pagination is explicit; next is executable input, null means the end of this traversal.", "plan only reads. apply needs no additional CLI confirmation.", "Raw effect declarations do not enforce read-only execution. Raw writes return mutation.state=unknown even when the tool completes.", "Preconditions are best effort, not atomic. Timeout after submission never proves a write did not happen."],
    operations: operation ? { [operation]: operations[operation] } : operations,
  };
}
