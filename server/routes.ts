/**
 * REST route handlers for the standalone server.
 *
 * Each handler maps 1:1 to an AcpClient method or a persistence operation the
 * browser UI calls. Handlers are plain async functions taking a parsed JSON body
 * and returning a JSON-serializable value; the server wrapper handles routing,
 * body parsing, and error→503/400 mapping.
 */
import type { SessionHost } from "./session-host";
import type { SessionStore } from "./session-store";
import type { StandaloneConfig } from "./config-store";
import { listConfigAgents } from "./config-store";
import {
	readPiConfig,
	writePiProvider,
	piHello,
	type PiConfig,
	type PiHelloResult,
} from "./pi-config";
import {
	codexLoginStatus,
	codexStartDeviceAuth,
	type CodexLoginStatus,
	type CodexDeviceAuth,
} from "./codex-login";
import {
	claudeLoginStatus,
	claudeStartLogin,
	claudeCompleteLogin,
	type ClaudeLoginStatus,
} from "./claude-login";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { NotebookGitHubService } from "./notebook-github";
import { executeShellCommand } from "./shell-executor";
import type {
	AgentsResponse,
	DirectoryRequest,
	DirectoryResponse,
	InitializeRequest,
	InitializeResponse,
	NewSessionRequest,
	SessionResponse,
	PromptRequest,
	CancelRequest,
	ShellRequest,
	SessionByIdRequest,
	ConfigOptionRequest,
	ConfigOptionResponse,
	ListSessionsResponse,
	DeleteAgentSessionRequest,
	PermissionResponse,
	SavedSessionsResponse,
	SavedMessagesResponse,
	SaveMessagesRequest,
	NotebookSourceRequest,
	NotebookLoadRequest,
	NotebookSaveRequest,
	NotebookAddRequest,
	NotebookRemoveRequest,
	NotebookSessionRequest,
	SaveNotebookSessionRequest,
	NotebookIndexResponse,
	NotebookDocumentResponse,
	NotebookMutationResponse,
	NotebookSessionResponse,
} from "./protocol";

export interface RouteContext {
	host: SessionHost;
	store: SessionStore;
	config: StandaloneConfig;
}

const notebookGitHub = new NotebookGitHubService();

