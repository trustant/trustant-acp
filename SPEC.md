# trustable-acp — Standalone ACP Client Specification

## 1. Goal

`trustable-acp` is a **standalone Agent Client Protocol (ACP) client** that:

1. Runs as a **local Node server** + **browser React UI** — no editor host required.
2. Launches Claude Code, Codex, Pi, and any custom ACP agent as subprocesses.
3. Keeps all configuration in a single **`config.json`** file (env-var references for secrets — no keychain).

Non-goals: mobile support; reusing any external editor's markdown/theme engines.

## 2. Architecture overview

The codebase is cleanly layered. ACP protocol handling is confined to `src/acp/`, business logic to `src/services/` and `src/hooks/`, and interface **ports** decouple the UI from the runtime (`ISettingsAccess`, `IVaultAccess`, `IChatViewHost`, `IChatViewContainer`). Agent events flow through a single `onSessionUpdate` channel.

**Responsibilities split across the two processes:**

| Concern | Module | Standalone mechanism |
|---|---|---|
| Server bootstrap | `server/index.ts`, `main.ts` | Node server bootstrap + browser app bootstrap |
| Views | `ChatView.tsx`, `SessionManagerView.tsx`, Modals | Browser routes / React modals |
| Settings UI | `SettingsTab.ts` | React settings form over `config.json` |
| Secrets | `acp-client.ts` | `process.env` (`.env` file) |
| Settings persistence | `settings-service.ts` | JSON file read/write |
| Session files | `session-storage.ts` | Node `fs` (server) |
| Chat export | `chat-exporter.ts` | Node `fs` (server) |
| cwd source | `ChatPanel.tsx` | user-chosen project dir / `process.cwd()` (see §10e) |
| Markdown | `MarkdownRenderer.tsx` | `react-markdown` + remark plugins |
| OS detection | `platform.ts`, `paths.ts`, others | `process.platform` |
| Icons | ~10 components | `lucide-react` |
| Toasts / menus | several | React toast / menu components |
| Networking | `update-checker.ts` | `fetch` |
| @-mentions | `vault-service.ts` | fs walk + fuzzy over cwd |
| Styling | `styles.css` | ~30 design tokens in `:root` (light+dark) |

**Portable core (framework-agnostic):** `acp/type-converter.ts`, `acp/acp-handler.ts`, `acp/permission-handler.ts`; all of `types/`; pure `services/` (`message-state`, `message-sender`, `session-state`, `session-helpers`, `settings-normalizer`, `view-registry`); most `hooks/`; pure React (`PermissionBanner`, `TerminalBlock`, `SuggestionPopup`); `utils/logger`, `utils/text`.

## 3. Target architecture

Two processes, one repo (monorepo or two build targets):

```
┌────────────────────────────┐         ┌─────────────────────────────────────┐
│  Browser (React UI)        │  WS +   │  Node server (localhost:PORT)        │
│                            │  REST   │                                      │
│  ChatPanel + ui/*          │◄───────►│  transport (ws/http)                 │
│  hooks/*                   │         │  ─ AcpClient  ─ TerminalManager      │
│  onSessionUpdate consumer  │         │  ─ SessionStorage (fs)               │
│  react-markdown renderer   │         │  ─ chat-exporter (fs)                │
│  design-token stylesheet   │         │  ─ mention file reads (fs)           │
│                            │         │  ─ config.json load/save             │
└────────────────────────────┘         │  spawns → claude/codex/pi            │
                                        └─────────────────────────────────────┘
```

- **Server owns all Node-only capabilities**: `child_process.spawn` (agents + terminals), `fs` (sessions, export, mentions), `config.json` I/O, env/secret resolution, WSL/Windows PATH logic (`platform.ts`, `paths.ts`).
- **Browser owns rendering only**: React UI, markdown, styling. No `child_process`, no `fs`.
- **Transport**: one **WebSocket** carries the streaming `session/update` events (the existing single `onSessionUpdate` channel serializes cleanly to WS messages) and permission/terminal requests; **REST** endpoints handle request/response calls (`initialize`, `newSession`, `sendPrompt`, `listSessions`, `loadSession`, `resumeSession`, `forkSession`, agent-owned `deleteSession`, `setSessionConfigOption`, `cancel`, config get/save, local session history get/delete, export).
- **Client-side transport shim** implements the same surface the UI expects today (an `AcpClient`-shaped facade) so `hooks/*` and `ChatPanel` change minimally — they call methods that now issue REST/WS instead of touching an in-process `AcpClient`.

### 3.1 Directory layout (proposed)

```
server/                  # Node
  index.ts               # http + ws server, --dir/--config/--cli, 0.0.0.0 bind, embedded web (§10a)
  acp-host.ts            # buildRuntime/buildAgentConfig → AcpClient inputs
  session-host.ts        # owns an AcpClient per agent, wires onSessionUpdate → ws
  session-store.ts       # saved-session metadata + message files (.acp-data)
  routes.ts              # REST handlers
  protocol.ts            # REST/WS request/response types
  config-store.ts        # config.json load/save + DEFAULT_CONFIG (agent defs)
  secrets.ts             # .env → process.env
  pi-config.ts           # pi: models.json custom provider + hello probe (§10d)
  codex-login.ts         # codex: login status + device-code auth (§10d)
  claude-login.ts        # claude: login status + paste-code OAuth (§10d)
  web-bundle.generated.ts # embedded dist-web/ (generated by esbuild.web.mjs)
src/acp/                 # portable ACP core (AcpClient, handler, converters)
web/                     # browser bundle: index.html, ChatApp.tsx, transport.ts, styles.css
config.json              # user config (see §5)
.env                     # secret values (gitignored)
```

