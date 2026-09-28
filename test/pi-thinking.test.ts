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

import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	applyTrustantThinking,
	readTrustantThinking,
	TRUSTANT_THINKING_VALUES,
} from "../extensions/trustant-runtime";
import { SessionHost } from "../server/session-host";
import { routes, type RouteContext } from "../server/routes";
import {
	PI_THINKING_VALUES,
	readThinkingPreference,
	writeThinkingPreference,
} from "../web/session-config";

const hostConfig = {
	windows: {},
	permissions: {},
} as never;

const chat = (extra: Record<string, unknown> = {}) => ({
	model: "glm-5.2:cloud",
	messages: [{ role: "user", content: "hi" }],
	...extra,
});

describe("Pi Thinking payload mapping", () => {
	it("true leaves Pi's payload untouched", () => {
		expect(applyTrustantThinking(chat(), "true")).toBeUndefined();
		expect(
			applyTrustantThinking(chat({ reasoning_effort: "high" }), "true"),
		).toBeUndefined();
	});

	it("none strips a Pi-added reasoning_effort and never adds one", () => {
		const stripped = applyTrustantThinking(
			chat({ reasoning_effort: "high" }),
			"none",
		);
		expect(stripped).toBeDefined();
		expect(stripped).not.toHaveProperty("reasoning_effort");
		expect(applyTrustantThinking(chat(), "none")).toBeUndefined();
	});

	it("false sends reasoning_effort none", () => {
		expect(
			applyTrustantThinking(chat({ reasoning_effort: "high" }), "false"),
		).toMatchObject({ reasoning_effort: "none" });
	});

	it.each(["low", "medium", "high"] as const)(
		"%s sends that reasoning_effort",
		(level) => {
			expect(applyTrustantThinking(chat(), level)).toMatchObject({
				reasoning_effort: level,
			});
		},
	);

	it("never adds think and does not mutate the original payload", () => {
		const original = chat({ reasoning_effort: "high" });
		const next = applyTrustantThinking(original, "low");
		expect(next).not.toHaveProperty("think");
		expect(original.reasoning_effort).toBe("high");
	});

	it("leaves non chat-completions payloads alone", () => {
		expect(applyTrustantThinking({ input: [] }, "false")).toBeUndefined();
		expect(applyTrustantThinking(null, "false")).toBeUndefined();
	});
});

describe("Pi Thinking state file", () => {
	it("defaults to true when missing or invalid", async () => {
		const dir = await mkdtemp(join(tmpdir(), "think-"));
		expect(readTrustantThinking(undefined)).toBe("true");
		expect(readTrustantThinking(join(dir, "absent.json"))).toBe("true");
		await writeFile(join(dir, "bad.json"), '{"think":"maybe"}');
		expect(readTrustantThinking(join(dir, "bad.json"))).toBe("true");
		await writeFile(join(dir, "junk.json"), "not json");
		expect(readTrustantThinking(join(dir, "junk.json"))).toBe("true");
	});

	it("round-trips every value through the route and the host file", async () => {
		const host = new SessionHost(hostConfig, "test", () => {});
		const ctx = { host, store: {}, config: {} } as unknown as RouteContext;
		for (const value of TRUSTANT_THINKING_VALUES) {
			const result = await routes["POST /api/pi/thinking"](ctx, {
				think: value,
			});
			expect(result.think).toBe(value);
			const file = (host as unknown as { thinkFile: string }).thinkFile;
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
				think: value,
			});
			expect(readTrustantThinking(file)).toBe(value);
		}
	});

	it("rejects unknown values as a bad request", async () => {
		const host = new SessionHost(hostConfig, "test", () => {});
		const ctx = { host, store: {}, config: {} } as unknown as RouteContext;
		await expect(
			routes["POST /api/pi/thinking"](ctx, { think: "xhigh" }),
		).rejects.toThrow(/^Bad request:/);
	});
});

describe("Pi Thinking browser preference", () => {
	it("keeps the browser and extension value lists in step", () => {
		expect([...PI_THINKING_VALUES]).toEqual([...TRUSTANT_THINKING_VALUES]);
	});

	it("defaults to true and remembers a valid choice", () => {
		const data = new Map<string, string>();
		const storage = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
		};
		expect(readThinkingPreference(storage)).toBe("true");
		expect(readThinkingPreference(null)).toBe("true");
		writeThinkingPreference("false", storage);
		expect(readThinkingPreference(storage)).toBe("false");
	});
});
