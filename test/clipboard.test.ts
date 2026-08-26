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

import { describe, expect, it, vi } from "vitest";
import { copyTextWithRuntime } from "../web/clipboard";

describe("copyTextWithRuntime", () => {
	it("uses the Clipboard API in a secure context", async () => {
		const writeText = vi.fn(async () => {});
		const fallbackCopy = vi.fn(() => true);

		await expect(
			copyTextWithRuntime("hello", {
				secureContext: true,
				writeText,
				fallbackCopy,
			}),
		).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledWith("hello");
		expect(fallbackCopy).not.toHaveBeenCalled();
	});

	it("uses the fallback directly for the HTTP development route", async () => {
		const writeText = vi.fn(async () => {});
		const fallbackCopy = vi.fn(() => true);

		await expect(
			copyTextWithRuntime("hello", {
				secureContext: false,
				writeText,
				fallbackCopy,
			}),
		).resolves.toBe(true);
		expect(writeText).not.toHaveBeenCalled();
		expect(fallbackCopy).toHaveBeenCalledWith("hello");
	});

	it("falls back when the browser rejects a modern clipboard write", async () => {
		const fallbackCopy = vi.fn(() => true);
		await expect(
			copyTextWithRuntime("hello", {
				secureContext: true,
				writeText: async () => {
					throw new Error("permission denied");
				},
				fallbackCopy,
			}),
		).resolves.toBe(true);
		expect(fallbackCopy).toHaveBeenCalledWith("hello");
	});

	it("reports a failed fallback instead of silently claiming success", async () => {
		await expect(
			copyTextWithRuntime("hello", {
				secureContext: false,
				fallbackCopy: () => false,
			}),
		).resolves.toBe(false);
	});
});
