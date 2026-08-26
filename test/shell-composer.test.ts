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
	classifyComposerSubmission,
	formatShellResult,
	READY_COMPOSER_PLACEHOLDER,
} from "../web/shell-command";

describe("TruACP shell composer", () => {
	it("publishes the exact ready message", () => {
		expect(READY_COMPOSER_PLACEHOLDER).toBe(
			"Message the agent or use the '!' to execute shell commands.",
		);
	});

	it("detects only a leading shell prefix", () => {
		expect(classifyComposerSubmission("  ! pwd  ")).toEqual({
			kind: "shell",
			command: "pwd",
			display: "! pwd",
		});
		expect(classifyComposerSubmission("Explain why ! is useful")).toEqual({
			kind: "agent",
			prompt: "Explain why ! is useful",
			display: "Explain why ! is useful",
		});
	});

	it("renders stdout, stderr, and nonzero status visibly", () => {
		const text = formatShellResult("demo", {
			stdout: "out\n",
			stderr: "err\n",
			exitCode: 9,
			signal: null,
			timedOut: false,
			truncated: false,
			durationMs: 4,
		});

		expect(text).toContain("$ demo");
		expect(text).toContain("out");
		expect(text).toContain("[stderr]\nerr");
		expect(text).toContain("[exit status 9]");
	});
});
