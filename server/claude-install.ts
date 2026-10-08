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

/**
 * On-demand Claude Code installation, gated on accepting Anthropic's terms.
 *
 * Claude Code is proprietary and must not ship in the Trustant image, so it is
 * installed here, from npm, into a private prefix on the user's machine, and
 * only after the user accepts Anthropic's Commercial Terms in the UI. The
 * prefix is `$TRUACP_CLAUDE_PREFIX`; Trustant points it at the persistent
 * workspace volume because the image's own ~/.local does not survive a pod
 * restart.
 */
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { CLAUDE_PACKAGES, CLAUDE_TERMS_URL } from "./claude-version";

/** Result of `/api/claude/install-status`. */
export interface ClaudeInstallStatus {
	/** True when every pinned package is present at its pinned version. */
	installed: boolean;
	/** True when the user has accepted the terms in this prefix. */
	accepted: boolean;
	specs: string[];
	termsUrl: string;
	prefix: string;
}

const ACCEPTANCE_FILE = "license-accepted.json";
const INSTALL_TIMEOUT_MS = 10 * 60_000;

function specs(): string[] {
	return CLAUDE_PACKAGES.map((p) => `${p.name}@${p.version}`);
}

/** Install prefix; overridable so Trustant can put it on a persistent volume. */
export function claudePrefix(): string {
	return (
		process.env.TRUACP_CLAUDE_PREFIX ||
		join(homedir(), ".local", "share", "truacp", "claude")
	);
}

function binPath(name: string): string {
	return join(claudePrefix(), "node_modules", ".bin", name);
}

/** The installed `claude` CLI (used for login and by the ACP adapter). */
export function claudeCliPath(): string {
	return binPath("claude");
}

/** The installed ACP adapter that TruACP spawns for the claude agent. */
export function claudeAcpPath(): string {
	return binPath("claude-agent-acp");
}

function installedVersion(name: string): string | null {
	try {
		const pkg = JSON.parse(
			readFileSync(
				join(claudePrefix(), "node_modules", name, "package.json"),
				"utf8",
			),
		) as { version?: string };
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

export function isClaudeInstalled(): boolean {
	return (
		CLAUDE_PACKAGES.every((p) => installedVersion(p.name) === p.version) &&
		existsSync(claudeCliPath()) &&
		existsSync(claudeAcpPath())
	);
}

export function claudeInstallStatus(): ClaudeInstallStatus {
	return {
		installed: isClaudeInstalled(),
		accepted: existsSync(join(claudePrefix(), ACCEPTANCE_FILE)),
		specs: specs(),
		termsUrl: CLAUDE_TERMS_URL,
		prefix: claudePrefix(),
	};
}

function runNpmInstall(prefix: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"npm",
			[
				"install",
				"--prefix",
				prefix,
				"--no-audit",
				"--no-fund",
				"--save-exact",
				...specs(),
			],
			// Run from the prefix so npm never walks up into a project tree.
			{ cwd: prefix, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 << 20 },
			(err, _stdout, stderr) => {
				if (err) {
					const tail = String(stderr || err.message)
						.trim()
						.split("\n")
						.slice(-15)
						.join("\n");
					reject(new Error(`npm install failed:\n${tail}`));
				} else resolve();
			},
		);
	});
}

// Single-flight: a second click or a second tab joins the running install
// instead of starting a concurrent npm into the same prefix.
let inFlight: Promise<ClaudeInstallStatus> | null = null;

/**
 * Record acceptance of Anthropic's terms, then install the pinned packages.
 * Refuses unless `accept` is exactly true: the install must never happen
 * without an explicit, recorded acceptance.
 */
export function installClaude(accept: unknown): Promise<ClaudeInstallStatus> {
	if (accept !== true) {
		return Promise.reject(
			new Error(
				`Claude Code is installed only after accepting Anthropic's Commercial Terms (${CLAUDE_TERMS_URL}).`,
			),
		);
	}
	if (inFlight) return inFlight;
	inFlight = (async () => {
		const prefix = claudePrefix();
		await mkdir(prefix, { recursive: true });
		await writeFile(
			join(prefix, ACCEPTANCE_FILE),
			JSON.stringify(
				{
					termsUrl: CLAUDE_TERMS_URL,
					acceptedAt: new Date().toISOString(),
					specs: specs(),
				},
				null,
				2,
			) + "\n",
		);
		if (!isClaudeInstalled()) {
			try {
				await runNpmInstall(prefix);
			} catch (e) {
				// A half-written node_modules would make the next status check
				// lie; drop it so a retry starts clean. Acceptance is kept.
				await rm(join(prefix, "node_modules"), {
					recursive: true,
					force: true,
				});
				throw e;
			}
		}
		const status = claudeInstallStatus();
		if (!status.installed) {
			throw new Error(
				"npm finished but Claude Code is still missing from " + prefix,
			);
		}
		return status;
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}
