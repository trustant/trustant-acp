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
