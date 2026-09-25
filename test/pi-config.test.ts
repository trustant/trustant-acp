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

import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piHello, readPiConfig, writePiProvider } from "../server/pi-config";

describe("Pi native configuration", () => {
	let dir: string;
	let previousAgentDir: string | undefined;
	let previousManaged: string | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "truacp-pi-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousManaged = process.env.TRUSTANT_MANAGED_RUNTIME;
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.TRUSTANT_MANAGED_RUNTIME;
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		if (previousAgentDir === undefined)
			delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousManaged === undefined)
			delete process.env.TRUSTANT_MANAGED_RUNTIME;
		else process.env.TRUSTANT_MANAGED_RUNTIME = previousManaged;
		await rm(dir, { recursive: true, force: true });
	});

	it("uses auth.json for the probe without exposing the key", async () => {
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "https://models.example/v1",
						apiKey: "$OPENAI_API_KEY",
						models: [{ id: "coder" }],
					},
				},
			}),
		);
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({
				local: { type: "api_key", key: "real-secret" },
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer real-secret",
				);
				return new Response(
					JSON.stringify({ data: [{ id: "coder" }] }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}),
		);

		expect(await piHello()).toEqual({
			ok: true,
			detail: "1 model(s)",
			managed: false,
		});
		const browserConfig = await readPiConfig();
		expect(browserConfig).toEqual({
			baseUrl: "https://models.example/v1",
			model: "coder",
		});
		expect(browserConfig).not.toHaveProperty("apiKey");
	});

	it("writes credentials only to auth.json", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ data: [{ id: "coder" }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		await writePiProvider({
			baseUrl: "https://models.example/v1",
			apiKey: "standalone-secret",
		});

		const modelsText = await readFile(join(dir, "models.json"), "utf8");
		const authText = await readFile(join(dir, "auth.json"), "utf8");
		const settingsText = await readFile(join(dir, "settings.json"), "utf8");
		const models = JSON.parse(modelsText) as {
			providers: { local: { apiKey: string } };
		};
		const auth = JSON.parse(authText) as {
			local: { type: string; key: string };
		};
		expect(models.providers.local.apiKey).toBe("$OPENAI_API_KEY");
		expect(modelsText).not.toContain("standalone-secret");
		expect(auth.local).toEqual({
			type: "api_key",
			key: "standalone-secret",
		});
		expect(JSON.parse(settingsText)).toMatchObject({
			defaultProvider: "local",
			defaultModel: "coder",
			enabledModels: ["local/*"],
		});
		expect((await stat(join(dir, "models.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "auth.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(dir, "settings.json"))).mode & 0o777).toBe(
			0o644,
		);
	});

	it("uses the provider selected by Trustant settings", async () => {
		process.env.TRUSTANT_MANAGED_RUNTIME = "1";
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					trustant: {
						baseUrl: "https://api.trustant.example/v1",
						apiKey: "$OPENAI_API_KEY",
						models: [{ id: "coder" }],
					},
					local: {
						baseUrl: "https://stale.example/v1",
						apiKey: "$OPENAI_API_KEY",
						models: [{ id: "stale" }],
					},
				},
			}),
		);
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({ defaultProvider: "trustant" }),
		);
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({
				trustant: { type: "api_key", key: "managed-secret" },
				local: { type: "api_key", key: "stale-secret" },
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				expect(url).toBe("https://api.trustant.example/v1/models");
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer managed-secret",
				);
				return new Response(
					JSON.stringify({ data: [{ id: "coder" }] }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}),
		);

		expect(await piHello()).toEqual({
			ok: true,
			detail: "1 model(s)",
			managed: true,
		});
	});

	it("marks managed probe failures so the UI does not open its local form", async () => {
		process.env.TRUSTANT_MANAGED_RUNTIME = "1";
		expect(await piHello()).toEqual({
			ok: false,
			detail: "Pi is not configured.",
			managed: true,
		});
	});
});
