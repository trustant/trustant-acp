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
import { ChatApp } from "../web/ChatApp";
import { NotebookPanel } from "../web/NotebookPanel";
import { NotebookNodeView } from "../web/NotebookNodeView";
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

	// The composer now shows Stop while a run-all is in flight as well as during
	// a turn, so guard the idle render: at rest it must still offer Send only.
	it("offers Send and no Stop when nothing is running", () => {
		const html = renderToStaticMarkup(React.createElement(ChatApp));
		expect(html).toContain(">Send<");
		expect(html).not.toContain(">Stop<");
		expect(html).not.toContain("Stopping…");
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

	it("restores the remove control when a write token is configured", () => {
		const html = panel({ index: index({ hasToken: true }) });
		expect(html).toContain("Remove Build");
	});

	it("offers no add-template form, even with a write token", () => {
		// Save to GitHub already creates and indexes a template that does not
		// exist, so a separate creation path would only duplicate it.
		const html = panel({ index: index({ hasToken: true }) });
		expect(html).not.toContain("Add template");
		expect(html).not.toContain("notebook-add");
		expect(html).not.toContain('aria-label="New template name"');
		expect(html).not.toContain('aria-label="New template path"');
	});

	it("hides the remove control on a read-only repository", () => {
		const html = panel({ activeNotebook: activeTemplate() });
		expect(html).not.toContain("notebook-warning");
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

	it("labels the ad-hoc pin control as adding to the loaded template", () => {
		// Pinning is the only way to start a template now, so the control says
		// which of the two it does. An ad-hoc node only exists while one is
		// loaded, so it always adds; the chat-turn variant is covered in
		// notebook-node-edit.test.ts and by the ChatApp render above.
		const html = renderToStaticMarkup(
			React.createElement(NotebookNodeView, {
				node: {
					id: "input-1",
					kind: "input" as const,
					prompt: "ad-hoc",
					outputs: [],
				},
				selected: false,
				editing: false,
				running: false,
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
		expect(html).toContain("Add to template");
		expect(html).not.toContain(">Pin<");
	});
});
