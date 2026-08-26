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

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeShellCommand } from "../server/shell-executor";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((dir) =>
			rm(dir, { recursive: true, force: true }),
		),
	);
});

describe("server shell executor", () => {
	it("runs in the requested cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "truacp-shell-"));
		temporaryDirectories.push(cwd);

		const result = await executeShellCommand({ command: "pwd", cwd });

		expect(await realpath(result.stdout.trim())).toBe(await realpath(cwd));
		expect(result.exitCode).toBe(0);
	});

	it("captures stdout, stderr, and a nonzero exit without rejecting", async () => {
		const result = await executeShellCommand({
			command: "printf stdout; printf stderr >&2; exit 7",
			cwd: process.cwd(),
		});

		expect(result.stdout).toBe("stdout");
		expect(result.stderr).toBe("stderr");
		expect(result.exitCode).toBe(7);
		expect(result.timedOut).toBe(false);
	});

	it("bounds runtime and captured output", async () => {
		const timed = await executeShellCommand({
			command: "sleep 1",
			cwd: process.cwd(),
			timeoutMs: 25,
		});
		expect(timed.timedOut).toBe(true);

		const capped = await executeShellCommand({
			command: "printf 1234567890",
			cwd: process.cwd(),
			maxOutputBytes: 5,
		});
		expect(capped.stdout).toBe("12345");
		expect(capped.truncated).toBe(true);
	});

	it("does not inherit credential-named host variables", async () => {
		const previous = process.env.TRUSTABLE_SHELL_TEST_SECRET;
		process.env.TRUSTABLE_SHELL_TEST_SECRET = "must-not-cross";
		try {
			const result = await executeShellCommand({
				command: 'printf "%s" "$TRUSTABLE_SHELL_TEST_SECRET"',
				cwd: process.cwd(),
			});
			expect(result.stdout).toBe("");
		} finally {
			if (previous === undefined) {
				delete process.env.TRUSTABLE_SHELL_TEST_SECRET;
			} else {
				process.env.TRUSTABLE_SHELL_TEST_SECRET = previous;
			}
		}
	});
});
