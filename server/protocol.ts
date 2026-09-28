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
import type {
	NotebookDocumentResponse,
	NotebookIndexResponse,
	NotebookMutationResponse,
	NotebookSessionState,
} from "../src/types/notebook";

// ---- REST -----------------------------------------------------------------

/** GET /api/agents → configured agents + which is default. */
export interface AgentsResponse {
	agents: Array<Pick<ConfigAgent, "id" | "displayName">>;
	defaultAgentId: string;
	projectDir: string;
}

/** POST /api/pi/thinking { think } → store the toolbar Thinking value for Pi. */
export interface PiThinkingRequest {
	think: string;
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

/** POST /api/session/shell — direct server shell in the active session cwd. */
export interface ShellRequest {
	sessionId: string;
	command: string;
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

/** Notebook repository APIs. The token never appears in a request/response. */
export interface NotebookSourceRequest {
	repository: string;
	ref: string;
}
export interface NotebookLoadRequest extends NotebookSourceRequest {
	name: string;
	path: string;
	readmeSha: string;
}
export interface NotebookRemoveRequest extends NotebookSourceRequest {
	readmeSha: string;
	path: string;
}
/**
 * The workbench working copy. The file name is fixed server-side, so requests
 * carry provenance and prompts only, never a path.
 */
export interface TemplateFrontMatterWire {
	name: string;
	repo: string;
	file: string;
	edited: boolean;
	extra?: Record<string, string>;
}
export interface NotebookSaveLocalRequest {
	frontMatter: TemplateFrontMatterWire;
	prompts: string[];
}
export interface NotebookLocalResponse {
	exists: boolean;
	frontMatter: TemplateFrontMatterWire;
	prompts: string[];
}
export interface NotebookSaveLocalResponse {
	path: string;
	staged: boolean;
}
/** Copy a catalog entry into the workbench, replacing any working copy. */
export interface NotebookSelectRequest extends NotebookLoadRequest {
	/** Required to replace a working copy that has unsaved edits. */
	force?: boolean;
}
/**
 * Save the working copy upstream. Prompts are read from `template.md`
 * server-side, so they are absent here by design.
 */
export interface NotebookSaveTemplateRequest {
	name: string;
	file: string;
}
export interface NotebookSaveTemplateResponse {
	index: NotebookIndexResponse;
	frontMatter: TemplateFrontMatterWire;
}

export interface NotebookSessionRequest {
	sessionId: string;
}
export interface SaveNotebookSessionRequest extends NotebookSessionRequest {
	state: NotebookSessionState;
}
export interface NotebookSessionResponse {
	state: NotebookSessionState | null;
}

export type {
	NotebookDocumentResponse,
	NotebookIndexResponse,
	NotebookMutationResponse,
};

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
