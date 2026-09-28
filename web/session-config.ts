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

import type {
	SessionConfigOption,
	SessionConfigSelectOption,
} from "../src/types/session";
import { flattenConfigSelectOptions } from "../src/types/session";

export type ManagedReasoningEffort = "high" | "xhigh";

export interface ManagedReasoningConfig {
	option: Extract<SessionConfigOption, { type: "select" }>;
	choices: SessionConfigSelectOption[];
}

export interface ManagedSessionConfigResult {
	configOptions: SessionConfigOption[];
	reasoningEffort: ManagedReasoningEffort | null;
}

export interface ConfigPreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const REASONING_OPTION_IDS = new Set([
	"thought_level",
	"reasoning_effort",
	"effort",
]);
const REASONING_VALUES: ManagedReasoningEffort[] = ["high", "xhigh"];
const REASONING_STORAGE_KEY = "truacp.reasoning-effort.v1";

function findSelectOption(
	configOptions: SessionConfigOption[],
	category: string,
	ids: ReadonlySet<string>,
): Extract<SessionConfigOption, { type: "select" }> | null {
	const byCategory = configOptions.find(
		(option) => option.type === "select" && option.category === category,
	);
	if (byCategory?.type === "select") return byCategory;

	const byId = configOptions.find(
		(option) => option.type === "select" && ids.has(option.id),
	);
	return byId?.type === "select" ? byId : null;
}

/**
 * Normalize Pi, Codex, Claude, and custom ACP reasoning options by semantic
 * category. Adapter ids are only compatibility fallbacks because ACP agents
 * are free to choose their own stable config id.
 */
export function managedReasoningConfig(
	configOptions: SessionConfigOption[],
): ManagedReasoningConfig | null {
	const option = findSelectOption(
		configOptions,
		"thought_level",
		REASONING_OPTION_IDS,
	);
	if (!option) return null;

	const available = new Map(
		flattenConfigSelectOptions(option.options).map((choice) => [
			choice.value,
			choice,
		]),
	);
	const choices = REASONING_VALUES.flatMap((value) => {
		const advertised = available.get(value);
		if (!advertised) return [];
		return [
			{
				...advertised,
				name: value === "xhigh" ? "Extra high" : "High",
			},
		];
	});

	return choices.length > 0 ? { option, choices } : null;
}

function managedWriteMode(
	agentId: string,
	configOptions: SessionConfigOption[],
): {
	option: Extract<SessionConfigOption, { type: "select" }>;
	value: string;
} | null {
	const required =
		agentId === "codex"
			? { value: "agent-full-access", label: "agent-full-access" }
			: agentId === "claude"
				? { value: "bypassPermissions", label: "bypassPermissions" }
				: null;
	if (!required) return null;

	const option = findSelectOption(configOptions, "mode", new Set(["mode"]));
	if (!option) {
		throw new Error(
			`${agentId} compatibility error: the ACP adapter did not advertise a mode option required for ${required.label}.`,
		);
	}

	const choice = flattenConfigSelectOptions(option.options).find(
		(candidate) =>
			candidate.value.toLowerCase() === required.value.toLowerCase(),
	);
	if (!choice) {
		throw new Error(
			`${agentId} compatibility error: the ACP adapter did not advertise the required ${required.label} mode.`,
		);
	}
	return { option, value: choice.value };
}

function currentSelectValue(
	configOptions: SessionConfigOption[],
	optionId: string,
): string | null {
	const option = configOptions.find(
		(candidate) => candidate.type === "select" && candidate.id === optionId,
	);
	return option?.type === "select" ? option.currentValue : null;
}

/**
 * Apply deterministic managed defaults before the chat becomes ready.
 *
 * WHY: Codex `agent` and Claude `acceptEdits` still prompt for ordinary shell
 * commands. Trustant runs these agents inside its VM/pod isolation boundary,
 * so managed sessions deliberately select their advertised no-prompt modes
 * while leaving the global auto-allow switch disabled for custom agents.
 */
