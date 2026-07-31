/**
 * Browser transport to the standalone server.
 *
 * Speaks the REST + WebSocket contract from server/protocol.ts: request/response
 * calls over fetch, and a single WebSocket that streams every agent SessionUpdate.
 * The server already exposes one endpoint per AcpClient method, so this is a thin
 * client — no business logic, just wire calls and an update-listener fan-out that
 * mirrors AcpClient.onSessionUpdate.
 */
import type {
	InitializeResult,
	SessionResult,
	SessionUpdate,
	ListSessionsResult,
	SessionConfigOption,
	SavedSessionInfo,
} from "../src/types/session";
import type { PromptContent, ChatMessage } from "../src/types/chat";
import type { WsEvent } from "../server/protocol";
import type {
	NotebookDocumentResponse,
	NotebookIndexEntry,
	NotebookIndexResponse,
	NotebookMutationResponse,
	NotebookSessionState,
	TemplateFrontMatter,
} from "../src/types/notebook";

/** The workbench working copy as returned by the local/select routes. */
interface LocalTemplateResponse {
	exists: boolean;
	frontMatter: TemplateFrontMatter;
	prompts: string[];
}
import type { ShellExecutionResult } from "../server/shell-executor";

export interface AgentInfo {
	id: string;
	displayName: string;
}

export interface AgentsInfo {
	agents: AgentInfo[];
	defaultAgentId: string;
	projectDir: string;
}

type UpdateListener = (update: SessionUpdate) => void;

export class AcpTransport {
	private readonly base: string;
	private ws: WebSocket | null = null;
	private readonly listeners = new Set<UpdateListener>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(base = "") {
		// Empty base → same origin (the server serves this bundle).
		this.base = base;
	}

	// ---- REST --------------------------------------------------------------

	private async call<T>(path: string, body?: unknown): Promise<T> {
		const method = path.startsWith("PUT ") ? "PUT" : "POST";
		const url = this.base + path.replace(/^PUT /, "");
		const res = await fetch(url, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		const json = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(
				(json as { error?: string }).error ??
					`${path} failed (${res.status})`,
			);
		}
		return json as T;
	}

	async getAgents(): Promise<AgentsInfo> {
		const res = await fetch(this.base + "/api/agents");
		if (!res.ok) throw new Error(`/api/agents failed (${res.status})`);
		return res.json();
	}

	// ---- working directory (SPEC §10e) ------------------------------------

	/** Read the server's current default cwd. */
	async getDirectory(): Promise<string> {
		const res = await fetch(this.base + "/api/directory");
		if (!res.ok) throw new Error(`/api/directory failed (${res.status})`);
		const { dir } = (await res.json()) as { dir: string };
		return dir;
	}

	/**
	 * Change the server's default cwd. Returns the resolved absolute path.
	 * Throws on a non-existent / non-directory path (server replies 400). Does
	 * not affect live sessions — start a new session to use the new directory.
	 */
	async setDirectory(dir: string): Promise<string> {
		const { dir: resolved } = await this.call<{ dir: string }>(
			"/api/directory",
			{ dir },
		);
		return resolved;
	}

	async initialize(agentId: string, cwd?: string): Promise<InitializeResult> {
		const { result } = await this.call<{ result: InitializeResult }>(
			"/api/session/initialize",
			{ agentId, cwd },
		);
		return result;
	}

	async newSession(agentId: string, cwd?: string): Promise<SessionResult> {
		const { result } = await this.call<{ result: SessionResult }>(
			"/api/session/new",
			{ agentId, cwd },
		);
		return result;
	}

	async sendPrompt(
		sessionId: string,
		content: PromptContent[],
	): Promise<void> {
		await this.call("/api/session/prompt", { sessionId, content });
	}

	async cancel(sessionId: string): Promise<void> {
		await this.call("/api/session/cancel", { sessionId });
	}

	/**
	 * Execute in the server-owned cwd for this active session. Deliberately no
	 * cwd argument: browser code must not select a filesystem execution scope.
	 */
	async executeShell(
		sessionId: string,
		command: string,
	): Promise<ShellExecutionResult> {
		return this.call<ShellExecutionResult>("/api/session/shell", {
			sessionId,
			command,
		});
	}

