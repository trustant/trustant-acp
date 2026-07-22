/**
 * Trustable-managed Pi sessions must not expose Pi's built-in provider catalog.
 * pi-acp currently returns every registered provider even when Pi's
 * `enabledModels` setting scopes model cycling, so the browser applies the same
 * provider boundary before rendering its selector.
 */
import type {
	SessionConfigOption,
	SessionConfigSelectOption,
} from "../src/types/session";
import { flattenConfigSelectOptions } from "../src/types/session";

export const TRUSTABLE_MODEL_PREFIX = "trustable/";

export function trustableModelChoices(
	modelOption: SessionConfigOption | null,
): SessionConfigSelectOption[] {
	if (!modelOption || modelOption.type !== "select") return [];
	return flattenConfigSelectOptions(modelOption.options).filter((option) =>
		option.value.startsWith(TRUSTABLE_MODEL_PREFIX),
	);
}
