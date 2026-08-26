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

import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "../src/types/session";
import {
	managedModelChoices,
	modelChoicesForAgent,
} from "../web/model-options";

describe("managed model choices", () => {
	it.each([
		["local", "local/coder"],
		["ollama", "ollama/qwen3-coder"],
		["trustable", "trustable/qwen3-coder-next"],
	])(
		"keeps only models from the active %s provider",
		(_provider, current) => {
			const option: SessionConfigOption = {
				type: "select",
				id: "model",
				category: "model",
				name: "Model",
				currentValue: current,
				options: [
					{ value: "openai/o3", name: "openai/o3" },
					{ value: "local/coder", name: "local/Coder" },
					{ value: "ollama/qwen3-coder", name: "ollama/Qwen3 Coder" },
					{
						value: "trustable/qwen3-coder-next",
						name: "trustable/Qwen3 Coder Next",
					},
					{ value: "anthropic/claude", name: "anthropic/Claude" },
				],
			};

			expect(
				managedModelChoices(option).map((model) => model.value),
			).toEqual([current]);
		},
	);

	it("rejects a built-in provider as the active managed model", () => {
		const option: SessionConfigOption = {
			type: "select",
			id: "model",
			name: "Model",
			currentValue: "openai/o3",
			options: [{ value: "openai/o3", name: "openai/o3" }],
		};
		expect(managedModelChoices(option)).toEqual([]);
	});

	it("filters only managed Pi and preserves other ACP agent catalogs", () => {
		const option: SessionConfigOption = {
			type: "select",
			id: "model",
			category: "model",
			name: "Model",
			currentValue: "trustable/qwen",
			options: [
				{ value: "trustable/qwen", name: "Trustable Qwen" },
				{ value: "openai/gpt-5", name: "OpenAI GPT-5" },
			],
		};

		expect(
			modelChoicesForAgent(option, "pi", true).map(
				(choice) => choice.value,
			),
		).toEqual(["trustable/qwen"]);
		expect(
			modelChoicesForAgent(option, "codex", null).map(
				(choice) => choice.value,
			),
		).toEqual(["trustable/qwen", "openai/gpt-5"]);
		expect(
			modelChoicesForAgent(option, "custom", false).map(
				(choice) => choice.value,
			),
		).toEqual(["trustable/qwen", "openai/gpt-5"]);
	});
});
