# Configuration and migration

## Source MCP configuration

A typical MCP client configuration is:

```json
{
  "cloudflare": {
    "url": "https://mcp.cloudflare.com/mcp",
    "headers": {
      "Authorization": "Bearer <token>"
    }
  }
}
```

The skill keeps the endpoint but intentionally does not copy the credential into any skill file. Convert it to environment variables:

```bash
export CLOUDFLARE_MCP_URL='https://mcp.cloudflare.com/mcp'
export CLOUDFLARE_MCP_TOKEN='<token>'
```

`CLOUDFLARE_MCP_TOKEN` is the value after `Bearer `. If an authentication system needs a different complete value, use:

```bash
export CLOUDFLARE_MCP_AUTHORIZATION='Bearer <token>'
```

Do not set both variables. If both are present, `CLOUDFLARE_MCP_AUTHORIZATION` takes precedence.

## Additional headers

For gateways or Cloudflare Access service tokens, provide non-Authorization headers as a JSON object:

```bash
export CLOUDFLARE_MCP_HEADERS_JSON='{
  "CF-Access-Client-Id": "example.access",
  "CF-Access-Client-Secret": "secret"
}'
```

Keep this value out of committed shell profiles and repository files when it contains secrets.

## Token permissions

Create a separate least-privilege token for agent automation. Grant only the account/zone and permissions needed for the task. Avoid a global API key.

Common operations may require distinct permissions, for example:

- DNS record reads/writes
- Workers Scripts reads/writes
- Workers Routes reads/writes
- Pages reads/writes
- R2 or D1 reads/writes
- Account Settings reads/writes
- Zero Trust or Access reads/writes

The API response will normally identify missing permission failures with HTTP `403` or an error code/message.

## MCP protocol behavior

The bundled client:

1. Opens a Streamable HTTP session.
2. Sends MCP `initialize`.
3. Sends `notifications/initialized`.
4. Lists or calls tools in the same process/session.
5. Accepts JSON and Server-Sent Events responses.
6. Handles paginated `tools/list` results.

Each CLI invocation creates a new MCP session. It does not persist access tokens, cookies, or session IDs.

## OAuth limitation

Cloudflare's MCP endpoint can use browser OAuth in interactive MCP clients. The bundled command-line client is intentionally noninteractive and uses a bearer token. Use an OAuth-capable MCP client if organizational policy disallows static API tokens.

## Credential rotation

If a real token was accidentally committed, pasted into a public issue, or otherwise disclosed:

1. Revoke or rotate it in the Cloudflare dashboard.
2. Replace the local environment variable.
3. Remove it from repository history and logs where possible.
4. Re-run `cfctl doctor`.
