#!/bin/sh
#
# setup.sh — install the coding agents used by the standalone ACP client, then
# (optionally) build and install this project itself.
#
# Three ordered phases:
#
#   1. Install components — CLI + ACP adapters globally via npm, then register
#      Pi extensions through `pi install`. Every pin lives in ./pi.version.
#   2. Build — ONLY if a package.json exists in the current directory. Produces
#      dist-web/ (the web UI) and dist-bin/truacp.cjs (the server bundle).
#   3. Install — copies the bundle to ~/.local/lib/truacp and writes the
#      launcher scripts to ~/.local/bin. Runs whenever a bundle is present,
#      whether phase 2 just built it or it shipped prebuilt.
#
# SELF-CONTAINED: this script needs no other file from the repo. Given just
#
#     setup.sh + pi.version + dist-bin/truacp.cjs
#
# it installs a complete, working truacp into ~/.local/bin — no package.json, no
# node_modules, no secondary installer, no network beyond npm for the agents.
# Keeping setup.sh as the sole installer prevents the image and source workflows
# from silently drifting to different launcher formats.
#
# With no package.json AND no bundle, phases 2 and 3 are both skipped and the
# script exits 0 after phase 1: the runtime-only mode for layers that need the
# agents but not the server.
#
# Portable POSIX sh — no bashisms, no arrays — so a Dockerfile can COPY this
# file and RUN it under the default /bin/sh. `node` and `npm` are assumed to be
# on PATH; this script installs agents, never a runtime.
#
# API keys are NOT handled here — set them in .env (see .env.example).
#
# Usage: ./setup.sh   (or: sh setup.sh)
set -eu

# Resolve the script's own directory: pi.version lives next to this file, while
# the build phase deliberately keys off the *current* directory.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
#
# Abort on the first failed check so a wrong environment fails loudly instead of
# half-installing.

if ! command -v node >/dev/null 2>&1; then
	echo "✗ node not found on PATH. Install Node.js first — this script does not install it." >&2
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "✗ npm not found on PATH. Install Node.js first (this repo uses node/npm)." >&2
	exit 1
fi

echo "Using: node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------------------
# Phase 1 — install components
# ---------------------------------------------------------------------------
#
# The ACP adapters are what config.json spawns (`npx -y <adapter>`); installing
# them globally makes launches instant and lets them work offline. Each adapter
# drives an underlying CLI that must also be on PATH: `claude`, `codex`, `pi`.
# Pi extensions differ: their npm package must also be recorded by `pi install`
# before Pi loads the extension.
#
# The package list lives entirely in ./pi.version — one literal npm install spec
# (`<module>@<version>`) per line, comments and blanks ignored. Nothing is
# hardcoded here, so upgrading an agent is a one-line edit to that manifest.
# It is read relative to the SCRIPT's directory, not the current one, so the
# pins apply in runtime-only mode too.
VERSIONS_FILE="$SCRIPT_DIR/pi.version"
if [ ! -f "$VERSIONS_FILE" ]; then
	echo "✗ $VERSIONS_FILE not found — it lists the packages to install." >&2
	exit 1
fi

# Strip comments and surrounding whitespace, drop blank lines.
PACKAGES=$(sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$VERSIONS_FILE" |
	grep -v '^$' || true)

if [ -z "$PACKAGES" ]; then
	echo "✗ $VERSIONS_FILE lists no packages." >&2
	exit 1
fi

# Every entry must be pinned. An unpinned spec would silently install latest and
# break build reproducibility, so it is an error rather than a fallback. The
# leading @ of a scoped name is stripped first so only a real version separator
# counts (`@scope/name` is unpinned, `@scope/name@1.2.3` is pinned).
for pkg in $PACKAGES; do
	case ${pkg#@} in
	*@*) ;;
	*)
		echo "✗ $VERSIONS_FILE: '$pkg' has no version — every entry must be pinned as <module>@<version>." >&2
		exit 1
		;;
	esac
done

echo "Packages pinned by $(basename "$VERSIONS_FILE"):"
for pkg in $PACKAGES; do
	printf '  %-45s %s\n' "${pkg%@*}" "${pkg##*@}"
done

# Pi extensions are not activated by a global npm install alone: Pi loads only
# packages recorded by `pi install`. Keep them in the shared version manifest,
# but provision them through Pi after the CLI itself has been installed.
GLOBAL_PACKAGES=""
PI_EXTENSION_PACKAGES=""
for pkg in $PACKAGES; do
	case "$pkg" in
	pi-mcp-adapter@* | pi-web-access@*)
		PI_EXTENSION_PACKAGES="$PI_EXTENSION_PACKAGES $pkg"
		;;
	*)
		GLOBAL_PACKAGES="$GLOBAL_PACKAGES $pkg"
		;;
	esac
done

# Choose an install prefix that does not require root. If npm's global
# lib/node_modules is writable, use it as-is; otherwise install into a
# user-level prefix at ~/.local (bin ends up in ~/.local/bin, conventionally on
# PATH in this project's VM and image). This keeps `npm install -g` sudo-free.
GLOBAL_PREFIX=$(npm config get prefix)
PREFIX_ARGS=""
INSTALL_PREFIX="$GLOBAL_PREFIX"
if [ -w "$GLOBAL_PREFIX/lib/node_modules" ]; then
	echo "Installing into global prefix: $GLOBAL_PREFIX"
