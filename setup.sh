#!/bin/sh
# Copyright 2025-2026 Nuvolaris Inc
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

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
#     setup.sh + pi.version + pi.integrity + dist-bin/truacp.cjs
#     + pi-acp-package.tgz + extensions/trustant-runtime.ts + extensions/requirements.txt
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
INTEGRITY_FILE="$SCRIPT_DIR/pi.integrity"
if [ ! -f "$INTEGRITY_FILE" ]; then
	echo "✗ $INTEGRITY_FILE not found — it pins the reviewed upstream Pi artifacts." >&2
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

# Verify the registry metadata against the reviewed SRI values before npm is
# allowed to install upstream Pi. npm then verifies the downloaded tarballs
# against the same registry integrity, while this checked-in comparison fails
# closed if a package is replaced or its metadata drifts.
while IFS= read -r integrity_line; do
	integrity_line=$(printf '%s\n' "$integrity_line" |
		sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
	[ -n "$integrity_line" ] || continue
	# shellcheck disable=SC2086 # The manifest deliberately contains two fields.
	set -- $integrity_line
	if [ "$#" -ne 2 ]; then
		echo "✗ $INTEGRITY_FILE contains an invalid entry: $integrity_line" >&2
		exit 1
	fi
	spec=$1
	expected_integrity=$2
	if ! printf '%s\n' "$PACKAGES" | grep -Fqx "$spec"; then
		echo "✗ $INTEGRITY_FILE pins $spec, but pi.version does not install it." >&2
		exit 1
	fi
	actual_integrity=$(npm view "$spec" dist.integrity)
	if [ "$actual_integrity" != "$expected_integrity" ]; then
		echo "✗ integrity mismatch for $spec" >&2
		echo "  expected: $expected_integrity" >&2
		echo "  received: $actual_integrity" >&2
		exit 1
	fi
done <"$INTEGRITY_FILE"

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

# Install the exact nested Trustant fork instead of resolving upstream
# pi-acp from npm. In source/VM mode setup builds a package from the checked-out
# submodule; image packaging supplies the same tarball next to setup.sh.
#
# WHY: Stop, activity, extension commands and launch negotiation are implemented
# in this fork. Falling back to npm would silently restore upstream behavior and
# make source, VM and image runs disagree.
PI_ACP_SOURCE_DIR="$SCRIPT_DIR/pi-acp"
PI_ACP_PREBUILT="$SCRIPT_DIR/pi-acp-package.tgz"
PI_ACP_BUILD_DIR=""
PI_ACP_PACKAGE=""

if [ -f "$PI_ACP_SOURCE_DIR/package.json" ]; then
	if [ ! -f "$PI_ACP_SOURCE_DIR/package-lock.json" ]; then
		echo "✗ nested pi-acp fork is missing package-lock.json." >&2
		exit 1
	fi
	PI_ACP_BUILD_DIR=$(mktemp -d)
	echo "Building nested Trustant pi-acp fork…"
	(
		cd "$PI_ACP_SOURCE_DIR"
		npm ci
		npm run build
		npm pack --pack-destination "$PI_ACP_BUILD_DIR"
	)
	set -- "$PI_ACP_BUILD_DIR"/pi-acp-*.tgz
	if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
		echo "✗ nested pi-acp build did not produce exactly one package archive." >&2
		exit 1
	fi
	PI_ACP_PACKAGE="$1"
elif [ -f "$PI_ACP_PREBUILT" ]; then
	PI_ACP_PACKAGE="$PI_ACP_PREBUILT"
else
	echo "✗ Trustant pi-acp fork is unavailable." >&2
	echo "  Initialize recursively or provide $PI_ACP_PREBUILT." >&2
	exit 1
fi

npm install -g --force $PREFIX_ARGS "$PI_ACP_PACKAGE"

PI_ACP_ENTRYPOINT="$INSTALL_PREFIX/lib/node_modules/pi-acp/dist/index.js"
if [ ! -f "$PI_ACP_ENTRYPOINT" ]; then
	echo "✗ pi-acp was installed but $PI_ACP_ENTRYPOINT was not found." >&2
	exit 1
fi
if [ -n "$PI_ACP_BUILD_DIR" ]; then
	rm -rf "$PI_ACP_BUILD_DIR"
fi
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

# pi-mcp-adapter 2.11.0 keeps a Streamable HTTP connection marked as connected
# after a co-located MCP server restarts and rejects its expired session ID.
# Apply the reviewed compatibility fix after every registration pass so an
# existing VM receives it even when `pi install` correctly skips the pinned
# package. The transform validates every source before writing any file and is
# idempotent; a future package layout must be reviewed instead of being patched
# partially.
PI_MCP_ADAPTER_SPEC=""
for pkg in $PI_EXTENSION_PACKAGES; do
	case "$pkg" in
	pi-mcp-adapter@*) PI_MCP_ADAPTER_SPEC="$pkg" ;;
	esac
