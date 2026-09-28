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
 * Owns the live AcpClient instances and fans their SessionUpdates out to
 * connected WebSocket clients.
 *
 * One AcpClient per agentId (a spawned agent process), created lazily and
 * reused across that agent's sessions — mirroring the plugin's one-client-per-
 * view model, but keyed by agent for a single-user local server. Every client's
 * single onSessionUpdate channel is forwarded verbatim as a `sessionUpdate` WS
 * event, so the browser sees exactly what the ACP core emits.
 */
import { AcpClient } from "../src/acp/acp-client";
import type { AcpRuntimeConfig } from "../src/acp/acp-runtime";
import type { SessionUpdate, InitializeResult } from "../src/types/session";
import {
	type StandaloneConfig,
	findConfigAgent,
	resolveProjectDir,
} from "./config-store";
import { buildRuntime, buildAgentConfig } from "./acp-host";
import type { WsEvent } from "./protocol";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactSensitiveValue } from "./redaction";
import {
	TRUSTANT_THINKING_VALUES,
	type TrustantThinking,
} from "../extensions/trustant-runtime";

/** Sink for server→client events (the WS broadcast). */
export type EventSink = (event: WsEvent) => void;

export class SessionHost {
	private readonly clients = new Map<string, AcpClient>();
	private readonly sessionDirectories = new Map<string, string>();
	private readonly redactionSecrets = new Map<string, string[]>();
	private readonly runtime: AcpRuntimeConfig;
	/**
	 * Runtime override of the default cwd, set by `setProjectDir` (POST
	 * /api/directory). When unset, the default falls back to config's
	 * `server.projectDir`. Absolute, already validated by the caller.
	 */
	private projectDirOverride?: string;
	/** Per-process file carrying the toolbar Thinking value to the Pi extension. */
	private thinkFile?: string;

	constructor(
		private config: StandaloneConfig,
		clientVersion: string,
		private emit: EventSink,
	) {
		this.runtime = buildRuntime(config, clientVersion);
	}

	/** Default working directory when a request omits cwd. */
	projectDir(): string {
		return this.projectDirOverride ?? resolveProjectDir(this.config);
	}

	/**
	 * Change the default cwd used by `initialize`/`newSession` when a request
	 * omits `cwd`. In-memory only — it does not `process.chdir()` (that would move
	 * config.json/.env/.acp-data resolution) and does not rewrite config.json.
	 * Live sessions are not retro-fitted; the new default applies to sessions
	 * created afterwards. The path must be absolute and already validated to be an
	 * existing directory (see the /api/directory route).
	 */
	setProjectDir(dir: string): void {
		this.projectDirOverride = dir;
	}

	/**
	 * Get (or lazily create) the AcpClient for an agent. New clients wire their
	 * onSessionUpdate straight to the WS broadcast.
	 */
	private getClient(agentId: string): AcpClient {
		let client = this.clients.get(agentId);
		if (!client) {
			client = new AcpClient(this.runtime);
			client.onSessionUpdate((update: SessionUpdate) =>
				this.emit({
					type: "sessionUpdate",
					update: redactSensitiveValue(
						update,
						this.redactionSecrets.get(agentId) ?? [],
					),
				}),
			);
			this.clients.set(agentId, client);
		}
		return client;
	}

	/**
	 * Spawn + initialize the agent process and return the ACP InitializeResult.
	 * Re-initializing an agent respawns it (AcpClient.initialize kills the prior
	 * process first), so this doubles as a restart.
	 */
	async initialize(agentId: string, cwd?: string): Promise<InitializeResult> {
		const agent = findConfigAgent(this.config, agentId);
		if (!agent) throw new Error(`Unknown agent "${agentId}"`);

		const workingDir = cwd ?? this.projectDir();
		const agentConfig = buildAgentConfig(
			agent,
			workingDir,
			this.piThinkingFile(),
		);
		this.redactionSecrets.set(
			agentId,
			agentConfig.redactionSecrets ?? [],
		);

		// WHY: managed MCP servers own stateful per-agent resources. Keeping an
		// initialized client for a previously selected agent would leave a
		// competing owner of those resources alive after an agent switch.
		await Promise.all(
			[...this.clients.entries()]
				.filter(([id]) => id !== agentId)
				.map(async ([id, client]) => {
					await client.disconnect().catch(() => {});
					this.clients.delete(id);
					this.redactionSecrets.delete(id);
				}),
		);
		const client = this.getClient(agentId);
		return client.initialize(agentConfig);
	}

