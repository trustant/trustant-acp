/**
 * Trustable Pi execution contract — version 2.
 *
 * This file is installed beside the TruACP server and passed to Pi through the
 * typed `_meta.trustable.piLaunch` contract. It deliberately has no dependency
 * on trustable-acp source files so the packaged VM/pod artifact is complete.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface TrustableRuntimeWorkbench {
	app: string;
	workspace: string;
	developmentUrl: string;
	browserUrl: string;
	requiredMcpServers: string[];
	mcpConfig?: string;
	watcherLog: string;
}

interface BeforeAgentStartEvent {
	systemPrompt: string;
}

interface ManagedAgentMessage {
	role: string;
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		[key: string]: unknown;
	}>;
	stopReason?: string;
	errorMessage?: string;
	[key: string]: unknown;
}

interface MessageEvent {
	message: ManagedAgentMessage;
}

interface MessageUpdateEvent extends MessageEvent {
	assistantMessageEvent: {
		type: string;
		[key: string]: unknown;
	};
}

interface ToolCallEvent {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolResultEvent {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
	details: unknown;
}

export interface ManagedMcpInvocation {
	mode: "status" | "connect" | "list" | "call";
	server?: string;
	tool?: string;
	args: Record<string, unknown>;
}

interface PendingToolAttempt {
	signature: string;
	mutation: boolean;
	frontendMutation: boolean;
	invocation?: ManagedMcpInvocation;
	actionCreation: boolean;
	redeploy: boolean;
	checker: boolean;
	reactValidation: boolean;
}

export interface TrustableRedeployResult {
	app: string;
	actionList: string;
}

export type TrustableRedeployFetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

interface ExtensionContext {
	cwd: string;
	abort(): void;
}

interface TrustableExtensionApi {
	on(
		event: "before_agent_start",
		handler: (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		) => Promise<{ systemPrompt: string } | undefined>,
	): void;
	on(
		event: "message_start",
		handler: (
			event: MessageEvent,
			ctx: ExtensionContext,
		) => Promise<void> | void,
	): void;
	on(
		event: "message_update",
		handler: (
			event: MessageUpdateEvent,
			ctx: ExtensionContext,
		) => Promise<void> | void,
	): void;
	on(
		event: "message_end",
		handler: (
			event: MessageEvent,
			ctx: ExtensionContext,
		) =>
			| Promise<{ message?: ManagedAgentMessage } | undefined>
			| { message?: ManagedAgentMessage }
			| undefined,
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute(
			toolCallId: string,
			params: { lines?: number },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: unknown;
		}>;
	}): void;
	on(
		event: "tool_call",
		handler: (
			event: ToolCallEvent,
			ctx: ExtensionContext,
		) => Promise<{ block: true; reason: string } | undefined>,
	): void;
	on(
		event: "tool_result",
		handler: (
			event: ToolResultEvent,
			ctx: ExtensionContext,
		) => Promise<
			{ content?: ToolResultEvent["content"]; details?: unknown; isError?: boolean } | undefined
		>,
	): void;
}

export const MANAGED_REPEATED_STREAM_ERROR =
	"Agent stopped because the provider repeated the same streamed response.";

export function managedRepeatedStreamTextDetected(
	message: ManagedAgentMessage,
	repetitions = 4,
	windowWords = 32,
): boolean {
	if (repetitions < 2 || windowWords < 8) {
		return false;
	}
	const words = message.content
		.flatMap((entry) => (entry.type === "text" ? [entry.text ?? ""] : []))
		.join(" ")
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}_-]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length < repetitions * windowWords) {
		return false;
	}

	// WHY: this is the fork's reviewed invariant moved to the upstream
	// extension boundary. Exact normalized word windows ignore formatting
	// deltas and avoid a global turn/step budget that would stop healthy runs.
	const occurrences = new Map<string, number>();
	for (let index = 0; index <= words.length - windowWords; index += 1) {
		const signature = words.slice(index, index + windowWords).join(" ");
		const count = (occurrences.get(signature) ?? 0) + 1;
		if (count >= repetitions) {
			return true;
		}
		occurrences.set(signature, count);
	}
	return false;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`Trustable runtime ${field} must be a non-empty string`,
		);
	}
	return value;
}

export function pathIsWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalDirectory(path: string, field: string): string {
	const value = nonEmptyString(path, field);
	if (!isAbsolute(value)) {
		throw new Error(
			`Trustable runtime ${field} must be absolute: ${value}`,
		);
	}
	const canonical = realpathSync(value);
	if (!statSync(canonical).isDirectory()) {
		throw new Error(
			`Trustable runtime ${field} is not a directory: ${value}`,
		);
	}
	return canonical;
}

/**
 * Revalidate the host contract inside Pi.
 *
 * WHY: TruACP validates before constructing session metadata, but the policy
 * extension must not trust process cwd or a manifest that changed between
 * adapter startup and Pi loading.
 */