Shared pure modules (`types/`, `settings-normalizer`, `session-helpers`, `message-*`) are imported by both sides.

## 4. Agent launching (unchanged core)

Agent spawn logic in `acp/acp-client.ts` + `utils/platform.ts` is kept; only the injected dependencies change:

- **command / args / env**: from `config.json` agent entry (see §5).
- **API key**: resolved from `process.env[envVarName]` (was `secretStorage`), injected into the agent's env under the mapped variable — Claude→`ANTHROPIC_API_KEY`, Codex→`OPENAI_API_KEY`, Pi→`PI_API_KEY`. `buildAgentConfigWithApiKey` keeps this mapping; `session-helpers` unchanged in shape.
- **cwd**: user-chosen project directory (server flag / config / **runtime change-directory** / per-session override), replacing `FileSystemAdapter.getBasePath()`. cwd remains the entire filesystem contract with the agent. The default cwd (`projectDir`) can be changed at runtime without restarting the server, and each new session may be created against a chosen cwd — see §10e.
- **shell wrapping**: login-shell (`$SHELL -l -c`), Windows `cmd.exe`, WSL `wsl.exe --exec` logic in `platform.ts` kept verbatim; `Platform` → `process.platform` shim.
- **process teardown**: `detached` process group + `process.kill(-pid)` (Unix) / `taskkill /T /F` (Windows) kept.

## 5. Configuration file (`config.json`)

Single JSON file, loaded at server start, hot-reloadable via the settings API. Secrets are **env-var names**, never values.

```jsonc
{
  "server": { "port": 4096, "projectDir": "." },       // port default 4096, overridable via --port; projectDir = default cwd
  "defaultAgentId": "pi",                               // agent used for a new session by default
  "nodePath": "",                                        // optional explicit node dir
  "agents": {
    "claude": {
      "id": "claude", "displayName": "Claude Code",
      "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"],
      "env": [],
      "apiKeyEnvVar": "ANTHROPIC_API_KEY"               // was apiKeySecretId
    },
    "codex":  { "id": "codex",  "displayName": "Codex",  "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"], "env": [], "apiKeyEnvVar": "OPENAI_API_KEY" },
    "pi":     { "id": "pi",     "displayName": "Pi",     "command": "npx", "args": ["-y", "pi-acp"], "env": [], "apiKeyEnvVar": "PI_API_KEY" }
  },
  "customAgents": [
    { "id": "my-agent", "displayName": "My Agent", "command": "my-acp", "args": [], "env": [{"key":"FOO","value":"bar"}] }
  ],
  "permissions": { "autoAllow": false },
  "display": {
    "sendMessageShortcut": "enter",                     // enter | cmd-enter
    "fontSize": 14, "showEmojis": true,
    "autoCollapseDiffs": true, "diffCollapseThreshold": 20,
    "maxNoteLength": 20000, "maxSelectionLength": 5000
  },
  "promptInjection": { "enabled": true, "latex": true, "wikiLinks": false, "tables": true },
  "mentions": { "autoMentionActiveNote": false },       // scoped to project dir
  "export": { "folder": "exports", "filenameTemplate": "{title}-{date}", "frontmatterTag": "chat" },
  "windows": { "wslMode": false, "wslDistribution": "" },
  "state": {                                            // machine-written, not hand-edited
    "savedSessions": [], "lastUsedModels": {}, "lastUsedModes": {}, "lastUsedConfigOptions": {}
  }
}
```

- **`.env`** (gitignored) holds the actual keys: `ANTHROPIC_API_KEY=...`, `OPENAI_API_KEY=...`, `PI_API_KEY=...`. Server loads it (`dotenv` or manual) into `process.env`.
- **Secrets location** — the server reads exactly one secrets file, given by `--env <path>` and loaded **before** the `--dir` chdir (§10a), so the path never depends on the working directory. The target directory's own `.env` is deliberately **not** read: that checkout is user content, and reading it would let an app inject or shadow provider credentials. `loadDotEnv` never overwrites an already-set variable, so externally-supplied keys (exported in the environment) win over the file. Omitting `--env` loads no file at all — keys then come purely from the environment.
- Config is authored fresh in `config.json`; there is no import path from other tools.
- `settings-service.ts` keeps its reactive `ISettingsAccess` surface; only the backing (`config-store.ts` read/write of `config.json`) changes. `useSettings` (`useSyncExternalStore`) is unchanged.

## 6. Transport contract

**WebSocket (`/ws`)** — server→client stream:
- `sessionUpdate` — the serialized `SessionUpdate` union (message/thought/user chunks, tool_call(_update), plan, available_commands, mode, usage, config_option, process_error).
- `permissionRequest` — agent asked for permission; client replies via REST `POST /permission/:id`.
- `terminalOutput` — for `TerminalBlock` polling (or push).

