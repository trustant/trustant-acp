import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotebookNodeView } from "../web/NotebookNodeView";
import { normalizeNotebookSessionState } from "../src/services/notebook";
import type { NotebookNode } from "../src/types/notebook";

const node: NotebookNode = {
	id: "node-1",
	kind: "notebook",
	prompt: "# Build\nrun the build",
	outputs: [],
};

function view(editing: boolean, overrides: Partial<NotebookNode> = {}): string {
	return renderToStaticMarkup(
		React.createElement(NotebookNodeView, {
			node: { ...node, ...overrides },
			selected: true,
			editing,
			busy: false,
			onSelect: () => {},
			onRun: () => {},
			onEdit: () => {},
			onSaveEdit: () => {},
			onCancelEdit: () => {},
			onRemove: () => {},
			onPin: () => {},
		}),
	);
}

describe("in-place prompt editing", () => {
	it("shows the summarized task with Run and Edit when not editing", () => {
		const html = view(false);
		expect(html).toContain("Run");
		expect(html).toContain("Edit");
		expect(html).toContain("Task details");
		expect(html).not.toContain("notebook-node-editor");
	});

	it("replaces the task body with an editor and Save/Cancel while editing", () => {
		const html = view(true);
		// The prompt is edited on the node itself, not copied into the composer.
		expect(html).toContain("notebook-node-editor");
		expect(html).toContain("run the build");
		expect(html).toContain("Save");
		expect(html).toContain("Cancel");
		expect(html).not.toContain("Task details");
		// Run/Remove are withheld mid-edit so a draft cannot be run or dropped.
		expect(html).not.toContain(">Run<");
		expect(html).not.toContain("Remove");
	});

	it("offers Pin instead of edit controls on an ad-hoc input node", () => {
		const html = view(false, { kind: "input" });
		expect(html).toContain("Pin");
		expect(html).not.toContain("Edit");
	});
});

describe("local template session state", () => {
	function state(local: unknown): Record<string, unknown> {
		return {
			version: 1,
			source: { repository: "trustable-ai/templates", ref: "main" },
			notebookName: "Saved Template",
			path: "template.md",
			fileSha: "",
			readmeSha: "",
			nodes: [],
			selectedNodeId: null,
			dirty: false,
			local,
		};
	}

	it("preserves the local flag so a resumed session keeps saving locally", () => {
		expect(normalizeNotebookSessionState(state(true)).local).toBe(true);
	});

	it("omits the flag for GitHub-backed templates", () => {
		expect(normalizeNotebookSessionState(state(false))).not.toHaveProperty(
			"local",
		);
		expect(
			normalizeNotebookSessionState(state(undefined)),
		).not.toHaveProperty("local");
	});

	it("ignores a non-boolean local value instead of trusting it", () => {
		expect(
			normalizeNotebookSessionState(state("yes")),
		).not.toHaveProperty("local");
	});
});
