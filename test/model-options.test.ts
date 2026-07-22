import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "../src/types/session";
import { trustableModelChoices } from "../web/model-options";

describe("Trustable model choices", () => {
	it("keeps only models from the Trustable provider", () => {
		const option: SessionConfigOption = {
			type: "select",
			id: "model",
			category: "model",
			name: "Model",
			currentValue: "trustable/qwen3-coder-next",
			options: [
				{ value: "openai/o3", name: "openai/o3" },
				{
					value: "trustable/qwen3-coder-next",
					name: "trustable/Qwen3 Coder Next",
				},
				{ value: "anthropic/claude", name: "anthropic/Claude" },
			],
		};

		expect(trustableModelChoices(option).map((model) => model.value)).toEqual([
			"trustable/qwen3-coder-next",
		]);
	});
});
