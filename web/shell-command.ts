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
