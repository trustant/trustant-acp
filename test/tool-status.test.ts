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
import { toolStatusPresentation } from "../web/tool-status";

describe("tool status presentation", () => {
	it("keeps completed calls green", () => {
		expect(
			toolStatusPresentation(
				{ title: "read", status: "completed" },
				[],
				false,
			),
		).toMatchObject({ status: "completed", label: "completed" });
	});

	it("marks a failed tool family as recovered after a later success", () => {
		expect(
			toolStatusPresentation(
				{ title: "mcp", status: "failed" },
				[{ title: "mcp", status: "completed" }],
				false,
			),
		).toMatchObject({
			status: "recovered",
			label: "recovered",
			rawStatus: "failed",
		});
	});

	it("correlates repeated shell inspection commands without parsing prose", () => {
		expect(
			toolStatusPresentation(
				{ title: "ls -la public/ | grep png", status: "failed" },
				[{ title: "ls -la public/", status: "completed" }],
				false,
			),
		).toMatchObject({ status: "recovered", rawStatus: "failed" });
	});

	it("shows known React validator findings as an amber issue state", () => {
		expect(
			toolStatusPresentation(
				{ title: "react_react_validate", status: "failed" },
				[],
				false,
			),
		).toMatchObject({ status: "issues-found", label: "issues found" });
	});

	it("shows an active unresolved failure as an intermediate attempt", () => {
		expect(
			toolStatusPresentation(
				{ title: "openserverless_action_list", status: "failed" },
				[],
				true,
			),
		).toMatchObject({
			status: "attempt-failed",
			label: "attempt failed",
		});
	});

	it("keeps an idle unresolved failure red", () => {
		expect(
			toolStatusPresentation(
				{ title: "openserverless_action_list", status: "failed" },
				[{ title: "mcp", status: "completed" }],
				false,
			),
		).toMatchObject({ status: "failed", label: "failed" });
	});
});
