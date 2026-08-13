import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { collectState } from "../web/tour-bridge";
import { NotebookPanel } from "../web/NotebookPanel";
import { NotebookNodeView } from "../web/NotebookNodeView";
import type {
	NotebookIndexResponse,
	NotebookNode,
} from "../src/types/notebook";

/**
 * The host tutorials address controls by `data-tour` name across the frame
 * boundary, so the markers are contract, not decoration: removing one silently
 * breaks a tutorial step in the other repository.
 */

function panelMarkup(): string {
	const index: NotebookIndexResponse = {
		source: { repository: "trustable-ai/templates", ref: "main" },
		hasToken: false,
		readmeSha: "sha",
		entries: [
			{ name: "App Suite", path: "app-suite.md", comment: "" },
			{ name: "Build", path: "build.md", comment: "" },
		],
	};
	return renderToStaticMarkup(
		React.createElement(NotebookPanel, {
			index,
			activeNotebook: null,
			localTemplate: null,
			busy: false,
			onRefresh: () => {},
			onSelect: () => {},
			onOpenLocal: () => {},
			onSaveToGitHub: () => {},
			onRemove: () => {},
			onClose: () => {},
		}),
	);
}

function nodeMarkup(kind: NotebookNode["kind"]): string {
	const node: NotebookNode = {
		id: "n1",
		kind,
		prompt: "Do the thing",
		outputs: [],
	};
	return renderToStaticMarkup(
		React.createElement(NotebookNodeView, {
			node,
			selected: false,
			editing: false,
			running: false,
			moving: false,
			busy: false,
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

/**
 * Minimal ParentNode stand-in: the tests run in the "node" environment, and
 * collectState only ever asks for a selector match and a dataset.
 */
function stubRoot(
	matches: Record<string, Array<{ runState?: string }>>,
): ParentNode {
	const list = (
		selector: string,
	): Array<{ dataset: { runState?: string } }> =>
		(matches[selector] ?? []).map((entry) => ({
			dataset: { runState: entry.runState },
		}));
	return {
		querySelector: (selector: string) => list(selector)[0] ?? null,
		querySelectorAll: (selector: string) => list(selector),
	} as unknown as ParentNode;
}

describe("notebook tour markers", () => {
	it("marks the panel, its close, refresh, source and catalog entries", () => {
		const markup = panelMarkup();
		expect(markup).toContain('data-tour="notebook-panel"');
		expect(markup).toContain('data-tour="notebook-close"');
		expect(markup).toContain('data-tour="notebook-refresh"');
		expect(markup).toContain('data-tour="notebook-source"');
		expect(markup.match(/data-tour-entry/g)).toHaveLength(2);
	});

	it("marks a notebook step and its Run button", () => {
		const markup = nodeMarkup("notebook");
		expect(markup).toContain("data-tour-node");
		expect(markup).toContain('data-run-state="pending"');
		expect(markup).toContain('data-tour="notebook-node-run"');
	});

	it("leaves ad-hoc input nodes unmarked, so step one is a template step", () => {
		const markup = nodeMarkup("input");
		expect(markup).not.toContain("data-tour-node");
		expect(markup).not.toContain('data-tour="notebook-node-run"');
	});
});

describe("collectState", () => {
	it("reports a closed panel with no catalog and no template", () => {
		expect(collectState(stubRoot({}))).toEqual({
			panelOpen: false,
			entries: 0,
			nodes: 0,
			firstNodeRunState: null,
			running: false,
		});
	});

	it("reports the first step's run state and whether any step runs", () => {
		const root = stubRoot({
			"[data-tour='notebook-panel']": [{}],
			"[data-tour-entry]": [{}, {}, {}],
			"[data-tour-node]": [{ runState: "done" }, { runState: "running" }],
		});
		expect(collectState(root)).toEqual({
			panelOpen: true,
			entries: 3,
			nodes: 2,
			firstNodeRunState: "done",
			running: true,
		});
	});

	it("ignores an unknown run state instead of forwarding it", () => {
		const root = stubRoot({ "[data-tour-node]": [{ runState: "weird" }] });
		expect(collectState(root).firstNodeRunState).toBeNull();
	});
});
