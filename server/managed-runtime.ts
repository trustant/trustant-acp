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

/**
 * Trustant-managed Pi runtime contract validation.
 *
 * The browser never supplies this data. trustable-app writes a private
 * credential-free manifest and starts TruACP with paths to that manifest and
 * the installed policy extension. Managed mode fails closed if either artifact
 * is absent, malformed, or does not describe the selected working directory.
 */
import { readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import type { McpServer } from "@agentclientprotocol/sdk";

export const TRUSTANT_PI_RUNTIME_VERSION = 2 as const;

export interface TrustantPiRuntimeWorkbench {
	app: string;
	workspace: string;
	developmentUrl: string;
	browserUrl: string;
	requiredMcpServers: string[];
	mcpConfig: string;
	watcherLog: string;
}

export interface TrustantPiRuntimeManifest {
	version: typeof TRUSTANT_PI_RUNTIME_VERSION;
	workbenches: TrustantPiRuntimeWorkbench[];
}

export interface ManagedPiRuntime {
	workbench: TrustantPiRuntimeWorkbench;
	extensionPath: string;
	mcpServers: McpServer[];
	redactionSecrets: string[];
	runtimeConfigPath: string;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`Trustant runtime ${field} must be a non-empty string`,
		);
	}
	return value;
}

function isPathWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalDirectory(path: string, field: string): string {
	const value = nonEmptyString(path, field);
	if (!isAbsolute(value)) {
		throw new Error(
			`Trustant runtime ${field} must be absolute: ${value}`,
		);
	}
	try {
		const canonical = realpathSync(value);
		if (!statSync(canonical).isDirectory()) {
			throw new Error("not a directory");
		}
		return canonical;
	} catch (error) {
		throw new Error(
			`Trustant runtime ${field} is unavailable at ${value}: ${(error as Error).message}`,
		);
	}
}

function parseManifest(path: string): TrustantPiRuntimeManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read Trustant Pi runtime manifest ${path}: ${(error as Error).message}`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Trustant Pi runtime manifest must be a JSON object");
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== TRUSTANT_PI_RUNTIME_VERSION) {
		throw new Error(
			`Unsupported Trustant Pi runtime version ${String(record.version)} (expected ${TRUSTANT_PI_RUNTIME_VERSION})`,
		);
	}
	if (!Array.isArray(record.workbenches) || record.workbenches.length === 0) {
		throw new Error(
			"Trustant Pi runtime manifest must declare at least one workbench",
		);
	}
	const workbenches = record.workbenches.map(
		(rawWorkbench, index): TrustantPiRuntimeWorkbench => {
			if (
				!rawWorkbench ||
				typeof rawWorkbench !== "object" ||
				Array.isArray(rawWorkbench)
			) {
				throw new Error(
					`Trustant runtime workbenches[${index}] must be a JSON object`,
				);
			}
			const workbench = rawWorkbench as Record<string, unknown>;
			const app = nonEmptyString(
				workbench.app,
				`workbenches[${index}].app`,
			);
			const workspace = canonicalDirectory(
				nonEmptyString(
					workbench.workspace,
					`workbenches[${index}].workspace`,
				),
				`workbenches[${index}].workspace`,
			);
			const developmentUrl = validHttpUrl(
				workbench.developmentUrl,
				`workbenches[${index}].developmentUrl`,
			);
			const browserUrl = validHttpUrl(
				workbench.browserUrl,
				`workbenches[${index}].browserUrl`,
			);
			if (
				!Array.isArray(workbench.requiredMcpServers) ||
				workbench.requiredMcpServers.some(
					(value) => typeof value !== "string" || !value.trim(),
				)
			) {
				throw new Error(
					`Trustant runtime workbenches[${index}].requiredMcpServers must be an array of non-empty strings`,
				);
			}
			const requiredMcpServers = [
				...new Set(workbench.requiredMcpServers as string[]),
			].sort();
			if (requiredMcpServers.length === 0) {
				throw new Error(
					`Trustant runtime workbenches[${index}] declares no required MCP servers`,
				);
			}
			const watcherLog = canonicalPrivateFile(
				nonEmptyString(
					workbench.watcherLog,
					`workbenches[${index}].watcherLog`,
				),
				`workbenches[${index}].watcherLog`,
			);
			if (isPathWithin(workspace, watcherLog)) {
				throw new Error(
					`Trustant runtime workbenches[${index}].watcherLog must remain outside the workbench`,
				);
			}
			const mcpConfig = canonicalPrivateFile(
				nonEmptyString(
					workbench.mcpConfig,
					`workbenches[${index}].mcpConfig`,
				),
				`workbenches[${index}].mcpConfig`,
			);
			if (isPathWithin(workspace, mcpConfig)) {
				throw new Error(
					`Trustant runtime workbenches[${index}].mcpConfig must remain outside the workbench`,
				);
			}
			return {
				app,
				workspace,
				developmentUrl,
				browserUrl,
				requiredMcpServers,
				mcpConfig,
				watcherLog,
			};
		},
	);
	return {
		version: TRUSTANT_PI_RUNTIME_VERSION,
		workbenches,
	};
}

function canonicalPrivateFile(path: string, field: string): string {
	const value = nonEmptyString(path, field);
	if (!isAbsolute(value)) {
		throw new Error(`Trustant runtime ${field} must be absolute: ${value}`);
	}
	try {
		const canonical = realpathSync(value);
		const info = statSync(canonical);
		if (!info.isFile()) {
			throw new Error("not a regular file");
		}
		// WHY: watcher output can include backend diagnostics. Managed metadata
		// must never authorize a group/world-readable log as an agent source.
		if ((info.mode & 0o077) !== 0) {
			throw new Error("not private (expected mode 0600)");
		}
		return canonical;
	} catch (error) {
		throw new Error(
			`Trustant runtime ${field} is unavailable at ${value}: ${(error as Error).message}`,
		);
	}
}

function validHttpUrl(value: unknown, field: string): string {
	const raw = nonEmptyString(value, field);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Trustant runtime ${field} is invalid: ${raw}`);
	}
	if (
		!parsed.hostname ||
		(parsed.protocol !== "http:" && parsed.protocol !== "https:")
	) {
		throw new Error(
			`Trustant runtime ${field} must use HTTP or HTTPS: ${raw}`,
		);
	}
	return raw;
}

