/**
 * Trustable-managed Pi runtime contract validation.
 *
 * The browser never supplies this data. trustable-app writes a private
 * credential-free manifest and starts TruACP with paths to that manifest and
 * the installed policy extension. Managed mode fails closed if either artifact
 * is absent, malformed, or does not describe the selected working directory.
 */
import { readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";

export const TRUSTABLE_PI_RUNTIME_VERSION = 2 as const;

export interface TrustablePiRuntimeWorkbench {
	app: string;
	workspace: string;
	developmentUrl: string;
	browserUrl: string;
	requiredMcpServers: string[];
	watcherLog: string;
}

export interface TrustablePiRuntimeManifest {
	version: typeof TRUSTABLE_PI_RUNTIME_VERSION;
	workbenches: TrustablePiRuntimeWorkbench[];
}

export interface ManagedPiRuntime {
	workbench: TrustablePiRuntimeWorkbench;
	extensionPath: string;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`Trustable runtime ${field} must be a non-empty string`,
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
			`Trustable runtime ${field} must be absolute: ${value}`,
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
			`Trustable runtime ${field} is unavailable at ${value}: ${(error as Error).message}`,
		);
	}
}

function parseManifest(path: string): TrustablePiRuntimeManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read Trustable Pi runtime manifest ${path}: ${(error as Error).message}`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Trustable Pi runtime manifest must be a JSON object");
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== TRUSTABLE_PI_RUNTIME_VERSION) {
		throw new Error(
			`Unsupported Trustable Pi runtime version ${String(record.version)} (expected ${TRUSTABLE_PI_RUNTIME_VERSION})`,
		);
	}
	if (!Array.isArray(record.workbenches) || record.workbenches.length === 0) {
		throw new Error(
			"Trustable Pi runtime manifest must declare at least one workbench",
		);
	}
	const workbenches = record.workbenches.map(
		(rawWorkbench, index): TrustablePiRuntimeWorkbench => {
			if (
				!rawWorkbench ||
				typeof rawWorkbench !== "object" ||
				Array.isArray(rawWorkbench)
			) {
				throw new Error(
					`Trustable runtime workbenches[${index}] must be a JSON object`,
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
					`Trustable runtime workbenches[${index}].requiredMcpServers must be an array of non-empty strings`,
				);
			}
			const requiredMcpServers = [
				...new Set(workbench.requiredMcpServers as string[]),
			].sort();
			if (requiredMcpServers.length === 0) {
				throw new Error(
					`Trustable runtime workbenches[${index}] declares no required MCP servers`,
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
					`Trustable runtime workbenches[${index}].watcherLog must remain outside the workbench`,
				);
			}
			return {
				app,
				workspace,
				developmentUrl,
				browserUrl,
				requiredMcpServers,
				watcherLog,
			};
		},
	);
	return {
		version: TRUSTABLE_PI_RUNTIME_VERSION,
		workbenches,
	};
}

function canonicalPrivateFile(path: string, field: string): string {
	const value = nonEmptyString(path, field);
	if (!isAbsolute(value)) {
		throw new Error(`Trustable runtime ${field} must be absolute: ${value}`);
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
			`Trustable runtime ${field} is unavailable at ${value}: ${(error as Error).message}`,
		);
	}
}

function validHttpUrl(value: unknown, field: string): string {
	const raw = nonEmptyString(value, field);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Trustable runtime ${field} is invalid: ${raw}`);
	}
	if (
		!parsed.hostname ||
		(parsed.protocol !== "http:" && parsed.protocol !== "https:")
	) {
		throw new Error(
			`Trustable runtime ${field} must use HTTP or HTTPS: ${raw}`,
		);
	}
	return raw;
}

function assertRequiredMcpServers(
	workbench: TrustablePiRuntimeWorkbench,
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
}

function canonicalExtensionPath(path: string): string {
	const value = nonEmptyString(path, "extension path");
	if (!isAbsolute(value)) {
		throw new Error(
			`Trustable runtime extension path must be absolute: ${value}`,
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
			`Trustable Pi extension is unavailable at ${value}: ${(error as Error).message}`,
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
	if (env.TRUSTABLE_MANAGED_RUNTIME !== "1") return undefined;
	const manifestPath = nonEmptyString(
		env.TRUSTABLE_RUNTIME_CONFIG,
		"manifest path",
	);
	const manifest = parseManifest(resolve(manifestPath));
	const canonicalWorkingDirectory = canonicalDirectory(
		workingDirectory,
		"working directory",
	);
	const matches = manifest.workbenches.filter((workbench) =>
		isPathWithin(workbench.workspace, canonicalWorkingDirectory),
	);
	if (matches.length !== 1) {
		throw new Error(
			`Trustable runtime expected one workbench for ${canonicalWorkingDirectory}, found ${matches.length}`,
		);
	}
	const workbench = matches[0];
	assertRequiredMcpServers(workbench);
	const extensionPath = canonicalExtensionPath(
		nonEmptyString(env.TRUSTABLE_PI_EXTENSION_PATH, "extension path"),
	);
	return { workbench, extensionPath };
}
