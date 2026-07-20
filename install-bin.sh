#!/usr/bin/env bash
#
# Install the bundled trustable-acp server as a single self-contained artifact
# plus a launcher on PATH:
#
#   ~/.local/lib/truacp/truacp.cjs   — the bundled server (web UI embedded)
#   ~/.local/bin/truacp              — launcher: `node <bundle> "$@"`
#
# Run after `npm run build:web` + `node esbuild.server.mjs` have produced
# dist-bin/truacp.cjs (npm run build does all of this).
set -euo pipefail

BUNDLE="dist-bin/truacp.cjs"
LIB_DIR="$HOME/.local/lib/truacp"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/truacp"

if [ ! -f "$BUNDLE" ]; then
	echo "✗ $BUNDLE not found — run 'npm run build' first" >&2
	exit 1
fi

mkdir -p "$LIB_DIR" "$BIN_DIR"
cp "$BUNDLE" "$LIB_DIR/truacp.cjs"

# Launcher forwards all args (e.g. --port 4096 --dir /path) to the bundle.
cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec node "$LIB_DIR/truacp.cjs" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "✓ Installed:"
echo "    $LIB_DIR/truacp.cjs"
echo "    $LAUNCHER"
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) echo "⚠ $BIN_DIR is not on PATH — add it to use 'truacp' directly" >&2 ;;
esac
