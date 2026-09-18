# Configuration

Requires Node.js 22 or newer. The CLI uses built-in Node APIs and has no package dependencies.

## Authentication

Provide a least-privilege Cloudflare API token through `CLOUDFLARE_MCP_TOKEN`. Alternatively, set `CLOUDFLARE_MCP_AUTHORIZATION` to a complete Authorization header value. Setting both is an error.

Do not put credentials in skill files, command arguments, request JSON, committed environment files, or diagnostic output. The CLI does not load `.env` files automatically. Supply credentials through the execution environment or a secret manager.

The CLI redacts configured authentication and additional-header values from its output, including upstream errors. This is defense in depth: arbitrary resource data can contain other secrets that the CLI cannot identify. Limit queries to the data needed for the task.

The endpoint defaults to `https://mcp.cloudflare.com/mcp`. Override it with `CLOUDFLARE_MCP_URL` for a trusted gateway. HTTPS is required except for localhost/loopback HTTP tests. URLs with embedded credentials, query parameters or fragments are rejected. Redirects are not followed.

The client is noninteractive and uses bearer authentication. It does not implement browser OAuth. If policy requires OAuth, use an OAuth-capable MCP client.

## Additional headers

`CLOUDFLARE_MCP_HEADERS_JSON` may contain a JSON object of string-valued headers for a trusted gateway or Cloudflare Access. Authorization, host, transport framing and MCP protocol headers cannot be overridden here. Use the authentication variables for Authorization.

All additional-header values are treated as sensitive for output redaction. Do not print the variable to diagnose header problems.

## Deadlines and response bounds

`CLOUDFLARE_MCP_TIMEOUT_MS` sets the deadline per HTTP request, including reading the response body. Default: 30000 milliseconds; supported range: 1–300000. An invocation can make several HTTP requests, so its total duration can exceed this deadline.

There are no automatic retries, including initialization, reads, and writes. HTTP 429 errors include `retry_after` when the server provides it. The agent decides whether a later retry is appropriate.

Each HTTP response and operation input is limited to 8 MiB. Oversized responses fail explicitly rather than being truncated. Reduce page size, narrow filters, or return a smaller structured result from raw code.

## MCP behavior

Each invocation initializes a fresh MCP session, sends `notifications/initialized`, then performs its operation in that session. Session IDs and authentication are not persisted locally. Server-side session expiry is managed by the server.

The client requests protocol version `2025-03-26` and also accepts `2025-06-18` and `2025-11-25`. It uses Streamable HTTP POST with JSON-RPC 2.0, accepts JSON or SSE responses, and correlates response IDs. For SSE it consumes complete events until the matching result/error arrives, then cancels the response stream; it does not wait for the server to close a persistent connection.

`mcp.tools` consumes all tool-definition pages and rejects repeated cursors. Resource lists deliberately return one page with executable next-page input. The client does not implement general server-initiated MCP requests, resumable streams, or OAuth.

## Permissions and diagnostics

Use a separate token scoped to the accounts/zones and permissions required by the task. Avoid a global API key. DNS reads/writes, Workers scripts/routes, Pages, R2, D1, account settings, and Zero Trust may require different permissions. A successful `doctor` proves MCP initialization worked; it does not prove every API permission is available.

Inspect structured error codes and API errors for a denied operation. Do not repeatedly broaden token permissions or retry a rejected write. If credentials are missing, ask for the exact environment variable to be supplied through a secure mechanism; do not ask the user to paste the token into chat.

If a credential is disclosed, revoke/rotate it, replace the execution environment value, and remove exposed copies from logs/history where possible.