function assertRequiredMcpServers(
	workbench: TrustantPiRuntimeWorkbench,
): void {
	const configPath = join(workbench.workspace, ".mcp.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read managed MCP config ${configPath}: ${(error as Error).message}`,
		);
	}
	const servers =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { mcpServers?: unknown }).mcpServers
			: undefined;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		throw new Error(
			`Managed MCP config ${configPath} has no mcpServers object`,
		);
	}
	const configured = new Set(Object.keys(servers));
	const missing = workbench.requiredMcpServers.filter(
		(name) => !configured.has(name),
	);
	if (missing.length > 0) {
		throw new Error(
			`Managed MCP config is missing required servers: ${missing.join(", ")}`,
		);
	}
	const expected = new Set(workbench.requiredMcpServers);
	const unexpected = [...configured].filter((name) => !expected.has(name));
	if (unexpected.length > 0) {
		throw new Error(
			`Managed MCP config contains unexpected servers: ${unexpected.join(", ")}`,
		);
	}
}

function stringArray(value: unknown, field: string): string[] {
	if (
		value === undefined ||
		(Array.isArray(value) &&
			value.every((entry) => typeof entry === "string"))
	) {
		return (value as string[] | undefined) ?? [];
	}
	throw new Error(`Managed MCP ${field} must be an array of strings`);
}

