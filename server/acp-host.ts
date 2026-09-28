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
 * Bridges the standalone config.json world to the portable ACP core.
 *
 * Builds the `AcpRuntimeConfig` (settings + secret resolver) and the per-agent
 * `AgentConfig` (command/args/env/cwd/apiKey) that `AcpClient` consumes, sourced
 * from config.json and process.env instead of Obsidian plugin settings + secret
 * storage.
 */
import type { AcpRuntimeConfig } from "../src/acp/acp-runtime";
import type { AgentConfig } from "../src/acp/acp-client";
import {
	type ConfigAgent,
	type StandaloneConfig,
	resolveProjectDir,
} from "./config-store";
import { resolveManagedPiRuntime } from "./managed-runtime";

/**
 * Build the runtime the ACP layer needs from the loaded config.
 *
 * `resolveSecret(id)` treats the secret id as an environment variable name and
 * returns its value from process.env (populated from .env at server start),
 * matching the config.json `apiKeyEnvVar` convention.
 */
export function buildRuntime(
	config: StandaloneConfig,
	clientVersion: string,
): AcpRuntimeConfig {
	return {
		nodePath: config.nodePath,
		windowsWslMode: config.windows.wslMode,
		windowsWslDistribution: config.windows.wslDistribution,
		autoAllowPermissions: config.permissions.autoAllow,
		clientVersion,
		resolveSecret: (envVarName: string) => process.env[envVarName] ?? "",
	};
}

/**
 * Convert a config.json agent entry into an `AgentConfig` for spawning.
 *
 * The `apiKey` intent carries the env-var name in BOTH fields (secretId and
 * envVarName): `resolveSecret` reads process.env[secretId] and the resolved
 * value is injected under envVarName — which is the same name. Explicit `env`
 * entries are converted to a plain record and applied by AcpClient over
 * process.env.
 */
export function buildAgentConfig(
	agent: ConfigAgent,
	workingDirectory: string,
	thinkFile?: string,
): AgentConfig {
	const env: Record<string, string> = {};
	for (const { key, value } of agent.env) {
		env[key] = value;
	}

	const base: AgentConfig = {
		id: agent.id,
		displayName: agent.displayName,
		command: agent.command,
		args: [...agent.args],
		env,
		workingDirectory,
	};

	if (agent.apiKeyEnvVar) {
		base.apiKey = {
			secretId: agent.apiKeyEnvVar,
			envVarName: agent.apiKeyEnvVar,
		};
	}

	const managed = resolveManagedPiRuntime(workingDirectory);
	if (managed) {
		base.mcpServers = managed.mcpServers;
		base.redactionSecrets = managed.redactionSecrets;
		if (agent.id === "pi") {
			// WHY: only the server can turn the host-owned manifest into the
			// typed piLaunch contract. The browser and config.json cannot supply
			// extension paths or relax the selected workbench.
			base.piLaunch = {
				version: 1,
				workbench: managed.workbench.workspace,
				extensionPaths: [managed.extensionPath],
			};
			// Pi's adapter consumes the credential-free .mcp.json. It receives
			// only the safe manifest path so trustant-mcp-launch can resolve
			// host-owned credentials without exposing them to project files.
			base.env = {
				...base.env,
				TRUSTANT_MANAGED_RUNTIME: "1",
				TRUSTANT_RUNTIME_CONFIG: managed.runtimeConfigPath,
				TRUSTANT_PI_EXTENSION_PATH: managed.extensionPath,
				// Read by the extension before every provider request, so the
				// toolbar Thinking selector applies without restarting Pi.
				...(thinkFile ? { TRUSTANT_THINK_FILE: thinkFile } : {}),
			};
		}
	}

	return base;
}

/** Resolve the working directory an agent should be launched in. */
export function agentWorkingDirectory(config: StandaloneConfig): string {
	return resolveProjectDir(config);
}