	async loadSession(
		agentId: string,
		sessionId: string,
		cwd?: string,
	): Promise<SessionResult> {
		const { result } = await this.call<{ result: SessionResult }>(
			"/api/session/load",
			{ agentId, sessionId, cwd },
		);
		return result;
	}

	async resumeSession(
		agentId: string,
		sessionId: string,
		cwd?: string,
	): Promise<SessionResult> {
		const { result } = await this.call<{ result: SessionResult }>(
			"/api/session/resume",
			{ agentId, sessionId, cwd },
		);
		return result;
	}

	async forkSession(
		agentId: string,
		sessionId: string,
		cwd?: string,
	): Promise<SessionResult> {
		const { result } = await this.call<{ result: SessionResult }>(
			"/api/session/fork",
			{ agentId, sessionId, cwd },
		);
		return result;
	}

	async setSessionConfigOption(
		sessionId: string,
		configId: string,
		value: string,
	): Promise<SessionConfigOption[]> {
		const { options } = await this.call<{ options: SessionConfigOption[] }>(
			"/api/session/config-option",
			{ sessionId, configId, value },
		);
		return options;
	}

	async listSessions(
		agentId: string,
		cwd?: string,
		cursor?: string,
	): Promise<ListSessionsResult> {
		const { result } = await this.call<{ result: ListSessionsResult }>(
			"/api/session/list",
			{ agentId, cwd, cursor },
		);
		return result;
	}

	async deleteAgentSession(
		agentId: string,
		sessionId: string,
	): Promise<void> {
		await this.call("/api/session/delete", { agentId, sessionId });
	}

	async respondToPermission(
		requestId: string,
		optionId: string,
	): Promise<void> {
		await this.call("/api/permission/respond", { requestId, optionId });
	}

	// ---- persisted sessions ------------------------------------------------

	async getSavedSessions(
		agentId?: string,
		cwd?: string,
	): Promise<SavedSessionInfo[]> {
		const { sessions } = await this.call<{ sessions: SavedSessionInfo[] }>(
			"/api/sessions/query",
			{ agentId, cwd },
		);
		return sessions;
	}

	async loadSessionMessages(
		sessionId: string,
	): Promise<ChatMessage[] | null> {
		const { messages } = await this.call<{
			messages: ChatMessage[] | null;
		}>("/api/sessions/messages/get", { sessionId });
		return messages;
	}

