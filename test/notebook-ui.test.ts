import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatApp } from "../web/ChatApp";
import { NotebookPanel } from "../web/NotebookPanel";
import type {
	NotebookIndexResponse,
	NotebookSessionState,
	TemplateFrontMatter,
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

function template(
	overrides: Partial<TemplateFrontMatter> = {},
): TemplateFrontMatter {
	return {
		name: "Build",
		repo: "trustable-ai/templates",
		file: "build.md",
		edited: false,
		extra: {},
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
		fileSha: "",
		readmeSha: "",
		nodes: [],
		selectedNodeId: null,
		dirty: false,
		template: template(),
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
			localTemplate: null,
			busy: false,
			onRefresh: () => {},
			onSelect: () => {},
			onOpenLocal: () => {},
			onSaveToGitHub: () => {},
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

	it("omits the working-copy block when the application has no template", () => {
		const html = panel();
		expect(html).not.toContain("Working copy");
		expect(html).not.toContain("Changed");
		expect(html).not.toContain('aria-label="Template name"');
	});

	it("shows an unedited working copy without a changed badge or save fields", () => {
		const html = panel({ localTemplate: template() });
		expect(html).toContain("Build");
		expect(html).toContain("build.md");
		expect(html).toContain("Open");
		expect(html).not.toContain("notebook-changed-badge");
		expect(html).not.toContain('aria-label="Template name"');
	});

	it("highlights an edited working copy and offers the editable identity", () => {
		const html = panel({
			index: index({ hasToken: true }),
			localTemplate: template({ edited: true }),
		});
		expect(html).toContain("notebook-working-copy changed");
		expect(html).toContain("notebook-changed-badge");
		expect(html).toContain('aria-label="Template name"');
		expect(html).toContain('aria-label="Template file"');
		expect(html).toContain("Save to GitHub");
	});

	it("still flags an edited working copy without a write token, but offers no upstream save", () => {
		// The highlight is how the user learns their edits are local-only, so it
		// must not be gated on the token that only the upstream save needs.
		const html = panel({ localTemplate: template({ edited: true }) });
		expect(html).toContain("notebook-changed-badge");
		expect(html).toContain('aria-label="Template name"');
		expect(html).not.toContain("Save to GitHub");
		expect(html).toContain(
			"add in configuration your github token to edit templates",
		);
	});

	it("names an unsaved template rather than showing a blank heading", () => {
		const html = panel({
			localTemplate: template({ name: "", repo: "", file: "", edited: true }),
		});
		expect(html).toContain("Unnamed template");
		expect(html).toContain("not yet saved to a repository");
	});

	it("restores add and remove controls when a write token is configured", () => {
		const html = panel({ index: index({ hasToken: true }) });
		expect(html).toContain("Add template");
		expect(html).toContain("Remove Build");
	});

	it("hides add and remove controls on a read-only repository", () => {
		const html = panel({ activeNotebook: activeTemplate() });
		expect(html).not.toContain("notebook-warning");
		expect(html).not.toContain("Add template");
		expect(html).not.toContain("Remove Build");
		expect(html).not.toContain('type="password"');
		expect(html.toLowerCase()).not.toContain("rename");
	});

	it("marks the catalog entry the working copy came from", () => {
		const html = panel({ activeNotebook: activeTemplate() });
		expect(html).toContain("notebook-list-entry active");
	});

	it("no longer lists the working copy as a catalog entry", () => {
		expect(panel({ localTemplate: template() })).not.toContain(
			"Saved Template",
		);
	});
});
