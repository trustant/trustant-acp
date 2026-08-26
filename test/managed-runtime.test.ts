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

import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { resolveManagedPiRuntime } from "../server/managed-runtime";
import {
	buildPiSessionRequestMeta,
	buildSessionMcpServers,
} from "../src/acp/acp-client";

async function managedFixture(root: string) {
	const workbench = join(root, "workbench", "example");
	const extensionPath = join(root, "runtime", "trustable-runtime.ts");
	const manifestPath = join(root, "runtime", "pi-runtime.json");
	const watcherLog = join(root, "runtime", "ops-ide-devel.log");
	const mcpConfig = join(root, "runtime", "mcp.json");
	await mkdir(workbench, { recursive: true });
	await mkdir(join(root, "runtime"), { recursive: true });
	await writeFile(extensionPath, "export default function () {}\n");
	await writeFile(watcherLog, "watcher ready\n", { mode: 0o600 });
	await writeFile(
		join(workbench, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				browser: { command: "browser" },
				openserverless: { command: "openserverless" },
			},
		}),
	);
	await writeFile(
		mcpConfig,
		JSON.stringify({
			mcpServers: {
				browser: {
					type: "stdio",
					command: "browser",
					args: [],
					env: {},
				},
				openserverless: {
					type: "stdio",
					command: "openserverless",
					args: ["--token", "mcp-sentinel-token"],
					env: { SERVICE_PASSWORD: "mcp-sentinel-password" },
				},
			},
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		manifestPath,
		JSON.stringify({
			version: 2,
			workbenches: [
				{
					app: "example",
					workspace: workbench,
					developmentUrl: "http://localhost:5173",
					browserUrl: "http://vite.example.test:8910",
					requiredMcpServers: ["openserverless", "browser"],
					mcpConfig,
					watcherLog,
				},
			],
		}),
	);
	return { workbench, extensionPath, manifestPath, watcherLog, mcpConfig };
}

describe("Trustable managed Pi runtime", () => {
	it("leaves standalone TruACP unchanged", () => {
		expect(
			resolveManagedPiRuntime(process.cwd(), {
				TRUSTABLE_MANAGED_RUNTIME: "0",
			}),
		).toBeUndefined();
	});

	it("validates the manifest, MCP contract, workbench, and extension", async () => {
		const root = await import("fs/promises").then(({ mkdtemp }) =>
			mkdtemp(join(tmpdir(), "managed-runtime-")),
		);
		const fixture = await managedFixture(root);
		const result = resolveManagedPiRuntime(fixture.workbench, {
			TRUSTABLE_MANAGED_RUNTIME: "1",
			TRUSTABLE_RUNTIME_CONFIG: fixture.manifestPath,
			TRUSTABLE_PI_EXTENSION_PATH: fixture.extensionPath,
		});

		expect(result?.workbench).toMatchObject({
			app: "example",
			workspace: fixture.workbench,
			developmentUrl: "http://localhost:5173",
			browserUrl: "http://vite.example.test:8910",
			requiredMcpServers: ["browser", "openserverless"],
			mcpConfig: fixture.mcpConfig,
			watcherLog: fixture.watcherLog,
		});
		expect(result?.extensionPath).toBe(fixture.extensionPath);
		expect(result?.mcpServers.map((server) => server.name)).toEqual([
			"browser",
			"openserverless",
		]);
		expect(result?.redactionSecrets).toEqual(
			expect.arrayContaining([
				"mcp-sentinel-token",
				"mcp-sentinel-password",
			]),
		);
	});

	it("fails closed for a cwd outside the selected workbench", async () => {
		const { mkdtemp } = await import("fs/promises");
		const root = await mkdtemp(join(tmpdir(), "managed-runtime-"));
		const fixture = await managedFixture(root);
		const other = join(root, "other");
		await mkdir(other);

		expect(() =>
			resolveManagedPiRuntime(other, {
				TRUSTABLE_MANAGED_RUNTIME: "1",
				TRUSTABLE_RUNTIME_CONFIG: fixture.manifestPath,
				TRUSTABLE_PI_EXTENSION_PATH: fixture.extensionPath,
			}),
		).toThrow("expected one workbench");
	});

	it("fails closed when a declared MCP server is absent", async () => {
		const { mkdtemp } = await import("fs/promises");
		const root = await mkdtemp(join(tmpdir(), "managed-runtime-"));
		const fixture = await managedFixture(root);
		await writeFile(
			join(fixture.workbench, ".mcp.json"),
			JSON.stringify({ mcpServers: { browser: {} } }),
		);

		expect(() =>
			resolveManagedPiRuntime(fixture.workbench, {
				TRUSTABLE_MANAGED_RUNTIME: "1",
				TRUSTABLE_RUNTIME_CONFIG: fixture.manifestPath,
				TRUSTABLE_PI_EXTENSION_PATH: fixture.extensionPath,
			}),
		).toThrow("missing required servers: openserverless");
	});

	it("passes only typed extension paths and rejects session cwd escape", () => {
		const config = {
			id: "pi",
			displayName: "Pi",
			command: "pi-acp",
			args: [],
			workingDirectory: "/workbench/example",
			piLaunch: {
				version: 1 as const,
				workbench: "/workbench/example",
				extensionPaths: ["/runtime/trustable-runtime.ts"],
			},
		};

		expect(
			buildPiSessionRequestMeta(config, "/workbench/example/src"),
		).toEqual({
			_meta: {
				trustable: {
					piLaunch: {
						version: 1,
						extensions: {
							discover: true,
							paths: ["/runtime/trustable-runtime.ts"],
						},
						skills: { discover: true },
					},
				},
			},
		});
		expect(() =>
			buildPiSessionRequestMeta(config, "/workbench/other"),
		).toThrow("outside the selected workbench");
	});

	it("passes managed MCP servers to Codex and Claude but keeps Pi on its proxy", () => {
		const servers = [
			{
				name: "react",
				command: "trustable-react-mcp",
				args: [],
				env: [],
			},
		];
		expect(
			buildSessionMcpServers({
				id: "codex",
				displayName: "Codex",
				command: "codex-acp",
				args: [],
				workingDirectory: "/workbench/example",
				mcpServers: servers,
			}),
		).toEqual(servers);
		expect(
			buildSessionMcpServers({
				id: "pi",
				displayName: "Pi",
				command: "pi-acp",
				args: [],
				workingDirectory: "/workbench/example",
				mcpServers: servers,
			}),
		).toEqual([]);
	});
});