**REST** (request/response), one handler per current `AcpClient` method:
- `POST /session/initialize`, `/session/new`, `/session/load`, `/session/resume`, `/session/fork`, `/session/list` — each accepts an optional `cwd` (see §10e); `/session/new` creates the session in `cwd ?? projectDir`.
- `POST /session/delete` calls standard ACP `session/delete` and clears the
  TruACP metadata only after the owning agent confirms deletion.
- `POST /session/:id/prompt`, `/session/:id/cancel`, `/session/:id/config-option`, `/session/:id/mode`
- `GET /api/directory` (current default cwd), `POST /api/directory` (change default cwd) — see §10e.
- `POST /permission/:id` (approve/reject)
- `GET/PUT /config`
- `GET/DELETE /sessions/history/:id`, `POST /export`
- `GET /mentions/search?q=`, `GET /mentions/read?path=` (project-dir-scoped)
- `GET /update-check`

**Client shim** (`web/acp-transport.ts`) exposes the same method names `hooks/*` already call, so `useAgent`, `useAgentSession`, `useAgentMessages`, `useSessionHistory` are largely untouched. The shim subscribes to the WS and re-emits through the existing `onSessionUpdate` listener set.

## 7. UI

- **Icons**: `lucide-react`; `IconButton.tsx`/`LucideIcon` is the single wrapper, decoupling ~10 components at once.
- **Toasts / menus / dropdowns / modals**: React toast component; React menu/dropdown; React `Modal` subclasses (`ChangeDirectoryModal`, `EditTitleModal`, `SessionHistoryModal`). `ChangeDirectoryModal` is backed by the trustable-acp server's `POST /api/directory` and starts a new session in the chosen cwd — see §10e.
- **Markdown** (`MarkdownRenderer.tsx`): `react-markdown` + `remark-gfm` + `remark-math`/`rehype-katex` (LaTeX) + a small remark plugin for `[[wikilinks]]` (only if `promptInjection.wikiLinks`). Internal-link clicks are an app-level "open file" action (opens in project dir / OS).
- **Views**: `ChatView`/`FloatingChatView`/`SessionManagerView` are browser routes/panels. `FloatingChatView` renders into a plain `document.body` div with an `IChatViewHost` shim — the mount model for the web app.
- **cwd / paths**: `ChatPanel` cwd is the project dir from config/server, changeable at runtime via the header directory control (§10e); `ToolCallBlock` base-path relative display uses the same project dir value.
- **Hotkey event bus**: hotkeys dispatch through a browser `EventTarget`/emitter.

## 8. Styling

- ~30 design tokens (`--text-muted`, `--background-modifier-border`, `--text-normal`, `--background-primary/secondary`, `--interactive-accent`, `--text-accent`, `--font-monospace`, `--color-red/green/yellow/orange`, `--line-height-normal`, …) live in a `theme.css` `:root` block with a `.theme-dark` / `prefers-color-scheme: dark` variant.
- `.markdown-rendered` content styles style the react-markdown output.
- The runtime `--ac-chat-font-size` var is set from `config.display.fontSize`.

## 9. Build & packaging

- **Builds**: `web` (browser bundle + `index.html`, embedded into the server) via
  `esbuild.web.mjs`, and `server` (single self-contained `.cjs`) via
  `esbuild.server.mjs`. `npm run build` chains both and produces
  `dist-bin/truacp.cjs`; installation is owned exclusively by `setup.sh`
  (see §10a "Single-bundle build").
- Deps: `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`, `lucide-react`, a WS lib (`ws`), `dotenv`, an http framework (or Node `http`).
- Core deps: `@agentclientprotocol/sdk`, `react`/`react-dom`, `@tanstack/react-virtual`, `diff`, `zod`, `semver`.
- `npm run serve` runs the server directly via `tsx`; the installed `truacp` binary
  runs the bundled build. Both serve the embedded web bundle at `localhost:<port>`
  (default 4096).

## 10. Component map

1. **Server core** — `acp/*` + `platform.ts`/`paths.ts`; `server/` with an `AcpClient` per session, `config.json` load, `.env` secrets. Agent spawn is verifiable end-to-end via the `--cli` harness (§10a) with no UI.
2. **Persistence on fs** — `session-storage.ts` and `chat-exporter.ts` on Node `fs`; `config-store.ts` is the `ISettingsAccess` backing.
3. **Transport** — WS + REST endpoints; client-side `transport.ts` shim exposing the `AcpClient` surface the hooks expect.
4. **UI** — `lucide` icons, React toasts/menus/modals; `ChatPanel` mounts in the browser via the floating-view pattern.
5. **Markdown + styling** — react-markdown renderer; design-token `theme.css`.
6. **Settings** — React form over `config.json`.
7. **Packaging** — two build targets, `npm start`.

## 10a. Server runtime (`server/index.ts`)

The standalone server is run via `tsx` (`npm run serve`, or `npm run serve:trureact`
for the trureact workbench). For development use `npm run dev` (§10a-dev), which adds
hot reload. Behaviour beyond the transport contract:

- **`--dir <path>`** — the server `process.chdir()`s into this directory. Relative
  paths (`config.json`, a relative `server.projectDir`) then resolve against it.
  Absent → runs from the invocation cwd. Note the chdir happens **after** `--env` is
  loaded, so secrets never resolve against the target directory.
