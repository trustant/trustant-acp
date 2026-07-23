/**
 * Wire contract between the standalone server and the browser UI.
 *
 * Two channels:
 *  - REST (request/response): one endpoint per AcpClient method the UI calls.
 *  - WebSocket (server→client stream): agent SessionUpdates and lifecycle events.
 *
 * This module is transport-agnostic type-only glue shared by both sides. The
 * browser transport shim (later phase) re-emits WsEvent `sessionUpdate` payloads
 * through the same onSessionUpdate listener set the hooks already consume, so
 * the UI needs no special-casing.
 */
import type {
	InitializeResult,
	SessionResult,
	SessionConfigOption,
	ListSessionsResult,
	SessionUpdate,
	SavedSessionInfo,
} from "../src/types/session";
import type { PromptContent, ChatMessage } from "../src/types/chat";
import type { ConfigAgent } from "./config-store";

// ---- REST -----------------------------------------------------------------

/** GET /api/agents → configured agents + which is default. */
export interface AgentsResponse {
	agents: Array<Pick<ConfigAgent, "id" | "displayName">>;
	defaultAgentId: string;
	projectDir: string;
}

/**
 * GET /api/directory → current default cwd.
 * POST /api/directory { dir } → change the default cwd (validated, absolute path
 * returned). See SPEC §10e.
 */
export interface DirectoryRequest {
	dir: string;
}
export interface DirectoryResponse {
	dir: string;
}

/** POST /api/session/initialize */
export interface InitializeRequest {
	agentId: string;
	cwd?: string;
}
export interface InitializeResponse {
	result: InitializeResult;
}

/** POST /api/session/new — cwd optional (defaults to projectDir). */
export interface NewSessionRequest {
	agentId: string;
	cwd?: string;
}
export interface SessionResponse {
	result: SessionResult;
}

/** POST /api/session/prompt */
export interface PromptRequest {
	sessionId: string;
	content: PromptContent[];
}

/** POST /api/session/cancel */
export interface CancelRequest {
	sessionId: string;
}

/** POST /api/session/{load,resume,fork} */
export interface SessionByIdRequest {
	agentId: string;
	sessionId: string;
	cwd?: string;
}

/** POST /api/session/config-option */
export interface ConfigOptionRequest {
	sessionId: string;
	configId: string;
	value: string;
}
export interface ConfigOptionResponse {
	options: SessionConfigOption[];
}

/** GET /api/session/list?agentId=&cwd= */
export interface ListSessionsResponse {
	result: ListSessionsResult;
}

/** POST /api/session/delete — removes an agent-owned persisted session. */
export interface DeleteAgentSessionRequest {
	agentId: string;
	sessionId: string;
}

/** POST /api/permission/respond */
export interface PermissionResponse {
	requestId: string;
	optionId: string;
}

/** GET /api/sessions?agentId=&cwd= — persisted metadata index. */
export interface SavedSessionsResponse {
	sessions: SavedSessionInfo[];
}

/** GET /api/sessions/messages?sessionId= */
export interface SavedMessagesResponse {
	messages: ChatMessage[] | null;
}

/** PUT /api/sessions/messages */
export interface SaveMessagesRequest {
	sessionId: string;
	agentId: string;
	messages: ChatMessage[];
}

export interface ErrorResponse {
	error: string;
}

// ---- WebSocket ------------------------------------------------------------

/**
 * Server→client events. `sessionUpdate` carries the same SessionUpdate union the
 * ACP core emits; other variants report connection lifecycle so the UI can react
 * to agent process death without a dedicated channel.
 */
export type WsEvent =
	| { type: "sessionUpdate"; update: SessionUpdate }
	| { type: "connected" }
	| { type: "agentDisconnected"; agentId: string; reason?: string };

/** The single WS path the server listens on. */
export const WS_PATH = "/ws";
