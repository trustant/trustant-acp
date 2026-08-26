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
 * Filesystem-backed session persistence for the standalone client.
 *
 * Replaces the plugin's SessionStorage (which stored metadata in Obsidian
 * settings and messages via the vault adapter). Here both live on disk under a
 * data directory:
 *   <dataDir>/sessions.json          — metadata index (SavedSessionInfo[])
 *   <dataDir>/sessions/<id>.json     — per-session message history
 *
 * Message Date fields are serialized to ISO strings on write and rehydrated to
 * Date on read, matching the plugin's on-disk format (version: 1).
 */
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join, isAbsolute, resolve } from "path";
import type { ChatMessage, MessageContent } from "../src/types/chat";
import type { SavedSessionInfo } from "../src/types/session";
import type { NotebookSessionState } from "../src/types/notebook";
import { normalizeNotebookSessionState } from "../src/services/notebook";

/** Maximum number of saved sessions to keep (mirrors the plugin). */
const MAX_SAVED_SESSIONS = 50;

interface SessionMessagesFile {
	version: number;
	sessionId: string;
	agentId: string;
	messages: Array<{
		id: string;
		role: "user" | "assistant";
		content: MessageContent[];
		timestamp: string;
	}>;
	savedAt: string;
}

export class SessionStore {
	private readonly dataDir: string;
	private readonly indexPath: string;
	private readonly sessionsDir: string;
	private readonly notebooksDir: string;

	/** Serializes index writes to avoid lost updates under concurrency. */
	private writeLock: Promise<void> = Promise.resolve();
	private readonly notebookWriteLocks = new Map<string, Promise<void>>();

	constructor(dataDir: string) {
		this.dataDir = isAbsolute(dataDir)
			? dataDir
			: resolve(process.cwd(), dataDir);
		this.indexPath = join(this.dataDir, "sessions.json");
		this.sessionsDir = join(this.dataDir, "sessions");
		this.notebooksDir = join(this.dataDir, "notebooks");
	}

	// ---- metadata index ----------------------------------------------------

	private async readIndex(): Promise<SavedSessionInfo[]> {
		try {
			const text = await readFile(this.indexPath, "utf8");
			const parsed = JSON.parse(text);
			return Array.isArray(parsed) ? (parsed as SavedSessionInfo[]) : [];
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	}

	private async writeIndex(sessions: SavedSessionInfo[]): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
		await writeFile(this.indexPath, JSON.stringify(sessions, null, 2));
	}

	/** Run a read-modify-write of the index under the lock. */
	private mutateIndex(
		fn: (sessions: SavedSessionInfo[]) => SavedSessionInfo[],
	): Promise<void> {
		this.writeLock = this.writeLock.then(async () => {
			const current = await this.readIndex();
			await this.writeIndex(fn(current));
		});
		return this.writeLock;
	}

	/** Insert or update a session's metadata (newest-first, capped). */
	async saveSession(info: SavedSessionInfo): Promise<void> {
		await this.mutateIndex((sessions) => {
			const next = [...sessions];
			const idx = next.findIndex((s) => s.sessionId === info.sessionId);
			if (idx >= 0) {
				next[idx] = info;
			} else {
				next.unshift(info);
				if (next.length > MAX_SAVED_SESSIONS) next.pop();
			}
			return next;
		});
	}

	/** List sessions filtered by agentId/cwd, newest-first. */
	async getSavedSessions(
		agentId?: string,
		cwd?: string,
	): Promise<SavedSessionInfo[]> {
		let sessions = await this.readIndex();
		if (agentId) sessions = sessions.filter((s) => s.agentId === agentId);
		if (cwd) sessions = sessions.filter((s) => s.cwd === cwd);
		return [...sessions].sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
	}

	/** Delete a session's metadata and its message history file. */
	async deleteSession(sessionId: string): Promise<void> {
		await this.mutateIndex((sessions) =>
			sessions.filter((s) => s.sessionId !== sessionId),
		);
		await this.deleteSessionMessages(sessionId);
		await this.deleteNotebookState(sessionId);
	}

	// ---- message history ---------------------------------------------------

	private sessionFilePath(sessionId: string): string {
		const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.sessionsDir, `${safeId}.json`);
	}

	async saveSessionMessages(
		sessionId: string,
		agentId: string,
		messages: ChatMessage[],
	): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });
		const data: SessionMessagesFile = {
			version: 1,
			sessionId,
			agentId,
			messages: messages.map((m) => ({
				id: m.id,
				role: m.role,
				content: m.content,
				// Over the REST boundary timestamp arrives as an ISO string; in
				// process it is a Date. Normalize either to an ISO string.
				timestamp:
					m.timestamp instanceof Date
						? m.timestamp.toISOString()
						: String(m.timestamp),
			})),
			savedAt: new Date().toISOString(),
		};
		await writeFile(
			this.sessionFilePath(sessionId),
			JSON.stringify(data, null, 2),
		);
	}

	/** Load message history, or null when absent/invalid. */
	async loadSessionMessages(sessionId: string): Promise<ChatMessage[] | null> {
		let text: string;
		try {
			text = await readFile(this.sessionFilePath(sessionId), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
		try {
			const data = JSON.parse(text) as SessionMessagesFile;
			if (data.version !== 1 || !Array.isArray(data.messages)) return null;
			return data.messages.map((m) => ({
				id: m.id,
				role: m.role,
				content: m.content,
				timestamp: new Date(m.timestamp),
			}));
		} catch {
			return null;
		}
	}

	async deleteSessionMessages(sessionId: string): Promise<void> {
		await rm(this.sessionFilePath(sessionId), { force: true });
	}

	// ---- notebook session sidecars ----------------------------------------

	private notebookFilePath(sessionId: string): string {
		const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.notebooksDir, `${safeId}.json`);
	}

	async saveNotebookState(
		sessionId: string,
		state: NotebookSessionState,
	): Promise<void> {
		const normalized = normalizeNotebookSessionState(state);
		const previous =
			this.notebookWriteLocks.get(sessionId) ?? Promise.resolve();
		const write = previous.catch(() => {}).then(async () => {
			await mkdir(this.notebooksDir, { recursive: true });
			await writeFile(
				this.notebookFilePath(sessionId),
				JSON.stringify(normalized, null, 2),
			);
		});
		this.notebookWriteLocks.set(sessionId, write);
		try {
			await write;
		} finally {
			if (this.notebookWriteLocks.get(sessionId) === write) {
				this.notebookWriteLocks.delete(sessionId);
			}
		}
	}

	async loadNotebookState(
		sessionId: string,
	): Promise<NotebookSessionState | null> {
		try {
			const value = JSON.parse(
				await readFile(this.notebookFilePath(sessionId), "utf8"),
			);
			return normalizeNotebookSessionState(value);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			if (error instanceof SyntaxError) return null;
			throw error;
		}
	}

	async cloneNotebookState(
		sourceSessionId: string,
		targetSessionId: string,
	): Promise<void> {
		const state = await this.loadNotebookState(sourceSessionId);
		if (state) await this.saveNotebookState(targetSessionId, state);
	}

	async deleteNotebookState(sessionId: string): Promise<void> {
		await rm(this.notebookFilePath(sessionId), { force: true });
	}
}
