import { describe, expect, it } from "vitest";
import {
	addNotebookIndexEntry,
	advanceNotebookSelection,
	insertAdHocNode,
	moveNotebookNode,
	normalizeNotebookSessionState,
	notebookPromptSummary,
	notebookPromptsForSave,
	parseNotebookIndex,
	parseNotebookMarkdown,
	parseTemplateDocument,
	pinNotebookNode,
	removeNotebookIndexEntry,
	removeNotebookNode,
	serializeNotebookMarkdown,
	serializeTemplateDocument,
	shouldContinueRunAll,
} from "../src/services/notebook";
import type { NotebookNode } from "../src/types/notebook";

function node(
	id: string,
	kind: "notebook" | "input" = "notebook",
): NotebookNode {
	return { id, kind, prompt: id, outputs: [] };
}

describe("template front matter", () => {
	const fm = {
		name: "Build",
		repo: "trustable-ai/templates",
		file: "flows/build.md",
		edited: false,
		extra: {},
	};

	it("must be stripped before prompt splitting", () => {
		// The front matter delimiter and the prompt separator are the same
		// token, so handing a front-mattered document straight to the prompt
		// splitter silently turns the metadata into the first prompt. This is
		// the defect that requires the positional strip.
		const document = serializeTemplateDocument(fm, ["first", "second"]);
		expect(parseNotebookMarkdown(document)[0]).toContain("name: Build");
		expect(parseTemplateDocument(document).prompts).toEqual([
			"first",
			"second",
		]);
	});

	it("round-trips provenance and prompts", () => {
		const document = serializeTemplateDocument(fm, ["one", "two\nlines"]);
		const parsed = parseTemplateDocument(document);
		expect(parsed.hasFrontMatter).toBe(true);
		expect(parsed.frontMatter).toEqual(fm);
		expect(parsed.prompts).toEqual(["one", "two\nlines"]);
	});

	it("emits every modelled key even when empty", () => {
		const document = serializeTemplateDocument(
			{ name: "", repo: "", file: "", edited: true, extra: {} },
			["p"],
		);
		expect(document.startsWith(
			"---\nname: \nrepo: \nfile: \nedited: true\n---\n\n",
		)).toBe(true);
	});

	it("keeps the body byte-identical to the upstream serialization", () => {
		const prompts = ["# A\n\nbody", "second"];
		const document = serializeTemplateDocument(fm, prompts);
		expect(document.endsWith(serializeNotebookMarkdown(prompts))).toBe(true);
	});

	it("treats a document without a leading delimiter as having no front matter", () => {
		const parsed = parseTemplateDocument("just a prompt\n\n---\n\nsecond");
		expect(parsed.hasFrontMatter).toBe(false);
		expect(parsed.prompts).toEqual(["just a prompt", "second"]);
	});

	it("treats an unterminated block as having no front matter", () => {
		const parsed = parseTemplateDocument("---\nname: A\n\nstill the body");
		expect(parsed.hasFrontMatter).toBe(false);
		expect(parsed.prompts).toEqual(["name: A\n\nstill the body"]);
	});

	it("does not swallow a distant separator as a terminator", () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		expect(parseTemplateDocument(`---\n${body}\n---\ntail`).hasFrontMatter).toBe(
			false,
		);
	});

	it("coerces the edited flag from the accepted spellings", () => {
		for (const value of ["true", "TRUE", "yes", "1"]) {
			expect(
				parseTemplateDocument(`---\nedited: ${value}\n---\n\np`).frontMatter
					.edited,
			).toBe(true);
		}
		for (const value of ["false", "no", "0", "", "maybe"]) {
			expect(
				parseTemplateDocument(`---\nedited: ${value}\n---\n\np`).frontMatter
					.edited,
			).toBe(false);
		}
	});

	it("prevents a value from forging a delimiter", () => {
		const document = serializeTemplateDocument(
			{ ...fm, name: "evil\n---\nrepo: attacker/repo" },
			["p"],
		);
		const parsed = parseTemplateDocument(document);
		expect(parsed.frontMatter.repo).toBe("trustable-ai/templates");
		expect(parsed.prompts).toEqual(["p"]);
	});

	it("preserves unknown keys across a round trip", () => {
		const parsed = parseTemplateDocument(
			"---\nname: A\nauthor: me\n---\n\np",
		);
		expect(parsed.frontMatter.extra).toEqual({ author: "me" });
		expect(
			parseTemplateDocument(
				serializeTemplateDocument(parsed.frontMatter, parsed.prompts),
			).frontMatter.extra,
		).toEqual({ author: "me" });
	});

	it("ignores blank and commented lines inside the block", () => {
		const parsed = parseTemplateDocument(
			"---\n\n# a comment\nname: A\n---\n\np",
		);
		expect(parsed.frontMatter.name).toBe("A");
		expect(parsed.frontMatter.extra).toEqual({});
	});
});

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

	it("moves a step up and down", () => {
		const nodes = [node("a"), node("b"), node("c")];
		expect(moveNotebookNode(nodes, "b", -1).map((item) => item.id)).toEqual([
			"b",
			"a",
			"c",
		]);
		expect(moveNotebookNode(nodes, "b", 1).map((item) => item.id)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	it("leaves the order unchanged at either boundary", () => {
		const nodes = [node("a"), node("b")];
		expect(moveNotebookNode(nodes, "a", -1)).toBe(nodes);
		expect(moveNotebookNode(nodes, "b", 1)).toBe(nodes);
	});

	// Only notebook nodes reach template.md, so a move has to swap against the
	// nearest step: hopping just the input would reorder the view but not the file.
	it("steps over an ad-hoc input so view and saved order agree", () => {
		const nodes = [node("a"), node("input", "input"), node("b")];
		const moved = moveNotebookNode(nodes, "b", -1);
		expect(moved.map((item) => item.id)).toEqual(["b", "input", "a"]);
		expect(notebookPromptsForSave(moved)).toEqual(["b", "a"]);
	});

	it("refuses to move an ad-hoc input or an unknown node", () => {
		const nodes = [node("a"), node("input", "input"), node("b")];
		expect(moveNotebookNode(nodes, "input", -1)).toBe(nodes);
		expect(moveNotebookNode(nodes, "missing", 1)).toBe(nodes);
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

describe("shouldContinueRunAll", () => {
	it("continues to the next step after a successful one", () => {
		expect(shouldContinueRunAll("ok", true)).toBe(true);
	});

	it("stops the sequence when a step fails", () => {
		expect(shouldContinueRunAll("failed", true)).toBe(false);
	});

	// A stop during a step: the step reports the cancel even though a cancelled
	// ACP turn resolves successfully.
	it("stops the sequence when a step is cancelled", () => {
		expect(shouldContinueRunAll("cancelled", true)).toBe(false);
	});

	// A stop between two steps: no step result reports it, so the cleared run
	// flag is the only signal.
	it("stops when the run flag was cleared, even after a successful step", () => {
		expect(shouldContinueRunAll("ok", false)).toBe(false);
	});
});
