# trustant-acp — Standalone ACP Client Specification

## 1. Goal

`trustant-acp` is a **standalone Agent Client Protocol (ACP) client** that:

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

In Trustant-managed mode the Node host also owns MCP selection. It validates a
credential-free workbench `.mcp.json` against the private mode-`0600`
`mcpConfig` named by the runtime manifest. Codex and Claude receive those
servers through ACP session parameters; Pi receives an empty ACP list and uses
its managed proxy plus credential-free launcher descriptors. Generic
`config.json` and browser requests cannot add commands.

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
  claude-install.ts      # claude: on-demand install after accepting Anthropic's terms (§10d)
  claude-version.ts      # claude: pinned npm specs for that install
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
      "command": "claude-agent-acp", "args": [],     // overridden at spawn: always the on-demand install (§10d)
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
- `POST /session/delete` sends the standard ACP `session/delete` JSON-RPC
  request through the generic request API because compatible SDK builds do not
  consistently expose the optional generated helper. TruACP clears its metadata
  only after the owning agent confirms deletion.
- `POST /session/:id/prompt`, `/session/:id/cancel`, `/session/:id/config-option`, `/session/:id/mode`
- `POST /api/session/shell` `{ sessionId, command }` executes an explicit
  user `!` command directly in the active session cwd. The server derives cwd
  from live session state; the browser cannot supply or override it.
- `GET /api/directory` (current default cwd), `POST /api/directory` (change default cwd) — see §10e.
- `POST /permission/:id` (approve/reject)
- `GET/PUT /config`
- `GET/DELETE /sessions/history/:id`, `POST /export`
- `GET /mentions/search?q=`, `GET /mentions/read?path=` (project-dir-scoped)
- `GET /update-check`

**Client shim** (`web/acp-transport.ts`) exposes the same method names `hooks/*` already call, so `useAgent`, `useAgentSession`, `useAgentMessages`, `useSessionHistory` are largely untouched. The shim subscribes to the WS and re-emits through the existing `onSessionUpdate` listener set.

## 7. UI

- **Icons**: `lucide-react`; `IconButton.tsx`/`LucideIcon` is the single wrapper, decoupling ~10 components at once.
- **Toasts / menus / dropdowns / modals**: React toast component; React menu/dropdown; React `Modal` subclasses (`ChangeDirectoryModal`, `EditTitleModal`, `SessionHistoryModal`). `ChangeDirectoryModal` is backed by the trustant-acp server's `POST /api/directory` and starts a new session in the chosen cwd — see §10e.
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
     launching the app from the Trustant UI. The message lists what *is* present in
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

### Managed MCP lifecycle and redaction

`TRUSTANT_RUNTIME_CONFIG` version 2 identifies a private `mcpConfig` outside
the workbench. Its names must exactly match the credential-free `.mcp.json`.
For Codex and Claude, `session/new`, `session/load`, `session/resume`, and
`session/fork` carry the converted stdio/HTTP entries. Pi continues to use
`pi-mcp-adapter`; secret-bearing stdio descriptors call the fixed
`trustant-mcp-launch` host launcher.

Only one agent process remains initialized. Selecting another agent disconnects
the previous process tree first, which also closes its persistent MCP servers.

TruACP removes host config paths and service credential variables from the
general Codex/Claude process environment. MCP values are injected only into the
selected MCP child. Known values, sensitive fields, and credential-bearing URIs
are recursively redacted from session updates and direct-shell REST results
before browser display or persistence. The Pi policy extension additionally
blocks direct reads or shell inspection of the private MCP config.

