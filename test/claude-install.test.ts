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

import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claudeAcpPath,
	claudeCliPath,
	claudeInstallStatus,
	installClaude,
} from "../server/claude-install";
import { CLAUDE_PACKAGES } from "../server/claude-version";
import { buildAgentConfig } from "../server/acp-host";
import { DEFAULT_CONFIG } from "../server/config-store";

let prefix: string;

beforeEach(async () => {
	prefix = await mkdtemp(join(tmpdir(), "claude-install-"));
	process.env.TRUACP_CLAUDE_PREFIX = prefix;
});

afterEach(async () => {
	delete process.env.TRUACP_CLAUDE_PREFIX;
	await rm(prefix, { recursive: true, force: true });
});

/** Lay out a fake install at the pinned versions. */
async function fakeInstall(): Promise<void> {
	for (const p of CLAUDE_PACKAGES) {
		const dir = join(prefix, "node_modules", p.name);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: p.name, version: p.version }),
		);
	}
	await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
	await writeFile(claudeCliPath(), "");
	await writeFile(claudeAcpPath(), "");
}

describe("claude on-demand install", () => {
	it("reports not installed and not accepted on an empty prefix", () => {
		const s = claudeInstallStatus();
		expect(s.installed).toBe(false);
		expect(s.accepted).toBe(false);
		expect(s.termsUrl).toBe(
			"https://www.anthropic.com/legal/commercial-terms",
		);
	});

	it("refuses to install without explicit acceptance", async () => {
		await expect(installClaude(undefined)).rejects.toThrow(
			/Commercial Terms/,
		);
		await expect(installClaude("true")).rejects.toThrow();
		expect(claudeInstallStatus().accepted).toBe(false);
	});

	it("records acceptance and skips npm when already installed", async () => {
		await fakeInstall();
		const s = await installClaude(true);
		expect(s.installed).toBe(true);
		expect(s.accepted).toBe(true);
		const rec = JSON.parse(
			await readFile(join(prefix, "license-accepted.json"), "utf8"),
		) as { termsUrl: string; specs: string[] };
		expect(rec.termsUrl).toContain("commercial-terms");
		expect(rec.specs).toContain("@anthropic-ai/claude-code@2.1.216");
	});

	it("treats a different installed version as not installed", async () => {
		await fakeInstall();
		await writeFile(
			join(prefix, "node_modules", CLAUDE_PACKAGES[0].name, "package.json"),
			JSON.stringify({ version: "0.0.1" }),
		);
		expect(claudeInstallStatus().installed).toBe(false);
	});

	it("never spawns claude via npx, and refuses when not installed", async () => {
		const agent = {
			...DEFAULT_CONFIG.agents.claude,
			command: "npx",
			args: ["-y", "@agentclientprotocol/claude-agent-acp"],
		};
		expect(() => buildAgentConfig(agent, prefix)).toThrow(/not installed/);
		await fakeInstall();
		const cfg = buildAgentConfig(agent, prefix);
		expect(cfg.command).toBe(claudeAcpPath());
		expect(cfg.args).toEqual([]);
		expect(cfg.env?.CLAUDE_CODE_EXECUTABLE).toBe(claudeCliPath());
	});
});