export async function applyManagedSessionConfig(args: {
	agentId: string;
	configOptions: SessionConfigOption[];
	savedReasoningEffort?: ManagedReasoningEffort | null;
	setConfigOption: (
		configId: string,
		value: string,
	) => Promise<SessionConfigOption[]>;
}): Promise<ManagedSessionConfigResult> {
	let configOptions = args.configOptions;

	const writeMode = managedWriteMode(args.agentId, configOptions);
	if (writeMode && writeMode.option.currentValue !== writeMode.value) {
		configOptions = await args.setConfigOption(
			writeMode.option.id,
			writeMode.value,
		);
	}
	if (
		writeMode &&
		currentSelectValue(configOptions, writeMode.option.id) !==
			writeMode.value
	) {
		throw new Error(
			`${args.agentId} compatibility error: the ACP adapter did not apply the required write mode.`,
		);
	}

	const reasoning = managedReasoningConfig(configOptions);
	if (!reasoning) {
		return { configOptions, reasoningEffort: null };
	}

	const supported = new Set(reasoning.choices.map((choice) => choice.value));
	const preferred =
		args.savedReasoningEffort && supported.has(args.savedReasoningEffort)
			? args.savedReasoningEffort
			: supported.has("high")
				? "high"
				: "xhigh";

	if (reasoning.option.currentValue !== preferred) {
		configOptions = await args.setConfigOption(
			reasoning.option.id,
			preferred,
		);
	}
	if (currentSelectValue(configOptions, reasoning.option.id) !== preferred) {
		throw new Error(
			`${args.agentId} compatibility error: the ACP adapter did not apply reasoning effort ${preferred}.`,
		);
	}

	return { configOptions, reasoningEffort: preferred };
}

function parseStoredReasoning(
	value: string | null,
): Record<string, ManagedReasoningEffort> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, ManagedReasoningEffort] =>
					entry[1] === "high" || entry[1] === "xhigh",
			),
		);
	} catch {
		return {};
	}
}

/**
 * Preferences are UI state rather than provider configuration. Browser
 * storage keeps them per agent across reconnects without rewriting Codex,
 * Claude, or Pi native configuration files.
 */
export function readReasoningPreference(
	agentId: string,
	storage: ConfigPreferenceStorage | null,
): ManagedReasoningEffort | null {
	if (!storage) return null;
	try {
		return (
			parseStoredReasoning(storage.getItem(REASONING_STORAGE_KEY))[
				agentId
			] ?? null
		);
	} catch {
		return null;
	}
}

export function writeReasoningPreference(
	agentId: string,
	effort: ManagedReasoningEffort,
	storage: ConfigPreferenceStorage | null,
): void {
	if (!storage) return;
	try {
		const current = parseStoredReasoning(
			storage.getItem(REASONING_STORAGE_KEY),
		);
		storage.setItem(
			REASONING_STORAGE_KEY,
			JSON.stringify({ ...current, [agentId]: effort }),
		);
	} catch {
		// Storage can be disabled by browser privacy policy. The active session
		// still uses the selected value; only cross-reload restoration is lost.
	}
}

/**
 * Values of the managed Pi Thinking selector. Kept in step with
 * TRUSTANT_THINKING_VALUES in extensions/trustant-runtime.ts, which the browser
 * bundle cannot import (it depends on node:fs).
 */
export const PI_THINKING_VALUES = [
	"none",
	"true",
	"false",
	"low",
	"medium",
	"high",
] as const;
export type PiThinking = (typeof PI_THINKING_VALUES)[number];
export const DEFAULT_PI_THINKING: PiThinking = "true";
const PI_THINKING_STORAGE_KEY = "truacp.pi-thinking.v1";

export function isPiThinking(value: unknown): value is PiThinking {
	return (PI_THINKING_VALUES as readonly unknown[]).includes(value);
}

/** Read the per-browser Thinking choice; anything unknown means the default. */
export function readThinkingPreference(
	storage: ConfigPreferenceStorage | null,
): PiThinking {
	try {
		const stored = storage?.getItem(PI_THINKING_STORAGE_KEY) ?? null;
		return isPiThinking(stored) ? stored : DEFAULT_PI_THINKING;
	} catch {
		return DEFAULT_PI_THINKING;
	}
}

export function writeThinkingPreference(
	value: PiThinking,
	storage: ConfigPreferenceStorage | null,
): void {
	try {
		storage?.setItem(PI_THINKING_STORAGE_KEY, value);
	} catch {
		// Same policy as the reasoning preference: only restoration is lost.
	}
}
