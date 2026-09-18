import { AgentError } from "./errors.mjs";
import { api, assertApi, toolData } from "./mcp.mjs";
import { validateRecord } from "./schema.mjs";

const base = (zoneId) => `/zones/${zoneId}/dns_records`;
const recordPath = (input) => `${base(input.zone_id)}/${input.record_id}`;

function pageResult(operation, input, response, result) {
  if (!Array.isArray(response.result)) throw new AgentError("PROTOCOL_ERROR", "List result is not an array.");
  result.data = { items: response.result, messages: response.messages || [] };
  const info = response.result_info;
  const perPage = info?.per_page;
  const total = info?.total_count;
  const pages = info?.total_pages ?? (Number.isInteger(total) && perPage > 0 ? Math.ceil(total / perPage) : null);
  if (info?.page !== input.page || !Number.isInteger(perPage) || perPage < 1 || perPage > 100 || !Number.isInteger(pages) || pages < 0 || (total !== undefined && (!Number.isInteger(total) || total < 0))) throw new AgentError("PAGINATION_ERROR", "Missing or inconsistent pagination metadata; do not treat these items as a complete list.", { details: info ?? null });
  const hasMore = input.page < pages;
  result.pagination = { page: info.page, per_page: perPage, total_count: total ?? null, total_pages: pages, has_more: hasMore, next: hasMore ? { operation, input: { ...input, page: input.page + 1, per_page: perPage } } : null };
}

function canonical(field, value, type) {
  if (typeof value !== "string") return value;
  if (field === "name" || (field === "content" && ["CNAME", "MX", "NS"].includes(type))) return value.toLowerCase().replace(/\.$/, "");
  if (field === "content" && type === "AAAA") {
    try { return new URL(`http://[${value}]/`).hostname; } catch { return value; }
  }
  return value;
}

function differences(expected, actual, type) {
  return Object.entries(expected).flatMap(([field, value]) => canonical(field, value, type) === canonical(field, actual?.[field], type) ? [] : [{ field, expected: value, actual: actual?.[field] ?? null }]);
}

async function zoneForName(client, input, name) {
  const response = assertApi(await api(client, { method: "GET", path: `/zones/${input.zone_id}` }));
  const zone = response.result;
  if (!zone?.name || zone.id !== input.zone_id) throw new AgentError("PROTOCOL_ERROR", "Zone read returned an unexpected resource.");
  if (name !== zone.name.toLowerCase() && !name.endsWith(`.${zone.name.toLowerCase()}`)) throw new AgentError("INVALID_INPUT", "The full DNS name is outside the target zone.", { exitCode: 2 });
  return { id: zone.id, name: zone.name };
}

