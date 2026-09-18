# Agent result contract (schema_version 1)

Every CLI invocation emits one JSON object and a newline on stdout. There is no normal diagnostic output on stderr. Resource values needed for subsequent operations are not shortened. Zone lists use compact summaries, and upstream error diagnostics are bounded to avoid copying large responses into agent context. Explicit response/input limits return errors. The CLI is a single-operation process, not an interactive shell or an NDJSON daemon.

All envelopes have these fields:

```json
{
  "schema_version": 1,
  "operation": "dns.update",
  "ok": true,
  "data": {},
  "pagination": null,
  "mutation": {"state": "applied", "verification": "passed"},
  "error": null
}
```

`ok` means the requested CLI operation completed under its defined checks. For raw tool calls it means the MCP tool completed without a tool error or a recognized outer API failure; it does not prove arbitrary code achieved its intended effect.

On failure, `data` can contain useful partial evidence such as a before snapshot, the submitted request, the write result, or a mismatching record. Inspect it before deciding on recovery. `pagination: null` on failure is not evidence of a complete list.

## Input

`cfctl schema` lists operations and JSON input schemas without authenticating or making network requests. `cfctl schema <operation>` narrows discovery. No arguments is equivalent to `schema`. There is no legacy command compatibility.

Use `--input <JSON>`, `--file <path>`, or `--stdin`, exclusively. No source means `{}`. Top-level input must be an object. Unknown fields are rejected, except the arbitrary tool arguments object for `mcp.call`; validate those against the live tool schema from `mcp.tools`.

DNS uses explicit zone/record IDs and full ASCII/punycode names. Names are normalized to lowercase without a final dot. `dns.list` type filters are normalized to uppercase; high-level create/update types remain the uppercase enum. Raw tool arguments and TXT content are preserved. Create requires explicit TTL and proxy state; list defaults are page 1 and 50 items, with a maximum page size of 100.

Supported high-level operations:

| Operation | Data |
| --- | --- |
| `doctor` | Negotiated protocol, server identity and capabilities |
| `mcp.tools` | `tools`: all live tool definitions |
| `mcp.call` | `structuredContent` if present; otherwise a sole JSON text block decoded; otherwise the original MCP result |
| `zones.list` | `items`: one page of compact summaries containing zone identity, state, timestamps, and account identity; `messages` |
| `dns.list` | `items`: one page of complete DNS record resources, `messages` |
| `dns.get` | `record`, `messages` |
| `dns.create`, `dns.update`, `dns.delete` | `target`, `before`, exact API `request`; after submission, `write_result`, `messages`, and verified `record` when available |

For deletion, `record: null` means the verification GET returned an API 404. `before` is null for create. API message arrays are retained, including verification messages for create/update.

## Pagination

A list includes:

```json
{
  "page": 1,
  "per_page": 50,
  "total_count": 75,
  "total_pages": 2,
  "has_more": true,
  "next": {"operation":"zones.list","input":{"page":2,"per_page":50}}
}
```

Execute `next` as a new invocation. Filters and IDs are carried forward. At the final page, `has_more` is false and `next` is null. Page order is a traversal of live data, not an atomic snapshot. Concurrent resource changes can affect counts and membership. Missing or inconsistent pagination metadata produces `PAGINATION_ERROR` and partial items may remain in `data`.

## Mutation states

| State | Meaning |
| --- | --- |
| `none` | No write submitted, or the high-level Cloudflare API explicitly rejected a write with a definite 4xx response (except 408) |
| `planned` | Read-only preparation succeeded; `data.request` shows the prospective mutation |
| `applied` | Cloudflare reported the high-level write succeeded |
| `unknown` | Submission may have occurred, or raw code was declared to have write effects that the CLI cannot infer |

| Verification | Meaning |
| --- | --- |
| `not_applicable` | Read, plan, or rejected/unsubmitted write |
| `not_performed` | Submission outcome unknown, or raw write requiring agent-managed verification |
| `passed` | High-level readback matched the requested fields, or delete GET returned 404 |
| `failed` | Successful readback contradicted the expected result |
| `unknown` | A known-successful write could not be conclusively read back |

Create/update verification compares each requested field plus the record ID. It normalizes case/final dots for DNS names and CNAME/MX/NS targets, and textual IPv6 representations. Other content is compared literally. It does not verify public DNS propagation or assert unrelated fields stayed unchanged. To verify public DNS, use Cloudflare DoH.

Updates use PATCH. If the resulting record is proxied and the patch omits TTL, the request includes TTL 1 to match Cloudflare behavior. `plan` exposes that normalization. High-level updates do not change record types.

`if_modified_on` is required for update/delete, including plans. The CLI reads the record immediately before preparation/submission and compares timestamps. This prevents using a known-stale snapshot, but Cloudflare may accept another writer's change between that check and the write. There is no atomic lock, idempotency key, duplicate-create suppression, or automatic rollback.

A plan is not a durable transaction and is not bound to a later apply. Apply re-reads and checks its own input. A create timeout may have created the record without returning its ID; query the zone by name/type and compare content before considering another create. Retained snapshots can assist rollback, but restoring them may need fresh IDs, timestamps, permissions, or advanced record fields.

## Errors and exit codes

Errors have `code`, `message`, `retryable`, `next_action`, and `details`. Machine consumers should branch on `code`, `mutation`, and exit status, not parse English messages.

Upstream error details are diagnostic summaries. API failures retain top-level response keys, status, errors, messages, pagination metadata, and the result shape/count, but omit the result payload itself. Long strings, arrays, and unusually wide or deeply nested MCP diagnostics are bounded with explicit truncation markers.

| Exit | Meaning |
| --- | --- |
| 0 | Operation completed; raw writes still require separate verification |
| 2 | Invalid input, input I/O, unknown operation, or invalid configuration |
| 3 | Network, HTTP, MCP, tool, API, pagination, protocol, response-limit, or unexpected local failure |
| 4 | Record precondition failed; no write submitted |
| 5 | Write may have happened, or a known-successful write failed verification |

Stable codes: `INVALID_INPUT`, `INVALID_JSON`, `INPUT_IO_ERROR`, `UNKNOWN_OPERATION`, `INVALID_CONFIG`, `TIMEOUT`, `NETWORK_ERROR`, `HTTP_ERROR`, `MCP_ERROR`, `TOOL_ERROR`, `API_ERROR`, `PROTOCOL_ERROR`, `PAGINATION_ERROR`, `RESPONSE_TOO_LARGE`, `PRECONDITION_FAILED`, `VERIFICATION_FAILED`, `INTERNAL_ERROR`.

The same transport error can exit 3 before submission or 5 after submission. Exit 5 and all errors with `state: applied/unknown` set `retryable: false` and direct the agent to reconcile resource state. Definite high-level API write rejections are also not automatically retried. Read throttling, server errors and network deadlines may set `retryable: true`; the CLI never retries itself.

For raw code, `effect` is an agent declaration, not enforcement. The CLI checks MCP `isError` and recognized outer `success: false`/error HTTP status results. Nested failures, partial writes, transactions, pagination inside code, and custom result formats must be interpreted by the agent.
