import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeaderActionButton } from "../web/HeaderActionButton";

describe("header action button", () => {
	it("renders an icon with an accessible label and tooltip", () => {
		const markup = renderToStaticMarkup(
			<HeaderActionButton
				icon="notebook"
				label="Open notebook"
				className="notebook-toggle"
			/>,
		);

		expect(markup).toContain('aria-label="Open notebook"');
		expect(markup).toContain('title="Open notebook"');
		expect(markup).not.toContain("data-tooltip");
		expect(markup).toContain('class="icon-action notebook-toggle"');
		expect(markup).toContain("<svg");
		expect(markup).not.toContain(">Open notebook</button>");
	});
});
