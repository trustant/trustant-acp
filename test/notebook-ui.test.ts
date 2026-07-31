import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatApp } from "../web/ChatApp";
import { NotebookPanel } from "../web/NotebookPanel";
import type {
	NotebookIndexResponse,
	NotebookSessionState,
} from "../src/types/notebook";

function index(
	overrides: Partial<NotebookIndexResponse> = {},
): NotebookIndexResponse {
	return {
		source: { repository: "trustable-ai/templates", ref: "main" },
		hasToken: false,
		readmeSha: "sha",
		entries: [{ name: "Build", path: "build.md", comment: "" }],
		...overrides,
	};
}

function activeTemplate(
	overrides: Partial<NotebookSessionState> = {},
): NotebookSessionState {
	return {
		version: 1,
		source: { repository: "trustable-ai/templates", ref: "main" },
		notebookName: "Build",
		path: "build.md",
		fileSha: "file",
		readmeSha: "sha",
		nodes: [],
		selectedNodeId: null,
		dirty: true,
		...overrides,
	};
}

function panel(
	props: Partial<React.ComponentProps<typeof NotebookPanel>> = {},
): string {
	return renderToStaticMarkup(
		React.createElement(NotebookPanel, {
			index: index(),
			activeNotebook: null,
			hasLocalTemplate: false,
			busy: false,
			onRefresh: () => {},
			onLoad: () => {},
			onLoadLocal: () => {},
			onSave: () => {},
			onAdd: () => {},
			onRemove: () => {},
			onClose: () => {},
			...props,
		}),
	);
}

describe("template UI", () => {
	it("keeps ordinary chat disabled until an agent is selected and exposes the toolbar", () => {
		const html = renderToStaticMarkup(React.createElement(ChatApp));
		expect(html).toContain("Open templates");
		expect(html).toContain("Run next step");
		expect(html).toContain("Run all steps");
		expect(html).toContain("Please Select Agent");
	});

	it("shows the managed source read-only, without source configuration fields", () => {
		const html = panel();
		expect(html).toContain("trustable-ai/templates · main");
		expect(html).not.toContain('aria-label="Notebook source"');
		expect(html).not.toContain('aria-label="Notebook branch"');
		expect(html).not.toContain("Load source");
	});

	it("hides every write control on a read-only repository and shows only a quiet hint", () => {
		const html = panel({ activeNotebook: activeTemplate() });
		// No warning banner, no add section, no active-template name row.
		expect(html).not.toContain("notebook-warning");
		expect(html).not.toContain("Add template");
		expect(html).not.toContain("notebook-add");
		expect(html).not.toContain("Save");
		expect(html).not.toContain("build.md");
		expect(html).toContain("notebook-hint");
		expect(html).toContain(
			"add in configuration your github token to edit templates",
		);
		expect(html).not.toContain('type="password"');
		expect(html.toLowerCase()).not.toContain("rename");
	});

	it("restores add, remove, and save controls when a write token is configured", () => {
		const html = panel({
			index: index({ hasToken: true }),
			activeNotebook: activeTemplate(),
		});
		expect(html).toContain("Add template");
		expect(html).toContain("Save");
		expect(html).toContain("build.md");
		expect(html).not.toContain("notebook-hint");
	});

	it("lists a saved local template ahead of the indexed ones", () => {
		const html = panel({ hasLocalTemplate: true });
		expect(html).toContain("Saved Template");
		expect(html.indexOf("Saved Template")).toBeLessThan(
			html.indexOf("Build"),
		);
	});

	it("omits the saved entry when the application has no local template", () => {
		expect(panel()).not.toContain("Saved Template");
	});
});
