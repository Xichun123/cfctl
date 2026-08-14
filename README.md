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
cfctl dns list example.com
cfctl dns list example.com --type A --name www
cfctl tools
```

DNS writes are dry runs unless `--yes` is supplied:

```bash
cfctl dns create example.com A www 192.0.2.1 --proxied
cfctl dns create example.com A www 192.0.2.1 --proxied --yes
cfctl dns update example.com <record-id> --content 192.0.2.2 --yes
cfctl dns delete example.com <record-id>
cfctl dns delete example.com <record-id> --yes
```

High-level DNS writes support `A`, `AAAA`, `CNAME`, `TXT`, `MX`, and `NS`. Use `--ttl`, `--priority`, `--comment`, `--proxied`, `--dns-only`, and `--json` as needed.

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
