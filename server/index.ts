/**
 * Standalone ACP client — HTTP + WebSocket server.
 *
 * Hosts the de-Obsidianized ACP core for a browser UI:
 *   - REST (POST/PUT/GET under /api/*) → one endpoint per AcpClient method
 *     (see routes.ts).
 *   - WebSocket (/ws) → streams every agent SessionUpdate to connected clients.
 *
 * Config comes from config.json + .env (no Obsidian, no plugin settings).
 * A `--cli "<prompt>"` flag runs the original one-shot harness instead of
 * starting the server, useful for quick verification.
 *
 * Run: npm run serve      (server)
 *      npm run acp -- --cli --agent claude "hello"   (one-shot)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile } from "fs/promises";
import { execSync } from "child_process";
import { join, normalize, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { AcpClient } from "../src/acp/acp-client";
import type { SessionUpdate } from "../src/types/session";
import { loadConfig, findConfigAgent } from "./config-store";
import { loadDotEnv } from "./secrets";
import { buildRuntime, buildAgentConfig, agentWorkingDirectory } from "./acp-host";
import { SessionStore } from "./session-store";
import { SessionHost } from "./session-host";
import { routes, type RouteContext, type RouteKey } from "./routes";
import { WS_PATH, type WsEvent } from "./protocol";
import { WEB_BUNDLE } from "./web-bundle.generated";

const CLIENT_VERSION = "0.11.0-standalone";

// ---- one-shot CLI harness (kept from Phase 1) -----------------------------

async function runCli(argv: string[]): Promise<void> {
	let agentId: string | undefined;
	let cwd: string | undefined;
	let configPath = "config.json";
	let envPath: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--agent") agentId = argv[++i];
		else if (a === "--cwd") cwd = argv[++i];
		else if (a === "--config") configPath = argv[++i];
		else if (a === "--env") envPath = argv[++i];
		else if (a === "--port") i++; // not meaningful for the one-shot harness
		else if (a === "--cli") continue;
		else rest.push(a);
	}

	// Only the explicitly-given secrets file; never the target directory's .env.
	if (envPath) await loadDotEnv(envPath);
	const config = await loadConfig(configPath);
	const id = agentId ?? config.defaultAgentId;
	const agent = findConfigAgent(config, id);
	if (!agent) throw new Error(`Unknown agent "${id}"`);

	const workingDir = cwd ?? agentWorkingDirectory(config);
	const client = new AcpClient(buildRuntime(config, CLIENT_VERSION));
	client.onSessionUpdate((u: SessionUpdate) => {
		if (u.type === "agent_message_chunk") process.stdout.write(u.text);
		else if (u.type === "process_error")
			process.stderr.write(
				`\n[process_error] ${u.error.title}: ${u.error.message}\n`,
			);
	});

	console.error(`→ ${agent.displayName} (${agent.id}) in ${workingDir}`);
	const init = await client.initialize(buildAgentConfig(agent, workingDir));
	console.error(`✓ initialize (protocol v${init.protocolVersion})`);
	const session = await client.newSession(workingDir);
	console.error(`✓ newSession (${session.sessionId})\n`);
	const prompt = rest.join(" ") || "Say hello in one short sentence.";
	console.error(`> ${prompt}\n`);
	await client.sendPrompt(session.sessionId, [{ type: "text", text: prompt }]);
	console.error(`\n\n✓ complete`);
	await client.disconnect();
	process.exit(0);
}

// ---- HTTP helpers ---------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(json),
	});
	res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

// Absolute path to the built web bundle on disk, resolved relative to THIS file
// (server/ → ../dist-web). Used only as a fallback when the embedded bundle is
// empty (e.g. before the first web build). Captured at load time so it stays
// correct even after the server chdir()s into a --dir working directory.
//
// import.meta.url drives this in the ESM run (tsx serve). In the bundled CJS
// binary, esbuild.server.mjs `define`s import.meta to an object whose `url` is
// derived from __filename (via the banner), so this resolves there too; the
// embedded bundle is always present in the binary, making WEB_DIR a dev-only
// fallback that must never throw at load time.
const moduleUrl =
	typeof import.meta !== "undefined" ? import.meta.url : undefined;
const moduleDir = moduleUrl
	? dirname(fileURLToPath(moduleUrl))
	: typeof __dirname !== "undefined"
		? __dirname
		: process.cwd();
const WEB_DIR = join(moduleDir, "..", "dist-web");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".png": "image/png",
};

/** True when the web UI has been embedded into the server via the web build. */
const HAS_EMBEDDED_WEB = Object.keys(WEB_BUNDLE).length > 0;

/**
 * Serve a file from the web bundle. Returns true if served. Path is normalized
 * and confined to the bundle to prevent traversal; "/" maps to index.html.
 *
 * The embedded bundle (server/web-bundle.generated.ts) is preferred so serving
 * does not depend on dist-web/ existing or on the server's working directory.
 * When nothing is embedded yet, falls back to reading dist-web/ from disk.
 * Returns false when the file is absent in both, so the caller can fall back to
 * the status page.
 */
