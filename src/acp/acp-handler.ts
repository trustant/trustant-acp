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

import * as acp from "@agentclientprotocol/sdk";

import type { SessionUpdate } from "../types/session";
import { AcpTypeConverter } from "./type-converter";
import type { PermissionManager } from "./permission-handler";
import type { TerminalManager } from "./terminal-handler";
import type { Logger } from "../utils/logger";

interface PiActivityMetadata {
	version: 1;
	state: string;
	label: string;
	active: boolean;
	timestamp: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPiActivity(value: unknown): PiActivityMetadata | undefined {
	if (!isRecord(value)) return undefined;
	const meta = value["_meta"];
	if (!isRecord(meta)) return undefined;
	const piAcp = meta["piAcp"];
	if (!isRecord(piAcp)) return undefined;
	const activity = piAcp["activity"];
	if (
		!isRecord(activity) ||
		activity["version"] !== 1 ||
		typeof activity["state"] !== "string" ||
		typeof activity["label"] !== "string" ||
		typeof activity["active"] !== "boolean" ||
		typeof activity["timestamp"] !== "string"
	) {
		return undefined;
	}
	return {
		version: 1,
		state: activity["state"],
		label: activity["label"],
		active: activity["active"],
		timestamp: activity["timestamp"],
	};
}

/**
 * Handles incoming ACP protocol events from the agent.
 *
 * These methods are registered by ACP method name on the client app
 * (acp.client(...)) in AcpClient, and receive session updates, permission
 * requests, and terminal operations dispatched by the SDK connection.
 *
 * This class does not initiate communication — that is AcpClient's role.
 * It only reacts to events from the agent side.
 */
export class AcpHandler {
	private sessionUpdateListeners = new Set<(update: SessionUpdate) => void>();

	/** Tracks session updates during a prompt. */
	private promptSessionUpdateCount = 0;

	constructor(
		private permissionManager: PermissionManager,
		private terminalManager: TerminalManager,
		private getWorkingDirectory: () => string,
		private getCurrentSessionId: () => string | null,
		private logger: Logger,
	) {}

	// ====================================================================
	// Callback Registration
	// ====================================================================

	/** Reset the update counter. Called by AcpClient before each sendPrompt. */
	resetUpdateCount(): void {
		this.promptSessionUpdateCount = 0;
	}

	/** Whether any session update was received since the last reset. */
	hasReceivedUpdates(): boolean {
		return this.promptSessionUpdateCount > 0;
	}

	onSessionUpdate(callback: (update: SessionUpdate) => void): () => void {
		this.sessionUpdateListeners.add(callback);
		return () => this.sessionUpdateListeners.delete(callback);
	}

	/** Emit a session update to all listeners. Filters by current sessionId. */
	emitSessionUpdate(update: SessionUpdate): void {
		const currentId = this.getCurrentSessionId();
		if (currentId && update.sessionId !== currentId) {
			return;
		}
		for (const listener of this.sessionUpdateListeners) {
			listener(update);
		}
	}

	// ====================================================================
	// ACP Client Protocol Handlers (registered on the client app)
	// ====================================================================

