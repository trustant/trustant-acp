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
 * Trustant-managed Pi sessions must not expose Pi's built-in provider catalog.
 * pi-acp currently returns every registered provider even when Pi's
 * `enabledModels` setting scopes model cycling, so the browser mirrors the
 * active managed prefix before rendering its selector.
 */
import type {
	SessionConfigOption,
	SessionConfigSelectOption,
} from "../src/types/session";
import { flattenConfigSelectOptions } from "../src/types/session";

export const TRUSTANT_MANAGED_MODEL_PREFIXES = [
	"local/",
	"ollama/",
	"trustant/",
] as const;

export function managedModelChoices(
	modelOption: SessionConfigOption | null,
): SessionConfigSelectOption[] {
	if (!modelOption || modelOption.type !== "select") return [];
	// The current value identifies Trustant's active provider. Restricting to
	// that one prefix prevents stale managed providers preserved in models.json
	// from reappearing beside the current catalog.
	const activePrefix = TRUSTANT_MANAGED_MODEL_PREFIXES.find((prefix) =>
		modelOption.currentValue.startsWith(prefix),
	);
	if (!activePrefix) return [];
	return flattenConfigSelectOptions(modelOption.options).filter((option) =>
		option.value.startsWith(activePrefix),
	);
}

/**
 * Only Trustant-managed Pi needs provider-prefix filtering. Codex, Claude,
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
