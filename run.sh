#!/usr/bin/env bash
#
# Development entry point: hot-reloading web UI + server, against a target app.
#
# Runs two watchers concurrently:
#   - esbuild.web.mjs (watch)  → rebundles web/ on every frontend change and
#                                regenerates server/web-bundle.generated.ts
#   - tsx watch server/index.ts → restarts the server on every backend change
#
# Secrets come from $WORKBENCH_DIR/.env, passed as an absolute path via --env and
# loaded BEFORE the server chdir()s into $ACP_DIR. The target checkout is user
# content, so its own .env is never read — an app cannot inject or shadow
# provider credentials. Keys already exported in the environment win over the
# file, which is how externally-supplied keys (Claude, Pi) are passed through.
#
# Override the target with env vars:
#   ACP_DIR=/path/to/app ACP_PORT=4097 ACP_ENV=/path/to/.env ./run.sh
set -euo pipefail

cd "$(dirname "$0")"

WORKBENCH_DIR="${WORKBENCH_DIR:-$HOME/workbench}"
ACP_DIR="${ACP_DIR:-$WORKBENCH_DIR/trureact}"
ACP_PORT="${ACP_PORT:-4096}"
ACP_ENV="${ACP_ENV:-$WORKBENCH_DIR/.env}"

# ---- preflight ------------------------------------------------------------
#
# This script is the in-VM development entry point. It expects to run inside the
# `trudev` Lima VM, against an app checkout in the workbench. Both conditions are
# checked up front: failing here with an explanation beats starting a server that
# advertises an unreachable URL or serves a directory that is not an app.

if ! ip -o link show lima0 >/dev/null 2>&1; then
	cat >&2 <<-EOF
		✗ no lima0 interface — this does not look like the trudev Lima VM.

		  run.sh is the in-VM development entry point. It must run INSIDE the VM,
		  not on the macOS host: the URL it advertises is the lima0 host↔VM address,
		  which only exists in the guest.

		  From the trustable-app repo on the macOS host:
		    ./start.sh          # provision/boot the Lima VM (trudev)
		    ./ssh.sh            # shell into it
		  then, inside the VM:
		    ./setup.sh          # one-time: ops/go/node/pi-acp + MCP servers, .env
		    cd trustable-acp && ./run.sh

		  If you are deliberately running outside Lima, use 'npm run serve' instead —
		  it has no VM assumptions.
	EOF
	exit 1
fi

if [ ! -d "$ACP_DIR" ]; then
	cat >&2 <<-EOF
		✗ no app checkout at $ACP_DIR

		  run.sh serves an app from the workbench; that directory has to exist first.
		  The workbench checkout is created by launching the app from the Trustable
		  UI (which clones \$WORKSPACE_DIR/workspace/<name> into \$WORKBENCH_DIR/<name>).

		  Either launch the app once from the Trustable UI, or point this run at an
		  existing checkout:
		    ACP_DIR=/path/to/app ./run.sh

		  Available in ${WORKBENCH_DIR}:
		$(ls -1 "$WORKBENCH_DIR" 2>/dev/null | sed 's/^/    /' || echo "    (workbench dir ${WORKBENCH_DIR} does not exist)")
	EOF
	exit 1
fi

# A missing secrets file is not fatal — keys may come from the environment — but
# it is the usual cause of "agent has no API key", so say so up front.
if [ ! -f "$ACP_ENV" ]; then
	echo "! no secrets file at $ACP_ENV (continuing; keys must come from the environment)" >&2
fi

# config.json lives here, not in the target dir; pass it as an absolute path
# since the server resolves it after chdir'ing into $ACP_DIR.
CONFIG_PATH="$PWD/config.json"

pids=()

