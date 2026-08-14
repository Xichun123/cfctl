# cfctl

A dependency-free Cloudflare CLI and reusable agent skill backed by Cloudflare's remote MCP server.

## Install

Install both the `cfctl` command and the standard `cfctl` skill:

```bash
curl -fsSL https://raw.githubusercontent.com/Xichun123/cfctl/main/install.sh | sh
```

From a local clone:

```bash
./install.sh
```

The installer copies the skill to `~/.agents/skills/cfctl` and links the CLI at `~/.local/bin/cfctl`. Ensure `~/.local/bin` is in `PATH`.

Skill-only installation is also supported:

```bash
skills add Xichun123/cfctl --skill cfctl -g -a universal -y
```

## Configure

Create a least-privilege Cloudflare API token, then export it from your shell profile:

```bash
export CLOUDFLARE_MCP_TOKEN='your-cloudflare-api-token'
```

Never commit the token or pass it as a command argument.

## Use

```bash
cfctl doctor
cfctl zones list
cfctl zones list --json
cfctl tools
```

For APIs without a high-level command, use the MCP escape hatch:

```bash
cfctl call search --args '{"code":"async () => { /* inspect spec */ }"}'
cfctl call execute --args-file /tmp/cloudflare-execute.json
```

## Repository layout

```text
skills/cfctl/
├── SKILL.md
├── scripts/
│   ├── cfctl.mjs
│   └── cfctl.test.mjs
└── reference/
    └── configuration.md
```

## Test

```bash
node --test skills/cfctl/scripts/cfctl.test.mjs
```

No credentials are stored in this repository.