	sessionUpdate(params: acp.SessionNotification): Promise<void> {
		const update = params.update;
		const sessionId = params.sessionId;
		this.promptSessionUpdateCount++;
		this.logger.log("[AcpHandler] sessionUpdate:", {
			sessionId,
			type: update.sessionUpdate,
		});

		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk":
			case "user_message_chunk":
				if (update.content.type === "text") {
					this.emitSessionUpdate({
						type: update.sessionUpdate,
						sessionId,
						text: update.content.text,
					});
				}
				break;

			case "tool_call":
			case "tool_call_update":
				this.emitSessionUpdate({
					type: update.sessionUpdate,
					sessionId,
					toolCallId: update.toolCallId,
					title: update.title ?? undefined,
					status: update.status || "pending",
					kind: update.kind ?? undefined,
					content: AcpTypeConverter.toToolCallContent(update.content),
					locations: update.locations ?? undefined,
					rawInput: update.rawInput as
						| { [k: string]: unknown }
						| undefined,
				});
				break;

			case "plan":
				this.emitSessionUpdate({
					type: "plan",
					sessionId,
					entries: update.entries,
				});
				break;

			case "available_commands_update":
				this.emitSessionUpdate({
					type: "available_commands_update",
					sessionId,
					commands: AcpTypeConverter.toSlashCommands(
						update.availableCommands,
					),
				});
				break;

			case "current_mode_update":
				this.emitSessionUpdate({
					type: "current_mode_update",
					sessionId,
					currentModeId: update.currentModeId,
				});
				break;

			case "session_info_update": {
				// WHY: ACP standard session info has no activity field yet. The
				// fork publishes a versioned metadata extension so the standalone
				// UI can show real Pi state without turning it into chat text.
				const activity = readPiActivity(update);
				this.emitSessionUpdate({
					type: "session_info_update",
					sessionId,
					title: update.title,
					updatedAt: update.updatedAt,
					activity,
				});
				break;
			}

			case "usage_update":
				this.emitSessionUpdate({
					type: "usage_update",
					sessionId,
					size: update.size,
					used: update.used,
					cost: update.cost ?? undefined,
				});
				break;

			case "config_option_update":
				this.emitSessionUpdate({
					type: "config_option_update",
					sessionId,
					configOptions: AcpTypeConverter.toSessionConfigOptions(
						update.configOptions,
					),
				});
				break;
		}
		return Promise.resolve();
	}

	requestPermission(
		params: acp.RequestPermissionRequest,
	): Promise<acp.RequestPermissionResponse> {
		return this.permissionManager.request(params);
	}

	// ====================================================================
	// File System Stubs
	// ====================================================================

	readTextFile(_params: acp.ReadTextFileRequest) {
		return Promise.resolve({ content: "" });
	}

	writeTextFile(_params: acp.WriteTextFileRequest) {
		return Promise.resolve({});
	}

	// ====================================================================
	// Terminal Operations (registered on the client app)
	// ====================================================================

	createTerminal(
		params: acp.CreateTerminalRequest,
	): Promise<acp.CreateTerminalResponse> {
		this.logger.log(
			"[AcpHandler] createTerminal called with params:",
			params,
		);

		const terminalId = this.terminalManager.createTerminal({
			command: params.command,
			args: params.args,
			cwd: params.cwd || this.getWorkingDirectory(),
			env: params.env ?? undefined,
			outputByteLimit: params.outputByteLimit ?? undefined,
		});
		return Promise.resolve({ terminalId });
	}

	terminalOutput(
		params: acp.TerminalOutputRequest,
	): Promise<acp.TerminalOutputResponse> {
		const result = this.terminalManager.getOutput(params.terminalId);
		if (!result) {
			throw new Error(`Terminal ${params.terminalId} not found`);
		}
		return Promise.resolve(result);
	}

	async waitForTerminalExit(
		params: acp.WaitForTerminalExitRequest,
	): Promise<acp.WaitForTerminalExitResponse> {
		return await this.terminalManager.waitForExit(params.terminalId);
	}

	killTerminal(
		params: acp.KillTerminalRequest,
	): Promise<acp.KillTerminalResponse> {
		const success = this.terminalManager.killTerminal(params.terminalId);
		if (!success) {
			throw new Error(`Terminal ${params.terminalId} not found`);
		}
		return Promise.resolve({});
	}

	releaseTerminal(
		params: acp.ReleaseTerminalRequest,
	): Promise<acp.ReleaseTerminalResponse> {
		const success = this.terminalManager.releaseTerminal(params.terminalId);
		if (!success) {
			this.logger.log(
				`[AcpHandler] releaseTerminal: Terminal ${params.terminalId} not found (may have been already cleaned up)`,
			);
		}
		return Promise.resolve({});
	}
}
