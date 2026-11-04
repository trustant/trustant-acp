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

import { describe, expect, it } from "vitest";
import { headerFloor } from "../web/min-width-bridge";

/**
 * The host divider stops at this number, so it must count selects at their
 * min-width (not their current width) and every fixed item at full size —
 * otherwise the panel either stops too early or lets the icons overflow.
 */

type Fake = { tagName: string; offsetWidth: number; style: Record<string, string> };

function el(tagName: string, offsetWidth: number, style: Record<string, string> = {}): Fake {
	return { tagName, offsetWidth, style };
}

function fakeWin(): Window {
	return {
		getComputedStyle: (node: Fake) => ({
			display: "flex",
			position: "static",
			marginLeft: "0px",
			marginRight: "0px",
			...node.style,
		}),
	} as unknown as Window;
}

function topbar(children: Fake[]): HTMLElement {
	return {
		tagName: "HEADER",
		offsetWidth: 0,
		children,
		style: {
			columnGap: "10px",
			paddingLeft: "15px",
			paddingRight: "15px",
			borderLeftWidth: "0px",
			borderRightWidth: "0px",
		},
	} as unknown as HTMLElement;
}

describe("headerFloor", () => {
	it("counts selects at min-width and fixed items at full width", () => {
		const bar = topbar([
			el("SELECT", 150, { minWidth: "80px" }),
			el("SPAN", 60),
			el("SELECT", 190, { minWidth: "80px" }),
			el("BUTTON", 35),
			el("BUTTON", 35),
		]);
		// padding 30 + selects 160 + fixed 130 + 4 gaps 40
		expect(headerFloor(bar, fakeWin())).toBe(360);
	});

	it("ignores hidden items and their gaps", () => {
		const bar = topbar([
			el("SELECT", 150, { minWidth: "80px" }),
			el("BUTTON", 35, { display: "none" }),
			el("BUTTON", 35),
		]);
		expect(headerFloor(bar, fakeWin())).toBe(30 + 80 + 35 + 10);
	});
});
