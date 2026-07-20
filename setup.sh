#!/usr/bin/env bash
#
# setup.sh — install the coding agents used by the standalone ACP client
# and their ACP adapters, globally via npm.
#
# Installs, for each agent referenced in config.json:
#   - Claude Code : @anthropic-ai/claude-code  + @agentclientprotocol/claude-agent-acp
#   - Codex       : @openai/codex              + @agentclientprotocol/codex-acp
#   - Pi          : @earendil-works/pi-coding-agent + pi-acp
#                   plus extensions: pi-mcp-adapter, pi-web-access
#
# The ACP adapters are what config.json spawns (`npx -y <adapter>`); installing
# them globally makes launches instant and work offline. Each adapter drives an
# underlying CLI that must also be on PATH: `claude`, `codex`, and `pi`
# respectively. (pi-acp requires the `pi` binary from @earendil-works/pi-coding-agent.)
#
# Runs on Linux with node/npm already installed and on PATH (i.e. inside the
# trudev VM). This is an agent installer, not a Node installer — see the
# preflight below.
# API keys are NOT handled here — set them in .env (see .env.example).
#
# Usage: ./setup.sh
set -euo pipefail

# Packages to install globally. Adapters mirror config.json's agent commands.
PACKAGES=(
	# Claude Code + its ACP adapter
	"@anthropic-ai/claude-code"
	"@agentclientprotocol/claude-agent-acp"
	# Codex + its ACP adapter (@zed-industries/codex-acp is deprecated in favor
	# of the @agentclientprotocol scope)
	"@openai/codex"
	"@agentclientprotocol/codex-acp"
	# Pi coding agent CLI + its ACP adapter (pi-acp spawns the `pi` binary)
	"@earendil-works/pi-coding-agent"
	"pi-acp"
	# Pi extensions: MCP adapter + web access (search, fetch, PDF/video)
	"pi-mcp-adapter"
	"pi-web-access"
)

# Preflight — abort on the first failed check so a wrong environment fails
# loudly instead of half-installing.

# 1. Linux only. The supported environment is the trudev VM; no per-platform
#    fallback is attempted.
KERNEL="$(uname -s)"
if [ "$KERNEL" != "Linux" ]; then
	echo "✗ Unsupported platform: $KERNEL. This script runs on Linux — use the trudev VM." >&2
	exit 1
fi

# 2. Node.js must already be installed and on PATH. This script installs agents,
#    not runtimes: it never downloads, upgrades, or version-manages node.
if ! command -v node >/dev/null 2>&1; then
	echo "✗ node not found on PATH. Install Node.js first — this script does not install it." >&2
	exit 1
fi

# 3. npm must be on PATH — it is how everything below is installed.
if ! command -v npm >/dev/null 2>&1; then
	echo "✗ npm not found on PATH. Install Node.js first (this repo uses node/npm)." >&2
	exit 1
fi

echo "Using: node $(node -v), npm $(npm -v)"

# Choose an install prefix that does not require root. If npm's global
# lib/node_modules is writable, use it as-is; otherwise install into a
# user-level prefix at ~/.local (bin ends up in ~/.local/bin, conventionally on
# PATH in this project's VM). This keeps `npm install -g` working without sudo.
GLOBAL_PREFIX="$(npm config get prefix)"
GLOBAL_LIB="$GLOBAL_PREFIX/lib/node_modules"
PREFIX_ARGS=()
if [ -w "$GLOBAL_LIB" ]; then
	echo "Installing into global prefix: $GLOBAL_PREFIX"
else
	PREFIX_ARGS=(--prefix "$HOME/.local")
	echo "Global prefix not writable — installing into user prefix: $HOME/.local"
	case ":$PATH:" in
		*":$HOME/.local/bin:"*) : ;;
		*) echo "  note: add \$HOME/.local/bin to PATH so the agents are found." ;;
	esac
fi

echo "Installing agents + ACP adapters…"
echo

# Single global install so npm resolves the dependency set once. --force lets a
# re-run overwrite bin links left by a previously-installed adapter (e.g. the
# deprecated @zed-industries/codex-acp), keeping the script idempotent.
npm install -g --force "${PREFIX_ARGS[@]}" "${PACKAGES[@]}"

echo
echo "✓ Installed:"
for pkg in "${PACKAGES[@]}"; do
	ver="$(npm view "$pkg" version 2>/dev/null || echo '?')"
	printf '  %-45s %s\n' "$pkg" "$ver"
done

echo
echo "Next steps:"
echo "  1. Set API keys in .env (copy from .env.example):"
echo "       ANTHROPIC_API_KEY, OPENAI_API_KEY, PI_API_KEY"
echo "  2. Start the server:  npm run serve   (or npm run serve:trureact)"