- **`--env <path>`** — secrets file, loaded before the `--dir` chdir; give it an
  absolute path. The target directory's own `.env` is never read (see §5). Omitted →
  no file is loaded and keys come from the environment. A missing file is a no-op.
- **`--config <path>`** — path to `config.json` (default `config.json`).
- **`--port <n>`** — listen port. Overrides `config.server.port`; both default to
  **4096**. Invalid values (non-integer, <1, >65535) abort startup. `npm run
  serve:trureact` passes `--port 4097` so it can run alongside a default instance
  without a port clash.
- **`--cli [...]`** — one-shot harness (`--agent`, `--cwd`) instead of the server.
- **Network binding** — the HTTP+WS server binds `0.0.0.0` by default so it is
  reachable from other machines (`http://<host-ip>:<port>/`), not just loopback.
  Overridable via `config.server.host`. Startup logs the bind address, every machine
  IP (`hostname -I`, falling back to `localhost` where unsupported, e.g. macOS), the
  port, and the current dir.
- **Advertised URL** — the `URL:`/`WebSocket:` lines use `advertisedIp()`, which
  prefers the **`lima0`** interface. This server normally runs inside the `trudev`
  Lima VM while the browser is on the macOS host, so the address that is actually
  openable is the host↔VM interface — not the VM's own default route (`eth0`, which
  is first in `hostname -I`) and not the k3s/CNI addresses. It is resolved by
  interface *name*, not by position: `hostname -I` ordering shifts as interfaces
  appear and disappear, so any fixed index is only accidentally right. Falls back to
  the first `hostname -I` address when `lima0` is absent (bare Linux server), then to
  `localhost`.
- **Embedded web bundle** — the built web UI is embedded into the server via a
  generated module `server/web-bundle.generated.ts` (each `dist-web/` file inlined
  as base64). `serveStatic` serves from this embedded map first, so the UI travels
  with the server code and does **not** depend on `dist-web/` existing at runtime or
  on the `--dir` working directory. It falls back to reading `dist-web/` from disk
  only when nothing is embedded yet (dev before a build). The generated module is
  committed (unlike `dist-web/`, which is gitignored). When no bundle is embedded
  or on disk, `/` serves a human-readable status page.

## 10a-dev. Development mode (`npm run dev` → `run.sh`)

`npm run dev` runs `run.sh`, which brings up the full stack with hot reload on both
sides against a target app checkout:

- **Frontend** — `node esbuild.web.mjs` (watch) rebundles `web/` → `dist-web/` and
  regenerates `server/web-bundle.generated.ts` on every change.
- **Backend** — `npx tsx watch server/index.ts` restarts the server on every change
  under `server/`, passing `--dir "$ACP_DIR" --port "$ACP_PORT"` and an absolute
  `--config` (config.json lives in the repo, not in the target dir). It is run with
  `--exclude server/web-bundle.generated.ts`: the esbuild watcher rewrites that file
  on every frontend edit, so without the exclusion a `.tsx` change would restart the
  backend and drop in-flight agent sessions.
- **Target** — `ACP_DIR` (default `$WORKBENCH_DIR/trureact`, with `WORKBENCH_DIR`
  defaulting to `$HOME/workbench`) and `ACP_PORT` (default 4096) are overridable:
  `ACP_DIR=/path/to/app ACP_PORT=4097 ./run.sh`.
- **Preflight** — before starting anything, `run.sh` aborts (exit 1) with an
  explanation of the prerequisite when either condition fails:
  1. **No `lima0` interface** — `run.sh` is the *in-VM* entry point, and the URL it
     advertises is the `lima0` host↔VM address, which exists only in the guest.
     Running it on the macOS host would serve an unreachable URL. The message points
     at `./start.sh` → `./ssh.sh` → `./setup.sh`, and notes that `npm run serve` is
     the VM-agnostic alternative. Note this is stricter than the server binary
     itself: `advertisedIp()` (§10a) *falls back* when `lima0` is absent, so bare
     Linux server builds keep working — only the dev script hard-fails.
  2. **No app checkout at `ACP_DIR`** — the workbench checkout is created by
     launching the app from the Trustable UI. The message lists what *is* present in
     `$WORKBENCH_DIR` so the right `ACP_DIR` is obvious.
- **Env** — `ACP_ENV` (default `$WORKBENCH_DIR/.env`) is passed through as an absolute
  `--env`, so it is loaded before the chdir and is independent of `ACP_DIR` (§5). The
  target checkout's own `.env` is never read. A missing file only warns, since keys
  may be supplied externally through the environment.

Process handling (all three constraints are load-bearing — see the comments in
`run.sh` before changing any of them):

- The watchers must **not** run under `setsid` or `set -m`. Detaching them into their
  own session/process groups stops `wait` from tracking them and stops a terminal
  Ctrl-C from reaching them, leaving them orphaned holding `$ACP_PORT`.
- `cleanup` runs under `set +e`. It is full of probing kills and tests that are
  expected to fail (already-dead PIDs, empty `ps` output); under the script's `set -e`
  the first non-zero status aborts cleanup midway and leaks the server.
- `tsx`'s actual server is a **grandchild** under `npx` (`npm exec` → `tsx` → server)
  that renames itself to `MainThread`, so it is unreachable by process name and three
  generations below the watcher PID. `kill_tree` therefore walks the subtree
  recursively (a single `pkill -P` misses the lower generations), and as a backstop
  cleanup reaps whatever still holds `$ACP_PORT` (looked up via `ss`, which reports
  PIDs for processes we own).

