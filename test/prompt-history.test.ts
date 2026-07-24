import { describe, expect, it } from "vitest";
import {
	createPromptHistoryCursor,
	navigatePromptHistory,
} from "../web/prompt-history";

describe("prompt history", () => {
	it("walks older prompts from newest to oldest", () => {
		let cursor = createPromptHistoryCursor();
		const prompts = ["first", "second", "third"];

		const newest = navigatePromptHistory(prompts, "", cursor, "older");
		expect(newest.value).toBe("third");
		cursor = newest.cursor;

		const previous = navigatePromptHistory(
			prompts,
			newest.value,
			cursor,
			"older",
		);
		expect(previous.value).toBe("second");
		cursor = previous.cursor;

		const oldest = navigatePromptHistory(
			prompts,
			previous.value,
			cursor,
			"older",
		);
		expect(oldest.value).toBe("first");
	});

	it("preserves and restores the unfinished draft", () => {
		const prompts = ["one", "two"];
		const older = navigatePromptHistory(
			prompts,
			"unfinished draft",
			createPromptHistoryCursor(),
			"older",
		);
		expect(older.value).toBe("two");

		const newer = navigatePromptHistory(
			prompts,
			older.value,
			older.cursor,
			"newer",
		);
		expect(newer.value).toBe("unfinished draft");
		expect(newer.cursor.index).toBe(-1);
	});

	it("stays at the oldest boundary and ignores newer outside history", () => {
		const prompts = ["only"];
		const older = navigatePromptHistory(
			prompts,
			"",
			createPromptHistoryCursor(),
			"older",
		);
		const boundary = navigatePromptHistory(
			prompts,
			older.value,
			older.cursor,
			"older",
		);
		expect(boundary.value).toBe("only");
		expect(boundary.cursor.index).toBe(0);

		const outside = navigatePromptHistory(
			prompts,
			"draft",
			createPromptHistoryCursor("draft"),
			"newer",
		);
		expect(outside.handled).toBe(false);
		expect(outside.value).toBe("draft");
	});
});
