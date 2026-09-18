# cfctl

An agent-only, dependency-free Cloudflare CLI and reusable skill, backed by Cloudflare's remote MCP server. Requires Node.js 22+.

Version 2 uses JSON inputs, JSON Schema discovery, and a single JSON output envelope. It intentionally removes the previous human-facing commands, tables, flags, and compatibility behavior.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Xichun123/cfctl/main/install.sh | sh
```

From a local checkout:

```bash
./install.sh
```

The installer copies the skill to `~/.agents/skills/cfctl` and links `~/.local/bin/cfctl`. Set `CFCTL_SKILL_HOME` or `CFCTL_BIN_DIR` to override those locations. No credentials are installed.

Skill-only installation also works:

```bash
skills add Xichun123/cfctl --skill cfctl -g -a universal -y
```

An agent can always invoke `node /absolute/path/to/cfctl/scripts/cfctl.mjs`; a global command or PATH change is not required. `SKILL.md` describes how to discover and use the interface.

## Interface

Provide `CLOUDFLARE_MCP_TOKEN` through the agent's execution environment or a secret manager. Never put credentials in request JSON, command arguments, or source files. `.env` files are not loaded automatically.

```bash
cfctl schema
cfctl schema dns.update
cfctl doctor
cfctl zones.list --input '{"name":"example.com"}'
cfctl dns.list --file /absolute/path/list-request.json
cfctl dns.update --stdin < /absolute/path/update-request.json
cfctl mcp.tools
cfctl mcp.call --file /absolute/path/raw-request.json
```

`schema` works offline without credentials. Input is validated before authentication or network access. Exactly one JSON object is written to stdout, including on errors; failures use nonzero exit codes. The output includes `ok`, `data`, `pagination`, `mutation`, and `error`.

DNS mutations require explicit `mode: "plan"` or `"apply"`. Plans only read. Apply requires no extra CLI confirmation. Update/delete use explicit resource IDs and a `modified_on` precondition. The CLI reads after writing and distinguishes verified success, applied changes with failed verification, and unknown write outcomes. It never automatically retries a write.

Resource lists return one page plus executable next-page input. High-level DNS creates/updates support A, AAAA, CNAME, TXT, MX and NS; reads and deletes support all record types. Other Cloudflare APIs use live MCP tool discovery and raw calls. A raw write always requires agent-managed readback, even when the tool reports success.

- [Agent instructions](skills/cfctl/SKILL.md)
- [Result contract and limitations](skills/cfctl/reference/contract.md)
- [Authentication and protocol configuration](skills/cfctl/reference/configuration.md)

## Development

```bash
node --test skills/cfctl/scripts/cfctl.test.mjs
```

Tests use a local MCP server and synthetic credentials. They cover JSON I/O, session/protocol handling, open SSE streams, pagination, read-only plans, preconditions, writes/readback, uncertain outcomes, redaction, and failure exit codes. No Cloudflare resources or real credentials are required.

```text
skills/cfctl/
├── SKILL.md
├── reference/
│   ├── configuration.md
│   └── contract.md
└── scripts/
    ├── cfctl.mjs
    ├── cfctl.test.mjs
    └── lib/
        ├── errors.mjs
        ├── mcp.mjs
        ├── operations.mjs
        └── schema.mjs
```