async function mutate(client, operation, input, result) {
  const action = operation.slice(4);
  let before = null;
  let zone = { id: input.zone_id };
  let body = input.record || input.patch;
  if (action === "create") {
    zone = await zoneForName(client, input, body.name);
  } else {
    const response = assertApi(await api(client, { method: "GET", path: recordPath(input) }));
    before = response.result;
    if (before?.id !== input.record_id) throw new AgentError("PROTOCOL_ERROR", "DNS read returned an unexpected record.");
    result.data = { target: { zone_id: input.zone_id, record_id: input.record_id }, before };
    if (before.modified_on !== input.if_modified_on) throw new AgentError("PRECONDITION_FAILED", "The record changed since it was read.", { exitCode: 4, details: { expected_modified_on: input.if_modified_on, actual_modified_on: before.modified_on ?? null }, nextAction: "Review the current record and requested change. Submit a new request with its modified_on only if the change is still intended." });
    if (action === "update") {
      // Validate the effective record, while submitting only the supplied fields.
      const effective = Object.fromEntries(Object.entries(before).filter(([key, value]) => ["type", "name", "content", "ttl", "proxied", "priority"].includes(key) && value !== null));
      Object.assign(effective, body);
      if (effective.proxied && body.ttl === undefined) {
        body = { ...body, ttl: 1 };
        effective.ttl = 1;
      }
      validateRecord(effective);
      if (body.name) zone = await zoneForName(client, input, body.name);
    }
  }
  const request = { method: { create: "POST", update: "PATCH", delete: "DELETE" }[action], path: action === "create" ? base(input.zone_id) : recordPath(input), ...(body ? { body } : {}) };
  result.data = { target: { zone_id: zone.id, ...(zone.name ? { zone_name: zone.name } : {}), ...(input.record_id ? { record_id: input.record_id } : {}) }, before, request };
  if (input.mode === "plan") {
    result.mutation = { state: "planned", verification: "not_applicable" };
    return;
  }

  // From this point, a lost response is not evidence that the write failed.
  result.mutation = { state: "unknown", verification: "not_performed" };
  const response = await api(client, request);
  if (response?.success === false && Number.isInteger(response.status) && response.status >= 400 && response.status < 500 && response.status !== 408) {
    result.mutation = { state: "none", verification: "not_applicable" };
    try { assertApi(response); } catch (error) { error.retryable = false; throw error; }
  }
  assertApi(response);
  result.mutation = { state: "applied", verification: "unknown" };
  result.data.write_result = response.result ?? null;
  result.data.messages = response.messages || [];
  const id = action === "create" ? response.result?.id : input.record_id;
  if (typeof id !== "string" || !/^[a-fA-F0-9]{32}$/.test(id)) throw new AgentError("VERIFICATION_FAILED", "The write succeeded but did not return a usable record ID.");
  result.data.target.record_id = id;
  let verification;
  try {
    verification = await api(client, { method: "GET", path: `${base(input.zone_id)}/${id}` });
    if (action === "delete") {
      if (verification?.status === 404 && verification.success === false) {
        result.data.record = null;
        result.mutation.verification = "passed";
        return;
      }
      assertApi(verification);
      result.data.record = verification.result;
      result.mutation.verification = "failed";
      throw new AgentError("VERIFICATION_FAILED", "The delete succeeded but the record is still present.");
    }
    assertApi(verification);
    result.data.record = verification.result;
    result.data.verification_messages = verification.messages || [];
    const expected = { ...body, id };
    const mismatch = differences(expected, verification.result, body.type || before?.type);
    if (mismatch.length) {
      result.mutation.verification = "failed";
      throw new AgentError("VERIFICATION_FAILED", "The write succeeded but the readback differs from the requested fields.", { details: { differences: mismatch } });
    }
    result.mutation.verification = "passed";
  } catch (error) {
    if (error.code === "VERIFICATION_FAILED") throw error;
    throw new AgentError("VERIFICATION_FAILED", "The write succeeded but its result could not be read back.", { details: { cause: error.code || "INTERNAL_ERROR", response: error.details ?? null } });
  }
}

export async function execute(client, operation, input, result, initialized) {
  if (operation === "doctor") {
    result.data = { protocol_version: client.protocol, server: initialized.serverInfo ?? null, capabilities: initialized.capabilities ?? {} };
    return;
  }
  if (operation === "mcp.tools") {
    result.data = { tools: await client.listTools() };
    return;
  }
  if (operation === "mcp.call") {
    if (input.effect === "write") result.mutation = { state: "unknown", verification: "not_performed" };
    const data = toolData(await client.callTool(input.name, input.arguments));
    result.data = data;
    // Tool-level success is not API success. Check recognizable API envelopes.
    if (data?.success === false || (typeof data?.status === "number" && data.status >= 400)) assertApi(data);
    return;
  }
  if (operation === "zones.list" || operation === "dns.list") {
    const query = { page: input.page, per_page: input.per_page };
    if (input.name) query.name = input.name;
    if (input.type) query.type = input.type;
    if (input.account_id) query["account.id"] = input.account_id;
    const response = assertApi(await api(client, { method: "GET", path: operation === "zones.list" ? "/zones" : base(input.zone_id), query }));
    pageResult(operation, input, response, result);
    return;
  }
  if (operation === "dns.get") {
    const response = assertApi(await api(client, { method: "GET", path: recordPath(input) }));
    if (response.result?.id !== input.record_id) throw new AgentError("PROTOCOL_ERROR", "DNS read returned an unexpected record.");
    result.data = { record: response.result, messages: response.messages || [] };
    return;
  }
  await mutate(client, operation, input, result);
}