	async saveSessionMessages(
		sessionId: string,
		agentId: string,
		messages: ChatMessage[],
	): Promise<void> {
		await this.call("PUT /api/sessions/messages", {
			sessionId,
			agentId,
			messages,
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.call("/api/sessions/delete", { sessionId });
	}

	async loadNotebookSession(
		sessionId: string,
	): Promise<NotebookSessionState | null> {
		const { state } = await this.call<{
			state: NotebookSessionState | null;
		}>("/api/sessions/notebook/get", { sessionId });
		return state;
	}

	async saveNotebookSession(
		sessionId: string,
		state: NotebookSessionState,
	): Promise<void> {
		await this.call("PUT /api/sessions/notebook", { sessionId, state });
	}

	// ---- GitHub-backed notebooks ------------------------------------------

	async listNotebooks(): Promise<NotebookIndexResponse> {
		return this.call("/api/notebooks/index", { repository: "", ref: "" });
	}

	async loadNotebook(
		index: NotebookIndexResponse,
		entry: NotebookIndexEntry,
	): Promise<NotebookDocumentResponse> {
		return this.call("/api/notebooks/load", {
			repository: index.source.repository,
			ref: index.source.ref,
			name: entry.name,
			path: entry.path,
			readmeSha: index.readmeSha,
		});
	}

	/** Copy a catalog entry into the workbench as the working copy. */
	async selectNotebook(
		index: NotebookIndexResponse,
		entry: NotebookIndexEntry,
		force = false,
	): Promise<LocalTemplateResponse> {
		return this.call("/api/notebooks/select", {
			repository: index.source.repository,
			ref: index.source.ref,
			name: entry.name,
			path: entry.path,
			readmeSha: index.readmeSha,
			force,
		});
	}

	// There is no addNotebook: saveTemplate creates and indexes a template that
	// does not exist yet, so creation has exactly one path.

	async removeNotebook(
		index: NotebookIndexResponse,
		entry: NotebookIndexEntry,
	): Promise<NotebookMutationResponse> {
		return this.call("/api/notebooks/remove", {
			repository: index.source.repository,
			ref: index.source.ref,
			readmeSha: index.readmeSha,
			path: entry.path,
		});
	}

	// ---- the workbench working copy ---------------------------------------

	async loadLocalTemplate(): Promise<LocalTemplateResponse> {
		return this.call("/api/notebooks/local", {});
	}

	async saveLocalTemplate(
		frontMatter: TemplateFrontMatter,
		prompts: string[],
	): Promise<{ path: string; staged: boolean }> {
		return this.call("PUT /api/notebooks/save-local", {
			frontMatter,
			prompts,
		});
	}

	/** Save the working copy upstream; prompts are read server-side. */
	async saveTemplate(
		name: string,
		file: string,
	): Promise<{
		index: NotebookIndexResponse;
		frontMatter: TemplateFrontMatter;
	}> {
		return this.call("PUT /api/notebooks/save-template", { name, file });
	}

	// ---- per-agent config + auth (endpoint/login popups) ------------------

	/** Probe Pi endpoint/auth quickly through its configured /models catalog. */
	async piHello(): Promise<{
		ok: boolean;
		detail: string;
		managed: boolean;
	}> {
		return this.call("/api/pi/hello");
	}

	/** Read pi's custom provider config from ~/.pi/agent/models.json. */
	async piConfigGet(): Promise<{
		baseUrl?: string;
		apiKey?: string;
		model?: string;
	}> {
		const { config } = await this.call<{
			config: { baseUrl?: string; apiKey?: string; model?: string };
		}>("/api/pi/config/get");
		return config;
	}

	/** Write pi's custom provider (base URL + API key; model auto-discovered). */
	async piConfigSet(cfg: {
		baseUrl: string;
		apiKey: string;
		model?: string;
	}): Promise<void> {
		await this.call("/api/pi/config/set", cfg);
	}

	/** Run `codex login status`. */
	async codexLoginStatus(): Promise<{ loggedIn: boolean; detail: string }> {
		return this.call("/api/codex/login-status");
	}

	/** Start codex device-auth; resolves with the verification URL + code. */
	async codexLoginDevice(): Promise<{
		url: string;
		code: string;
		raw: string;
	}> {
		return this.call("/api/codex/login-device");
	}

	/** Run `claude auth status --text`. */
	async claudeLoginStatus(): Promise<{ loggedIn: boolean; detail: string }> {
		return this.call("/api/claude/login-status");
	}

	/** Start claude OAuth login; resolves with the authorize URL. */
	async claudeLoginStart(): Promise<{ url: string }> {
		return this.call("/api/claude/login-start");
	}

	/** Submit the pasted code to finish claude login. */
	async claudeLoginComplete(
		code: string,
	): Promise<{ loggedIn: boolean; detail: string }> {
		return this.call("/api/claude/login-complete", { code });
	}

	// ---- WebSocket streaming ----------------------------------------------

	/** Subscribe to streamed SessionUpdates. Returns an unsubscribe fn. */
	onSessionUpdate(listener: UpdateListener): () => void {
		this.listeners.add(listener);
		this.ensureSocket();
		return () => this.listeners.delete(listener);
	}

	private ensureSocket(): void {
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

		const wsUrl =
			(this.base || location.origin).replace(/^http/, "ws") + "/ws";
		const ws = new WebSocket(wsUrl);
		this.ws = ws;

		ws.addEventListener("message", (e) => {
			let event: WsEvent;
			try {
				event = JSON.parse(e.data as string);
			} catch {
				return;
			}
			if (event.type === "sessionUpdate") {
				for (const l of this.listeners) l(event.update);
			}
		});

		// Reconnect on drop while listeners remain.
		ws.addEventListener("close", () => {
			this.ws = null;
			if (this.listeners.size > 0 && !this.reconnectTimer) {
				this.reconnectTimer = setTimeout(() => {
					this.reconnectTimer = null;
					this.ensureSocket();
				}, 1000);
			}
		});
	}
}
