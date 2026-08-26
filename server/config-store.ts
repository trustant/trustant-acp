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
 * config.json loading, validation, and access for the standalone ACP client.
 *
 * Mirrors the subset of the old plugin settings that a headless server needs.
 * Obsidian-only settings (floating window geometry, chat font size, export
 * templates, etc.) are intentionally omitted here — they belong to the UI
 * layer, added in a later phase. Secrets are never stored: agents reference an
 * env-var name (`apiKeyEnvVar`) resolved from process.env at spawn time.
 */
import { readFile } from "fs/promises";
import { resolve, isAbsolute } from "path";

/** A single environment variable passed to an agent process. */
export interface ConfigEnvVar {
	key: string;
	value: string;
}

/** One agent entry in config.json. */
export interface ConfigAgent {
	id: string;
	displayName: string;
	command: string;
	args: string[];
	env: ConfigEnvVar[];
	/**
	 * Name of the env var (resolved from process.env / .env) holding this
	 * agent's API key. Injected into the spawn env at launch. Omit for agents
	 * that set their key directly via `env`.
	 */
	apiKeyEnvVar?: string;
}

/** Full config.json shape. */
export interface StandaloneConfig {
	server: { port: number; projectDir: string; host?: string };
	defaultAgentId: string;
	nodePath: string;
	agents: Record<string, ConfigAgent>;
	customAgents: ConfigAgent[];
	permissions: { autoAllow: boolean };
	windows: { wslMode: boolean; wslDistribution: string };
}

/** Defaults applied when config.json is absent or partial. */
export const DEFAULT_CONFIG: StandaloneConfig = {
	server: { port: 4096, projectDir: "." },
	defaultAgentId: "pi",
	nodePath: "",
	agents: {
		claude: {
			id: "claude",
			displayName: "Claude Code",
			command: "npx",
			args: ["-y", "@agentclientprotocol/claude-agent-acp"],
			env: [],
			apiKeyEnvVar: "ANTHROPIC_API_KEY",
		},
		codex: {
			id: "codex",
			displayName: "Codex",
			command: "npx",
			args: ["-y", "@agentclientprotocol/codex-acp"],
			env: [],
			apiKeyEnvVar: "OPENAI_API_KEY",
		},
		pi: {
			id: "pi",
			displayName: "Pi",
			// Use the globally installed `pi-acp` binary directly (setup.sh
			// installs it): launches are instant and work offline, unlike `npx`.
			// `pi-acp` takes no flags.
			command: "pi-acp",
			args: [],
			env: [],
			apiKeyEnvVar: "PI_API_KEY",
		},
	},
	customAgents: [],
	permissions: { autoAllow: false },
	windows: { wslMode: false, wslDistribution: "" },
};

/**
 * Deep-merge a partial parsed config over the defaults. Only known keys are
 * honored; `agents` and `customAgents` fully replace their defaults when
 * present so a user can define a different agent set.
 */
function mergeConfig(raw: unknown): StandaloneConfig {
	const r = (raw ?? {}) as Partial<StandaloneConfig>;
	return {
		server: { ...DEFAULT_CONFIG.server, ...(r.server ?? {}) },
		defaultAgentId: r.defaultAgentId ?? DEFAULT_CONFIG.defaultAgentId,
		nodePath: r.nodePath ?? DEFAULT_CONFIG.nodePath,
		agents: r.agents ?? DEFAULT_CONFIG.agents,
		customAgents: r.customAgents ?? DEFAULT_CONFIG.customAgents,
		permissions: { ...DEFAULT_CONFIG.permissions, ...(r.permissions ?? {}) },
		windows: { ...DEFAULT_CONFIG.windows, ...(r.windows ?? {}) },
	};
}

/**
 * Load config.json from disk, applying defaults for any missing fields.
 * A missing file is not an error — the full default config is returned so the
 * client works out of the box.
 *
 * @param configPath absolute or cwd-relative path to config.json
 */
export async function loadConfig(configPath: string): Promise<StandaloneConfig> {
	const abs = isAbsolute(configPath)
		? configPath
		: resolve(process.cwd(), configPath);
	try {
		const text = await readFile(abs, "utf8");
		return mergeConfig(JSON.parse(text));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_CONFIG };
		}
		throw new Error(
			`Failed to load config from ${abs}: ${(err as Error).message}`,
		);
	}
}

/**
 * Look up an agent by id across built-in `agents` and `customAgents`.
 */
export function findConfigAgent(
	config: StandaloneConfig,
	agentId: string,
): ConfigAgent | null {
	return (
		config.agents[agentId] ??
		config.customAgents.find((a) => a.id === agentId) ??
		null
	);
}

/**
 * List all configured agents (built-ins first, then custom).
 */
export function listConfigAgents(config: StandaloneConfig): ConfigAgent[] {
	return [...Object.values(config.agents), ...config.customAgents];
}

/**
 * Resolve the working directory for agents: an absolute projectDir as-is, or a
 * relative one resolved against process.cwd().
 */
export function resolveProjectDir(config: StandaloneConfig): string {
	const dir = config.server.projectDir || ".";
	return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}