export function loadTrustableRuntimeManifest(
	workingDirectory = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): TrustableRuntimeWorkbench {
	if (env.TRUSTABLE_MANAGED_RUNTIME !== "1") {
		throw new Error(
			"Trustable runtime extension requires TRUSTABLE_MANAGED_RUNTIME=1",
		);
	}
	const manifestPath = nonEmptyString(
		env.TRUSTABLE_RUNTIME_CONFIG,
		"manifest path",
	);
	const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
		string,
		unknown
	>;
	if (raw.version !== 2) {
		throw new Error(
			`Unsupported Trustable Pi runtime version ${String(raw.version)} (expected 2)`,
		);
	}
	const cwd = canonicalDirectory(workingDirectory, "working directory");
	if (!Array.isArray(raw.workbenches) || raw.workbenches.length === 0) {
		throw new Error(
			"Trustable Pi runtime manifest must declare at least one workbench",
		);
	}
	const workbenches = raw.workbenches.map(
		(rawWorkbench, index): TrustableRuntimeWorkbench => {
			if (
				!rawWorkbench ||
				typeof rawWorkbench !== "object" ||
				Array.isArray(rawWorkbench)
			) {
				throw new Error(
					`Trustable runtime workbenches[${index}] must be a JSON object`,
				);
			}
			const record = rawWorkbench as Record<string, unknown>;
			const workspace = canonicalDirectory(
				nonEmptyString(
					record.workspace,
					`workbenches[${index}].workspace`,
				),
				`workbenches[${index}].workspace`,
			);
			const watcherLog = canonicalPrivateFile(
				nonEmptyString(
					record.watcherLog,
					`workbenches[${index}].watcherLog`,
				),
				`workbenches[${index}].watcherLog`,
			);
			if (pathIsWithin(workspace, watcherLog)) {
				throw new Error(
					`Trustable runtime workbenches[${index}].watcherLog must remain outside the workbench`,
				);
			}
			const mcpConfig = canonicalPrivateFile(
				nonEmptyString(
					record.mcpConfig,
					`workbenches[${index}].mcpConfig`,
				),
				`workbenches[${index}].mcpConfig`,
			);
			if (pathIsWithin(workspace, mcpConfig)) {
				throw new Error(
					`Trustable runtime workbenches[${index}].mcpConfig must remain outside the workbench`,
				);
			}
			return {
				app: nonEmptyString(record.app, `workbenches[${index}].app`),
				workspace,
				developmentUrl: validHttpUrl(
					record.developmentUrl,
					`workbenches[${index}].developmentUrl`,
				),
				browserUrl: validHttpUrl(
					record.browserUrl,
					`workbenches[${index}].browserUrl`,
				),
				requiredMcpServers: requiredServerNames(
					record.requiredMcpServers,
					index,
				),
				mcpConfig,
				watcherLog,
			};
		},
	);
	const matches = workbenches.filter((workbench) =>
		pathIsWithin(workbench.workspace, cwd),
	);
	if (matches.length !== 1) {
		throw new Error(
			`Trustable runtime expected one workbench for ${cwd}, found ${matches.length}`,
		);
	}
	const selected = matches[0];

	// Re-read the standard project config at Pi load time. WHY: a stale cached
	// server list must not satisfy the host contract after .mcp.json changed.
	const mcpPath = join(selected.workspace, ".mcp.json");
	const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
		mcpServers?: Record<string, unknown>;
	};
	const configured = new Set(Object.keys(mcp.mcpServers ?? {}));
	const missing = selected.requiredMcpServers.filter(
		(name) => !configured.has(name),
	);
	if (missing.length > 0) {
		throw new Error(
			`Managed MCP config is missing required servers: ${missing.join(", ")}`,
		);
	}
	return selected;
}

function canonicalPrivateFile(path: string, field: string): string {
	const value = nonEmptyString(path, field);
	if (!isAbsolute(value)) {
		throw new Error(
			`Trustable runtime ${field} must be absolute: ${value}`,
		);
	}
	const canonical = realpathSync(value);
	const info = statSync(canonical);
	if (!info.isFile()) {
		throw new Error(`Trustable runtime ${field} is not a file: ${value}`);
	}
	if ((info.mode & 0o077) !== 0) {
		throw new Error(
			`Trustable runtime ${field} must be private (expected mode 0600): ${value}`,
		);
	}
	return canonical;
}

function validHttpUrl(value: unknown, field: string): string {
	const raw = nonEmptyString(value, field);
	const parsed = new URL(raw);
	if (
		!parsed.hostname ||
		(parsed.protocol !== "http:" && parsed.protocol !== "https:")
	) {
		throw new Error(
			`Trustable runtime ${field} must use HTTP or HTTPS: ${raw}`,
		);
	}
	return raw;
}

function requiredServerNames(value: unknown, index: number): string[] {
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string" || !entry.trim())
	) {
		throw new Error(
			`Trustable runtime workbenches[${index}].requiredMcpServers must be an array of non-empty strings`,
		);
	}
	const names = [...new Set(value as string[])].sort();
	if (names.length === 0) {
		throw new Error(
			`Trustable runtime workbenches[${index}] declares no required MCP servers`,
		);
	}
	return names;
}