Service isolation remains inside the selected MCP process rather than in agent
prompts. The private Redis descriptor launches `trustant-redis-mcp`, which
qualifies reviewed key, scan, channel, and index arguments with the
application's private prefix and rejects global or unknown operations. The
private S3 descriptor names its environment-derived primary connection
`default`. Pi, Codex, and Claude therefore receive the same isolation and
connection semantics through their different ACP/proxy delivery paths.

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
`setup.sh` to install the bundle and generate the `truacp` and `trustant-acp`
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
   install the pinned nested Trustant `pi` and `pi-acp` forks. npm extension
   pins live in `pi.version`; fork revisions are pinned by nested Git
   submodules.
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
pi-packages/*.tgz + extensions/trustant-runtime.ts
```

it installs a complete, working truacp into `~/.local/bin` — no `package.json`,
no `node_modules`, no secondary installer, and no network beyond npm for the
remaining agents. Source mode builds the nested fork; image mode supplies the
tarball produced from that same source revision. Phase 3 is the only launcher
implementation, so source, VM, and image runtimes cannot drift.

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
| Claude Code | `@anthropic-ai/claude-code` (`claude`) | `@agentclientprotocol/claude-agent-acp` — **not installed by setup.sh**, see §10d |
| Codex | `@openai/codex` (`codex`) | `@agentclientprotocol/codex-acp` |
| Pi | nested `trustable-ai/pi` fork (`pi`) | nested `pi-acp` fork |

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
- The pinned `pi-mcp-adapter@2.11.0` is patched deterministically after
  registration. A Streamable HTTP `Session not found` response closes only the
  stale connection, reconnects to refresh tools/resources, and retries the
  original tool call exactly once. Proxy, direct-tool, and MCP UI paths use the
  same manager recovery. Setup validates the exact version and every source
  target before writing, remains idempotent, and fails closed on source drift.
- `@zed-industries/codex-acp` is deprecated; config and this script use the
  maintained `@agentclientprotocol/codex-acp` (same `codex-acp` bin, drop-in).
- The script installs into npm's global prefix when writable, else falls back to a
  user prefix at `~/.local` (bin → `~/.local/bin`, conventionally on PATH), so no
  sudo is needed. `--force` keeps re-runs idempotent (overwrites stale bin links).
- `pi-acp` comes from the nested Trustant fork, based on upstream v0.0.31. The
  fork natively honors `PI_SKIP_VERSION_CHECK` and `PI_OFFLINE`, exposes
  versioned launch/activity metadata, includes extension commands, and bounds
  abort requests. `setup.sh` never falls back to the public npm adapter because
  that would silently remove those capabilities.
- The Pi CLI, agent core, AI, TUI, and SQLite session-storage packages come from the nested
  `trustable-ai/pi` fork at the pinned upstream-compatible version. Source/VM
  mode builds all five tarballs; image mode consumes those exact artifacts.
  Installing the public coding-agent package is forbidden because stream-loop
  protection lives below ACP in the owned core.
- The Trustant local-release build compiles the checked-in Pi model catalogs.
  It does not refresh them from models.dev, OpenRouter, NVIDIA, or other live
  catalogs while packaging an unchanged commit. Catalog refresh remains an
  explicit upstream/release-maintenance action, so VM and image builds are
  deterministic and cannot acquire an incompatible provider schema mid-build.
- Source/VM and image packaging hydrate the nested Pi fork with `npm ci
  --ignore-scripts`. The explicit local-release command owns its build; repository
  lifecycle hooks such as Husky are not runtime prerequisites and may otherwise
  follow a worktree `.git` pointer into host-only Git administration paths that
  are deliberately unavailable inside Lima, WSL, or an image builder.
- API keys are not handled here — set them in `.env` (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `PI_API_KEY`; see `.env.example`).
- After running it, **restart the server** so the newly-installed binaries are on
  the server process's inherited PATH.

### The version manifest (`pi.version`)

`pi.version`, next to `setup.sh`, is the source of truth for npm-installed
packages and versions. The `pi-acp` adapter is the explicit exception: its
source revision is the nested `pi-acp` submodule and its package version is
recorded in that repository. This separation makes Trustant adapter changes
reviewable without publishing a replacement npm package.

Each line is a **literal npm install spec**, `<module>@<version>`. `#` comments
and blank lines are ignored:

```
@openai/codex@0.144.6
@agentclientprotocol/codex-acp@1.1.4
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

The build gate tests the **current** directory, so `cd trustant-acp &&
./setup.sh` builds while `./trustant-acp/setup.sh` from the parent does not. The
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
- Pi's startup prelude follows the same boundary: `AGENTS.md` remains active
  project context, but its absolute path and a redundant **Context** section are
  not rendered into the browser conversation.
- Each non-active session row has a separate `×` action. It asks for explicit
  confirmation, calls standard ACP `session/delete`, keeps failures visible in
  the modal, and removes the row only after Pi and TruACP metadata deletion both
  succeed. The current session cannot be deleted until another session is
  created or loaded.
- The standalone composer recalls user prompts from the current or restored
  session with `ArrowUp`/`ArrowDown`. It preserves the unfinished draft and
  does not intercept selection, IME/modifier input, or ordinary multiline
  cursor movement.
- In a ready session the composer placeholder is exactly **"Message the agent
  or use the '!' to execute shell commands."** A trimmed submission whose first
  character is `!` bypasses ACP and every agent, while embedded `!` characters
  remain ordinary prompt text. The browser sends only the active `sessionId`
  and command to `POST /api/session/shell`; Node runs it in the cwd recorded
  when that session was created/loaded/resumed/forked. The user command and a
  separate shell result turn are both visible in the conversation.
- Shell execution uses the platform shell with stdin closed, a 30-second
  timeout, a 256 KiB combined stdout/stderr capture limit, process-tree
  termination, explicit timeout/truncation/nonzero-exit rendering, and a
  credential-filtered child environment. Transport and server logs never
  serialize the host environment. The browser imports no Node process API.
- Transcript text remains selectable. User and assistant turns expose a copy
  action, and rendered code blocks expose their own copy action. Message copy
  uses the original Markdown; the browser uses `navigator.clipboard` when
  available and a click-triggered fallback on Trustant's HTTP `*.nip.io`
  development route. Success and failure are visible instead of silently
  swallowing clipboard errors.
- Tool rows preserve the raw ACP status in their DOM metadata and tooltip while
  deriving a separate display status from deterministic timeline evidence. A
  later successful call in the same tool family changes an earlier failure to
  muted **recovered**; the known React validator reports **issues found** in
  amber; an active unresolved attempt reports **attempt failed** in amber; only
  an unresolved failure after the run becomes idle remains red **failed**.
  Classification never reads free-form assistant prose and does not assume
  that an arbitrary non-zero shell search means "no results".

### Trustant Pi ACP extensions

TruACP adds `_meta.trustant.piLaunch` version 1 to Pi `session/new` and
`session/load`. It enables normal extension/skill discovery without allowing
raw argv. The fork validates the version and converts only typed extension,
skill, prompt-template, and session-directory fields into discrete arguments.
Other ACP agents never receive this metadata.

The typed contract is the transport for extensions selected by a trusted
server-side configuration. Browser requests cannot inject extension paths.

In a Trustant-managed runtime, issue #57 adds a versioned host contract.
TruACP reads `TRUSTANT_RUNTIME_CONFIG`, validates its canonical workbench,
exact credential-free `.mcp.json`, private `mcpConfig`, local development URL,
browser-visible application URL, private watcher log, and the extension selected by
`TRUSTANT_PI_EXTENSION_PATH`, then includes
only that validated path in `piLaunch.extensions.paths`. The manifest uses the
version-2 `workbenches` envelope. Managed mode fails
closed if the contract is absent, malformed, stale, or does not cover the
requested session cwd.
Standalone TruACP retains normal Pi discovery without requiring this manifest.

`setup.sh` installs the self-contained extension at
`~/.local/lib/truacp/extensions/trustant-runtime.ts`. The extension
revalidates the contract inside Pi, injects the host context before each turn,
blocks `write`/`edit` outside the selected workbench, and registers the
read-only `trustant_runtime_status` tool. The tool returns a bounded, redacted
tail of the host-owned `ops ide devel` log, so deployment diagnosis uses
evidence instead of guessed paths or process polling. In managed live mode the
extension also rejects shell inspection/polling of `packages/**/*.zip`, masked
checker pipelines, and a second checker call without an intervening source or
OpenServerless-wiring mutation.

The same managed extension treats target-workbench `.env` and
`.env.production` as immutable: Pi cannot read, write, edit, or inspect them
through shell, and the environment-mutating `secret_ensure` MCP call is
rejected. Only the enclosing Trustant configuration UI owns application env
values. The corrected OpenServerless `auth_setup` remains available because it
atomically adds Redis wiring to the complete token/protected/logout endpoint
set without reading or writing `.env`. The host prompt requires Redis-backed
opaque sessions for generated application authentication and deterministic
`react_validate` after frontend mutations.

The extension rejects direct writes to generated `packages/**/__main__.py`
wrappers and `packages/**/*.zip` deploy artifacts. It also rejects mutating
service-MCP operations such as PostgreSQL `execute_sql`, while retaining
read-only service discovery and verification. Schema, migration, seed, and app
writes must therefore remain reproducible in setup or public OpenServerless
actions instead of repairing only the live service state.

The nested Pi fork detects repeated normalized prose inside one streamed
provider response. It aborts that pathological response below ACP. It does not
impose a provider-step or turn budget; healthy runs exceeding 300 turns remain
valid.

The managed extension normalizes the real `pi-mcp-adapter` proxy contract,
including full tool names such as `openserverless_action_new`, JSON-string
`args`, and both server-discovery shapes: `mcp({server:"..."})` and
`mcp({connect:"..."})`. Before application work it requires proof that the MCP
proxy is reachable and successful discovery for every server named by the
managed manifest. A successful `connect` supplies both proxy-reachability
evidence and discovery evidence for that server; the compatible
`mcp({})` plus per-server `server` sequence remains valid. It blocks raw
action/service administration, direct service clients,
manual action scaffold/wrapper generation, ad-hoc dependency installation,
service-MCP writes, shell-based `src/`/`packages/` writes, destructive Git
recovery, and piecemeal Redis wiring for authentication endpoints.
Only successful tool results advance bootstrap, checker, React-validation, and
source-revision state. After three semantically equivalent failures without a
successful relevant source or OpenServerless-wiring mutation, the same strategy
is rejected until the model changes its hypothesis/inputs or makes real
progress. Durable workflow recovery and completion evidence remain later issue
#57 increments.

The fork reports `_meta.piAcp.activity` version 1 on `session_info_update`.
`thinking`, `responding`, tool-specific states, `retrying`, `compacting`,
`stopping`, and `idle` remain control-plane UI state; retry/compaction text must
not be appended to the assistant transcript.

## 10d. Per-agent config & auth (gear panel)

Each agent is configured/authenticated through its **own native mechanism** (its
login CLI or config file) — there is no side-store; the server just drives those.
Configuration is surfaced **automatically on agent select** (standalone pi
probes `/models` and pops a form on failure; codex/claude check login and pop the
auth flow) and can be re-triggered via a **⚙️ gear** in the header. In a
Trustant-managed runtime (`TRUSTANT_MANAGED_RUNTIME=1`), Pi configuration is
owned by Trustant, so the redundant Pi gear is hidden and failures direct the
user to Trustant's main Configure screen. Standalone Pi keeps its gear, while
Codex and Claude keep their login-renewal gears.

**Pi — try-then-ask, written to pi's native config.** Pi has no headless auth
CLI, and it does *not* honor `OPENAI_BASE_URL` (verified: it always hits
platform.openai.com). A custom OpenAI-compatible endpoint is configured through
pi's native `~/.pi/agent/models.json` and `auth.json`: the custom provider
(`local`) keeps endpoint/models plus a `$OPENAI_API_KEY` reference in models.json,
while the real credential lives only in auth.json. In managed mode, TruACP reads
the active `local`, `ollama`, or `trustant` provider from
`settings.json.defaultProvider`; pi-acp then discovers the same native
configuration.
The UI flow is **"try, then ask"**: on selecting pi, the server probes the
configured endpoint with `GET <baseUrl>/models` (`POST /api/pi/hello`) — a fast
reachability + auth check that avoids the multi-second hang a real completion can
cause on cold/large models (e.g. Ollama). If it lists models, the session starts.
If not, standalone mode opens a popup collecting **only Base URL + API key**;
`POST /api/pi/config/set` fetches `/models`, writes endpoint/models to
models.json and the key to auth.json, then retries the probe. The config GET API
never returns the stored key. Managed mode shows the Trustant Configure message
instead. (`server/pi-config.ts`.)

**Codex — ChatGPT device-code login.** Codex authenticates out-of-band via the
`codex` CLI (not via ACP). On selecting codex, the UI calls
`POST /api/codex/login-status` (runs `codex login status`); if not logged in it
calls `POST /api/codex/login-device`, which runs `codex login --device-auth`,
scrapes the verification **URL + one-time code** from stdout (ANSI-stripped), and
returns them. The popup shows both; the user authenticates in a browser and
clicks **"Ho completato"**, which re-checks `login status` and, on success,
creates the session. (`server/codex-login.ts`.)

**Claude — on-demand install behind Anthropic's terms.** Claude Code is
proprietary (Anthropic Commercial Terms, no redistribution grant), so it is
never in `pi.version`, never installed by `setup.sh`, and never in the published
image. On selecting claude the UI first calls `POST /api/claude/install-status`
→ `{ installed, accepted, specs, termsUrl, prefix }`. If not installed, an
**Install Claude Code** modal links to
<https://www.anthropic.com/legal/commercial-terms> (opened in a new tab:
anthropic.com sends `X-Frame-Options: SAMEORIGIN` / `frame-ancestors 'self'`, so
an iframe would render blank), lists the pinned packages, and enables
**Accept and install** only once the acceptance checkbox is ticked. That calls
`POST /api/claude/install` with `{ "accept": true }` — refused for anything else —
which writes `<prefix>/license-accepted.json` (`termsUrl`, `acceptedAt`, `specs`)
and runs `npm install --prefix <prefix>` with the pins in
`server/claude-version.ts` (single-flight; a failed install removes the partial
`node_modules`). Cancel leaves no agent selected. After install the normal login
flow below continues.

The prefix is `$TRUACP_CLAUDE_PREFIX` (default `~/.local/share/truacp/claude`);
Trustant points it at its persistent workspace volume. "Installed" means every
pin is present **at its pinned version**, so bumping a pin asks again. The claude
agent always spawns `<prefix>/node_modules/.bin/claude-agent-acp` with
`CLAUDE_CODE_EXECUTABLE=<prefix>/node_modules/.bin/claude`, whatever
`config.json` says — an `npx -y` entry would otherwise fetch an unpinned copy and
bypass the terms — and `initialize` fails with "Claude Code is not installed"
when the install is missing. `claude-login.ts` likewise uses the installed
`claude` (unless `CLAUDE_COMMAND` is set), never one found on PATH.

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

**Reasoning effort selector.** After the session advertises `configOptions`, the
header also shows a managed **Reasoning effort** selector for any agent exposing
a `select` option with ACP category `thought_level`. The category is
authoritative; `thought_level` (Pi), `reasoning_effort` (Codex), and `effort`
(Claude) are accepted compatibility ids. The managed UI deliberately exposes
only **High** (`high`) and **Extra high** (`xhigh`), defaults to `high` when no
valid per-agent value was saved, and sends the selected value through the
option's real id with `setSessionConfigOption`. `xhigh` is shown only when the
active agent/model advertises it: TruACP never reports Extra high while silently
downgrading the agent. A model change immediately re-evaluates the option because
reasoning capabilities are model-specific. New, loaded, resumed, and reconnected
sessions restore the last valid effort separately for each agent; values never
leak between Pi, Codex, Claude, or a custom agent. Like other configuration
controls, the selector is disabled during an active turn.

**Pi Thinking selector (managed runtime).** For Pi under the Trustant managed
runtime (`hello.managed`), the header shows a **Thinking** selector instead of
the Reasoning effort selector, with the values `none`, `true`, `false`, `low`,
`medium`, `high`, defaulting to `true`. The managed `high` reasoning default is
still applied to Pi's `thought_level` at session start, so `true` preserves the
existing behaviour. The value is persisted per browser
(`truacp.pi-thinking.v1`), sent with `POST /api/pi/thinking { think }` whenever a
Pi session becomes ready and on every change, and rejected with 400 unless it is
one of the six values. The server writes it to a per-process state file whose
path reaches Pi as `TRUSTANT_THINK_FILE`. The managed extension re-reads that
file in `before_provider_request`, so a change applies to the next provider
call without restarting Pi, and it rewrites only `reasoning_effort` in
chat-completions payloads:

| Thinking | `reasoning_effort` |
|---|---|
| `none` | removed, never sent (even when Pi computed one) |
| `true` (default, also for a missing/invalid file) | left exactly as Pi computed it |
| `false` | `"none"` |
| `low` / `medium` / `high` | that value |

`think` is never sent: Pi always uses the OpenAI chat-completions API, and
Ollama's `/v1` ignores `think`, whereas `reasoning_effort` is honoured. The
selector exists because GLM on Ollama intermittently returns its tool calls as
raw `<arg_key>…</tool_call>` text while thinking is on; `false` avoids it.

The owned Pi adapter derives its `thought_level` choices from Pi's active model
metadata rather than publishing a fixed list. A model with `reasoning !== true`
offers only `off`. A reasoning model supports the standard levels through
`high` unless a `thinkingLevelMap` entry explicitly disables one; extended
`xhigh` is advertised only when `thinkingLevelMap.xhigh` exists and is
non-null. This keeps the ACP response aligned with Pi's real clamping behavior
and prevents the managed default from producing a false compatibility error.

Pi's `get_available_thinking_levels` is the primary source for that list; the
model metadata above is the fallback when a Pi build does not answer it, and
the historical fixed list is used only when neither source is readable. Levels
Pi reports outside the adapter's ACP surface are never advertised. The current
value is always one of the advertised choices, and a `thought_level` change
reports the level Pi actually applied rather than the level requested, so a
client that verifies the echo cannot be told a clamped effort was honored.

**Managed deployment ownership.** When Trustant supplies the versioned runtime
manifest, its Pi extension states that the existing `ops ide devel` watcher is
the sole owner of live action packaging/deployment. The extension rejects Pi
`bash`/`shell` calls whose executable segment starts `ops ide deploy` or
`ops ide devel`, including `timeout ... ops ide deploy` after `cd`, while
allowing read-only commands that merely search for that text. This narrow
deterministic guard prevents concurrent deploy processes and timeout-escalation
loops. The same guard rejects direct shell access to watcher-owned action ZIPs,
checker output masking, and repeated checker calls for an unchanged revision.
After one or more successful OpenServerless `action_new` creations, Pi finishes
the coherent action/wiring/source batch and calls the extension-owned
`trustant_runtime_redeploy` tool exactly once. That tool invokes the co-located
Trustant `/api/redeploy` SSE workflow used by the UI, which safely stops the
watcher, runs the full deploy, and restarts the watcher. Until it succeeds, the
extension blocks watcher status, checker, HTTP, and browser verification while
still allowing the coherent batch to finish. A compatible idempotent
`action_new` no-op does not require redeploy. Pi then reads watcher status, runs
one source-contract checker pass, and verifies real HTTP endpoints.

**Managed autonomous mode for Codex and Claude.** Before the first prompt can be
sent after selecting, creating, loading, resuming, or reconnecting one of these
agents, TruACP applies and verifies the no-prompt mode advertised through ACP
`configOptions`: Codex uses `agent-full-access` and Claude uses
`bypassPermissions`. Their narrower `agent` / `acceptEdits` modes are not
sufficient: the adapters may still request approval for ordinary shell commands
such as reading a source file. TruACP resolves the real mode option by ACP
category/id and must surface a compatibility error instead of silently
continuing in a prompted or read-only mode when the required value is absent.
Global `permissions.autoAllow` remains `false`; the full-permission decision is
explicit and agent-specific rather than approving arbitrary permission requests
from custom agents. In a Trustant-managed deployment, the VM or pod is the
isolation boundary for these autonomous agents. Custom agents keep their
advertised/default permission behavior.

For Pi, Trustant owns the provider boundary. The active provider is `trustant`
for the Trustant status catalog, `ollama` for embedded/status-backed Ollama,
or `local` for provided/custom endpoints. Pi settings contain only
`enabledModels: ["<active-provider>/*"]`, and the TruACP header retains only
option values with that same active prefix. Both controls are required because
pi-acp currently publishes Pi's full built-in provider catalog in
`configOptions` even when model cycling is scoped by `enabledModels`.

New REST endpoints: `POST /api/pi/hello`, `/api/pi/config/{get,set}`,
`/api/codex/login-status`, `/api/codex/login-device`,
`/api/claude/install-status`, `/api/claude/install`,
`/api/claude/login-status`, `/api/claude/login-start`, `/api/claude/login-complete`.

## 10e. Change directory & new session (ACP-native)

The working directory (**cwd**) is the entire filesystem contract with an agent
(§4). Two runtime operations are exposed **by the trustant-acp server** (the local
Node server, `server/`) — driven from the browser UI over the same REST transport as
every other call (§6), without restarting the server: **changing the default project
directory** and **creating a new session in a chosen directory**. Both are handled
in the trustant-acp server's `routes.ts`/`session-host.ts` and drive the ACP core
directly — no agent-specific code path — so they work for any ACP agent the server
launches.

The `cwd` param is already threaded end-to-end (`routes.ts` `/api/session/{new,load,
resume,fork,list}` all read `body.cwd ?? host.projectDir()`; `transport.ts` methods
accept an optional `cwd`; `session-host.ts` `projectDir()` is the fallback).
Trustant's managed browser UI intentionally uses the single launch-time
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

`SessionHost` also records the resolved cwd for every successful new/load/resume/
fork operation. Direct shell mode accepts only the currently active session id
and resolves its cwd from this host-owned mapping; a stale or unknown session is
rejected instead of falling back to the default directory.

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

- The Trustant-managed header does not display the absolute cwd. It is an
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
- For Pi, Codex, and Claude, verify the reasoning selector exposes only the
  advertised subset of `high`/`xhigh`, persists independently per agent, and
  sends the real adapter config id. Change model and confirm the choices are
  reconciled without a silent downgrade.
- For managed Pi, verify the Thinking selector replaces the reasoning selector,
  defaults to `true`, survives a reload, and that each value produces the
  `reasoning_effort` in the table above on the next provider request.
- For Codex, verify session readiness applies `agent-full-access`; for Claude,
  verify it applies `bypassPermissions`. Reading files, running ordinary shell
  commands, and modifying the workbench must not create permission prompts.
- In each supported agent session submit `!pwd`, stdout/stderr, and a nonzero
  command. Confirm no agent prompt is emitted, the resolved cwd is the active
  project, command/result remain visible in the conversation, and timeout,
  truncation, stderr, and exit status are explicit.

New REST endpoints: `GET /api/directory`, `POST /api/directory`.

## 10f. GitHub-backed template workflows

The browser can load an ordered prompt template into an existing ACP session.
The model/parser/reducer live in `src/types/notebook.ts` and
`src/services/notebook.ts`; the GitHub Contents API client lives exclusively on
the Node server in `server/notebook-github.ts`, and the local `template.md`
fallback in `server/notebook-local.ts`.

The user-visible name of this feature is **Templates**; `notebook` remains the
wire name for types, routes, environment variables, CSS classes, and the session
sidecar, so existing workspaces and persisted sessions keep working unchanged.

The default source is `trustable-ai/templates` on `main`. In managed mode,
Trustant's main Configure screen owns repository/ref and write access, then
launch injects `NOTEBOOK_GITHUB_REPOSITORY`, `NOTEBOOK_GITHUB_REF`, and
`NOTEBOOK_GITHUB_TOKEN` only into the TruACP process. Managed APIs ignore
browser-authored source overrides. The panel displays the active source
read-only with a Refresh action.

Public reads need no credential. Writes use
`process.env.NOTEBOOK_GITHUB_TOKEN`; the browser receives only `hasToken` and
never displays a token field. The source branch is explicit, paths are validated
repository-relative Markdown paths, and every mutation checks the loaded SHA
before sending it to GitHub. File/index operations are separate commits and
report partial completion explicitly. Standalone TruACP keeps the public
defaults when managed source variables are absent.

### The workbench working copy

A template is edited as `template.md` at the root of the launched application's
workbench checkout. GitHub is the catalog it is copied from and saved back to;
the working copy is what the session actually runs and edits, so a template
travels with the application and is published with it.

The file carries front matter recording its provenance:

```
---
name: Build
repo: trustable-ai/templates
file: flows/build.md
edited: false
---