	/** Lazily create the private directory holding the Thinking state file. */
	private piThinkingFile(): string {
		if (!this.thinkFile) {
			const dir = mkdtempSync(join(tmpdir(), "truacp-"));
			this.thinkFile = join(dir, "pi-thinking.json");
		}
		return this.thinkFile;
	}

	/**
	 * Store the toolbar Thinking value. The managed Pi extension re-reads the
	 * file before each provider request; see extensions/trustant-runtime.ts.
	 */
	setPiThinking(value: string): TrustantThinking {
		if (!(TRUSTANT_THINKING_VALUES as readonly string[]).includes(value)) {
			throw new Error(
				`Bad request: think must be one of ${TRUSTANT_THINKING_VALUES.join(", ")}`,
			);
		}
		const file = this.piThinkingFile();
		// Rename keeps a concurrent read from ever seeing a half-written file.
		writeFileSync(`${file}.tmp`, JSON.stringify({ think: value }));
		renameSync(`${file}.tmp`, file);
		return value as TrustantThinking;
	}

	/** Redact host-known MCP credentials before REST output is persisted. */
	redactSensitive<T>(value: T): T {
		const secrets = [...this.redactionSecrets.values()].flat();
		return redactSensitiveValue(value, secrets);
	}

	/**
	 * Return an already-initialized client for the agent, or throw. Used by
	 * session operations that require a live connection.
	 */
	requireClient(agentId: string): AcpClient {
		const client = this.clients.get(agentId);
		if (!client || !client.isInitialized()) {
			throw new Error(
				`Agent "${agentId}" is not initialized. Call /api/session/initialize first.`,
			);
		}
		return client;
	}

	/**
	 * Locate the live client currently owning a session id. Session-scoped
	 * endpoints (prompt/cancel/config-option) only carry the sessionId, so we
	 * find the client whose current session matches.
	 */
	clientForSession(sessionId: string): AcpClient {
		for (const client of this.clients.values()) {
			if (client.getCurrentSessionId() === sessionId) return client;
		}
		// Fall back to the sole initialized client when there is exactly one.
		const initialized = [...this.clients.values()].filter((c) =>
			c.isInitialized(),
		);
		if (initialized.length === 1) return initialized[0];
		throw new Error(`No live client for session "${sessionId}"`);
	}

	/**
	 * Bind a session to the cwd used by its ACP create/load operation.
	 *
	 * WHY: shell passthrough must never trust a browser-provided filesystem
	 * path. Keeping this association beside the live ACP clients lets the server
	 * derive the active project's cwd from the session id alone.
	 */
	bindSessionDirectory(sessionId: string, cwd: string): void {
		this.sessionDirectories.set(sessionId, resolve(cwd));
	}

	/** Resolve the cwd only when the requested session is currently active. */
	activeSessionDirectory(sessionId: string): string {
		const active = [...this.clients.values()].some(
			(client) => client.getCurrentSessionId() === sessionId,
		);
		if (!active) throw new Error(`No active session "${sessionId}"`);
		const cwd = this.sessionDirectories.get(sessionId);
		if (!cwd) throw new Error(`No working directory for session "${sessionId}"`);
		return cwd;
	}

	/**
	 * Route a permission response to whichever initialized client holds the
	 * pending request. Permission requests are resolved by requestId inside the
	 * client's PermissionManager, so responding on the right client is enough;
	 * with a single active agent this is unambiguous.
	 */
	respondToPermission(requestId: string, optionId: string): Promise<void> {
		const initialized = [...this.clients.values()].filter((c) =>
			c.isInitialized(),
		);
		if (initialized.length === 0) {
			throw new Error("No live agent to respond to permission request");
		}
		return Promise.all(
			initialized.map((c) =>
				c.respondToPermission(requestId, optionId).catch(() => {}),
			),
		).then(() => undefined);
	}

	/** Disconnect and drop every agent process (server shutdown). */
	async shutdown(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map((c) => c.disconnect().catch(() => {})),
		);
		this.clients.clear();
		this.sessionDirectories.clear();
		this.redactionSecrets.clear();
	}
}
