/*
 * Copyright 2025-2026 Nuvolaris Inc
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

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
import {
	readLocalTemplate,
	sanitizeTemplateFrontMatter,
	saveLocalTemplate,
} from "./notebook-local";
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
	NotebookRemoveRequest,
	NotebookLocalResponse,
	NotebookSaveLocalRequest,
	NotebookSaveLocalResponse,
	NotebookSelectRequest,
	NotebookSaveTemplateRequest,
	NotebookSaveTemplateResponse,
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
		return ctx.host.redactSensitive(
			await executeShellCommand({ command: body.command, cwd }),
		);
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

	// `PUT /api/notebooks/save` is deliberately absent: its concurrency contract
	// took a browser-supplied file SHA, which the working-copy model replaces —
	// prompts now come from template.md and SHAs are read server-side.

	// `POST /api/notebooks/add` is deliberately absent: save-template already
	// creates and indexes a template whose file does not exist, so a second
	// creation path would only be a second thing to keep in step.

	"POST /api/notebooks/remove": async (
		_ctx: RouteContext,
		body: NotebookRemoveRequest,
	): Promise<NotebookMutationResponse> =>
		notebookGitHub.removeNotebook(body),

	// ---- the workbench working copy ---------------------------------------
	// A template is edited as template.md in the launched application's
	// workbench checkout; GitHub is the catalog it is copied from and saved to.

	"POST /api/notebooks/local": async (
		ctx: RouteContext,
	): Promise<NotebookLocalResponse> => readLocalTemplate(ctx.host.projectDir()),

	/**
	 * Copy a catalog entry into the workbench in one hop.
	 *
	 * Done server-side so the browser and the disk cannot disagree mid-copy,
	 * and so provenance is recorded from the source the service actually
	 * fetched rather than from anything the browser claims.
	 */
	"POST /api/notebooks/select": async (
		ctx: RouteContext,
		body: NotebookSelectRequest,
	): Promise<NotebookLocalResponse> => {
		const projectDir = ctx.host.projectDir();
		const existing = await readLocalTemplate(projectDir);
		if (existing.exists && existing.frontMatter.edited && body.force !== true) {
			throw new Error(
				"Conflict: the working copy has unsaved changes; confirm to replace it",
			);
		}
		const document = await notebookGitHub.loadNotebook(body);
		const frontMatter = {
			name: document.name,
			repo: document.source.repository,
			file: document.path,
			edited: false,
			extra: {},
		};
		await saveLocalTemplate(projectDir, frontMatter, document.prompts);
		return { exists: true, frontMatter, prompts: document.prompts };
	},

	"PUT /api/notebooks/save-local": async (
		ctx: RouteContext,
		body: NotebookSaveLocalRequest,
	): Promise<NotebookSaveLocalResponse> => {
		if (!Array.isArray(body.prompts)) {
			throw new Error("Bad request: prompts is required");
		}
		// Clearing `edited` is the server's conclusion after a successful
		// upstream save, never something a client can assert — otherwise a bug
		// could mark diverged work as pristine and hide it from the user.
		const frontMatter = {
			...sanitizeTemplateFrontMatter(body.frontMatter),
			edited: true,
		};
		return saveLocalTemplate(ctx.host.projectDir(), frontMatter, body.prompts);
	},

	"PUT /api/notebooks/save-template": async (
		ctx: RouteContext,
		body: NotebookSaveTemplateRequest,
	): Promise<NotebookSaveTemplateResponse> => {
		const projectDir = ctx.host.projectDir();
		const local = await readLocalTemplate(projectDir);
		if (!local.exists) {
			throw new Error("Bad request: there is no working copy to save");
		}
		if (!local.frontMatter.edited) {
			throw new Error("Bad request: the working copy has no changes to save");
		}
		const saved = await notebookGitHub.saveTemplate({
			repository: local.frontMatter.repo,
			ref: "",
			name: body.name ?? "",
			file: body.file ?? "",
			prompts: local.prompts,
		});
		// Record the repository actually written, which under a managed runtime
		// is the configured one rather than whatever the copy came from.
		const frontMatter = {
			...local.frontMatter,
			name: saved.name,
			repo: saved.source.repository,
			file: saved.file,
			edited: false,
		};
		await saveLocalTemplate(projectDir, frontMatter, local.prompts);
		return { index: saved.index, frontMatter };
	},

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