# Kill a watcher and every descendant. Without job control the children share
# this script's process group, so we cannot signal the group (that would hit us
# too) and must walk the tree by hand.
#
# The walk has to be recursive: `npm exec` → `tsx` → the real server is three
# generations deep, so a single `pkill -P` leaves the lower ones running. We
# collect the whole subtree depth-first, then signal children before parents so
# a dying parent cannot reparent a survivor away from us.
#
# Caveat: if a watcher is SIGKILLed from outside, its descendants are reparented
# to init before we can enumerate them, and an idle `tsx watch` may survive. It
# holds no port (the port sweep below covers the one that does), so the stack
# restarts fine. Ctrl-C and normal exits are unaffected.
collect_descendants() {
	local pid="$1" child
	for child in $(pgrep -P "$pid" 2>/dev/null); do
		collect_descendants "$child"
		echo "$child"
	done
}

kill_tree() {
	local sig="$1" pid="$2" target
	for target in $(collect_descendants "$pid"); do
		kill "-$sig" "$target" 2>/dev/null || true
	done
	kill "-$sig" "$pid" 2>/dev/null || true
}

cleanup() {
	# `set +e` matters: cleanup is full of probing kills and tests that are
	# expected to fail (already-dead pids, empty `ps` output). Under `set -e` the
	# first such non-zero status aborts cleanup midway and leaks the server.
	set +e
	trap - INT TERM EXIT
	# TERM first so the server runs its graceful shutdown handler.
	for pid in "${pids[@]}"; do kill_tree TERM "$pid"; done
	for _ in $(seq 1 15); do
		local still=0
		for pid in "${pids[@]}"; do
			if kill -0 "$pid" 2>/dev/null; then still=1; fi
		done
		[ "$still" = 0 ] && break
		sleep 0.2
	done
	for pid in "${pids[@]}"; do kill_tree KILL "$pid"; done

	# tsx's real server is a grandchild under npx that renames itself to
	# "MainThread"; it is not reachable by name or by our child PIDs, and it
	# outlives them holding $ACP_PORT. Reap whatever still owns the port.
	# (ss only reports the pid for processes we own — which this one is.)
	local holder
	for _ in $(seq 1 15); do
		holder=$(ss -lptnH "sport = :$ACP_PORT" 2>/dev/null |
			grep -oP 'pid=\K[0-9]+' | head -1)
		[ -z "$holder" ] && break
		kill -TERM "$holder" 2>/dev/null || true
		sleep 0.2
		kill -0 "$holder" 2>/dev/null && kill -KILL "$holder" 2>/dev/null || true
		sleep 0.2
	done
}
trap cleanup INT TERM EXIT

# NOTE: no `setsid` and no `set -m` here. Detaching the watchers into their own
# session/groups stops `wait` from tracking them and stops a terminal Ctrl-C
# from reaching them, which left them orphaned holding $ACP_PORT.
echo "→ web    : watching web/ → dist-web/ (+ embedded bundle)"
node esbuild.web.mjs &
pids+=($!)

# --exclude web-bundle.generated.ts: the esbuild watcher rewrites that file on
# every frontend edit, and tsx watches server/ — without this, editing a .tsx
# file needlessly restarts the backend (and drops in-flight agent sessions).
echo "→ server : $ACP_DIR on :$ACP_PORT (env: $ACP_ENV)"
npx tsx watch --exclude server/web-bundle.generated.ts server/index.ts \
	--config "$CONFIG_PATH" \
	--dir "$ACP_DIR" \
	--env "$ACP_ENV" \
	--port "$ACP_PORT" &
pids+=($!)

# Block until either watcher exits, then fall through to cleanup via the EXIT
# trap — so one watcher crashing tears the other down instead of leaving half a
# stack running. On Ctrl-C bash interrupts the wait and runs the INT trap.
#
# Poll rather than `wait -n`: a bare `wait -n` under `set -e` bypasses the trap
# when a child exits non-zero, and `wait -n || true` swallows that exit and then
# blocks on the *remaining* child — which left esbuild and the port alive after
# the server watcher was killed.
while :; do
	for pid in "${pids[@]}"; do
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "✗ a watcher exited — shutting down the stack" >&2
			exit 1
		fi
	done
	sleep 1
done
