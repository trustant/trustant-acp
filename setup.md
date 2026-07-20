# setup.sh — agent installation

`setup.sh` installs the coding agents used by the standalone ACP client, plus
their ACP adapters, globally via npm. It is a one-shot bootstrap script: run it
once on a new machine (or inside the `trudev` VM) before starting the server.

```bash
./setup.sh
```

## What it installs

The adapters are what [config.json](config.json) actually spawns (`npx -y
<adapter>`); installing them globally makes launches instant and lets them work
offline. Each adapter drives an underlying CLI that must also be on PATH.

| Agent | Package(s) | CLI on PATH |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` + `@agentclientprotocol/claude-agent-acp` | `claude` |
| Codex | `@openai/codex` + `@agentclientprotocol/codex-acp` | `codex` |
| Pi | `@earendil-works/pi-coding-agent` + `pi-acp` | `pi` |

Pi additionally gets two extensions to the `pi` CLI (not ACP adapters):
`pi-mcp-adapter` for MCP server support, and `pi-web-access` for web search, URL
fetching, repo cloning, and PDF/video extraction. `pi-web-access` needs a search
provider key (OpenAI, Brave, Tavily, Exa, …) configured in Pi before its tools
work — this script installs the package but sets no credentials.

For Codex, `@zed-industries/codex-acp` is deprecated in favour of the
`@agentclientprotocol` scope.

## Behaviour

1. **npm check** — exits with a non-zero status if `npm` is not on PATH, then
   prints the resolved node/npm versions.
2. **Prefix selection** — reads `npm config get prefix`. If
   `<prefix>/lib/node_modules` is writable, installs there as-is. Otherwise it
   falls back to `--prefix "$HOME/.local"` (bins land in `~/.local/bin`) so
   `npm install -g` never needs `sudo`. In the fallback case it warns if
   `~/.local/bin` is not already on PATH.
3. **Install** — a single `npm install -g --force` over the whole package list,
   so npm resolves the dependency set once. `--force` makes re-runs idempotent
   by allowing bin links from a previously-installed adapter (e.g. the
   deprecated `@zed-industries/codex-acp`) to be overwritten.
4. **Report** — prints each package with its version from `npm view`.

`set -euo pipefail` is in effect, so any failing step aborts the script.

## What it does *not* do

API keys are not handled here. Set them in `.env` (copy from
[.env.example](.env.example)): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`PI_API_KEY`.

## Next steps

```bash
npm run serve            # or: npm run serve:trureact
```

## Where it runs

Anywhere `node`/`npm` are on PATH — the host machine or inside the `trudev`
Lima VM.
