/**
 * Trustable-managed Pi sessions must not expose Pi's built-in provider catalog.
 * pi-acp currently returns every registered provider even when Pi's
 * `enabledModels` setting scopes model cycling, so the browser mirrors the
 * active managed prefix before rendering its selector.
 */
import type {
	SessionConfigOption,
	SessionConfigSelectOption,
} from "../src/types/session";
import { flattenConfigSelectOptions } from "../src/types/session";

export const TRUSTABLE_MANAGED_MODEL_PREFIXES = [
	"local/",
	"ollama/",
	"trustable/",
] as const;

export function managedModelChoices(
	modelOption: SessionConfigOption | null,
): SessionConfigSelectOption[] {
	if (!modelOption || modelOption.type !== "select") return [];
	// The current value identifies Trustable's active provider. Restricting to
	// that one prefix prevents stale managed providers preserved in models.json
	// from reappearing beside the current catalog.
	const activePrefix = TRUSTABLE_MANAGED_MODEL_PREFIXES.find((prefix) =>
		modelOption.currentValue.startsWith(prefix),
	);
	if (!activePrefix) return [];
	return flattenConfigSelectOptions(modelOption.options).filter((option) =>
		option.value.startsWith(activePrefix),
	);
}

/**
 * Only Trustable-managed Pi needs provider-prefix filtering. Codex, Claude,
 * standalone Pi, and custom ACP agents must retain the complete model catalog
 * they advertised; applying Pi's filter globally hides their selectors.
 */
export function modelChoicesForAgent(
	modelOption: SessionConfigOption | null,
	agentId: string,
	piManaged: boolean | null,
): SessionConfigSelectOption[] {
	if (!modelOption || modelOption.type !== "select") return [];
	if (agentId === "pi" && piManaged === true) {
		return managedModelChoices(modelOption);
	}
	return flattenConfigSelectOptions(modelOption.options);
}
