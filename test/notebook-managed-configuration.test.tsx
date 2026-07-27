import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotebookPanel } from "../web/NotebookPanel";

describe("managed notebook configuration", () => {
	it("shows the active source without editable source controls", () => {
		const html = renderToStaticMarkup(
			<NotebookPanel
				index={{
					source: { repository: "trustable-ai/notebooks", ref: "main" },
					hasToken: false,
					readmeSha: "readme-sha",
					entries: [],
				}}
				activeNotebook={null}
				busy={false}
				onRefresh={() => undefined}
				onLoad={() => undefined}
				onSave={() => undefined}
				onAdd={() => undefined}
				onRemove={() => undefined}
				onClose={() => undefined}
			/>,
		);
		expect(html).toContain("trustable-ai/notebooks · main");
		expect(html).toContain("Trustable Configure");
		expect(html).not.toContain('aria-label="Notebook source"');
		expect(html).not.toContain('aria-label="Notebook branch"');
		expect(html).not.toContain("Load source");
	});
});
