/**
 * Trustable security guardrails loaded by Pi before built-in tools execute.
 *
 * The model-facing project instructions remain the primary policy surface, but
 * secret access must not depend on the model remembering prose. This extension
 * blocks direct file and shell access before credentials can enter model
 * context or a remote completion request.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SAFE_ENV_TEMPLATES = new Set([
	".env.dist",
	".env.example",
	".env.sample",
	".env.template",
]);

const SENSITIVE_FILENAMES = new Set([
	"auth.json",
	".npmrc",
	".pypirc",
	".netrc",
	"credentials",
]);

export function isSensitivePath(candidate: string): boolean {
	const normalized = candidate
		.replaceAll("\\", "/")
		.replace(/[\"'`]/g, "")
		.toLowerCase();
	const parts = normalized.split("/").filter(Boolean);
	const filename = parts.at(-1) ?? "";

	if (filename === ".env" || (filename.startsWith(".env.") && !SAFE_ENV_TEMPLATES.has(filename))) {
		return true;
	}
	if (SENSITIVE_FILENAMES.has(filename)) return true;
	if (parts.includes(".ssh") && !filename.endsWith(".pub")) return true;
	if (normalized.includes("/.trustable/secrets/")) return true;
	if (normalized.endsWith("/.ops/config.json") || normalized === ".ops/config.json") return true;
	if (/\/proc\/(?:self|\d+)\/environ(?:$|[/?#])/.test(normalized)) return true;
	return false;
}

export function unsafeShellReason(command: string): string | undefined {
	const normalized = command.replace(/\\\s*\n/g, " ");

	// Environment-wide dumps and direct secret expansions bypass protected
	// files entirely, so block them independently from path inspection.
	if (/(^|[;&|()\s])(?:env|printenv)(?:\s|$)/i.test(normalized)) {
		return "environment dumps are not allowed";
	}
	if (/(^|[;&|()\s])(?:set|export\s+-p|declare\s+-x)(?:\s|$)/i.test(normalized)) {
		return "shell environment dumps are not allowed";
	}
	if (
		/\$(?:\{)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*(?:\})?/i.test(
			normalized,
		)
	) {
		return "secret environment expansion is not allowed";
	}
	if (
		/(?:process\.env|os\.environ|os\.getenv|deno\.env|\/proc\/(?:self|\d+)\/environ)/i.test(
			normalized,
		)
	) {
		return "programmatic environment access is not allowed";
	}

	const shellTokens = normalized
		.split(/[\s;&|()<>{}]+/)
		.map((token) => token.replace(/^[=:]+|[,:]+$/g, ""))
		.filter(Boolean);
	if (shellTokens.some(isSensitivePath)) {
		return "access to credential-bearing files is not allowed";
	}
	return undefined;
}

export default function trustableGuardrails(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (
			event.toolName === "read" ||
			event.toolName === "write" ||
			event.toolName === "edit"
		) {
			const path =
				typeof event.input.path === "string" ? event.input.path : "";
			if (isSensitivePath(path)) {
				return {
					block: true,
					reason: `Trustable blocked access to protected path "${path}". Use the approved MCP secret tools instead.`,
				};
			}
		}

		if (event.toolName === "bash") {
			const command =
				typeof event.input.command === "string"
					? event.input.command
					: "";
			const reason = unsafeShellReason(command);
			if (reason) {
				return {
					block: true,
					reason: `Trustable blocked this shell command: ${reason}.`,
				};
			}
		}

		return undefined;
	});
}
