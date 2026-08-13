import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildFrame, collectState, collectTargets } from "../web/tour-bridge";
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

/**
 * Stand-in for a laid-out `[data-tour]` element. collectTargets only asks for
 * the dataset, the rect and the text, so the tests stay in the "node"
 * environment rather than pulling in a DOM implementation.
 */
function stubTarget(
	tour: string,
	rect: Partial<DOMRect>,
	extra: { label?: string; text?: string } = {},
): unknown {
	return {
		dataset: { tour, tourLabel: extra.label },
		textContent: extra.text ?? "",
		getBoundingClientRect: () => ({
			x: 0,
			y: 0,
			width: 10,
			height: 10,
			...rect,
		}),
	};
}

function targetRoot(targets: unknown[]): ParentNode {
	return {
		querySelector: () => null,
		querySelectorAll: (selector: string) =>
			selector === "[data-tour]" ? targets : [],
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

	it("labels every catalog entry so the host can pick one by name", () => {
		const markup = panelMarkup();
		expect(markup).toContain('data-tour-label="App Suite"');
		expect(markup).toContain('data-tour-label="Build"');
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

describe("collectTargets", () => {
	it("keeps every match of a name, not just the first", () => {
		const root = targetRoot([
			stubTarget("notebook-entry", { y: 10 }, { label: "App Suite" }),
			stubTarget("notebook-entry", { y: 40 }, { label: "Build" }),
			stubTarget("notebook-close", { y: 0 }),
		]);
		const targets = collectTargets(root);
		expect(targets["notebook-entry"]).toHaveLength(2);
		expect(targets["notebook-entry"].map((t) => t.label)).toEqual([
			"App Suite",
			"Build",
		]);
		expect(targets["notebook-close"]).toHaveLength(1);
	});

	it("drops zero-sized elements so the host never spotlights nothing", () => {
		const root = targetRoot([
			stubTarget("notebook-refresh", { width: 0 }),
			stubTarget("notebook-close", { height: 0 }),
		]);
		expect(collectTargets(root)).toEqual({});
	});

	it("falls back to the rendered text when no label marker is present", () => {
		const root = targetRoot([
			stubTarget("run-all", {}, { text: "  Run all steps  " }),
		]);
		expect(collectTargets(root)["run-all"][0].label).toBe("Run all steps");
	});
});

describe("buildFrame", () => {
	it("stamps the protocol version so the host can spot an old bridge", () => {
		const frame = buildFrame(targetRoot([]));
		expect(frame.version).toBe(2);
		expect(frame.source).toBe("trustable-tour-frame");
	});
});