The main loop polls the two watcher PIDs rather than using `wait -n`: under `set -e`
a bare `wait -n` bypasses the trap when a child exits non-zero, while `wait -n || true`
swallows the exit and then blocks on the *remaining* child — both leave half a stack
running. Polling means either watcher exiting takes the whole script down.

**Build the web UI + regenerate the embed module:** `npm run build:web`
(`node esbuild.web.mjs production`). This builds `dist-web/` **and** rewrites
`server/web-bundle.generated.ts`; `npm run dev:web` does the same on watch.
esbuild's executable must match the build host: development setup builds inside
`trudev`, while `image.sh` installs dependencies and builds on its own host before
staging the portable JavaScript bundle.

**Single-bundle build:** `npm run build` produces one self-contained artifact:

1. `build:web` — builds the web UI and refreshes the embed module (above).
2. `build:server` (`node esbuild.server.mjs`) — bundles `server/index.ts` into
   `dist-bin/truacp.cjs`: everything (ws, ACP SDK, the embedded web UI) inlined,
   only Node builtins external, minified, with a `#!/usr/bin/env node` shebang.
The build does not install anything into the caller's home directory. Run
`setup.sh` to install the bundle and generate the `truacp` and `trustable-acp`
launchers. Keeping that side effect out of `npm run build` lets `image.sh` build
and stage the artifact without modifying the build host. Because the web UI is
embedded, the single `.cjs` needs no `dist-web/` or `node_modules` at runtime —
just a Node runtime.

**The launchers generated by `setup.sh` are portable shell scripts, not compiled
binaries.** `node` is assumed to be on PATH and is resolved at run time, so a
launcher is architecture-independent: the same bytes work on any platform with
a Node runtime. The build output contains only `dist-bin/truacp.cjs`; launcher
generation is an installation concern.

## 10b. Setup (`setup.sh`)

`./setup.sh` (or `npm run setup:agents`) is the one-shot bootstrap. It runs three
ordered phases:

1. **Install components** — the supported CLIs and upstream ACP adapters
   globally via npm, register Pi extensions through `pi install`, and build or
   install the pinned nested Trustable `pi-acp` fork. npm package pins live in
   `pi.version`; the fork revision is pinned by the nested Git submodule.
2. **Build** — *only if a `package.json` exists in the current directory*:
   `dist-web/` (web UI) and `dist-bin/truacp.cjs` (server bundle).
3. **Install** — the bundle into `~/.local/lib/truacp` plus the launcher scripts
   into `~/.local/bin`, whenever a bundle is present (freshly built or prebuilt).

The script is portable **POSIX `sh`** — no bashisms, no arrays — so a Dockerfile
can `COPY` it and `RUN` it under the default `/bin/sh`. `set -eu` is in effect,
so any failing step aborts it.

**Self-contained.** `setup.sh` depends on no other file in the repo. Given only

```
setup.sh + pi.version + dist-bin/truacp.cjs + pi-acp-package.tgz
    + trustable-guardrails.ts
```

it installs a complete, working truacp into `~/.local/bin` — no `package.json`,
no `node_modules`, no secondary installer, and no network beyond npm for the
remaining agents. Source mode builds the nested fork; image mode supplies the
tarball produced from that same source revision. The fifth artifact is the
reviewed Pi `tool_call` extension that prevents credentials from entering model
context. Phase 3 is the only launcher implementation, so source, VM, and image
runtimes cannot drift.

### Preflight

The script runs a preflight before installing anything and **aborts with a
non-zero status** on the first failed check, so a wrong environment fails loudly
instead of half-installing:

1. **Node.js already installed and on PATH** — `node` must resolve via
   `command -v`. The script is an agent installer, **not** a Node installer: it
   never downloads, upgrades, or version-manages a runtime. A missing `node`
   aborts with an instruction to install it first.
2. **npm on PATH** — `npm` must likewise resolve; it is the mechanism every
   install below uses.

On success the preflight prints the resolved `node -v` / `npm -v` so the
versions in play are visible in the log. There is deliberately **no OS gate**:
the script must run in a Docker build layer as well as in the `trudev` VM, and
the two checks above are the only environmental requirements it actually has.

The agents and their adapters:

