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
 * Domain Models for Agent Configuration
 *
 * These types represent agent settings and configuration,
 * independent of the plugin infrastructure. They define
 * the core concepts of agent identity, capabilities, and
 * connection parameters.
 */

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Environment variable for agent process.
 *
 * Used to pass configuration and credentials to agent processes
 * via environment variables (e.g., API keys, paths, feature flags).
 */
export interface AgentEnvVar {
	/** Environment variable name (e.g., "ANTHROPIC_API_KEY") */
	key: string;

	/** Environment variable value */
	value: string;
}

// ============================================================================
// Agent Configuration
// ============================================================================

/**
 * Base configuration shared by all agent types.
 *
 * Defines the common properties needed to launch and communicate
 * with any ACP-compatible agent, regardless of the specific
 * implementation (Claude Code, Gemini CLI, custom agents, etc.).
 */
export interface BaseAgentSettings {
	/** Unique identifier for this agent (e.g., "claude", "gemini", "custom-1") */
	id: string;

	/** Human-readable display name shown in UI */
	displayName: string;

	/** Command to execute (full path to executable or command name) */
	command: string;

	/** Command-line arguments passed to the agent */
	args: string[];

	/** Environment variables for the agent process */
	env: AgentEnvVar[];
}

/**
 * Configuration for the Pi agent (`npx -y pi-acp`).
 *
 * Extends base settings with Pi-specific requirements.
 * The API key (PI_API_KEY) is referenced by an env-var name; the standalone
 * runtime resolves it from process.env at spawn time. Empty string means no
 * API key is configured.
 */
export interface PiAgentSettings extends BaseAgentSettings {
	/** Env-var name holding the Pi API key (PI_API_KEY) */
	apiKeySecretId: string;
}

/**
 * Configuration for Claude Code agent.
 *
 * Extends base settings with Claude-specific requirements.
 * The API key (ANTHROPIC_API_KEY) is stored in Obsidian's secret storage
 * and referenced by ID. Empty string means no API key is configured.
 */
export interface ClaudeAgentSettings extends BaseAgentSettings {
	/** Secret storage ID containing the Anthropic API key (ANTHROPIC_API_KEY) */
	apiKeySecretId: string;
}

/**
 * Configuration for Codex CLI agent.
 *
 * Extends base settings with Codex-specific requirements.
 * The API key (OPENAI_API_KEY) is stored in Obsidian's secret storage
 * and referenced by ID. Empty string means no API key is configured.
 */
export interface CodexAgentSettings extends BaseAgentSettings {
	/** Secret storage ID containing the OpenAI API key (OPENAI_API_KEY) */
	apiKeySecretId: string;
}

/**
 * Configuration for custom ACP-compatible agents.
 *
 * Uses only the base settings, allowing users to configure
 * any agent that implements the Agent Client Protocol.
 */
export type CustomAgentSettings = BaseAgentSettings;
