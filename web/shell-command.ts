import type { ShellExecutionResult } from "../server/shell-executor";

export const READY_COMPOSER_PLACEHOLDER =
	"Message the agent or use the '!' to execute shell commands.";

export type ComposerSubmission =
	| { kind: "agent"; prompt: string; display: string }
	| { kind: "shell"; command: string; display: string };

export function classifyComposerSubmission(input: string): ComposerSubmission {
	const text = input.trim();
	// WHY: classification happens before any ACP call so an explicit leading
	// `!` can bypass every agent equally; embedded exclamation marks remain
	// ordinary prompt text for Pi, Codex, Claude and custom agents.
	if (text.startsWith("!")) {
		return {
			kind: "shell",
			command: text.slice(1).trim(),
			display: text,
		};
	}
	return { kind: "agent", prompt: text, display: text };
}

export function formatShellResult(
	command: string,
	result: ShellExecutionResult,
): string {
	const sections = [`$ ${command}`];
	if (result.stdout) sections.push(result.stdout.replace(/\n$/, ""));
	if (result.stderr) {
		sections.push(`[stderr]\n${result.stderr.replace(/\n$/, "")}`);
	}
	if (result.timedOut) {
		sections.push("[command timed out]");
	} else if (result.exitCode !== 0) {
		sections.push(`[exit status ${result.exitCode ?? "unknown"}]`);
	}
	if (result.truncated) sections.push("[output truncated]");
	if (sections.length === 1) sections.push("(no output)");
	return sections.join("\n");
}

export function formatShellFailure(command: string, message: string): string {
	return `$ ${command}\n[shell error]\n${message}`;
}
