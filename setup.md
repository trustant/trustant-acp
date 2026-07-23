# setup.sh — install, build, install

`setup.sh` is the one-shot bootstrap for the standalone ACP client. It runs three
ordered phases:

1. **Install components** — coding agents and ACP adapters globally via npm,
   then Pi extensions through `pi install` so Pi actually registers them. The
   package list and pins live entirely in [pi.version](pi.version).
2. **Build** — *only if there is a `package.json` in the current directory*:
   builds `dist-web/` (the web UI) and `dist-bin/truacp.cjs` (the server bundle).
3. **Install** — copies the bundle to `~/.local/lib/truacp` and writes the
   launcher scripts to `~/.local/bin`. Runs whenever a bundle is present, whether
   phase 2 just built it or it shipped prebuilt.

```bash
./setup.sh          # or: sh setup.sh
```

It is portable POSIX `sh` — no bashisms, no arrays — so a Dockerfile can `COPY`
it and `RUN` it under the default `/bin/sh`. `node` and `npm` are assumed to be
on PATH; this script installs agents, never a runtime.

## Self-contained deployment

`setup.sh` needs **no other file from this repo**. Given just three files:

```
setup.sh
pi.version
dist-bin/truacp.cjs
```

it installs a complete, working `truacp` into `~/.local/bin` — no `package.json`,
no `node_modules`, no secondary installer, and no network access beyond npm for
the agents. That is what makes it dropable into a Docker layer:

```dockerfile
COPY setup.sh pi.version ./
COPY dist-bin/truacp.cjs dist-bin/
RUN sh setup.sh
```

With no `package.json` the build phase is skipped, and phase 3 installs the
prebuilt bundle directly. The bundle is looked for next to the script first
(`<script dir>/dist-bin/truacp.cjs`, then `<script dir>/truacp.cjs`) and then in
the current directory, so both the three-file layout and a source checkout work.

`setup.sh` is intentionally the only installer. `npm run build` only creates the
bundle, which prevents build hosts from being modified and guarantees that VM
and image installs use the same launcher implementation.

## Phase 1 — components

The adapters are what [config.json](config.json) actually spawns (`npx -y
<adapter>`); installing them globally makes launches instant and lets them work
offline. Each adapter drives an underlying CLI that must also be on PATH.

| Agent | Package(s) | CLI on PATH |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` + `@agentclientprotocol/claude-agent-acp` | `claude` |
| Codex | `@openai/codex` + `@agentclientprotocol/codex-acp` | `codex` |
| Pi | `@earendil-works/pi-coding-agent` + `pi-acp` | `pi` |

Pi additionally gets two extensions to the `pi` CLI (not ACP adapters),
registered by `pi install` rather than only copied by global npm:
`pi-mcp-adapter` for MCP server support, and `pi-web-access` for web search, URL
fetching, repo cloning, and PDF/video extraction. `pi-web-access` needs a search
provider key (OpenAI, Brave, Tavily, Exa, …) configured in Pi before its tools
work — this script installs the package but sets no credentials.

For Codex, `@zed-industries/codex-acp` is deprecated in favour of the
`@agentclientprotocol` scope.

### The version manifest (`pi.version`)

**Every package and version lives in [pi.version](pi.version) — none are
hardcoded in `setup.sh`.** Each line is a literal npm install spec,
`<module>@<version>`; `#` comments and blank lines are ignored:

```
# Claude Code — CLI + ACP adapter
@anthropic-ai/claude-code@2.1.216
@agentclientprotocol/claude-agent-acp@0.60.0
...
@earendil-works/pi-coding-agent@0.80.10
pi-acp@0.0.31
```

`setup.sh` reads the file, passes CLI/ACP specs to `npm install -g`, and registers
the two Pi extension specs as `npm:<package>@<version>` with `pi install`.
Upgrading an agent or extension is therefore a one-line edit here.