async function serveStatic(
	pathname: string,
	res: ServerResponse,
): Promise<boolean> {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	// Reject traversal.
	const safe = normalize(rel);
	if (safe.startsWith("..") || safe.includes("../")) return false;

	// 1) Embedded bundle (base64), independent of the filesystem.
	const embedded = WEB_BUNDLE[safe];
	if (embedded !== undefined) {
		const data = Buffer.from(embedded, "base64");
		res.writeHead(200, {
			"content-type": MIME[extname(safe)] ?? "application/octet-stream",
			"content-length": data.byteLength,
		});
		res.end(data);
		return true;
	}

	// 2) Fallback: read from dist-web/ on disk (dev before an embed exists).
	if (HAS_EMBEDDED_WEB) return false;
	const filePath = join(WEB_DIR, safe);
	try {
		const data = await readFile(filePath);
		res.writeHead(200, {
			"content-type": MIME[extname(filePath)] ?? "application/octet-stream",
			"content-length": data.byteLength,
		});
		res.end(data);
		return true;
	} catch {
		return false;
	}
}

/** Escape text for safe interpolation into the status HTML. */
function esc(s: string): string {
	return s.replace(
		/[&<>"]/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
	);
}

/** Minimal human-readable status page served at GET /. */
function landingPage(ctx: RouteContext): string {
	const agents = Object.values(ctx.config.agents)
		.map(
			(a) =>
				`<li><code>${esc(a.id)}</code> — ${esc(a.displayName)} ` +
				`(<code>${esc(a.command)} ${esc(a.args.join(" "))}</code>)</li>`,
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8">
<title>Standalone ACP Client</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#222}
 code{background:#f4f4f5;padding:.1em .35em;border-radius:4px}
 h1{font-size:1.4rem} li{margin:.2rem 0} .muted{color:#666}
</style></head><body>
<h1>Standalone ACP Client</h1>
<p class="muted">Headless server is running. The browser UI is not built yet — this is a status page.</p>
<h2>Agents</h2><ul>${agents}</ul>
<h2>Project directory</h2><p><code>${esc(ctx.host.projectDir())}</code></p>
<h2>Endpoints</h2>
<ul>
 <li><code>GET  /health</code></li>
 <li><code>GET  /api/agents</code></li>
 <li><code>POST /api/session/initialize</code> · <code>/new</code> · <code>/prompt</code> · <code>/cancel</code> · <code>/load</code> · <code>/resume</code> · <code>/fork</code> · <code>/list</code> · <code>/config-option</code></li>
 <li><code>POST /api/permission/respond</code></li>
 <li><code>POST /api/sessions/query</code> · <code>/messages/get</code> · <code>/delete</code> · <code>PUT /api/sessions/messages</code></li>
 <li><code>POST /api/notebooks/index</code> · <code>/load</code> · <code>/select</code> · <code>/remove</code> · <code>/local</code> · <code>PUT /api/notebooks/save-local</code> · <code>/save-template</code></li>
 <li><code>WS   /ws</code> — streams <code>sessionUpdate</code> events</li>
</ul>
</body></html>`;
}

// ---- server ---------------------------------------------------------------

/**
 * Machine IP(s) as reported by `hostname -I` (space-separated on Linux).
 * Falls back to "localhost" when the command is unavailable (e.g. macOS, where
 * `hostname -I` is not supported).
 */
function machineIp(): string {
	try {
		const out = execSync("hostname -I", { encoding: "utf8" }).trim();
		return out || "localhost";
	} catch {
		return "localhost";
	}
}

/**
 * The address to advertise in the startup banner — the one a user can actually
 * open in a browser.
 *
 * This server normally runs inside the `trudev` Lima VM while the browser is on
 * the macOS host, so the reachable address is the host↔VM interface (`lima0`),
 * NOT the VM's own default route (`eth0`, first in `hostname -I`) and not the
 * k3s/CNI addresses. We resolve it by interface name rather than by position:
 * `hostname -I` ordering shifts as interfaces come and go, so any fixed index is
 * only accidentally correct.
 *
 * Falls back to the first `hostname -I` address when `lima0` is absent (bare
 * Linux server, no VM), and finally to "localhost".
 */
function advertisedIp(): string {
	// Preferred: the Lima host↔VM interface, addressed by name.
	for (const iface of ["lima0"]) {
		try {
			const out = execSync(
				`ip -o -4 addr show dev ${iface} scope global 2>/dev/null`,
				{ encoding: "utf8" },
			).trim();
			const addr = out.split(/\s+/)[3]?.split("/")[0];
			if (addr) return addr;
		} catch {
			// Interface absent (not running under Lima) — fall through.
		}
	}
	return machineIp().split(/\s+/)[0] || "localhost";
}

async function runServer(
	configPath: string,
	dir?: string,
	portOverride?: number,
	envPath?: string,
): Promise<void> {
	// Secrets are loaded BEFORE the chdir, from a path that does not depend on
	// the working directory. The target app checkout is user content — its own
	// .env is deliberately NOT read, so an app cannot inject or shadow provider
	// credentials. Real environment variables still win (loadDotEnv never
	// overwrites), which is how externally-supplied keys are passed in.
	if (envPath) await loadDotEnv(envPath);

	// Change into the requested directory so that relative paths (config.json,
	// projectDir) resolve against it.
	if (dir) process.chdir(dir);

	const config = await loadConfig(configPath);
	// --port wins over config.server.port; both default to 4096.
	if (portOverride !== undefined) config.server.port = portOverride;

	// WS clients + broadcast sink shared with the host.
	const sockets = new Set<WebSocket>();
	const broadcast = (event: WsEvent): void => {
		const data = JSON.stringify(event);
		for (const ws of sockets) {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		}
	};

	const host = new SessionHost(config, CLIENT_VERSION, broadcast);
	const store = new SessionStore(config.server.projectDir + "/.acp-data");
	const ctx: RouteContext = { host, store, config };

	const httpServer = createServer((req, res) => {
		void handleRequest(req, res, ctx);
	});

	const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
	wss.on("connection", (ws) => {
		sockets.add(ws);
		ws.send(JSON.stringify({ type: "connected" } satisfies WsEvent));
		ws.on("close", () => sockets.delete(ws));
		ws.on("error", () => sockets.delete(ws));
	});

	const port = config.server.port;
	// Bind to 0.0.0.0 so the server is reachable from other machines on the
	// network (e.g. http://<host-ip>:<port>/), not just localhost.
	const host_addr = config.server.host ?? "0.0.0.0";
	await new Promise<void>((resolve) =>
		httpServer.listen(port, host_addr, resolve),
	);
	const ip = advertisedIp();
	console.error(
		`Standalone ACP client listening\n` +
			`  Bind: ${host_addr}\n` +
			`  IP: ${machineIp()}\n` +
			`  Port: ${port}\n` +
			`  Current dir: ${process.cwd()}\n` +
			`  URL: http://${ip}:${port}\n` +
			`  WebSocket: ws://${ip}:${port}${WS_PATH}\n` +
			`  Project dir: ${host.projectDir()}\n` +
			`  Agents: ${Object.keys(config.agents).join(", ")}`,
	);

	const shutdown = async (): Promise<void> => {
		console.error("\nShutting down…");
		await host.shutdown();
		httpServer.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): Promise<void> {
	// Permissive CORS for the local browser bundle.
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
	res.setHeader("access-control-allow-headers", "content-type");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url ?? "/", "http://localhost");

	// Liveness probe.
	if (req.method === "GET" && url.pathname === "/health") {
		send(res, 200, { ok: true });
		return;
	}

	// Static web bundle (index.html, main.js, main.css). Non-/api, non-/ws GETs
	// are served from dist-web/ when the bundle has been built.
	if (
		req.method === "GET" &&
		!url.pathname.startsWith("/api/") &&
		url.pathname !== WS_PATH
	) {
		if (await serveStatic(url.pathname, res)) return;

		// No bundle: root falls back to the human-readable status page so the
		// server is still discoverable in a browser before `npm run build:web`.
		if (url.pathname === "/") {
			const html = landingPage(ctx);
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-length": Buffer.byteLength(html),
			});
			res.end(html);
			return;
		}
	}

	const key = `${req.method} ${url.pathname}` as RouteKey;
	const handler = routes[key];

	if (!handler) {
		send(res, 404, { error: `No route for ${key}` });
		return;
	}

	try {
		const body =
			req.method === "GET" ? {} : ((await readBody(req)) as never);
		// Route handlers are (ctx, body) => result | Promise<result>.
		const result = await (
			handler as (c: RouteContext, b: unknown) => unknown
		)(ctx, body);
		send(res, 200, result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Client errors: 400 for bad input, 409 for wrong lifecycle state.
		let status = 500;
		if (/^Bad request:/.test(message)) status = 400;
		else if (/^Forbidden:/.test(message)) status = 403;
		else if (/^Conflict:/.test(message)) status = 409;
		else if (/^Upstream:|^Partial mutation:/.test(message)) status = 502;
		else if (/not initialized|Unknown agent|No live client/.test(message))
			status = 409;
		send(res, status, { error: message });
	}
}

// ---- entry ----------------------------------------------------------------

const argv = process.argv.slice(2);
const configFlag = argv.indexOf("--config");
const configPath = configFlag >= 0 ? argv[configFlag + 1] : "config.json";
const dirFlag = argv.indexOf("--dir");
const startDir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
const envFlag = argv.indexOf("--env");
const envPath = envFlag >= 0 ? argv[envFlag + 1] : undefined;
const portFlag = argv.indexOf("--port");
let portOverride: number | undefined;
if (portFlag >= 0) {
	const parsed = Number(argv[portFlag + 1]);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		console.error(`✗ invalid --port "${argv[portFlag + 1]}"`);
		process.exit(1);
	}
	portOverride = parsed;
}

if (argv.includes("--cli")) {
	runCli(argv).catch((err) => {
		console.error("\n✗ harness failed:", err);
		process.exit(1);
	});
} else {
	runServer(configPath, startDir, portOverride, envPath).catch((err) => {
		console.error("✗ server failed:", err);
		process.exit(1);
	});
}
