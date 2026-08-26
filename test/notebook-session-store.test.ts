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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../server/session-store";
import type { NotebookSessionState } from "../src/types/notebook";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

function state(): NotebookSessionState {
	return {
		version: 1,
		source: { repository: "owner/repo", ref: "main" },
		notebookName: "Flow",
		path: "flow.md",
		fileSha: "file",
		readmeSha: "readme",
		nodes: [
			{
				id: "node",
				kind: "notebook",
				prompt: "Prompt",
				outputs: [
					{
						kind: "assistant",
						id: "output",
						text: "Answer",
						thoughts: "",
					},
				],
			},
		],
		selectedNodeId: "node",
		dirty: false,
		template: {
			name: "Notebook",
			repo: "trustable-ai/templates",
			file: "one.md",
			edited: false,
			extra: {},
		},
	};
}

describe("notebook session persistence", () => {
	it("saves, restores, forks, and deletes the notebook sidecar", async () => {
		const dir = await mkdtemp(join(tmpdir(), "truacp-notebook-"));
		dirs.push(dir);
		const store = new SessionStore(dir);
		await store.saveNotebookState("source", state());
		expect(await store.loadNotebookState("source")).toEqual(state());
		await store.cloneNotebookState("source", "fork");
		expect(await store.loadNotebookState("fork")).toEqual(state());
		await store.deleteSession("source");
		expect(await store.loadNotebookState("source")).toBeNull();
		expect(await store.loadNotebookState("fork")).toEqual(state());
	});
});