first prompt

---

second prompt
```

All four keys are always emitted, in this order, even when empty — an explicit
blank `name:` is how a template started from pinned chat records that it has no
origin yet. Unknown keys are preserved across a round trip.

`repo` is **informational**. It records where a copy came from so the origin
stays visible, but it never selects a write destination: save-back resolves the
repository through the managed source, so a template file can never redirect an
authenticated write. Under a managed runtime the recorded repository is
therefore overridden by the configured one, and the response reports the
repository actually written.

`edited` is the definition of "changed" — set by any local edit, cleared by a
successful save back to GitHub. It is never a content comparison, and a client
cannot clear it: `save-local` forces it true, and only a successful upstream
save clears it.

Front matter must be split from the body **before** prompt parsing. The block
delimiter and the prompt separator are the same `---` token, so the block can
only be identified positionally, as a strict file prefix; handing a
front-mattered document straight to the prompt splitter silently turns the
metadata into the first prompt.

The local file name is a server constant, never request data — in particular
`file` records an origin path inside the template repository and is never joined
onto a filesystem path. Staging is best-effort and deliberately stops at
`git add`: the application's own save already commits and pushes, so the
template rides along instead of producing commits the user did not ask for.

Selecting a catalog entry copies it into the workbench in one hop, server-side,
recording provenance from the source the service actually fetched. Replacing a
working copy that has unsaved edits is refused unless confirmed.

A repository without a write token cannot be published to. The catalog still
reads and the working copy still saves locally, so only the upstream controls
are withheld: per-entry remove and the Save to GitHub button. No warning banner is shown; an unhighlighted note reads *"add in
configuration your github token to edit templates"*. The changed highlight
appears regardless of the token, because that is how the user learns their edits
are local-only.

REST endpoints are `POST /api/notebooks/{index,load,select,remove,local}` and
`PUT /api/notebooks/{save-local,save-template}`. `save-template` takes the name
and file only — prompts are read from `template.md` server-side, so a stale
client cannot publish content the workbench never held, and it updates the
README index when a template is added or renamed. There is no add endpoint:
`save-template` creates and indexes a template whose file does not exist, so
creation has exactly one path, and renaming happens in place. Session notebook state is
persisted through `POST /api/sessions/notebook/get` and
`PUT /api/sessions/notebook` as a whitelisted sidecar under `.acp-data`; it
contains notebook/ad-hoc nodes, execution outputs, selection, dirty state, and
the provenance block, but no credentials. A fork copies this sidecar. New
sessions start without one.

Notebook nodes use the existing `/api/session/prompt` path. Node execution
advances to the next persisted node exactly once; ad-hoc input is inserted
before selection without advancing; pin promotes it into the persisted save
set. The final node clears selection. Ordinary chats follow the pre-existing
path whenever no notebook is loaded.

A template can also start from nothing. With none loaded there are no ad-hoc
nodes to pin, so each of the user's own chat messages carries a pin action —
labelled **New template** when none is loaded and **Add to template** when one
is, since pinning is now the only way a template is created:
the first pin creates an unnamed working copy, converts that message into the
first step, and switches the conversation into template mode. The message's
assistant reply is carried across so pinning does not discard what the step
produced.

**Run all** runs every step from the current selection to the end, awaiting each
one because they share a single ACP session. Ad-hoc unpinned inputs are skipped,
each step's prompt is re-read at execution time so a mid-run edit takes effect,
and a failed step ends the run instead of firing the remainder into a broken
session.

**Stop aborts the whole run**, not merely the in-flight step. The composer Stop
button (§ "Composer") is the single control and stays available in the gap
between two steps, where no turn is running but the sequence is still live.
Selection remains on the stopped step so Run all resumes from there, and no
error banner is shown — a deliberate stop is not a failure.

The run loop cannot rely on the step's own outcome to detect this: a cancelled
turn resolves successfully (`agent.ts` returns `{stopReason:'cancelled'}` as a
normal result, and `acp-client.ts` swallows abort errors). The browser therefore
records the cancel intent locally when Stop is pressed. That is strictly more
reliable than plumbing `stopReason` through the wire — which is discarded at
three layers today — and it keeps the server contract untouched.

Notebook cards show a bounded task title derived from the first Markdown
heading or meaningful line. Full prompt text is collapsed under **Task
details**. Each card carries its run state — pending, running, or already run —
on its left edge and as a named badge. A step counts as run when it has output,
so the distinction survives a session resume; a re-run reads as running rather
than as already run. State is named as well as coloured and the running pulse is
suppressed under reduced-motion, and selection stays a ring so the two signals
never share a visual channel. Editing is in place: **Edit** replaces the card body with a prompt
editor plus **Save**/**Cancel**, leaving the composer free for ad-hoc input.
Save writes the working copy through and marks it edited; it does not run the
step. Editing is write-through — every mutation of the persisted prompt set
reaches disk when it is made, so durability never depends on a panel button.
Assistant output is visually primary, while tool calls share a
scrollable activity window with three visible rows that follows the latest
operation without dropping history. Notebook tool rows use the same
deterministic recovered/validator/active/terminal display projection as the
ordinary chat timeline. These are presentation-only projections of the
existing node and output state; the persisted ACP status is unchanged.

Tool titles and statuses are display-only ACP adapter metadata. ChatApp and the
server sidecar boundary normalize missing, non-string, empty, or oversized
values to bounded fallback strings, so one malformed tool event cannot reject
the complete notebook state. Structural node and tool-call IDs remain strict.

The complete product contract is [spec/notebook.md](../spec/notebook.md).

## 11. Verification

- **Phase 1**: from a terminal, server spawns `claude` in a chosen cwd, completes `initialize`→`newSession`→`sendPrompt`, and streams `agent_message_chunk`s to stdout. Repeat for `codex` and `pi`.
- **End-to-end**: open `localhost:PORT`, start a chat, send a prompt, see streamed response + a tool call with diff, approve a permission, fork/resume a session, export to markdown. `config.json` alone (plus `.env`) fully configures agents, cwd, and display.

## Upstream Pi runtime ownership (issue #71)

This section supersedes earlier fork-specific Pi packaging language. Trustant
uses the exact upstream `@earendil-works/pi-*` `0.82.0` package set recorded in
`pi.version`; `setup.sh` must verify each reviewed SHA-512 value from
`pi.integrity` before installation. The ACP repository must not contain a `pi`
gitlink, build the Pi source tree, accept prebuilt `pi-packages`, or fall back to
an unpinned registry release. The separately owned `pi-acp` fork remains pinned
because it supplies Trustant's ACP launch and lifecycle behavior.

Trustant-specific repeated-stream protection belongs to
`extensions/trustant-runtime.ts`, using upstream Pi's `message_update`,
`message_end`, and `ctx.abort()` extension contracts. Four occurrences of one
normalized 32-word window within a single assistant text response abort the
active provider run and finalize that assistant message with an explicit error.
The detector resets for each assistant response. It must not impose a global
turn, tool-call, or provider-step budget; healthy runs beyond 300 turns remain
valid.

Both clean `trudev` setup and production image setup consume the same
`pi.version`, `pi.integrity`, managed extension, and pinned `pi-acp` artifact.
No build may depend on a local Pi checkout, unpublished object, cached tarball,
or developer-machine path.
## Header connection state

- `Connecting...` describes only the interval before ACP exposes a usable
  session.
- Once the session is ready, the header remains connected while prompts,
  notebook nodes, tools, or other general UI work are busy.

## Streaming chat scroll

- New streamed output follows the bottom only while the reader is already
  within 80 pixels of it.
- Scrolling upward preserves the reader's position across subsequent text,
  reasoning, tool, permission, and notebook updates.
- Returning near the bottom re-enables output following automatically.

## Header actions

- TruACP renders configuration, new-session, session-history, notebook, and
  run-next actions as compact icon buttons.
- Every icon action exposes the same descriptive accessible label through
  `aria-label` and one native `title` tooltip. No second CSS tooltip is rendered.
- Icon-only presentation does not change action availability, disabled state,
  or click behavior.

## Guided-tutorial bridge (`web/tour-bridge.ts`)

The Trustant host embeds this UI in an iframe served from a different
hostname, so its guided tutorials cannot read this document. The bridge closes
that gap for the duration of a tutorial and only then:

- The host posts `{source: "trustant-tour-host", type: "start" | "stop" |
  "scroll"}` to the frame. Messages from any window other than the direct parent
  are ignored.
- While started, the frame posts `{source: "trustant-tour-frame", type:
  "frame", version, targets, state}` back to the requesting origin every 200 ms
  — never to `*` — and stops on `stop`.
- `version` is the protocol revision, currently `2`. Revision 1 reported one
  rect per name. The host needs to tell a bridge that is too old from no bridge
  at all, because both otherwise look like a tutorial step that never advances.
- `targets` maps each `data-tour` name to **every** visible element carrying it,
  in document order, as `{x, y, width, height, disabled, label}`. `label` is
  `data-tour-label` when present, else the trimmed text, so the host can pick a
  catalog entry by name rather than by position. The host adds the iframe
  offset and draws the spotlight in its own document; the hole it leaves passes
  clicks through to the real control.
- `{type: "scroll", target, index}` brings one marked control into view and
  reports immediately afterwards. Wheel events over the host's overlay scroll
  the host document, never this frame, so without it a control below our fold
  is unreachable for the whole tutorial. Honoured only for an origin that has
  already started a tour.
- `state` is derived from the DOM, not from React: `panelOpen`, `entries`
  (catalog size), `nodes` (steps in the loaded template), `firstNodeRunState`
  (`pending` / `running` / `done`), and `running`. The host advances a step only
  when this state confirms the action completed.

Marked controls: `notebook-toggle`, `run-next`, `run-all` (header),
`notebook-panel`, `notebook-close`, `notebook-refresh`, `notebook-source`,
`notebook-entry` (template panel), and `notebook-node-run` (step). Steps carry
`data-tour-node`, and catalog entries `data-tour-entry` for counting plus
`data-tour-label` for naming. Ad-hoc
input nodes are deliberately unmarked so "the first step" means the first
template step. These names are a cross-repository contract with
`trustable-app/web/js/tutorial.js`.