function stringRecord(
	value: unknown,
	field: string,
): Record<string, string> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Managed MCP ${field} must be a string map`);
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new Error(`Managed MCP ${field}.${key} must be a string`);
		}
		result[key] = entry;
	}
	return result;
}

function sensitiveValues(
	env: Record<string, string>,
	args: string[],
): string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (
			value.length >= 4 &&
			/(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential|uri|connection)/i.test(
				name,
			)
		) {
			values.add(value);
		}
		if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+:[^@\s]+@/i.test(value)) {
			values.add(value);
		}
	}
	for (let index = 0; index < args.length - 1; index++) {
		if (
			/^--?.*(?:password|secret|token|api[_-]?key|credential)$/i.test(
				args[index],
			) &&
			args[index + 1].length >= 4
		) {
			values.add(args[index + 1]);
		}
	}
	return [...values].sort((left, right) => right.length - left.length);
}

function readManagedMcpServers(
	workbench: TrustantPiRuntimeWorkbench,
): { servers: McpServer[]; secrets: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(workbench.mcpConfig, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read private managed MCP config: ${(error as Error).message}`,
		);
	}
	const entries =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { mcpServers?: unknown }).mcpServers
			: undefined;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
		throw new Error("Private managed MCP config has no mcpServers object");
	}
	const record = entries as Record<string, unknown>;
	const configured = Object.keys(record).sort();
	const expected = [...workbench.requiredMcpServers].sort();
	if (
		configured.length !== expected.length ||
		configured.some((name, index) => name !== expected[index])
	) {
		throw new Error(
			"Private managed MCP config does not match the credential-free server manifest",
		);
	}

	const secrets = new Set<string>();
	const servers = expected.map((name): McpServer => {
		const value = record[name];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Managed MCP server ${name} must be an object`);
		}
		const server = value as Record<string, unknown>;
		if (server.type === "http") {
			const url = validHttpUrl(server.url, `MCP server ${name}.url`);
			return { type: "http", name, url, headers: [] };
		}
		if (server.type !== "stdio" || typeof server.command !== "string") {
			throw new Error(
				`Managed MCP server ${name} must use stdio or HTTP`,
			);
		}
		const args = stringArray(server.args, `${name}.args`);
		const env = stringRecord(server.env, `${name}.env`);
		for (const secret of sensitiveValues(env, args)) secrets.add(secret);
		return {
			name,
			command: server.command,
			args,
			env: Object.entries(env).map(([envName, value]) => ({
				name: envName,
				value,
			})),
		};
	});
	return { servers, secrets: [...secrets] };
}

function canonicalExtensionPath(path: string): string {
	const value = nonEmptyString(path, "extension path");
	if (!isAbsolute(value)) {
		throw new Error(
			`Trustant runtime extension path must be absolute: ${value}`,
		);
	}
	try {
		const canonical = realpathSync(value);
		if (!statSync(canonical).isFile()) {
			throw new Error("not a regular file");
		}
		return canonical;
	} catch (error) {
		throw new Error(
			`Trustant Pi extension is unavailable at ${value}: ${(error as Error).message}`,
		);
	}
}

/**
 * Resolve the managed runtime for a Pi agent.
 *
 * Standalone TruACP returns undefined and keeps upstream Pi discovery. Once the
 * managed marker is present, missing host inputs are fatal; there is no
 * fallback to an unguarded Pi session.
 */
export function resolveManagedPiRuntime(
	workingDirectory: string,
	env: NodeJS.ProcessEnv = process.env,
): ManagedPiRuntime | undefined {
	if (env.TRUSTANT_MANAGED_RUNTIME !== "1") return undefined;
	const manifestPath = nonEmptyString(
		env.TRUSTANT_RUNTIME_CONFIG,
		"manifest path",
	);
	const runtimeConfigPath = resolve(manifestPath);
	const manifest = parseManifest(runtimeConfigPath);
	const canonicalWorkingDirectory = canonicalDirectory(
		workingDirectory,
		"working directory",
	);
	const matches = manifest.workbenches.filter((workbench) =>
		isPathWithin(workbench.workspace, canonicalWorkingDirectory),
	);
	if (matches.length !== 1) {
		throw new Error(
			`Trustant runtime expected one workbench for ${canonicalWorkingDirectory}, found ${matches.length}`,
		);
	}
	const workbench = matches[0];
	assertRequiredMcpServers(workbench);
	const extensionPath = canonicalExtensionPath(
		nonEmptyString(env.TRUSTANT_PI_EXTENSION_PATH, "extension path"),
	);
	const managedMcp = readManagedMcpServers(workbench);
	return {
		workbench,
		extensionPath,
		mcpServers: managedMcp.servers,
		redactionSecrets: managedMcp.secrets,
		runtimeConfigPath,
	};
}
