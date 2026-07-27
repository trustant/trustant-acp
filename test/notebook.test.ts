import { describe, expect, it } from "vitest";
import {
	addNotebookIndexEntry,
	advanceNotebookSelection,
	insertAdHocNode,
	normalizeNotebookSessionState,
	notebookPromptSummary,
	notebookPromptsForSave,
	parseNotebookIndex,
	parseNotebookMarkdown,
	pinNotebookNode,
	removeNotebookIndexEntry,
	removeNotebookNode,
	serializeNotebookMarkdown,
} from "../src/services/notebook";
import type { NotebookNode } from "../src/types/notebook";

function node(
	id: string,
	kind: "notebook" | "input" = "notebook",
): NotebookNode {
	return { id, kind, prompt: id, outputs: [] };
}

describe("notebook Markdown", () => {
	it("parses separator lines without splitting horizontal rules inside text", () => {
		expect(
			parseNotebookMarkdown(" first \n\n---\n\nsecond\nline\n---\nthird\n"),
		).toEqual(["first", "second\nline", "third"]);
	});

	it("serializes deterministically", () => {
		expect(serializeNotebookMarkdown([" first\n", "\nsecond "])).toBe(
			" first\n\n---\n\nsecond \n",
		);
	});

	it("derives a bounded task summary without changing the prompt", () => {
		expect(
			notebookPromptSummary(
				"Context before title\n\n# Phase 2 - Employee management\n\nDetails",
			),
		).toBe("Phase 2 - Employee management");
		const summary = notebookPromptSummary("A".repeat(200), 24);
		expect(summary).toHaveLength(24);
		expect(summary.endsWith("...")).toBe(true);
		expect(notebookPromptSummary(" \n ")).toBe("Untitled task");
	});
});

describe("README notebook index", () => {
	it("parses name, path, and optional comment", () => {
		expect(
			parseNotebookIndex(
				"# Catalog\n- [Build](flows/build.md) recommended\n- [Test](test.md)\n",
			),
		).toEqual([
			{ name: "Build", path: "flows/build.md", comment: "recommended" },
			{ name: "Test", path: "test.md", comment: "" },
		]);
	});

	it("adds and removes entries without rewriting unrelated README content", () => {
		const original = "# Catalog\n\nKeep this prose.\n";
		const added = addNotebookIndexEntry(original, {
			name: "Build",
			path: "build.md",
			comment: "",
		});
		expect(added).toContain("Keep this prose.");
		expect(added).toContain("- [Build](build.md)");
		expect(removeNotebookIndexEntry(added, "build.md")).toBe(original);
	});
});

describe("notebook workflow", () => {
	it("advances exactly once, skips ad-hoc input, and clears after final node", () => {
		const nodes = [node("a"), node("input", "input"), node("b")];
		expect(advanceNotebookSelection(nodes, "a")).toBe("b");
		expect(advanceNotebookSelection(nodes, "b")).toBeNull();
	});

	it("inserts ad-hoc input before selection without changing selection", () => {
		const nodes = insertAdHocNode(
			[node("a"), node("b")],
			node("input", "input"),
			"b",
		);
		expect(nodes.map((item) => item.id)).toEqual(["a", "input", "b"]);
	});

	it("persists only notebook and pinned nodes", () => {
		const nodes = [node("a"), node("input", "input")];
		expect(notebookPromptsForSave(nodes)).toEqual(["a"]);
		expect(notebookPromptsForSave(pinNotebookNode(nodes, "input"))).toEqual([
			"a",
			"input",
		]);
	});

	it("keeps selection valid when a selected node is removed", () => {
		const result = removeNotebookNode(
			[node("a"), node("b"), node("c")],
			"b",
			"b",
		);
		expect(result.selectedNodeId).toBe("c");
	});

	it("whitelists session state and drops unknown token-shaped fields", () => {
		const normalized = normalizeNotebookSessionState({
			version: 1,
			source: { repository: "owner/repo", ref: "main" },
			notebookName: "Example",
			path: "example.md",
			fileSha: "file",
			readmeSha: "readme",
			nodes: [node("a")],
			selectedNodeId: "a",
			dirty: false,
			NOTEBOOK_GITHUB_TOKEN: "must-not-persist",
		});
		expect(normalized).not.toHaveProperty("NOTEBOOK_GITHUB_TOKEN");
	});

	it("normalizes adapter-owned tool metadata without losing notebook state", () => {
		const normalized = normalizeNotebookSessionState({
			version: 1,
			source: { repository: "owner/repo", ref: "main" },
			notebookName: "Example",
			path: "example.md",
			fileSha: "file",
			readmeSha: "readme",
			nodes: [
				{
					...node("a"),
					outputs: [
						{
							kind: "tool",
							id: "tool-1",
							title: { text: "structured adapter title" },
							status: null,
						},
						{
							kind: "tool",
							id: "tool-2",
							title: "t".repeat(2_100),
							status: "s".repeat(300),
						},
					],
				},
			],
			selectedNodeId: "a",
			dirty: false,
		});

		expect(normalized.nodes[0].outputs[0]).toEqual({
			kind: "tool",
			id: "tool-1",
			title: "(tool)",
			status: "unknown",
		});
		expect(normalized.nodes[0].outputs[1]).toEqual({
			kind: "tool",
			id: "tool-2",
			title: "t".repeat(2_000),
			status: "s".repeat(200),
		});
	});
});
