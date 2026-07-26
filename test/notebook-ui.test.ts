import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatApp } from "../web/ChatApp";
import { NotebookPanel } from "../web/NotebookPanel";

describe("notebook UI", () => {
	it("keeps ordinary chat disabled until an agent is selected and exposes the toolbar", () => {
		const html = renderToStaticMarkup(React.createElement(ChatApp));
		expect(html).toContain("Notebook");
		expect(html).toContain("Run next");
		expect(html).toContain("Please Select Agent");
	});

	it("shows a server-side token warning without a token input or rename control", () => {
		const html = renderToStaticMarkup(
			React.createElement(NotebookPanel, {
				source: "trustable-ai/notebooks",
				sourceRef: "main",
				index: {
					source: {
						repository: "trustable-ai/notebooks",
						ref: "main",
					},
					hasToken: false,
					readmeSha: "sha",
					entries: [],
				},
				activeNotebook: null,
				busy: false,
				onSourceChange: () => {},
				onRefChange: () => {},
				onRefresh: () => {},
				onLoad: () => {},
				onSave: () => {},
				onAdd: () => {},
				onRemove: () => {},
				onClose: () => {},
			}),
		);
		expect(html).toContain("NOTEBOOK_GITHUB_TOKEN");
		expect(html).not.toContain('type="password"');
		expect(html.toLowerCase()).not.toContain("rename");
	});
});
