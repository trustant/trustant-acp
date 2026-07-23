import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "../src/types/session";
import { managedModelChoices } from "../web/model-options";

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
});
