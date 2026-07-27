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