function jsonObject(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string" || !value.trim()) {
		return {};
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Normalize both pi-mcp-adapter call shapes into one policy-facing contract.
 *
 * WHY: current Pi calls the proxy as
 * `mcp({tool:"openserverless_action_new", args:"{...}"})`, while early
 * Trustable tests used `{server:"openserverless", tool:"action_new"}`. Server
 * discovery also has two real shapes: `{server:"..."}` lists cached tools,
 * while `{connect:"..."}` performs lazy connection plus metadata refresh. A
 * guardrail that recognizes only the early test shapes is visible in tests but
 * absent from real sessions.
 */
export function managedMcpInvocation(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: string[] = [],
): ManagedMcpInvocation | undefined {
	if (toolName !== "mcp") {
		return undefined;
	}
	const explicitServer =
		typeof input.server === "string" && input.server.trim()
			? input.server.trim().toLowerCase()
			: undefined;
	const connectedServer =
		typeof input.connect === "string" && input.connect.trim()
			? input.connect.trim().toLowerCase()
			: undefined;
	const requestedTool =
		typeof input.tool === "string" && input.tool.trim()
			? input.tool.trim().toLowerCase().replaceAll("-", "_")
			: undefined;
	if (!requestedTool) {
		// WHY: pi-mcp-adapter 2.11 emits `connect` during real capability
		// bootstrap. trulongrun6 proved that treating it as global status left
		// every required server "unlisted" and blocked all subsequent work.
		if (connectedServer) {
			return {
				mode: "connect",
				server: connectedServer,
				args: {},
			};
		}
		return explicitServer
			? { mode: "list", server: explicitServer, args: {} }
			: { mode: "status", args: {} };
	}
	const candidates = [
		...new Set([
			...knownServers.map((name) => name.toLowerCase()),
			"openserverless",
			"agentireact",
			"browser",
			"react",
			"postgres",
			"redis",
			"mongodb",
			"milvus",
			"s3",
		]),
	].sort((left, right) => right.length - left.length);
	const inferredServer = candidates.find((name) =>
		requestedTool.startsWith(`${name}_`),
	);
	const server = explicitServer ?? inferredServer;
	const normalizedTool =
		server && requestedTool.startsWith(`${server}_`)
			? requestedTool.slice(server.length + 1)
			: requestedTool;
	return {
		mode: "call",
		server,
		tool: normalizedTool,
		args: jsonObject(input.args),
	};
}

export function trustableRuntimeSystemPrompt(
	workbench: TrustableRuntimeWorkbench,
): string {
	return [
		'<trustable_runtime version="2" priority="mandatory">',
		"  This process is managed by Trustable. This host contract has priority over repository guidance.",
		`  Current application: ${workbench.app}`,
		`  Workbench root: ${workbench.workspace}`,
		`  Local development URL: ${workbench.developmentUrl}`,
		`  Browser-visible application URL: ${workbench.browserUrl}`,
		`  Required MCP servers: ${workbench.requiredMcpServers.join(", ")}`,
		"  Operate only inside the declared workbench.",
		"  MCP discovery is host-managed and credential-free. Never read the private MCP config, inspect managed-process environments, or start MCP server commands manually.",
		"  Before application work, complete the mandatory MCP bootstrap with either sequence: (a) call mcp({}) once, then mcp({server:\"<name>\"}) for every required server listed above; or (b) call mcp({connect:\"<name>\"}) for every required server. A successful connect is stronger evidence and satisfies both proxy reachability and that server's tool discovery. Use the exact tool names and schemas returned by those calls. Do not infer tool availability from memory or repository prose.",
		"  Treat service MCPs as discovery and read-only verification interfaces. Application schemas, seed data, and writes belong in reproducible setup/actions created through the OpenServerless MCP, never in direct service-MCP repair calls.",
		"  Run the deterministic React MCP react_validate after frontend mutations and before Browser MCP verification. Agentic React is optional selection context, not source validation.",
		"  The existing ops ide devel watcher is the sole owner of live action deployment. Never run ops ide deploy or start another ops ide devel process.",
		"  After one or more successful action_new creations, finish the coherent action/wiring/source batch and call trustable_runtime_redeploy exactly once before watcher status, the action checker, HTTP checks, or browser verification. This invokes the same safe redeploy workflow as the Trustable UI without racing the watcher.",
		"  After redeploy, call trustable_runtime_status to read the managed watcher evidence, then run the action checker once and perform real HTTP checks. In managed live mode the checker validates source contracts without using sibling ZIP freshness.",
		"  Never inspect, search, stat, or poll packages/**/*.zip. Do not infer watcher state from archive paths, process searches, repeated checker calls, or longer timeouts.",
		"  Use the local development URL through the Browser MCP and the browser-visible URL only for external verification; do not infer another host.",
		"  Application .env and .env.production files are immutable agent boundaries. Never read, create, edit, import, synchronize, or regenerate them. Only the user may change application environment values through the Trustable configuration interface; report a missing value without attempting to create it.",
		"  For authenticated application pages, create all endpoints first and call the OpenServerless auth_setup tool once with the complete token, protected/session, and logout endpoint sets. It atomically adds Redis wiring; use opaque random session tokens with an expiry, build every key from ctx.REDIS_PREFIX, validate the Redis session on every protected request, and delete it on logout. Never use JWT or an application secret as the session foundation.",
		"  Never create or edit generated packages/<package>/<action>/__main__.py wrappers or packages/**/*.zip artifacts. Use the exposed OpenServerless action and connector tools; never invent commands such as ops ide action invoke.",
		"  Execute available bounded checks yourself instead of delegating shell commands to the user.",
		"</trustable_runtime>",
	].join("\n");
}

function redactWatcherLog(value: string): string {
	return value
		.replace(
			/\b(authorization|api[_-]?key|token|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/gi,
			"$1$2[REDACTED]",
		)
		.replace(
			/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi,
			"$1[REDACTED]@",
		)
		.replace(
			/(\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)\b)(\s*[:=]\s*)([^\s,;]+)/g,
			"$1$2[REDACTED]",
		)
		.replace(
			/(\s(?:-p|--param)\s+[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g,
			"$1[REDACTED]",
		);
}

function isSecretPath(
	path: string,
	workspace: string,
	privateMcpConfig?: string,
): boolean {
	const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
	const name = basename(absolute);
	return (
		(privateMcpConfig !== undefined &&
			resolve(absolute) === resolve(privateMcpConfig)) ||
		name === ".env" ||
		name.startsWith(".env.") ||
		absolute.includes(`${sep}.trustable${sep}secrets${sep}`)
	);
}

/**
 * Block every direct application env access and every MCP operation that can
 * synthesize a value without the user-facing Trustable configuration flow.
 *
 * WHY: a captured long run printed APP_SECRET after Pi inspected `.env`.
 * The environment editor is also the sole configuration owner, so prompt
 * guidance alone cannot protect credentials or prevent configuration drift.
 */
export function managedSecretAccessBlockReason(
	toolName: string,
	input: Record<string, unknown>,
	workspace: string,
	knownServers: string[] = [],
	privateMcpConfig?: string,
): string | undefined {
	if (
		(toolName === "read" || toolName === "write" || toolName === "edit") &&
		typeof input.path === "string" &&
		isSecretPath(input.path, workspace, privateMcpConfig)
	) {
		return "Trustable blocked direct application env access. Only the user may change .env values through the Trustable configuration interface; report the missing variable without reading or modifying the file.";
	}
	if (
		(toolName === "bash" || toolName === "shell") &&
		typeof input.command === "string" &&
		/(?:^|[\s"'\/])\.env(?:\.[A-Za-z0-9_-]+)?(?:$|[\s"'\/])/m.test(
			input.command,
		)
	) {
		return "Trustable blocked shell access to an application env file. Only the user may change environment values through the Trustable configuration interface.";
	}
	if (
		(toolName === "bash" || toolName === "shell") &&
		typeof input.command === "string" &&
		((privateMcpConfig !== undefined &&
			input.command.includes(privateMcpConfig)) ||
			/TRUSTABLE_(?:RUNTIME|MCP)_CONFIG|\.config\/trustable\/runtime\/[^\s"']*mcp\.json/i.test(
				input.command,
			))
	) {
		return "Trustable blocked access to host-private MCP configuration. Use the managed MCP tools and credential-free server list; never inspect or launch their private process configuration.";
	}
	if (
		(toolName === "bash" || toolName === "shell") &&
		typeof input.command === "string" &&
		/(?:^|[;&|]\s*|\b(?:exec|env|timeout|command)\s+)(?:trustable-mcp-launch|trustable-browser-mcp|trustable-react-mcp|openserverless-mcp|postgres-mcp|redis-mcp-server|mcp-server-milvus|mongodb-mcp-server|mcp-s3)\b/m.test(
			input.command,
		)
	) {
		return "Trustable blocked direct startup of a managed MCP server. Use the host-selected MCP tools so lifecycle, ordering, reconnection, and credential injection remain managed.";
	}
	const invocation = managedMcpInvocation(toolName, input, knownServers);
	if (
		invocation?.mode === "call" &&
		invocation.server === "openserverless" &&
		invocation.tool === "secret_ensure"
	) {
		return "Trustable blocked automatic environment-secret creation. Application env values are user-managed in the Trustable configuration interface; use Redis-backed opaque sessions for page authentication.";
	}
	return undefined;
}

function managedTargetPath(
	path: string,
	workspace: string,
	workingDirectory: string,
): string {
	return isAbsolute(path) ? resolve(path) : resolve(workingDirectory, path);
}

/**
 * Reject edits to OpenServerless-generated action wrappers and deploy archives.
 *
 * WHY: the trulongrun3 session rewrote generated `__main__.py` files and then
 * polled sibling ZIPs. That bypassed connector ownership and left actions with
 * inconsistent Redis bindings even though their business modules looked valid.
 */
export function managedGeneratedArtifactBlockReason(
	toolName: string,
	input: Record<string, unknown>,
	workspace: string,
	workingDirectory = workspace,
): string | undefined {
	if (toolName !== "write" && toolName !== "edit") {
		return undefined;
	}
	const requestedPath = input.path;
	if (typeof requestedPath !== "string" || !requestedPath.trim()) {
		return undefined;
	}
	const target = managedTargetPath(
		requestedPath,
		workspace,
		workingDirectory,
	);
	if (!pathIsWithin(workspace, target)) {
		return undefined;
	}
	const parts = relative(workspace, target).split(sep);
	if (parts[0] !== "packages") {
		return undefined;
	}
	if (basename(target) === "__main__.py" || target.endsWith(".zip")) {
		return "Trustable blocked a write to an OpenServerless-generated wrapper or deploy artifact. Create actions and add Redis/service wiring with the exposed OpenServerless MCP tools (use auth_setup for the complete authentication endpoint set), then edit only the generated business module.";
	}
	if (
		existsSync(workspace) &&
		target.endsWith(".py") &&
		parts.length >= 4 &&
		!existsSync(join(workspace, parts[0], parts[1], parts[2], "__main__.py"))
	) {
		return "Trustable blocked creation of a business module before its OpenServerless action scaffold exists. Call the discovered OpenServerless action_new tool first, then edit only the business module it generated.";
	}
	return undefined;
}

const SERVICE_MCP_MUTATIONS: Record<string, RegExp> = {
	postgres:
		/(?:^|_)(?:execute_sql|create|alter|drop|truncate|insert|update|delete|grant|revoke)(?:_|$)/,
	redis:
		/(?:^|_)(?:set|delete|del|hset|hdel|lpush|rpush|sadd|srem|zadd|zrem|expire|persist|rename|flush|incr|decr)(?:_|$)/,
	mongodb:
		/(?:^|_)(?:insert|update|delete|replace|bulk|create|drop|rename|write)(?:_|$)/,
	s3: /(?:^|_)(?:put|upload|delete|copy|create)(?:_|$)/,
	milvus:
		/(?:^|_)(?:insert|upsert|delete|create|drop|load|release|compact|flush)(?:_|$)/,
};

/**
 * Keep service MCPs diagnostic during application generation.
 *
 * WHY: trulongrun3 used `postgres_execute_sql` to patch the live database.
 * That made the current run appear healthier while a clean app still lacked
 * the schema/seed action needed to reproduce the state.
 */
export function managedServiceMcpMutationBlockReason(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: string[] = [],
): string | undefined {
	const invocation = managedMcpInvocation(
		toolName,
		input,
		knownServers,
	);
	if (
		invocation?.mode !== "call" ||
		!invocation.server ||
		!invocation.tool
	) {
		return undefined;
	}
	const server = invocation.server;
	const mutation = SERVICE_MCP_MUTATIONS[server];
	if (!mutation) {
		return undefined;
	}
	if (!mutation.test(invocation.tool)) {
		return undefined;
	}
	return `Trustable blocked the mutating ${server} MCP tool '${invocation.tool}' during application generation. Put schema and seed changes in an idempotent setup action and application writes in OpenServerless actions; service MCPs remain available for read-only verification.`;
}

export function readTrustableRuntimeStatus(
	workbench: TrustableRuntimeWorkbench,
	requestedLines = 80,
): {
	app: string;
	watcher: "ops ide devel";
	updatedAt: string;
	lines: string[];
} {
	const lines = Math.max(1, Math.min(200, Math.trunc(requestedLines)));
	const info = statSync(workbench.watcherLog);
	const content = redactWatcherLog(
		readFileSync(workbench.watcherLog, "utf8"),
	);
	return {
		app: workbench.app,
		watcher: "ops ide devel",
		updatedAt: info.mtime.toISOString(),
		lines: content.split(/\r?\n/).slice(-lines),
	};
}

/**
 * Return a deterministic managed-runtime rejection for deployment commands.
 *
 * WHY: `ops ide devel` packages and deploys action changes continuously. A
 * concurrent `ops ide deploy` races that watcher, can leave two deploy tasks
 * waiting on the same artifacts, and previously sent Pi into timeout/retry
 * loops. Read-only searches that merely mention the command remain allowed.
 */
export function managedShellCommandBlockReason(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	if (toolName !== "bash" && toolName !== "shell") {
		return undefined;
	}
	const command = input.command;
	if (typeof command !== "string" || !command.trim()) {
		return undefined;
	}
	// WHY: ZIPs are derived watcher state, not an application-facing contract.
	// Direct archive inspection caused Pi to turn one deployment failure into
	// repeated ls/find/test polling instead of reading the canonical log.
	if (
		/(?:^|[/"'\s])packages(?:\/|\s)/i.test(command) &&
		/(?:\.zip\b|\*\.zip\b)/i.test(command)
	) {
		return "Trustable blocked direct inspection or mutation of watcher-owned packages/**/*.zip artifacts. Read trustable_runtime_status, run check_openserverless_actions.sh once for source-contract validation, and verify the real HTTP endpoint.";
	}
	// WHY: these commands mutate the managed VM or bypass connector-owned
	// scaffolding. Long runs previously used them to repair only the current
	// instance, leaving a clean checkout broken.
	if (
		/(?:^|[;&|]\s*)(?:timeout\s+\S+\s+)?(?:wsk|ops)\s+action\b/i.test(
			command,
		)
	) {
		return "Trustable blocked direct action administration. Discover and use the OpenServerless MCP action tools so generated wrappers, bindings, and source remain reproducible.";
	}
	if (
		/(?:^|[;&|]\s*)(?:timeout\s+\S+\s+)?(?:psql|redis-cli|mongosh|mongo|minio|mc|milvus_cli)\b/i.test(
			command,
		)
	) {
		return "Trustable blocked a direct service CLI. Service MCPs are read-only verification interfaces; implement schema, seed, and application writes in reproducible OpenServerless setup/actions.";
	}
	if (
		/(?:^|[;&|]\s*)(?:sudo\s+)?(?:apt(?:-get)?\s+install|pip3?\s+install|uv\s+pip\s+install|npm\s+install\s+-g)\b/i.test(
			command,
		)
	) {
		return "Trustable blocked an ad-hoc dependency installation. Declare action dependencies through the OpenServerless action requirements tool or project package metadata; do not mutate the managed VM.";
	}
	if (
		/(?:generate_wrappers?\.py|__main__\.py)/i.test(command) ||
		/\b(?:rm\s+-[^\n;]*r[^\n;]*|mkdir|touch|cp|mv)\b[^\n;]*\bpackages\//i.test(
			command,
		)
	) {
		return "Trustable blocked manual OpenServerless scaffolding or generated-wrapper manipulation. Create the action with the OpenServerless MCP, then edit only its generated business module.";
	}
	if (
		/(?:\b(?:sed\s+-i|perl\s+-pi|tee)\b|(?:^|[;&|]\s*)(?:cat|printf|echo)\b|>{1,2})[^\n]*(?:packages|src)\//i.test(
			command,
		)
	) {
		return "Trustable blocked a shell-based source mutation. Use the typed write/edit tools so workbench boundaries, generated artifacts, frontend validation, and semantic progress are enforced.";
	}
	if (/\bgit\s+(?:checkout|restore|reset|clean)\b/i.test(command)) {
		return "Trustable blocked a destructive Git recovery command. Inspect the current diff and repair only the intended files without discarding application work.";
	}
	const managedCommand =
		/^(?:timeout\s+\S+\s+)?(?:env\s+(?:\S+=\S+\s+)*)?(?:command\s+)?ops\s+ide\s+(deploy|devel)\b/;
	const blocked = command
		.split(/&&|\|\||;|\||\r?\n/)
		.map((segment) => segment.trim())
		.find((segment) => managedCommand.test(segment));
	if (!blocked) {
		return undefined;
	}
	return "Trustable blocked a manual ops ide deploy/devel command because the existing managed ops ide devel watcher owns live action deployment. Read trustable_runtime_status, run check_openserverless_actions.sh once and perform HTTP checks; do not retry with a longer timeout.";
}

export function managedCheckerCommandBlockReason(
	command: string,
	checkerAlreadyRan: boolean,
): string | undefined {
	if (!/\bcheck_openserverless_actions\.sh\b/.test(command)) {
		return undefined;
	}
	// WHY: output truncation hid the first actionable watcher/checker error in
	// the captured long run and made a failed check appear inconclusive.
	if (/\|\||\|\s*(?:head|tail)\b/.test(command)) {
		return "Trustable blocked a masked action checker command. Run timeout 60 check_openserverless_actions.sh . once without ||, head, or tail so the complete source-contract result remains visible.";
	}
	if (checkerAlreadyRan) {
		return "Trustable blocked a repeated action checker call without a relevant source or OpenServerless wiring change. Read trustable_runtime_status and verify the real HTTP endpoint; rerun the checker only after a new mutation.";
	}
	return undefined;
}

export function isManagedActionMutation(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: string[] = [],
): boolean {
	if (toolName === "write" || toolName === "edit") {
		return true;
	}
	const invocation = managedMcpInvocation(
		toolName,
		input,
		knownServers,
	);
	if (
		invocation?.mode !== "call" ||
		invocation.server !== "openserverless"
	) {
		return false;
	}
	const tool = invocation.tool;
	return (
		typeof tool === "string" &&
		/^(?:action_new|action_requirements|action_add_|secret_(?:ensure|bind|unbind)|auth_setup)/.test(
			tool,
		)
	);
}

function stableValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableValue).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function semanticShellStrategy(command: string): string {
	const normalized = command
		.toLowerCase()
		.replace(/\btimeout\s+\d+(?:\.\d+)?/g, "timeout")
		.replace(/\s+/g, " ")
		.trim();
	if (/\bcheck_openserverless_actions\.sh\b/.test(normalized)) {
		return "checker";
	}
	if (/\bcurl\b/.test(normalized)) {
		const endpoint =
			normalized.match(/https?:\/\/[^\s"'|;&]+/)?.[0] ?? normalized;
		return `http:${endpoint}`;
	}
	return normalized;
}

export function managedAttemptSignature(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: string[] = [],
): string {
	const invocation = managedMcpInvocation(
		toolName,
		input,
		knownServers,
	);
	if (invocation?.mode === "call") {
		return `mcp:${invocation.server ?? "unknown"}:${invocation.tool ?? "unknown"}:${stableValue(invocation.args)}`;
	}
	if (
		(toolName === "bash" || toolName === "shell") &&
		typeof input.command === "string"
	) {
		return `shell:${semanticShellStrategy(input.command)}`;
	}
	if (
		(toolName === "write" || toolName === "edit" || toolName === "read") &&
		typeof input.path === "string"
	) {
		return `${toolName}:${input.path}`;
	}
	return `${toolName}:${stableValue(input)}`;
}

function nonEmptyFailureValue(value: unknown): boolean {
	if (value === false) {
		return true;
	}
	if (typeof value === "string") {
		return Boolean(value.trim());
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	return value !== undefined && value !== null;
}

function detailsReportFailure(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (
		("error" in record && nonEmptyFailureValue(record.error)) ||
		record.ok === false ||
		record.success === false ||
		record.connected === false
	) {
		return true;
	}
	return Object.values(record).some((entry) => detailsReportFailure(entry));
}

export function managedToolResultFailed(event: ToolResultEvent): boolean {
	if (event.isError || detailsReportFailure(event.details)) {
		return true;
	}
	const text = event.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	return /(?:^|\n)\s*(?:error|failed|failure|traceback)\b|(?:connection refused|access denied|permission denied)/i.test(
		text,
	);
}

export class ManagedSemanticCircuit {
	private revision = 0;
	private readonly failures = new Map<
		string,
		{ failures: number; revision: number }
	>();

	resetForUserTurn(): void {
		this.failures.clear();
	}

	blockReason(signature: string): string | undefined {
		const state = this.failures.get(signature);
		if (
			!state ||
			state.revision !== this.revision ||
			state.failures < 3
		) {
			return undefined;
		}
		return "Trustable stopped a repeated no-progress strategy after three semantically equivalent failures. Read the concrete MCP/watcher evidence, change the hypothesis or inputs, and make a relevant source/wiring change before trying again.";
	}

	recordFailure(signature: string): void {
		const previous = this.failures.get(signature);
		this.failures.set(signature, {
			failures:
				previous?.revision === this.revision
					? previous.failures + 1
					: 1,
			revision: this.revision,
		});
	}

	recordSuccess(signature: string, mutation: boolean): void {
		this.failures.delete(signature);
		if (!mutation) {
			return;
		}
		this.revision += 1;
		this.failures.clear();
	}
}

export function managedBootstrapBlockReason(
	toolName: string,
	input: Record<string, unknown>,
	statusSeen: boolean,
	listedServers: ReadonlySet<string>,
	requiredServers: string[],
): string | undefined {
	const missingServers = requiredServers.filter(
		(server) => !listedServers.has(server),
	);
	const complete = statusSeen && missingServers.length === 0;
	if (complete) {
		return undefined;
	}
	const invocation = managedMcpInvocation(
		toolName,
		input,
		requiredServers,
	);
	if (
		invocation?.mode === "status" ||
		((invocation?.mode === "list" ||
			invocation?.mode === "connect") &&
			invocation.server &&
			requiredServers.includes(invocation.server))
	) {
		return undefined;
	}
	const isWork =
		invocation?.mode === "call" ||
		toolName === "write" ||
		toolName === "edit" ||
		toolName === "bash" ||
		toolName === "shell";
	if (!isWork) {
		return undefined;
	}
	// WHY: do not tell Pi to perform both equivalent bootstrap sequences. The
	// adapter's successful `connect` form supplies reachability and discovery,
	// while cached `server` listings still require the separate global status.
	const reachability = statusSeen
		? ""
		: "Prove MCP proxy reachability with mcp({}) or a successful required-server connect. ";
	const discovery = missingServers
		.map(
			(server) =>
				`mcp({connect:${JSON.stringify(server)}}) or mcp({server:${JSON.stringify(server)}})`,
		)
		.join(", ");
	return `Trustable blocked application work until the mandatory MCP bootstrap succeeds. ${reachability}Discover every missing server and use its exact returned tool schemas: ${discovery}.`;
}

/**
 * Apply only successful adapter discovery evidence to the managed bootstrap.
 *
 * WHY: `connect` is stronger than a cached server listing: it proves the MCP
 * proxy can reach the selected server and refresh its tool metadata. Keeping
 * this transition explicit also guarantees a failed connect cannot unlock
 * application work.
 */
export function recordManagedMcpBootstrapResult(
	invocation: ManagedMcpInvocation | undefined,
	succeeded: boolean,
	statusSeen: boolean,
	listedServers: Set<string>,
): boolean {
	if (!succeeded || !invocation) {
		return statusSeen;
	}
	if (
		(invocation.mode === "list" || invocation.mode === "connect") &&
		invocation.server
	) {
		listedServers.add(invocation.server);
	}
	return statusSeen ||
		invocation.mode === "status" ||
		invocation.mode === "connect";
}

function toolResultText(event: ToolResultEvent): string {
	return event.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

export function managedActionWasCreated(
	invocation: ManagedMcpInvocation | undefined,
	event: ToolResultEvent,
): boolean {
	return (
		invocation?.mode === "call" &&
		invocation.server === "openserverless" &&
		invocation.tool === "action_new" &&
		/(?:^|\n)Created endpoint at\b/.test(toolResultText(event))
	);
}

export function managedRedeployVerificationBlockReason(
	toolName: string,
	input: Record<string, unknown>,
	redeployRequired: boolean,
	knownServers: string[] = [],
): string | undefined {
	if (!redeployRequired || toolName === "trustable_runtime_redeploy") {
		return undefined;
	}
	const invocation = managedMcpInvocation(toolName, input, knownServers);
	const command =
		(toolName === "bash" || toolName === "shell") &&
		typeof input.command === "string"
			? input.command
			: "";
	const verification =
		toolName === "trustable_runtime_status" ||
		(invocation?.mode === "call" &&
			(invocation.server === "browser" ||
				(invocation.server === "openserverless" &&
					invocation.tool === "action_invoke"))) ||
		/\b(?:check_openserverless_actions\.sh|curl|wget)\b/.test(command);
	if (!verification) {
		return undefined;
	}
	return "Trustable requires one safe redeploy after the latest successful action_new batch. Finish the coherent action/wiring/source changes, then call trustable_runtime_redeploy before watcher status, checker, HTTP, or browser verification.";
}

interface TrustableRedeployEvent {
	event: string;
	data: string;
}

export function parseTrustableRedeployEvents(
	body: string,
): TrustableRedeployEvent[] {
	const events: TrustableRedeployEvent[] = [];
	let event = "";
	let data: string[] = [];
	const flush = () => {
		if (event || data.length > 0) {
			events.push({ event: event || "message", data: data.join("\n") });
		}
		event = "";
		data = [];
	};
	for (const line of `${body}\n`.split(/\r?\n/)) {
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("event:")) {
			event = line.slice("event:".length).trim();
		} else if (line.startsWith("data:")) {
			data.push(line.slice("data:".length).trimStart());
		}
	}
	return events;
}

export async function requestTrustableRedeploy(
	app: string,
	fetchImpl: TrustableRedeployFetch = fetch,
	timeoutMs = 180_000,
): Promise<TrustableRedeployResult> {
	const url = new URL("http://127.0.0.1:8910/api/redeploy");
	url.searchParams.set("name", app);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				headers: { Accept: "text/event-stream" },
				signal: controller.signal,
			});
		} catch (error) {
			const detail =
				error instanceof Error ? error.message : String(error);
			throw new Error(`Trustable redeploy request failed: ${detail}`);
		}
		if (!response.ok) {
			throw new Error(
				`Trustable redeploy returned HTTP ${response.status} ${response.statusText}`.trim(),
			);
		}
		const events = parseTrustableRedeployEvents(await response.text());
		const failure = events.find((entry) => entry.event === "error");
		if (failure) {
			throw new Error(
				`Trustable redeploy failed: ${failure.data || "missing error detail"}`,
			);
		}
		const done = [...events]
			.reverse()
			.find((entry) => entry.event === "done");
		if (!done) {
			throw new Error(
				"Trustable redeploy ended without a completion event",
			);
		}
		return { app, actionList: done.data };
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(
				`Trustable redeploy timed out after ${timeoutMs}ms`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function authRedisBindingBlockReason(
	invocation: ManagedMcpInvocation | undefined,
): string | undefined {
	if (
		invocation?.mode !== "call" ||
		invocation.server !== "openserverless" ||
		invocation.tool !== "action_add_redis"
	) {
		return undefined;
	}
	const endpoint = Object.values(invocation.args)
		.filter((value) => typeof value === "string")
		.join(" ")
		.toLowerCase();
	if (!/(?:auth|login|logout|session|register|signup|me)\b/.test(endpoint)) {
		return undefined;
	}
	return "Trustable blocked piecemeal Redis binding for authentication endpoints. Create the complete endpoint set first, then call the discovered OpenServerless auth_setup tool once with all token, protected/session, and logout endpoints.";
}

export default function trustableRuntimeExtension(
	pi: TrustableExtensionApi,
): void {
	// Throwing during extension load is deliberate: managed Pi must never fall
	// back to an unguarded session when the host contract is unavailable.
	const manifest = loadTrustableRuntimeManifest();
	let checkerRanSinceMutation = false;
	let reactValidationRequired = false;
	let redeployRequired = false;
	let mcpStatusSeen = false;
	const listedMcpServers = new Set<string>();
	const pendingAttempts = new Map<string, PendingToolAttempt>();
	const semanticCircuit = new ManagedSemanticCircuit();
	let repeatedStreamAborted = false;

	pi.registerTool({
		name: "trustable_runtime_status",
		label: "Trustable runtime status",
		description:
			"Read the authoritative, redacted tail of the Trustable-managed ops ide devel watcher log for the current application.",
		promptSnippet:
			"Read managed ops ide devel state and recent redacted watcher output.",
		promptGuidelines: [
			"Use this before diagnosing action packaging/deployment or declaring the managed watcher stale.",
		],
		// WHY: the extension is installed outside Pi's npm package tree. Keep
		// its TypeBox-compatible JSON schema self-contained so loading it never
		// relies on package resolution from the Trustable installation path.
		parameters: {
			type: "object",
			properties: {
				lines: {
					type: "integer",
					minimum: 1,
					maximum: 200,
					description: "Number of recent watcher log lines to return",
				},
			},
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const current = loadTrustableRuntimeManifest();
			const status = readTrustableRuntimeStatus(current, params.lines);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(status, null, 2),
					},
				],
				details: status,
			};
		},
	});

	pi.registerTool({
		name: "trustable_runtime_redeploy",
		label: "Trustable redeploy",
		description:
			"Safely stop the managed watcher, deploy all current actions, and restart the watcher through the same Trustable workflow used by the UI Redeploy action.",
		promptSnippet:
			"Redeploy the current coherent action batch through the Trustable host.",
		promptGuidelines: [
			"Call once after one or more action_new creations and after finishing their coherent wiring/source batch.",
			"Do not replace this tool with ops ide deploy or another ops ide devel process.",
		],
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		async execute() {
			const current = loadTrustableRuntimeManifest();
			const result = await requestTrustableRedeploy(current.app);
			return {
				content: [
					{
						type: "text",
						text: `Trustable redeploy completed for ${result.app}.\n${result.actionList}`,
					},
				],
				details: {
					ok: true,
					app: result.app,
					actionList: result.actionList,
				},
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = loadTrustableRuntimeManifest(ctx.cwd);
		// WHY: keep capability discovery for this managed runtime, but let a new
		// user turn intentionally replace a failed strategy.
		semanticCircuit.resetForUserTurn();
		pendingAttempts.clear();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${trustableRuntimeSystemPrompt(current)}`,
		};
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			repeatedStreamAborted = false;
		}
	});

	pi.on("message_update", (event, ctx) => {
		if (
			repeatedStreamAborted ||
			event.message.role !== "assistant" ||
			event.assistantMessageEvent.type !== "text_delta"
		) {
			return;
		}
		if (managedRepeatedStreamTextDetected(event.message)) {
			repeatedStreamAborted = true;
			// Upstream Pi routes this extension action to the active RPC abort
			// handler. It cancels the current provider run without invalidating
			// the durable session or imposing any budget on later turns.
			ctx.abort();
		}
	});

	pi.on("message_end", (event) => {
		if (!repeatedStreamAborted || event.message.role !== "assistant") {
			return undefined;
		}
		repeatedStreamAborted = false;
		return {
			message: {
				...event.message,
				stopReason: "error",
				errorMessage: MANAGED_REPEATED_STREAM_ERROR,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = loadTrustableRuntimeManifest(ctx.cwd);
		const invocation = managedMcpInvocation(
			event.toolName,
			event.input,
			current.requiredMcpServers,
		);
		const secretBlockReason = managedSecretAccessBlockReason(
			event.toolName,
			event.input,
			current.workspace,
			current.requiredMcpServers,
			current.mcpConfig,
		);
		if (secretBlockReason) {
			return { block: true, reason: secretBlockReason };
		}
		const bootstrapBlockReason = managedBootstrapBlockReason(
			event.toolName,
			event.input,
			mcpStatusSeen,
			listedMcpServers,
			current.requiredMcpServers,
		);
		if (bootstrapBlockReason) {
			return { block: true, reason: bootstrapBlockReason };
		}
		const redeployBlockReason =
			managedRedeployVerificationBlockReason(
				event.toolName,
				event.input,
				redeployRequired,
				current.requiredMcpServers,
			);
		if (redeployBlockReason) {
			return { block: true, reason: redeployBlockReason };
		}
		const generatedArtifactBlockReason =
			managedGeneratedArtifactBlockReason(
				event.toolName,
				event.input,
				current.workspace,
				ctx.cwd,
			);
		if (generatedArtifactBlockReason) {
			return { block: true, reason: generatedArtifactBlockReason };
		}
		const serviceMutationBlockReason =
			managedServiceMcpMutationBlockReason(
				event.toolName,
				event.input,
				current.requiredMcpServers,
			);
		if (serviceMutationBlockReason) {
			return { block: true, reason: serviceMutationBlockReason };
		}
		const authBlockReason = authRedisBindingBlockReason(invocation);
		if (authBlockReason) {
			return { block: true, reason: authBlockReason };
		}
		if (
			reactValidationRequired &&
			invocation?.mode === "call" &&
			invocation.server === "browser"
		) {
			return {
				block: true,
				reason:
					"Trustable requires one deterministic react_validate call after the latest frontend mutation and before Browser MCP verification.",
			};
		}
		const shellBlockReason = managedShellCommandBlockReason(
			event.toolName,
			event.input,
		);
		if (shellBlockReason) {
			return { block: true, reason: shellBlockReason };
		}
		if (
			(event.toolName === "bash" || event.toolName === "shell") &&
			typeof event.input.command === "string"
		) {
			const checkerBlockReason = managedCheckerCommandBlockReason(
				event.input.command,
				checkerRanSinceMutation,
			);
			if (checkerBlockReason) {
				return { block: true, reason: checkerBlockReason };
			}
		}
		const signature = managedAttemptSignature(
			event.toolName,
			event.input,
			current.requiredMcpServers,
		);
		const circuitBlockReason = semanticCircuit.blockReason(signature);
		if (circuitBlockReason) {
			return {
				block: true,
				reason: circuitBlockReason,
			};
		}
		let frontendMutation = false;
		if (event.toolName === "write" || event.toolName === "edit") {
			const requestedPath = event.input.path;
			if (typeof requestedPath !== "string" || !requestedPath.trim()) {
				return {
					block: true,
					reason: `Trustable runtime blocked ${event.toolName} without a valid path`,
				};
			}
			const absoluteTarget = isAbsolute(requestedPath)
				? requestedPath
				: join(ctx.cwd, requestedPath);
			if (!pathIsWithin(current.workspace, absoluteTarget)) {
				return {
					block: true,
					reason: `Trustable runtime blocked a write outside the workbench: ${absoluteTarget}`,
				};
			}
			frontendMutation = pathIsWithin(
				join(current.workspace, "src"),
				absoluteTarget,
			);
		}
		pendingAttempts.set(event.toolCallId, {
			signature,
			mutation: isManagedActionMutation(
				event.toolName,
				event.input,
				current.requiredMcpServers,
			),
			frontendMutation,
			invocation,
			actionCreation:
				invocation?.mode === "call" &&
				invocation.server === "openserverless" &&
				invocation.tool === "action_new",
			redeploy: event.toolName === "trustable_runtime_redeploy",
			checker:
				(event.toolName === "bash" || event.toolName === "shell") &&
				typeof event.input.command === "string" &&
				/\bcheck_openserverless_actions\.sh\b/.test(
					event.input.command,
				),
			reactValidation:
				invocation?.mode === "call" &&
				invocation.server === "react" &&
				invocation.tool === "react_validate",
		});
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const attempt = pendingAttempts.get(event.toolCallId);
		pendingAttempts.delete(event.toolCallId);
		if (!attempt) {
			return undefined;
		}
		const failed = managedToolResultFailed(event);
		mcpStatusSeen = recordManagedMcpBootstrapResult(
			attempt.invocation,
			!failed,
			mcpStatusSeen,
			listedMcpServers,
		);
		if (failed) {
			semanticCircuit.recordFailure(attempt.signature);
			return undefined;
		}
		semanticCircuit.recordSuccess(attempt.signature, attempt.mutation);
		if (
			attempt.actionCreation &&
			managedActionWasCreated(attempt.invocation, event)
		) {
			redeployRequired = true;
		}
		if (attempt.redeploy) {
			redeployRequired = false;
		}
		if (attempt.checker) {
			checkerRanSinceMutation = true;
		}
		if (attempt.reactValidation) {
			reactValidationRequired = false;
		}
		if (attempt.mutation) {
			// WHY: only a successful source/wiring mutation is progress. A failed
			// call cannot reset the no-progress circuit or checker requirement.
			checkerRanSinceMutation = false;
			if (attempt.frontendMutation) {
				reactValidationRequired = true;
			}
		}
		return undefined;
	});

	// Keep the validated object live so a malformed load cannot be optimized
	// away and startup logs identify the selected app without exposing secrets.
	if (!manifest.app) {
		throw new Error("Trustable runtime selected no application");
	}
}
