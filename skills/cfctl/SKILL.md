---
name: cfctl
description: Agent-only Cloudflare operations through a JSON CLI and Cloudflare's remote MCP. Use for zones, DNS, Workers, Pages, R2, D1, KV, Zero Trust, WAF, CDN, account settings, and Cloudflare API discovery or execution.
---

# cfctl

Agent interface, version 2. Node.js 22+. Every invocation returns exactly one compact JSON envelope on stdout. No tables, prompts, implicit retries, or legacy command syntax.

## Invoke and discover

Resolve `scripts/cfctl.mjs` relative to this SKILL.md. Invoke it with Node using its absolute path; this works with a skill-only installation. If the installer provided `cfctl` on PATH, it is equivalent.

```bash
node /absolute/path/to/cfctl/scripts/cfctl.mjs schema
node /absolute/path/to/cfctl/scripts/cfctl.mjs schema dns.update
```

Below, `cfctl` denotes that same entry point. `schema [operation]` works offline, without credentials. It is authoritative for operation names, required fields, input schemas, output contract, and exit codes. Read the relevant schema before using an unfamiliar operation.

```bash
cfctl <operation> --input '<JSON object>'
cfctl <operation> --file /absolute/path/request.json
cfctl <operation> --stdin < /absolute/path/request.json
```

Use exactly one input source. Omitted input means `{}`. Prefer a JSON file for code, multiline strings, or values requiring shell quoting. Unknown fields and invalid input are rejected. Never put credentials in operation input or command arguments.

Authentication comes from `CLOUDFLARE_MCP_TOKEN` or `CLOUDFLARE_MCP_AUTHORIZATION`. Do not print their values. Use `doctor` to diagnose connectivity/authentication when needed; it is not required before every operation. See [configuration](reference/configuration.md).

## Work from explicit targets

1. Use `zones.list` with a name/account filter to obtain a zone ID. It returns compact zone summaries rather than permissions and plan metadata. Keep account and zone identity visible in your reasoning; never select an ambiguous match.
2. Use `dns.list` or `dns.get` for record IDs and current `modified_on`. Names are full ASCII/punycode DNS names; no `@`, relative-name expansion, or implicit zone selection.
3. Lists return one page. Follow `pagination.next.operation` and `pagination.next.input` until `next` is null before claiming to have enumerated all matches. A null next on page 2 does not imply page 1 was read. Contents are not clipped.
4. DNS reads accept all record types. High-level creates/updates support A, AAAA, CNAME, TXT, MX and NS; advanced writes and type changes use raw MCP.

```bash
cfctl zones.list --input '{"name":"example.com"}'
cfctl dns.list --input '{"zone_id":"<32-hex-zone-id>","type":"A","name":"www.example.com"}'
cfctl dns.get --input '{"zone_id":"<32-hex-zone-id>","record_id":"<32-hex-record-id>"}'
```

## Mutations and authorization

DNS mutations require an explicit `mode`: `plan` performs reads and returns the exact request; `apply` submits it. There is no `--yes` and no interactive confirmation. A plan is optional, not an approval gate. It is useful when the user requests a preview or the target/effect needs review.

Act within the user's existing authorization; do not ask again for an already authorized action. If an essential target, intended effect, or authorization is missing, identify exactly what is needed. `mode: apply` is an execution instruction, not proof of user authorization.

For update/delete, pass the exact `if_modified_on` from a current read. A mismatch returns `PRECONDITION_FAILED` with the current record and performs no write. Review that record before submitting a new precondition. This check is not atomic and cannot eliminate concurrent-write races.

```bash
cfctl dns.update --input '{"zone_id":"<32-hex-zone-id>","record_id":"<32-hex-record-id>","if_modified_on":"<exact-modified_on>","mode":"apply","patch":{"content":"192.0.2.2"}}'
```

Create requires explicit type, full name, content, TTL, and proxy state. MX also requires priority. Update uses PATCH and preserves unspecified settings; enabling proxying normalizes TTL to 1, which is shown in the request. Before a change that affects traffic, retain the prior state and identify how to restore it. Responses include `before` for update/delete; this is evidence for recovery, not an automatic rollback or an executable create payload.

## Read outcomes before deciding what to do next

Always inspect `ok`, `error`, and `mutation`; do not rely on exit status alone.

- `state: none`: no mutation was submitted, or a high-level API write was explicitly rejected.
- `state: planned`: only reads occurred; inspect `data.request`.
- `state: applied, verification: passed`: the DNS write succeeded and the readback matched requested fields (or delete returned 404).
- `state: applied, verification: failed/unknown`: the write succeeded, but readback differed or could not be obtained. Do not replay it. Reconcile by reading the target.
- `state: unknown`: a write may have occurred. Do not replay it. Use the target ID, or for a create the zone/name/type/content, to inspect actual state.

Errors provide `code`, `message`, `retryable`, `next_action`, and `details`. `retryable` permits consideration of a read retry; it never triggers an automatic retry. Exit 5 requires reconciliation, not blind replay. See [the result contract](reference/contract.md) for exact semantics and limitations.

## Raw MCP for other Cloudflare capabilities

1. Call `mcp.tools` once before the first raw operation in the task. Its live tool schemas are authoritative.
2. Call the discovered `search` tool to inspect the API. Do not guess endpoints or payload fields.
3. Call `execute` with code based on that discovery. Declare `effect: read` or `effect: write` honestly. This declaration is not a sandbox and cannot prevent writes.
4. Have code return structured results including API `success`, `status`, `errors`, `messages`, and relevant resource IDs. Inspect every nested result in batch/multi-step operations.
5. For a raw mutation, make a separate read to verify the intended resource state. Raw write results always have `state: unknown, verification: not_performed`, even with `ok: true`: tool completion alone does not prove what arbitrary code changed.

```bash
cfctl mcp.tools
cfctl mcp.call --file /absolute/path/search-request.json
cfctl mcp.call --file /absolute/path/execute-request.json
```

A raw request is `{"name":"<discovered-tool>","arguments":{...},"effect":"read|write"}`. Only the outer recognized API envelope is checked automatically; arbitrary nested results and rollback remain the agent's responsibility.

Use narrow token permissions and resource scope. Never log credentials. Managed DNS inventory comes from the Cloudflare API; public DNS resolution/propagation checks must use Cloudflare DoH at `https://cloudflare-dns.com/dns-query`.