| Agent | CLI package (bin) | ACP adapter (spawned by config) |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` (`claude`) | `@agentclientprotocol/claude-agent-acp` |
| Codex | `@openai/codex` (`codex`) | `@agentclientprotocol/codex-acp` |
| Pi | `@earendil-works/pi-coding-agent` (`pi`) | `pi-acp` |

- The adapters are what `config.json` spawns via `npx -y <adapter>`; a global install
  makes launches instant/offline. The CLIs are the binaries the adapters exec.
  `pi-acp` is **not** self-contained — it requires the `pi` binary on PATH.
- **Pi extensions.** Two further packages extend the `pi` CLI itself (they are
  not ACP adapters and are never spawned directly by `config.json`). They must
  be registered through `pi install`; a global npm install alone leaves them
  unavailable to Pi:
  - `pi-mcp-adapter` — MCP (Model Context Protocol) support for Pi, letting it
    consume MCP servers as tool sources.
  - `pi-web-access` — web search, URL fetching, GitHub repo cloning, and
    PDF/YouTube/video extraction. It is backed by a third-party search provider
    (OpenAI, Brave, Parallel, Tavily, Exa, Perplexity, or Gemini), so it needs that
    provider's key configured in Pi before the web tools work — `setup.sh` installs
    the package but configures no credentials (see the API-keys bullet below).
- `@zed-industries/codex-acp` is deprecated; config and this script use the
  maintained `@agentclientprotocol/codex-acp` (same `codex-acp` bin, drop-in).
- The script installs into npm's global prefix when writable, else falls back to a
  user prefix at `~/.local` (bin → `~/.local/bin`, conventionally on PATH), so no
  sudo is needed. `--force` keeps re-runs idempotent (overwrites stale bin links).
- `pi-acp` comes from the nested Trustable fork, based on upstream v0.0.31. The
  fork natively honors `PI_SKIP_VERSION_CHECK` and `PI_OFFLINE`, exposes
  versioned launch/activity metadata, includes extension commands, and bounds
  abort requests. `setup.sh` never falls back to the public npm adapter because
  that would silently remove those capabilities.
- API keys are not handled here — set them in `.env` (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `PI_API_KEY`; see `.env.example`).
- After running it, **restart the server** so the newly-installed binaries are on
  the server process's inherited PATH.

### The version manifest (`pi.version`)

`pi.version`, next to `setup.sh`, is the source of truth for npm-installed
packages and versions. The `pi-acp` adapter is the explicit exception: its
source revision is the nested `pi-acp` submodule and its package version is
recorded in that repository. This separation makes Trustable adapter changes
reviewable without publishing a replacement npm package.

Each line is a **literal npm install spec**, `<module>@<version>`. `#` comments
and blank lines are ignored:

```
@anthropic-ai/claude-code@2.1.216
@agentclientprotocol/claude-agent-acp@0.60.0
@openai/codex@0.144.6
@agentclientprotocol/codex-acp@1.1.4
@earendil-works/pi-coding-agent@0.80.10
pi-mcp-adapter@2.11.0
pi-web-access@0.13.0
```

**Every entry must be pinned.** An unpinned spec would silently resolve to latest
and defeat build reproducibility, so `setup.sh` rejects it and exits non-zero
instead of falling back. Detection strips the leading `@` of a scoped name before
looking for a version separator, so `@scope/name` is correctly read as unpinned
while `@scope/name@1.2.3` is pinned. A missing, empty, or comment-only manifest
is likewise a hard error.

The file is read relative to the *script's* directory, not the current directory,
so the pins apply in runtime-only mode too.

### Build and install phases

The two phases are gated **independently** — that is what makes the five-file
deployment above work:

| Working directory holds | Phase 2 (build) | Phase 3 (install) |
|---|---|---|
| `package.json` + sources | builds the bundle | installs what it built |
| a prebuilt `truacp.cjs` only | skipped | installs the prebuilt bundle |
| neither | skipped | skipped — agents only, exit **0** |

The build gate tests the **current** directory, so `cd trustable-acp &&
./setup.sh` builds while `./trustable-acp/setup.sh` from the parent does not. The
bundle lookup is the reverse: it prefers the **script's** directory
(`<script dir>/dist-bin/truacp.cjs`, then `<script dir>/truacp.cjs`) before the
current one, so a copied-out five-file set installs correctly regardless of the
invoking cwd. A missing bundle is not an error — it is the runtime-only mode.

With a `package.json` present, phase 2 runs `npm ci` (falling back to `npm
install`), then `npm run build:web` and `npm run build:server`. Because esbuild's
binaries are platform-specific, the build phase must run where they match — in
this project's setup, the `trudev` VM or the image build. Phase 3 has no such
constraint: it only copies a file and writes shell scripts.

## 10c. Web UI agent selection (`web/ChatApp.tsx`)

The chat UI connects to a default agent and lets the user switch:

- On load, the UI reads the server's **`defaultAgentId`** (`pi` by default, from
  `GET /api/agents`) and **auto-selects + connects** to it once — so a new session
  starts on pi with no manual pick. The auto-select fires only if that agent id is in
  the catalog, and only once (the user can freely switch afterward). Selecting the
  empty `Select agent` placeholder tears the chat back down to the disabled state.
- Until an agent is connected, the chat area is **disabled** and shows
  **"Please Select Agent"** (both as the empty-state message and the textarea
  placeholder).
- Selecting an agent from the pull-down (or the auto-select) **connects immediately**
  (`initialize` + `newSession`) — there is no separate Connect button. During the
  attempt the header shows "Connecting…"; on success it shows "● \<agent name\>" and
  the chat becomes writable.
- Agent, model, and configuration controls are disabled while a turn is active,
  because switching transports would make Stop target the wrong ACP session.
  Once idle, switching clears the prior turns/session/permission and reconnects.
- While Pi is active, the composer becomes a red **Stop** action. The adapter
  publishes `piAcp.activity` metadata and the UI shows its label plus elapsed
  time. This is activity, not a fabricated percentage: Pi does not expose a
  reliable total-work denominator.
- **New session** is the prominent, non-wrapping header action that creates a
  fresh session in the current cwd. **Sessions** lists resumable Pi sessions and
  loads the selected one through ACP `session/load`. The managed header does not
  render the launch-time cwd: an app is already scoped to its workbench and the
  absolute server path provides no useful user action.