**Every entry must carry a version.** An unpinned spec would silently resolve to
latest and break build reproducibility, so the script treats it as an error and
aborts rather than falling back. A scoped name without a version
(`@anthropic-ai/claude-code`) is correctly detected as unpinned — the leading `@`
of the scope is not mistaken for a version separator. A missing, empty, or
comment-only manifest likewise aborts.

The file is read relative to the *script's* directory rather than the current
one, so the pins apply in runtime-only mode too (see below).

Preflight: the script exits non-zero if `node` or `npm` is missing, then prints
the resolved versions. Install goes into npm's global prefix when
`<prefix>/lib/node_modules` is writable, otherwise into `--prefix "$HOME/.local"`
(bins land in `~/.local/bin`) so `npm install -g` never needs `sudo`. It warns
when `~/.local/bin` is not already on PATH. A single `npm install -g --force`
covers CLI and ACP packages. Pi extensions are skipped when the exact pinned
source is already present in `pi list`, keeping re-runs idempotent.

`pi-acp@0.0.31` performs an update lookup independently from Pi and does not
honor Pi's `PI_SKIP_VERSION_CHECK` or `PI_OFFLINE` flags. Immediately after the
pinned global install, `setup.sh` applies a narrow compatibility guard to the
installed adapter. This prevents its unsolicited `npm view` request and startup
banner when either flag is set. The patch is idempotent and checks the expected
adapter structure; setup fails clearly if a future pinned version changes that
structure, so the compatibility layer must be reviewed rather than silently
misapplied. This temporary patch can be removed once `pi-acp` supports the flags
natively.

## Phases 2 and 3 — build and install

The two phases are gated independently, which is what allows the three-file
deployment above:

| In the working directory | Phase 2 (build) | Phase 3 (install) |
|---|---|---|
| `package.json` + sources | builds the bundle | installs what it built |
| prebuilt `dist-bin/truacp.cjs` only | skipped | installs the prebuilt bundle |
| neither | skipped | skipped — agents only, exit 0 |

The build check is against the *current* directory, not the script's own — so
`cd trustable-acp && ./setup.sh` builds, while `./trustable-acp/setup.sh` from
the parent does not. The bundle lookup is the opposite way round: it prefers the
*script's* directory (`<script dir>/dist-bin/truacp.cjs`, then
`<script dir>/truacp.cjs`) before the current one, so a copied-out three-file set
installs correctly no matter where it is invoked from. With neither sources nor a
bundle, the script exits 0 after phase 1 — the runtime-only mode for image layers
that need the agents but not the server.

With a `package.json` present, phase 2 runs `npm ci` (falling back to `npm
install`), then `npm run build:web` and `npm run build:server`. Phase 3 then
installs, producing:

| Path | What |
|---|---|
| `~/.local/lib/truacp/truacp.cjs` | the bundled server, web UI embedded |
| `~/.local/bin/truacp` | launcher shell script |
| `~/.local/bin/trustable-acp` | the same launcher, long name |

**The launchers are portable shell scripts, not compiled binaries.** Each is a
four-line `#!/bin/sh` wrapper that does `exec node <bundle> "$@"`, forwarding all
flags (`--port`, `--dir`, `--config`, …). They are architecture-independent, so
the same file works wherever `node` is on PATH — which is what lets the Trustable
Docker image install them without shipping a platform-specific executable. The
only checked build artifact is `dist-bin/truacp.cjs`; launchers exist only in
the installation prefix generated by `setup.sh`.

Note that esbuild's own executable is platform-specific, so phase 2 must use
dependencies installed for the machine performing the build. Development setup
builds inside `trudev`; `image.sh` installs dependencies and builds on its host,
then stages the portable JavaScript bundle.

`set -eu` is in effect, so any failing step aborts the script.

## What it does *not* do

API keys are not handled here. Set them in `.env` (copy from
[.env.example](.env.example)): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`PI_API_KEY`.

## Next steps

```bash
truacp --port 4096 --dir /path/to/app     # the installed launcher
npm run serve                             # or run from source
```

## Where it runs

Anywhere `node`/`npm` are on PATH — the host machine, inside the `trudev` Lima
VM, or a Docker build layer.
