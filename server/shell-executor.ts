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

import { spawn } from "node:child_process";

export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const DEFAULT_SHELL_OUTPUT_LIMIT_BYTES = 256 * 1024;

export interface ShellExecutionOptions {
	command: string;
	cwd: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface ShellExecutionResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
}

const SENSITIVE_ENV_NAME =
	/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|COOKIE|DATABASE_URL|DSN|CONNECTION_STRING)(?:_|$)/i;

function shellEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		// WHY: provider and deployment credentials belong to the Node host, not
		// to a browser-visible shell transcript. Ordinary runtime variables such
		// as PATH, HOME and project configuration remain available.
		if (!SENSITIVE_ENV_NAME.test(name)) env[name] = value;
	}
	return env;
}

function shellCommand(command: string): {
	file: string;
	args: string[];
} {
	if (process.platform === "win32") {
		return {
			file: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c", command],
		};
	}
	return {
		file: process.env.SHELL || "/bin/sh",
		args: ["-lc", command],
	};
}

export async function executeShellCommand(
	options: ShellExecutionOptions,
): Promise<ShellExecutionResult> {
	const command = options.command.trim();
	if (!command) throw new Error("Bad request: shell command is required");
	const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
	const maxOutputBytes =
		options.maxOutputBytes ?? DEFAULT_SHELL_OUTPUT_LIMIT_BYTES;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
		throw new Error("Bad request: shell timeout must be positive");
	}
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1) {
		throw new Error("Bad request: shell output limit must be positive");
	}

	const invocation = shellCommand(command);
	const detached = process.platform !== "win32";
	const startedAt = Date.now();

	// WHY: direct shell mode must remain a server capability. The browser sends
	// only a command and session id; Node owns process creation, output bounds,
	// timeout enforcement and process-tree cleanup.
	const child = spawn(invocation.file, invocation.args, {
		cwd: options.cwd,
		env: shellEnvironment(),
		detached,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	let capturedBytes = 0;
	let truncated = false;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];

	const capture = (target: Buffer[], chunk: Buffer): void => {
		const remaining = maxOutputBytes - capturedBytes;
		if (remaining <= 0) {
			truncated = true;
			return;
		}
		const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
		target.push(kept);
		capturedBytes += kept.byteLength;
		if (kept.byteLength !== chunk.byteLength) truncated = true;
	};

	child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
	child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

	let timedOut = false;
	const terminate = (signal: NodeJS.Signals): void => {
		if (!child.pid) return;
		try {
			if (detached) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			// The process may have exited between the timeout and the signal.
		}
	};

	return new Promise<ShellExecutionResult>((resolve, reject) => {
		let settled = false;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate("SIGTERM");
			forceTimer = setTimeout(() => terminate("SIGKILL"), 1_000);
			forceTimer.unref?.();
		}, timeoutMs);
		timeout.unref?.();

		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceTimer) clearTimeout(forceTimer);
			// Do not serialize the spawn error object: platform errors can expose
			// host paths that are unrelated to the requested command.
			reject(new Error("Shell process could not be started"));
		});

		child.once("close", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceTimer) clearTimeout(forceTimer);
			resolve({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				exitCode,
				signal,
				timedOut,
				truncated,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}
