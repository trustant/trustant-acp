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

describe("working copy session state", () => {
	function state(overrides: Record<string, unknown>): Record<string, unknown> {
		return {
			version: 1,
			source: { repository: "trustable-ai/templates", ref: "main" },
			notebookName: "Build",
			path: "flows/build.md",
			fileSha: "",
			readmeSha: "",
			nodes: [],
			selectedNodeId: null,
			dirty: false,
			...overrides,
		};
	}

	it("preserves provenance so a resumed session knows its origin", () => {
		const template = {
			name: "Build",
			repo: "trustable-ai/templates",
			file: "flows/build.md",
			edited: true,
			extra: { author: "me" },
		};
		expect(
			normalizeNotebookSessionState(state({ template })).template,
		).toEqual(template);
	});

	it("defaults provenance when the sidecar carries none", () => {
		expect(normalizeNotebookSessionState(state({})).template).toEqual({
			name: "",
			repo: "",
			file: "",
			edited: false,
			extra: {},
		});
	});

	it("seeds provenance from a legacy local sidecar", () => {
		// Sessions written before templates became working copies carry
		// `local: true`; a resumed one should keep showing its name rather than
		// presenting itself as an unnamed template.
		const result = normalizeNotebookSessionState(state({ local: true }));
		expect(result.template.name).toBe("Build");
		expect(result.template.file).toBe("flows/build.md");
		expect(result.template.edited).toBe(true);
	});

	it("coerces a non-boolean edited flag instead of trusting it", () => {
		expect(
			normalizeNotebookSessionState(
				state({ template: { name: "", repo: "", file: "", edited: "yes" } }),
			).template.edited,
		).toBe(false);
	});

	it("drops the superseded local flag", () => {
		expect(
			normalizeNotebookSessionState(state({ local: true })),
		).not.toHaveProperty("local");
	});
});