else
	INSTALL_PREFIX="$HOME/.local"
	PREFIX_ARGS="--prefix $INSTALL_PREFIX"
	echo "Global prefix not writable — installing into user prefix: $INSTALL_PREFIX"
fi

case ":$PATH:" in
*":$HOME/.local/bin:"*) ;;
*) echo "  note: add \$HOME/.local/bin to PATH so the agents and truacp are found." ;;
esac

echo "Installing agents + ACP adapters…"
echo

# One global install resolves the CLI/ACP dependency set once. Pi extensions
# are deliberately excluded because only `pi install` registers them with Pi.
# --force keeps re-runs idempotent when stale adapter bin links are present.
# shellcheck disable=SC2086 # Both variables are deliberately word-split specs.
npm install -g --force $PREFIX_ARGS $GLOBAL_PACKAGES

# Resolve the Pi binary from the prefix just populated instead of assuming the
# caller has already refreshed PATH. This is required in fresh VM/image builds.
PI_BIN="$INSTALL_PREFIX/bin/pi"
if [ ! -x "$PI_BIN" ]; then
	PI_BIN=$(command -v pi || true)
fi
if [ -z "$PI_BIN" ] || [ ! -x "$PI_BIN" ]; then
	echo "✗ pi CLI was installed but its executable could not be located." >&2
	exit 1
fi

# `pi install` persists each pinned extension in ~/.pi/agent/settings.json and
# installs it in Pi's own package directory. Checking `pi list` first avoids an
# unnecessary registry operation on every idempotent setup.sh run.
PI_PACKAGE_LIST=$($PI_BIN list 2>/dev/null || true)
for pkg in $PI_EXTENSION_PACKAGES; do
	source="npm:$pkg"
	if printf '%s\n' "$PI_PACKAGE_LIST" | grep -Fq "$source"; then
		echo "Pi extension already registered: $source"
	else
		echo "Registering Pi extension: $source"
		"$PI_BIN" install "$source" --no-approve
		PI_PACKAGE_LIST=$($PI_BIN list 2>/dev/null || true)
	fi
done

echo
# Every spec is pinned, so the manifest is the record of what was installed —
# no need to ask the registry (`npm view` reports latest, not what landed).
echo "✓ Provisioned $(printf '%s\n' "$PACKAGES" | grep -c '^') pinned packages."

# ---------------------------------------------------------------------------
# Phase 2 — build (only with a package.json in the current directory)
# ---------------------------------------------------------------------------
#
# Deliberately keyed off the *current* directory, not the script's directory:
# running this script from elsewhere skips the build. Missing sources are not an
# error — a prebuilt bundle may already be present, so fall through to phase 3.
if [ -f package.json ]; then
	echo
	echo "Found package.json — building trustable-acp in $PWD"
	echo
	echo "Installing project dependencies…"
	npm ci || npm install

	echo
	echo "Building web UI → dist-web/ …"
	npm run build:web

	echo
	echo "Building server bundle → dist-bin/ …"
	npm run build:server
fi

# ---------------------------------------------------------------------------
# Phase 3 — install into ~/.local
# ---------------------------------------------------------------------------
#
# Self-contained: this phase needs nothing but the bundle itself, so a machine
# with only setup.sh, pi.version and dist-bin/truacp.cjs can install a complete,
# working truacp. Installation deliberately lives only here so source, VM, and
# image builds all generate the same launchers from the same implementation.
#
# The bundle is looked for next to the script first (the three-file layout), then
# in the current directory (running from a source checkout elsewhere).
BUNDLE=""
for candidate in \
	"$SCRIPT_DIR/dist-bin/truacp.cjs" \
	"$SCRIPT_DIR/truacp.cjs" \
	"dist-bin/truacp.cjs" \
	"truacp.cjs"; do
	if [ -f "$candidate" ]; then
		BUNDLE="$candidate"
		break
	fi
done

if [ -z "$BUNDLE" ]; then
	# Agents are installed and there is nothing to install as a server. That is
	# the runtime-only mode — succeed quietly.
	exit 0
fi

LIB_DIR="$HOME/.local/lib/truacp"
BIN_DIR="$HOME/.local/bin"

echo
echo "Installing truacp into $HOME/.local (from $BUNDLE) …"
mkdir -p "$LIB_DIR" "$BIN_DIR"
cp "$BUNDLE" "$LIB_DIR/truacp.cjs"

# The launcher is a portable shell script, not a compiled binary: `node` is
# resolved from PATH at run time, so the same bytes work on any architecture.
# Installed under both names — `truacp` is what Trustable launches.
for launcher in "$BIN_DIR/truacp" "$BIN_DIR/trustable-acp"; do
	cat >"$launcher" <<EOF
#!/bin/sh
# trustable-acp launcher — generated by setup.sh. Runs the bundled ACP server
# with whatever node is on PATH.
exec node "$LIB_DIR/truacp.cjs" "\$@"
EOF
	chmod +x "$launcher"
done

echo "✓ Installed:"
echo "    $LIB_DIR/truacp.cjs"
echo "    $BIN_DIR/truacp"
echo "    $BIN_DIR/trustable-acp"
