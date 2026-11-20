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

// trustant#206: setup.sh patches pi-ai's retry classifier so Ollama's 429
// "session usage limit" is not retried. This runs the exact embedded transform
// against a fixture shaped like the pinned pi-ai 0.82.0 layout.

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it } from "vitest";

// Excerpt of pi-ai 0.82.0 dist/utils/retry.js: same anchor, same classifier.
const RETRY_JS = `function buildProviderErrorPattern(patterns) {
    return new RegExp(patterns.join("|"), "i");
}
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
    "GoUsageLimitError",
    "Monthly usage limit reached",
    "quota exceeded",
]);
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
    "rate.?limit",
    "429",
]);
export function isRetryableAssistantError(message) {
    if (message.stopReason !== "error" || !message.errorMessage)
        return false;
    const errorMessage = message.errorMessage;
    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))
        return false;
    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
`;

function extractPatch(): string {
	const setup = readFileSync(join(process.cwd(), "setup.sh"), "utf8");
	const match = setup.match(
		/<<'PI_AI_RETRY_PATCH'\n([\s\S]*?)\nPI_AI_RETRY_PATCH\n/,
	);
	if (!match) throw new Error("PI_AI_RETRY_PATCH heredoc not found");
	return match[1];
}

function writePiAi(root: string, version: string, source = RETRY_JS) {
	mkdirSync(join(root, "@earendil-works", "pi-ai", "dist", "utils"), {
		recursive: true,
	});
	writeFileSync(
		join(root, "@earendil-works", "pi-ai", "package.json"),
		JSON.stringify({ version, type: "module" }),
	);
	writeFileSync(
		join(root, "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
		source,
	);
}

describe("setup.sh pi-ai retry patch (trustant#206)", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function setupFixture() {
		dir = mkdtempSync(join(tmpdir(), "pi-ai-retry-"));
		const nodeModules = join(dir, "node_modules");
		writePiAi(nodeModules, "0.82.0");
		// Nested copy imported by pi-coding-agent's agent-session.
		writePiAi(
			join(nodeModules, "@earendil-works", "pi-coding-agent", "node_modules"),
			"0.82.0",
		);
		// Another version (pi-mcp-adapter's dependency) must be left alone.
		writePiAi(join(nodeModules, "pi-mcp-adapter", "node_modules"), "0.74.2");
		const script = join(dir, "patch.cjs");
		writeFileSync(script, extractPatch());
		const run = () =>
			execFileSync("node", [script, nodeModules, "0.82.0"], {
				encoding: "utf8",
			});
		return { nodeModules, run };
	}

	it("makes the session usage limit non-retryable and keeps 429 retryable", async () => {
		const { nodeModules, run } = setupFixture();
		expect(run()).toContain("to 2 of 2 copies");

		for (const base of [
			nodeModules,
			join(nodeModules, "@earendil-works", "pi-coding-agent", "node_modules"),
		]) {
			const url = pathToFileURL(
				join(base, "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
			).href;
			const { isRetryableAssistantError } = (await import(url)) as {
				isRetryableAssistantError: (message: {
					stopReason: string;
					errorMessage: string;
				}) => boolean;
			};
			expect(
				isRetryableAssistantError({
					stopReason: "error",
					errorMessage:
						"429 you have reached your session usage limit, please wait or upgrade to continue",
				}),
			).toBe(false);
			expect(
				isRetryableAssistantError({
					stopReason: "error",
					errorMessage: "429 Too Many Requests",
				}),
			).toBe(true);
		}

		const other = readFileSync(
			join(
				nodeModules,
				"pi-mcp-adapter",
				"node_modules",
				"@earendil-works",
				"pi-ai",
				"dist",
				"utils",
				"retry.js",
			),
			"utf8",
		);
		expect(other).toBe(RETRY_JS);
	});

	it("is idempotent", () => {
		const { nodeModules, run } = setupFixture();
		run();
		const path = join(
			nodeModules,
			"@earendil-works",
			"pi-ai",
			"dist",
			"utils",
			"retry.js",
		);
		const once = readFileSync(path, "utf8");
		expect(run()).toContain("already applied");
		expect(readFileSync(path, "utf8")).toBe(once);
		expect(once.split('"session usage limit",').length - 1).toBe(1);
	});

	it("fails closed when the anchor is missing", () => {
		const { nodeModules, run } = setupFixture();
		writePiAi(nodeModules, "0.82.0", "export const x = 1;\n");
		expect(run).toThrow(/expected one patch target/);
	});
});
