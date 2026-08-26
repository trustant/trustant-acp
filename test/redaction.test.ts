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
import {
	redactSensitiveText,
	redactSensitiveValue,
} from "../server/redaction";

describe("managed output redaction", () => {
	it("removes known MCP credentials and credential-bearing URIs", () => {
		const sentinel = "mcp-sentinel-password";
		const output = redactSensitiveText(
			`password=${sentinel} postgresql://demo:${sentinel}@postgres/db`,
			[sentinel],
		);
		expect(output).not.toContain(sentinel);
		expect(output).toContain("[REDACTED]");
	});

	it("redacts nested credential fields before session persistence", () => {
		const output = redactSensitiveValue({
			type: "tool_call_update",
			content: [
				{
					text: "token=mcp-sentinel-token",
					details: { apiKey: "mcp-sentinel-key" },
				},
			],
		});
		expect(JSON.stringify(output)).not.toContain("mcp-sentinel");
	});
});