- Each non-active session row has a separate `×` action. It asks for explicit
  confirmation, calls standard ACP `session/delete`, keeps failures visible in
  the modal, and removes the row only after Pi and TruACP metadata deletion both
  succeed. The current session cannot be deleted until another session is
  created or loaded.

### Trustable Pi ACP extensions

TruACP adds `_meta.trustable.piLaunch` version 1 to Pi `session/new` and
`session/load`. It enables normal extension/skill discovery without allowing
raw argv. The fork validates the version and converts only typed extension,
skill, prompt-template, and session-directory fields into discrete arguments.
Other ACP agents never receive this metadata.

In a Trustable-managed launch, TruACP also supplies the installed
`trustable-guardrails.ts` path through the typed extension list. The launcher,
not the browser, owns that path via `TRUSTABLE_PI_EXTENSION`. Pi loads the
extension before built-in tools execute; its `tool_call` hook blocks reads,
writes, edits, shell environment dumps, and programmatic access to credential
files or secret-bearing environment values. Template files such as
`.env.example` remain readable. This is a narrow data-loss-prevention boundary,
not a replacement for the removed OpenCode completion/recovery state machine.

The fork reports `_meta.piAcp.activity` version 1 on `session_info_update`.
`thinking`, `responding`, tool-specific states, `retrying`, `compacting`,
`stopping`, and `idle` remain control-plane UI state; retry/compaction text must
not be appended to the assistant transcript.

## 10d. Per-agent config & auth (gear panel)

Each agent is configured/authenticated through its **own native mechanism** (its
login CLI or config file) — there is no side-store; the server just drives those.
Configuration is surfaced **automatically on agent select** (standalone pi
probes `/models` and pops a form on failure; codex/claude check login and pop the
auth flow) and can be re-triggered anytime via a **⚙️ gear** in the header. In a
Trustable-managed runtime (`TRUSTABLE_MANAGED_RUNTIME=1`), Pi configuration is
owned by Trustable: failures and the gear direct the user to Trustable's main
Configure screen instead of opening the standalone credential form.

**Pi — try-then-ask, written to pi's native config.** Pi has no headless auth
CLI, and it does *not* honor `OPENAI_BASE_URL` (verified: it always hits
platform.openai.com). A custom OpenAI-compatible endpoint is configured through
pi's native `~/.pi/agent/models.json` and `auth.json`: the custom provider
(`local`) keeps endpoint/models plus a `$OPENAI_API_KEY` reference in models.json,
while the real credential lives only in auth.json. In managed mode, TruACP reads
the active `local`, `ollama`, or `trustable` provider from
`settings.json.defaultProvider`; pi-acp then discovers the same native
configuration.
The UI flow is **"try, then ask"**: on selecting pi, the server probes the
configured endpoint with `GET <baseUrl>/models` (`POST /api/pi/hello`) — a fast
reachability + auth check that avoids the multi-second hang a real completion can
cause on cold/large models (e.g. Ollama). If it lists models, the session starts.
If not, standalone mode opens a popup collecting **only Base URL + API key**;
`POST /api/pi/config/set` fetches `/models`, writes endpoint/models to
models.json and the key to auth.json, then retries the probe. The config GET API
never returns the stored key. Managed mode shows the Trustable Configure message
instead. (`server/pi-config.ts`.)

**Codex — ChatGPT device-code login.** Codex authenticates out-of-band via the
`codex` CLI (not via ACP). On selecting codex, the UI calls
`POST /api/codex/login-status` (runs `codex login status`); if not logged in it
calls `POST /api/codex/login-device`, which runs `codex login --device-auth`,
scrapes the verification **URL + one-time code** from stdout (ANSI-stripped), and
returns them. The popup shows both; the user authenticates in a browser and
clicks **"Ho completato"**, which re-checks `login status` and, on success,
creates the session. (`server/codex-login.ts`.)

**Claude — paste-code OAuth login.** On selecting claude, the UI calls
`POST /api/claude/login-status` (runs `claude auth status --text`). If an
`ANTHROPIC_API_KEY` is set, `loggedIn` is true (`hasApiKey`) and no login is
needed — claude connects directly. Otherwise, if not logged in, the UI calls
`POST /api/claude/login-start`, which runs `claude auth login`, scrapes the
authorize **URL** from stdout, and keeps the process alive with stdin open (the
CLI blocks on "Paste code here"). The popup shows the URL and a code input; the
user signs in, copies the code, and submits it — `POST /api/claude/login-complete`
writes it to the process's stdin and reports success / "Invalid code". Then the
session is created. (`server/claude-login.ts`.) Model/mode/effort remain exposed
via the `configOptions` API (§6) after `newSession`.

Note the two login shapes differ: **codex** is device-code (show URL + code, poll
via a "done" button), **claude** is paste-code (show URL, user pastes a code back).

**Model selector.** After a session is created, the header shows a model
dropdown next to the gear, populated from the session's `configOptions` (the
`select` option with category/id `model`) — available immediately after connect,
and refreshed on `config_option_update`. Changing it calls
`setSessionConfigOption(model, value)`. This is the standard ACP channel, so it
works for any agent that exposes model options (claude: Opus/Sonnet/Haiku; others
after their endpoint/login is configured).