export const routes = {
	"GET /api/agents": (ctx: RouteContext): AgentsResponse => ({
		agents: listConfigAgents(ctx.config).map((a) => ({
			id: a.id,
			displayName: a.displayName,
		})),
		defaultAgentId: ctx.config.defaultAgentId,
		projectDir: ctx.host.projectDir(),
	}),

	// ---- working directory (SPEC §10e) ------------------------------------

	"GET /api/directory": (ctx: RouteContext): DirectoryResponse => ({
		dir: ctx.host.projectDir(),
	}),

	"POST /api/directory": (
		ctx: RouteContext,
		body: DirectoryRequest,
	): DirectoryResponse => {
		const raw = (body.dir ?? "").trim();
		if (!raw) throw new Error("Bad request: dir is required");
		// Resolve relative paths against the server's invocation cwd, mirroring
		// resolveProjectDir; validate it is an existing directory.
		const dir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
		let stat;
		try {
			stat = statSync(dir);
		} catch {
			throw new Error(`Bad request: directory does not exist: ${dir}`);
		}
		if (!stat.isDirectory()) {
			throw new Error(`Bad request: not a directory: ${dir}`);
		}
		ctx.host.setProjectDir(dir);
		return { dir };
	},

	"POST /api/session/initialize": async (
		ctx: RouteContext,
		body: InitializeRequest,
	): Promise<InitializeResponse> => {
		const result = await ctx.host.initialize(body.agentId, body.cwd);
		return { result };
	},

	"POST /api/session/new": async (
		ctx: RouteContext,
		body: NewSessionRequest,
	): Promise<SessionResponse> => {
		const client = ctx.host.requireClient(body.agentId);
		const cwd = body.cwd ?? ctx.host.projectDir();
		const result = await client.newSession(cwd);
		ctx.host.bindSessionDirectory(result.sessionId, cwd);
		await ctx.store.saveSession({
			sessionId: result.sessionId,
			agentId: body.agentId,
			cwd,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		return { result };
	},

	"POST /api/session/prompt": async (
		ctx: RouteContext,
		body: PromptRequest,
	): Promise<{ ok: true }> => {
		const client = ctx.host.clientForSession(body.sessionId);
		await client.sendPrompt(body.sessionId, body.content);
		return { ok: true };
	},

	"POST /api/session/cancel": async (
		ctx: RouteContext,
		body: CancelRequest,
	): Promise<{ ok: true }> => {
		const client = ctx.host.clientForSession(body.sessionId);
		await client.cancel(body.sessionId);
		return { ok: true };
	},

	"POST /api/session/shell": async (
		ctx: RouteContext,
		body: ShellRequest,
	) => {
		// WHY: cwd is host-owned session state, not request data. This prevents
		// the browser from turning shell mode into an arbitrary-directory API.
		const cwd = ctx.host.activeSessionDirectory(body.sessionId);
		return executeShellCommand({ command: body.command, cwd });
	},

	"POST /api/session/load": async (
		ctx: RouteContext,
		body: SessionByIdRequest,
	): Promise<SessionResponse> => {
		const client = ctx.host.requireClient(body.agentId);
		const cwd = body.cwd ?? ctx.host.projectDir();
		const result = await client.loadSession(body.sessionId, cwd);
		ctx.host.bindSessionDirectory(result.sessionId, cwd);
		return { result };
	},

	"POST /api/session/resume": async (
		ctx: RouteContext,
		body: SessionByIdRequest,
	): Promise<SessionResponse> => {
		const client = ctx.host.requireClient(body.agentId);
		const cwd = body.cwd ?? ctx.host.projectDir();
		const result = await client.resumeSession(body.sessionId, cwd);
		ctx.host.bindSessionDirectory(result.sessionId, cwd);
		return { result };
	},

	"POST /api/session/fork": async (
		ctx: RouteContext,
		body: SessionByIdRequest,
	): Promise<SessionResponse> => {
		const client = ctx.host.requireClient(body.agentId);
		const cwd = body.cwd ?? ctx.host.projectDir();
		const result = await client.forkSession(body.sessionId, cwd);
		await ctx.store.saveSession({
			sessionId: result.sessionId,
			agentId: body.agentId,
			cwd,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		await ctx.store.cloneNotebookState(body.sessionId, result.sessionId);
		ctx.host.bindSessionDirectory(result.sessionId, cwd);
		return { result };
	},

	"POST /api/session/config-option": async (
		ctx: RouteContext,
		body: ConfigOptionRequest,
	): Promise<ConfigOptionResponse> => {
		const client = ctx.host.clientForSession(body.sessionId);
		const options = await client.setSessionConfigOption(
			body.sessionId,
			body.configId,
			body.value,
		);
		return { options };
	},

	"POST /api/session/list": async (
		ctx: RouteContext,
		body: { agentId: string; cwd?: string; cursor?: string },
	): Promise<ListSessionsResponse> => {
		const client = ctx.host.requireClient(body.agentId);
		return { result: await client.listSessions(body.cwd, body.cursor) };
	},

	"POST /api/session/delete": async (
		ctx: RouteContext,
		body: DeleteAgentSessionRequest,
	): Promise<{ ok: true }> => {
		const client = ctx.host.requireClient(body.agentId);
		// WHY: Pi owns the canonical session file. Remove it through ACP first;
		// only then clear TruACP's secondary metadata to avoid a ghost Pi entry.
		await client.deleteSession(body.sessionId);
		await ctx.store.deleteSession(body.sessionId);
		return { ok: true };
	},

	"POST /api/permission/respond": async (
		ctx: RouteContext,
		body: PermissionResponse,
	): Promise<{ ok: true }> => {
		await ctx.host.respondToPermission(body.requestId, body.optionId);
		return { ok: true };
	},

	"POST /api/sessions/query": async (
		ctx: RouteContext,
		body: { agentId?: string; cwd?: string },
	): Promise<SavedSessionsResponse> => ({
		sessions: await ctx.store.getSavedSessions(body.agentId, body.cwd),
	}),

	"POST /api/sessions/messages/get": async (
		ctx: RouteContext,
		body: { sessionId: string },
	): Promise<SavedMessagesResponse> => ({
		messages: await ctx.store.loadSessionMessages(body.sessionId),
	}),

	"PUT /api/sessions/messages": async (
		ctx: RouteContext,
		body: SaveMessagesRequest,
	): Promise<{ ok: true }> => {
		await ctx.store.saveSessionMessages(
			body.sessionId,
			body.agentId,
			body.messages,
		);
		return { ok: true };
	},

	"POST /api/sessions/delete": async (
		ctx: RouteContext,
		body: { sessionId: string },
	): Promise<{ ok: true }> => {
		await ctx.store.deleteSession(body.sessionId);
		return { ok: true };
	},

	"POST /api/sessions/notebook/get": async (
		ctx: RouteContext,
		body: NotebookSessionRequest,
	): Promise<NotebookSessionResponse> => ({
		state: await ctx.store.loadNotebookState(body.sessionId),
	}),

	"PUT /api/sessions/notebook": async (
		ctx: RouteContext,
		body: SaveNotebookSessionRequest,
	): Promise<{ ok: true }> => {
		await ctx.store.saveNotebookState(body.sessionId, body.state);
		return { ok: true };
	},

	// ---- GitHub-backed notebooks ------------------------------------------

	"POST /api/notebooks/index": async (
		_ctx: RouteContext,
		body: NotebookSourceRequest,
	): Promise<NotebookIndexResponse> =>
		notebookGitHub.readIndex(body.repository, body.ref),

	"POST /api/notebooks/load": async (
		_ctx: RouteContext,
		body: NotebookLoadRequest,
	): Promise<NotebookDocumentResponse> =>
		notebookGitHub.loadNotebook(body),

	"PUT /api/notebooks/save": async (
		_ctx: RouteContext,
		body: NotebookSaveRequest,
	): Promise<{ sha: string; hasToken: boolean }> =>
		notebookGitHub.saveNotebook(body),

	"POST /api/notebooks/add": async (
		_ctx: RouteContext,
		body: NotebookAddRequest,
	): Promise<NotebookMutationResponse> =>
		notebookGitHub.addNotebook(body),

	"POST /api/notebooks/remove": async (
		_ctx: RouteContext,
		body: NotebookRemoveRequest,
	): Promise<NotebookMutationResponse> =>
		notebookGitHub.removeNotebook(body),

	// ---- pi provider config (native ~/.pi/agent/models.json) --------------
	// OpenCode endpoint routes are intentionally absent: Pi is the managed
	// coding runtime, so retaining the old routes would expose dead UI paths and
	// imply that an OpenCode executable is still installed.

	"POST /api/pi/hello": async (): Promise<PiHelloResult> => piHello(),

	"POST /api/pi/config/get": async (): Promise<{
		config: Partial<PiConfig>;
	}> => ({
		config: await readPiConfig(),
	}),

	"POST /api/pi/config/set": async (
		_ctx: RouteContext,
		body: PiConfig,
	): Promise<{ ok: true }> => {
		await writePiProvider({
			baseUrl: body.baseUrl ?? "",
			apiKey: body.apiKey ?? "",
			model: body.model ?? "",
		});
		return { ok: true };
	},

	// ---- codex login (device-code flow) -----------------------------------

	"POST /api/codex/login-status": async (): Promise<CodexLoginStatus> =>
		codexLoginStatus(),

	"POST /api/codex/login-device": async (): Promise<CodexDeviceAuth> =>
		codexStartDeviceAuth(),

	// ---- claude login (paste-code OAuth flow) -----------------------------

	"POST /api/claude/login-status": async (): Promise<ClaudeLoginStatus> =>
		claudeLoginStatus(),

	"POST /api/claude/login-start": async (): Promise<{ url: string }> =>
		claudeStartLogin(),

	"POST /api/claude/login-complete": async (
		_ctx: RouteContext,
		body: { code: string },
	): Promise<ClaudeLoginStatus> => claudeCompleteLogin(body.code ?? ""),
} as const;

export type RouteKey = keyof typeof routes;
