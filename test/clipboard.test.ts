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
