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
