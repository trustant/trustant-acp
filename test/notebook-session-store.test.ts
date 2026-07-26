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