done
if [ -z "$PI_MCP_ADAPTER_SPEC" ]; then
	echo "✗ pi.version does not contain a pinned pi-mcp-adapter package." >&2
	exit 1
fi

PI_MCP_ADAPTER_VERSION=${PI_MCP_ADAPTER_SPEC##*@}
PI_MCP_ADAPTER_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-mcp-adapter"
if [ ! -f "$PI_MCP_ADAPTER_DIR/package.json" ]; then
	echo "✗ pi-mcp-adapter was registered but $PI_MCP_ADAPTER_DIR/package.json was not found." >&2
	exit 1
fi

node - "$PI_MCP_ADAPTER_DIR" "$PI_MCP_ADAPTER_VERSION" <<'NODE'
const {
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const [adapterDir, expectedVersion] = process.argv.slice(2);
const packageJson = JSON.parse(
	readFileSync(join(adapterDir, "package.json"), "utf8"),
);
if (packageJson.version !== expectedVersion) {
	throw new Error(
		`pi-mcp-adapter version mismatch: expected ${expectedVersion}, found ${packageJson.version}`,
	);
}

const managerMethod = `  async callToolWithSessionRecovery(
    name: string,
    request: Parameters<Client["callTool"]>[0],
    resultSchema: Parameters<Client["callTool"]>[1],
    options: Parameters<Client["callTool"]>[2],
  ) {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(\`Server "\${name}" is not connected\`);
    }

    try {
      return await connection.client.callTool(request, resultSchema, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !connection.definition.url ||
        !/Session not found for MCP Streamable HTTP transport/i.test(message)
      ) {
        throw error;
      }

      let replacement = this.connections.get(name);
      if (replacement === connection) {
        await this.close(name);
        replacement = undefined;
      }
      if (!replacement || replacement.status !== "connected") {
        replacement = await this.connect(
          name,
          connection.definition,
          options?.signal,
        );
      }

      // Call the replacement client directly: this is the single allowed retry.
      return await replacement.client.callTool(request, resultSchema, options);
    }
  }

`;

const transforms = [
	{
		file: "server-manager.ts",
		marker: "  async callToolWithSessionRecovery(",
		search:
			"  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {",
		replacement:
			managerMethod +
			"  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {",
	},
	{
		file: "proxy-modes.ts",
		marker:
			"const resultPromise = state.manager.callToolWithSessionRecovery(serverName, {",
		search: "const resultPromise = connection.client.callTool({",
		replacement:
			"const resultPromise = state.manager.callToolWithSessionRecovery(serverName, {",
	},
	{
		file: "direct-tools.ts",
		marker:
			"const resultPromise = state.manager.callToolWithSessionRecovery(spec.serverName, {",
		search: "const resultPromise = connection.client.callTool({",
		replacement:
			"const resultPromise = state.manager.callToolWithSessionRecovery(spec.serverName, {",
	},
	{
		file: "ui-server.ts",
		marker:
			"const result = await options.manager.callToolWithSessionRecovery(options.serverName, {",
		search: "const result = await connection.client.callTool({",
		replacement:
			"const result = await options.manager.callToolWithSessionRecovery(options.serverName, {",
	},
];

const sources = transforms.map((transform) => {
	const path = join(adapterDir, transform.file);
	return {
		...transform,
		path,
		source: readFileSync(path, "utf8"),
	};
});
const applied = sources.map(({ marker, source }) => source.includes(marker));
if (applied.every(Boolean)) {
	console.log(
		`pi-mcp-adapter ${expectedVersion} Streamable HTTP recovery already applied`,
	);
	process.exit(0);
}
if (applied.some(Boolean)) {
	throw new Error(
		`pi-mcp-adapter ${expectedVersion} recovery patch is only partially applied`,
	);
}

const pending = sources.map(({ search, replacement, ...source }) => {
	const count = source.source.split(search).length - 1;
	if (count !== 1) {
		throw new Error(
			`pi-mcp-adapter ${expectedVersion}: expected one patch target in ${source.file}, found ${count}`,
		);
	}
	return {
		...source,
		updated: source.source.replace(search, replacement),
	};
});

for (const { path, updated } of pending) {
	const temporary = `${path}.trustant-new`;
	writeFileSync(temporary, updated, { mode: statSync(path).mode & 0o777 });
	renameSync(temporary, path);
}
console.log(
	`Applied pi-mcp-adapter ${expectedVersion} Streamable HTTP session recovery`,
);
NODE

echo
# Every spec is pinned, so the manifest is the record of what was installed;
# querying the registry would report latest, not what actually landed.
PACKAGE_COUNT=$(printf '%s\n' "$PACKAGES" | grep -c '^')
echo "✓ Provisioned $((PACKAGE_COUNT + 1)) pinned packages (including integrity-verified upstream Pi and the Trustant pi-acp fork)."

# ---------------------------------------------------------------------------
# Phase 2 — build (only with a package.json in the current directory)
# ---------------------------------------------------------------------------
#
# Deliberately keyed off the *current* directory, not the script's directory:
# running this script from elsewhere skips the build. Missing sources are not an
# error — a prebuilt bundle may already be present, so fall through to phase 3.
if [ -f package.json ]; then
	echo
	echo "Found package.json — building trustant-acp in $PWD"
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
# Self-contained: this phase consumes the runtime artifacts named in the
# header to install a complete, working truacp. Installation deliberately lives
# only here so source, VM, and image builds all generate the same launchers from
# the same implementation.
#
# The bundle is looked for next to the script first (the packaged layout), then
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
TRUSTANT_EXTENSION_SOURCE=""
for candidate in \
	"$SCRIPT_DIR/extensions/trustant-runtime.ts" \
	"extensions/trustant-runtime.ts"; do
	if [ -f "$candidate" ]; then
		TRUSTANT_EXTENSION_SOURCE="$candidate"
		break
	fi
done
if [ -z "$TRUSTANT_EXTENSION_SOURCE" ]; then
	echo "✗ Trustant Pi runtime extension is missing." >&2
	exit 1
fi

echo
echo "Installing truacp into $HOME/.local (from $BUNDLE) …"
mkdir -p "$LIB_DIR/extensions" "$BIN_DIR"
cp "$BUNDLE" "$LIB_DIR/truacp.cjs"
# WHY: Pi receives this path through typed ACP metadata. Installing it beside
# the bundle keeps VM and image runtimes identical and makes a missing policy
# artifact a setup failure rather than an unguarded fallback.
cp "$TRUSTANT_EXTENSION_SOURCE" "$LIB_DIR/extensions/trustant-runtime.ts"
# The extension reads the action runtime's Python library list from this file
# beside it; without it managed Pi refuses to start.
TRUSTANT_REQUIREMENTS_SOURCE="$(dirname "$TRUSTANT_EXTENSION_SOURCE")/requirements.txt"
if [ ! -f "$TRUSTANT_REQUIREMENTS_SOURCE" ]; then
	echo "✗ Trustant Python runtime requirements.txt is missing." >&2
	exit 1
fi
cp "$TRUSTANT_REQUIREMENTS_SOURCE" "$LIB_DIR/extensions/requirements.txt"

# The launcher is a portable shell script, not a compiled binary: `node` is
# resolved from PATH at run time, so the same bytes work on any architecture.
# Installed under both names — `truacp` is what Trustant launches.
for launcher in "$BIN_DIR/truacp" "$BIN_DIR/trustant-acp"; do
	cat >"$launcher" <<EOF
#!/bin/sh
# trustant-acp launcher — generated by setup.sh. Runs the bundled ACP server
# with whatever node is on PATH.
exec node "$LIB_DIR/truacp.cjs" "\$@"
EOF
	chmod +x "$launcher"
done

echo "✓ Installed:"
echo "    $LIB_DIR/truacp.cjs"
echo "    $LIB_DIR/extensions/trustant-runtime.ts"
echo "    $LIB_DIR/extensions/requirements.txt"
echo "    $BIN_DIR/truacp"
echo "    $BIN_DIR/trustant-acp"
