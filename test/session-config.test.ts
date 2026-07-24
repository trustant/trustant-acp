import { describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "../src/types/session";
import {
	applyManagedSessionConfig,
	managedReasoningConfig,
	readReasoningPreference,
	writeReasoningPreference,
} from "../web/session-config";

function selectOption(
	id: string,
	category: string,
	currentValue: string,
	values: string[],
): SessionConfigOption {
	return {
		type: "select",
		id,
		category,
		name: id,
		currentValue,
		options: values.map((value) => ({ value, name: value })),
	};
}

function setterFor(initial: SessionConfigOption[]) {
	let current = structuredClone(initial);
	const setConfigOption = vi.fn(async (configId: string, value: string) => {
		current = current.map((option) =>
			option.type === "select" && option.id === configId
				? { ...option, currentValue: value }
				: option,
		);
		return structuredClone(current);
	});
	return { setConfigOption, current: () => current };
}

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("managed reasoning configuration", () => {
	it.each([
		["thought_level", "Pi"],
		["reasoning_effort", "Codex"],
		["effort", "Claude"],
	])("normalizes %s and exposes only High/Extra high", (id) => {
		const config = managedReasoningConfig([
			selectOption(id, "thought_level", "medium", [
				"low",
				"medium",
				"high",
				"xhigh",
			]),
		]);

		expect(config?.option.id).toBe(id);
		expect(config?.choices).toEqual([
			{ value: "high", name: "High" },
			{ value: "xhigh", name: "Extra high" },
		]);
	});

	it("uses the compatibility id when an adapter omits the category", () => {
		const config = managedReasoningConfig([
			selectOption("reasoning_effort", "", "high", ["high", "xhigh"]),
		]);
		expect(config?.option.id).toBe("reasoning_effort");
	});

	it("does not invent Extra high when the active model omits it", () => {
		const config = managedReasoningConfig([
			selectOption("thought_level", "thought_level", "high", [
				"low",
				"high",
			]),
		]);
		expect(config?.choices.map((choice) => choice.value)).toEqual(["high"]);
	});

	it("defaults to high and restores a supported saved xhigh", async () => {
		const initial = [
			selectOption("thought_level", "thought_level", "medium", [
				"high",
				"xhigh",
			]),
		];
		const first = setterFor(initial);
		const defaulted = await applyManagedSessionConfig({
			agentId: "pi",
			configOptions: initial,
			setConfigOption: first.setConfigOption,
		});
		expect(defaulted.reasoningEffort).toBe("high");
		expect(first.setConfigOption).toHaveBeenCalledWith(
			"thought_level",
			"high",
		);

		const restoredSetter = setterFor(initial);
		const restored = await applyManagedSessionConfig({
			agentId: "pi",
			configOptions: initial,
			savedReasoningEffort: "xhigh",
			setConfigOption: restoredSetter.setConfigOption,
		});
		expect(restored.reasoningEffort).toBe("xhigh");
		expect(restoredSetter.setConfigOption).toHaveBeenCalledWith(
			"thought_level",
			"xhigh",
		);
	});

	it("falls back to high when a changed model no longer advertises xhigh", async () => {
		const initial = [
			selectOption("thought_level", "thought_level", "xhigh", ["high"]),
		];
		const setter = setterFor(initial);
		const result = await applyManagedSessionConfig({
			agentId: "pi",
			configOptions: initial,
			savedReasoningEffort: "xhigh",
			setConfigOption: setter.setConfigOption,
		});
		expect(result.reasoningEffort).toBe("high");
		expect(setter.setConfigOption).toHaveBeenCalledWith(
			"thought_level",
			"high",
		);
	});
});

describe("managed write modes", () => {
	it("applies Codex agent mode before reasoning without full access", async () => {
		const initial = [
			selectOption("mode", "mode", "default", [
				"default",
				"agent",
				"agent-full-access",
			]),
			selectOption("reasoning_effort", "thought_level", "medium", [
				"high",
				"xhigh",
			]),
		];
		const setter = setterFor(initial);

		await applyManagedSessionConfig({
			agentId: "codex",
			configOptions: initial,
			setConfigOption: setter.setConfigOption,
		});

		expect(setter.setConfigOption.mock.calls).toEqual([
			["mode", "agent"],
			["reasoning_effort", "high"],
		]);
		expect(setter.current()).not.toContainEqual(
			expect.objectContaining({ currentValue: "agent-full-access" }),
		);
	});

	it("applies Claude acceptEdits without selecting bypassPermissions", async () => {
		const initial = [
			selectOption("mode", "mode", "default", [
				"default",
				"acceptEdits",
				"bypassPermissions",
			]),
			selectOption("effort", "thought_level", "low", ["high"]),
		];
		const setter = setterFor(initial);

		await applyManagedSessionConfig({
			agentId: "claude",
			configOptions: initial,
			setConfigOption: setter.setConfigOption,
		});

		expect(setter.setConfigOption.mock.calls).toEqual([
			["mode", "acceptEdits"],
			["effort", "high"],
		]);
		expect(setter.current()).not.toContainEqual(
			expect.objectContaining({ currentValue: "bypassPermissions" }),
		);
	});

	it("fails visibly when a managed adapter lacks its required mode", async () => {
		await expect(
			applyManagedSessionConfig({
				agentId: "codex",
				configOptions: [
					selectOption("reasoning_effort", "thought_level", "high", [
						"high",
					]),
				],
				setConfigOption: vi.fn(),
			}),
		).rejects.toThrow(/did not advertise a mode option/);
	});

	it("leaves custom-agent permissions unchanged", async () => {
		const initial = [
			selectOption("mode", "mode", "manual", ["manual", "agent"]),
			selectOption("effort", "thought_level", "low", ["high"]),
		];
		const setter = setterFor(initial);

		await applyManagedSessionConfig({
			agentId: "custom-agent",
			configOptions: initial,
			setConfigOption: setter.setConfigOption,
		});

		expect(setter.setConfigOption).toHaveBeenCalledTimes(1);
		expect(setter.setConfigOption).toHaveBeenCalledWith("effort", "high");
	});
});

describe("reasoning preference storage", () => {
	it("keeps independent values for each agent", () => {
		const storage = memoryStorage();
		writeReasoningPreference("pi", "high", storage);
		writeReasoningPreference("codex", "xhigh", storage);

		expect(readReasoningPreference("pi", storage)).toBe("high");
		expect(readReasoningPreference("codex", storage)).toBe("xhigh");
		expect(readReasoningPreference("claude", storage)).toBeNull();
	});
});
