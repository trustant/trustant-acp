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
			? { value: "agent", label: "workspace-write" }
			: agentId === "claude"
				? { value: "acceptEdits", label: "acceptEdits" }
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
 * Apply deterministic managed defaults before the chat becomes ready. Codex
 * and Claude receive only their sandboxed edit-capable modes; broad
 * agent-full-access/bypass settings and the global auto-allow switch are
 * deliberately outside this path.
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
