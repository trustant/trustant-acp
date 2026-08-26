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
	extra: { moving?: boolean; busy?: boolean } = {},
): string {
	return renderToStaticMarkup(
		React.createElement(NotebookNodeView, {
			node: { ...node, ...overrides },
			selected: true,
			editing,
			running,
			moving: extra.moving ?? false,
			busy: extra.busy ?? false,
			onSelect: () => {},
			onRun: () => {},
			onEdit: () => {},
			onSaveEdit: () => {},
			onCancelEdit: () => {},
			onRemove: () => {},
			onPin: () => {},
			onMove: () => {},
			onMoveKey: () => {},
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

describe("step move mode", () => {
	it("offers Move on a step", () => {
		expect(view(false)).toContain(">Move</button>");
	});

	// An ad-hoc input is not written to the template, so there is nothing to
	// reorder and the control would only promise something it cannot deliver.
	it("does not offer Move on an ad-hoc input", () => {
		expect(view(false, { kind: "input" })).not.toContain(">Move</button>");
	});

	it("replaces the controls with the hint while moving", () => {
		const html = view(false, {}, false, { moving: true });
		expect(html).toContain("use arrow to move, enter to confirm esc to cancel");
		expect(html).not.toContain(">Move</button>");
		expect(html).not.toContain(">Run</button>");
		expect(html).not.toContain(">Remove</button>");
	});

	it("marks the moving node and makes it focusable for the arrows", () => {
		const html = view(false, {}, false, { moving: true });
		expect(html).toContain('data-moving="true"');
		expect(html).toContain("moving");
		expect(html).toContain('tabindex="-1"');
	});

	it("keeps Move out of an edit, where Save and Cancel own the controls", () => {
		expect(view(true)).not.toContain(">Move</button>");
	});

	it("disables Move during a run, as with the other step controls", () => {
		expect(view(false, {}, false, { busy: true })).toContain(
			'disabled=""',
		);
	});
});
