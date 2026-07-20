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

	return base;
}

/** Resolve the working directory an agent should be launched in. */
export function agentWorkingDirectory(config: StandaloneConfig): string {
	return resolveProjectDir(config);
}