For Pi, Trustable owns the provider boundary. The active provider is `trustable`
for the Trustable status catalog, `ollama` for embedded/status-backed Ollama,
or `local` for provided/custom endpoints. Pi settings contain only
`enabledModels: ["<active-provider>/*"]`, and the TruACP header retains only
option values with that same active prefix. Both controls are required because
pi-acp currently publishes Pi's full built-in provider catalog in
`configOptions` even when model cycling is scoped by `enabledModels`.

New REST endpoints: `POST /api/pi/hello`, `/api/pi/config/{get,set}`,
`/api/codex/login-status`, `/api/codex/login-device`,
`/api/claude/login-status`, `/api/claude/login-start`, `/api/claude/login-complete`.

## 10e. Change directory & new session (ACP-native)

The working directory (**cwd**) is the entire filesystem contract with an agent
(§4). Two runtime operations are exposed **by the trustable-acp server** (the local
Node server, `server/`) — driven from the browser UI over the same REST transport as
every other call (§6), without restarting the server: **changing the default project
directory** and **creating a new session in a chosen directory**. Both are handled
in the trustable-acp server's `routes.ts`/`session-host.ts` and drive the ACP core
directly — no agent-specific code path — so they work for any ACP agent the server
launches.

The `cwd` param is already threaded end-to-end (`routes.ts` `/api/session/{new,load,
resume,fork,list}` all read `body.cwd ?? host.projectDir()`; `transport.ts` methods
accept an optional `cwd`; `session-host.ts` `projectDir()` is the fallback).
Trustable's managed browser UI intentionally uses the single launch-time
`projectDir`: the enclosing application already selects the workbench.

### Change directory — default project cwd

- **`GET /api/directory`** → `{ dir: string }` — the server's current default cwd
  (`host.projectDir()`). The existing `GET /api/agents` also returns `projectDir`;
  this endpoint is the single-purpose read used by the picker.
- **`POST /api/directory`** `{ dir: string }` → `{ dir: string }` — validate that
  `dir` exists and is a directory (resolve relative paths against the server's
  invocation cwd, as `config-store.ts` `resolveProjectDir` does; reject with 400
  otherwise), then update the in-memory default cwd on the `SessionHost` so
  subsequent `initialize`/`newSession` calls that omit `cwd` use it. This does **not**
  `process.chdir()` the server process (that would move `config.json`/`.env`/
  `.acp-data` resolution) and does **not** rewrite `config.json` unless a `persist`
  flag is added later — it changes only the agent working directory.
- Changing the directory does **not** retro-fit live sessions (an ACP session's cwd
  is fixed at `session/new`). The UI should treat a directory change as a prompt to
  start a **new session** in that directory (below).

`SessionHost` gains a settable default cwd (replacing the read-only `projectDir()`
that today only reads config): `setProjectDir(dir)` updates the field consulted by
`initialize`/`newSession` fallbacks.

### New session in a chosen directory

- **`POST /api/session/new`** already accepts `{ agentId, cwd? }` and creates the
  session in `cwd ?? projectDir`, persisting `{sessionId, agentId, cwd, …}` to
  `.acp-data`. The change is purely to **have the UI pass `cwd`** when the user has
  picked a directory, rather than always falling back to the default.
- Under the hood `newSession(cwd)` issues the ACP `session/new` request with `{ cwd }`
  (`src/acp/acp-client.ts`); the agent creates a session rooted at that worktree.
  `session/load`/`resume`/`fork` likewise take the cwd so a
  reopened session resolves against the same directory it was created in.

### Managed UI (§10c connect flow)

- The Trustable-managed header does not display the absolute cwd. It is an
  internal server path, consumes scarce horizontal space, and cannot be changed
  meaningfully without leaving the workbench selected by the enclosing app.
- A prominent, non-wrapping **"New session"** action creates a new session in the
  launch-time workbench cwd. The server still retains its cwd-aware ACP APIs for
  standalone clients and session restoration.

### Verification

- `POST /api/directory {dir: "<path-A>"}` then `POST /api/session/new {agentId:
  "pi"}` → the session is created with cwd `<path-A>` and `.acp-data` records
  `cwd: "<path-A>"`.
- `POST /api/session/new {agentId: "pi", cwd: "<path-B>"}` → session created in
  `<path-B>` regardless of the default; a prompt that lists files reflects `<path-B>`.
- `POST /api/directory {dir: "/does/not/exist"}` → 400, default cwd unchanged.
- In the managed browser, the absolute cwd is absent from the header; start a
  "New session" and confirm a fresh session in the same workbench.
- Delete an inactive session from the list, confirm it disappears after
  confirmation and does not return after reopening the modal. Verify the active
  session delete control is disabled.

New REST endpoints: `GET /api/directory`, `POST /api/directory`.

## 11. Verification

- **Phase 1**: from a terminal, server spawns `claude` in a chosen cwd, completes `initialize`→`newSession`→`sendPrompt`, and streams `agent_message_chunk`s to stdout. Repeat for `codex` and `pi`.
- **End-to-end**: open `localhost:PORT`, start a chat, send a prompt, see streamed response + a tool call with diff, approve a permission, fork/resume a session, export to markdown. `config.json` alone (plus `.env`) fully configures agents, cwd, and display.
