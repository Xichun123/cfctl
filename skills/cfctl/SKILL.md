---
name: cfctl
description: Operate Cloudflare through the cfctl CLI and Cloudflare's remote MCP server. Use for zones, DNS, Workers, Pages, R2, D1, KV, Zero Trust, WAF, CDN, account settings, or Cloudflare API discovery and execution.
---

# cfctl

Use the bundled dependency-free CLI to access `https://mcp.cloudflare.com/mcp`.

## Requirements

- Node.js 18 or newer.
- A least-privilege Cloudflare API token in `CLOUDFLARE_MCP_TOKEN`.
- Never place a token in source files, command arguments, logs, or committed `.env` files.

```bash
export CLOUDFLARE_MCP_TOKEN='your-cloudflare-api-token'
```

Optional configuration:

```bash
export CLOUDFLARE_MCP_URL='https://mcp.cloudflare.com/mcp'
# Or provide the complete Authorization value:
export CLOUDFLARE_MCP_AUTHORIZATION='Bearer your-token'
```

## Workflow

1. Check connectivity and authentication:

   ```bash
   cfctl doctor
   ```

2. Retrieve live MCP tool definitions before the first raw operation in a session:

   ```bash
   cfctl tools
   ```

3. Prefer a high-level command when available:

   ```bash
   cfctl zones list
   cfctl zones list --json
   ```

4. For tasks not covered by a high-level command, call MCP `search` first. Do not guess endpoint paths or payload fields. Call `execute` only after discovery.

5. For mutations, summarize the exact target and effect before execution. Obtain explicit confirmation before destructive, security-sensitive, billing-related, or broad-impact changes unless the user already authorized that exact action.

6. Validate `success`, HTTP status, `errors`, and `messages`; after a mutation, read the resource again to verify the result.

## Raw MCP calls

```bash
cfctl call search --args '{"code":"async () => { /* inspect spec */ }"}'
cfctl call execute --args-file /tmp/cloudflare-execute.json
printf '%s' '{"code":"async () => { /* execute */ }"}' | cfctl call execute --stdin
```

The live `tools` output is authoritative if its schema differs from these examples.

## Safety

- Use the narrowest account, zone, resource, and token permissions possible.
- Never print environment variables or authorization headers while debugging.
- Treat DNS deletion, zone changes, deployments, routes, WAF, Access policies, token changes, and bulk operations as high impact.
- Preserve existing settings unless the requested task requires changing them.
- Retrieve all pages before drawing conclusions.
- State the rollback path before changes that can affect production traffic.

See `reference/configuration.md` for credential and protocol details.
