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

function view(
	editing: boolean,
	overrides: Partial<NotebookNode> = {},
	running = false,
): string {
	return renderToStaticMarkup(
		React.createElement(NotebookNodeView, {
			node: { ...node, ...overrides },
			selected: true,
			editing,
			running,
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

const output = {
	kind: "assistant" as const,
	id: "out-1",
	text: "done",
	thoughts: "",
};

describe("step run state", () => {
	it("marks a step that has not run yet", () => {
		const html = view(false);
		expect(html).toContain('data-run-state="pending"');
		expect(html).toContain("run-pending");
		expect(html).toContain("Not run");
		expect(html).toContain('aria-label="Not yet run"');
	});

	it("marks a step that has produced output as already run", () => {
		const html = view(false, { outputs: [output] });
		expect(html).toContain('data-run-state="done"');
		expect(html).toContain("run-done");
		expect(html).toContain('aria-label="Already run"');
	});

	it("highlights the step currently in flight", () => {
		const html = view(false, {}, true);
		expect(html).toContain('data-run-state="running"');
		expect(html).toContain("run-running");
		expect(html).toContain("Running…");
		expect(html).toContain('aria-label="Running"');
	});

	it("prefers the running state over prior output", () => {
		// A re-run of a completed step must read as running, not as done.
		const html = view(false, { outputs: [output] }, true);
		expect(html).toContain('data-run-state="running"');
		expect(html).not.toContain('data-run-state="done"');
	});

	it("keeps run state independent of selection", () => {
		// Selection is a ring, run state is the left edge; both can be true.
		const html = view(false, { outputs: [output] });
		expect(html).toContain("selected");
		expect(html).toContain("run-done");
	});
});

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

	it("offers add-to-template instead of edit controls on an ad-hoc input node", () => {
		// An ad-hoc node only exists while a template is loaded, so pinning it
		// always adds to that template rather than creating a new one.
		const html = view(false, { kind: "input" });
		expect(html).toContain("Add to template");
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
