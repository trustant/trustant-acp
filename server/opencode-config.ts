/**
 * OpenCode provider configuration + connectivity check.
 *
 * OpenCode speaks ACP natively (`opencode acp`), but like pi it has no simple
 * headless credential command for a custom endpoint. An OpenAI-compatible
 * endpoint is configured through OpenCode's own config `~/.config/opencode/
 * opencode.jsonc` — a custom provider (`trustable`) using the
 * `@ai-sdk/openai-compatible` npm driver with `options.baseURL` + `options.apiKey`
 * and a model (per OpenCode's ProviderConfig schema).
 *
 * Mirrors pi-config.ts: the UI flow is "try, then ask" — `opencodeHello()` runs
 * a real one-shot `opencode run` against the configured provider; if it fails,
 * the UI collects base URL + API key + model and `writeOpencodeProvider()` writes
 * them here, after which the probe is retried.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { listModelsFromEndpoint, probeModels } from "./pi-config";

/** Provider id/name we register OpenCode's custom endpoint under. */
export const OC_PROVIDER = "trustable";

/** ~/.config/opencode/opencode.jsonc — OpenCode's native config. */
function opencodeConfigPath(): string {
	const base =
		process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
	return join(base, "opencode.jsonc");
}

/** User-facing OpenCode provider config. `model` is optional — resolved from
 * the endpoint's /models list when omitted. */
export interface OpencodeConfig {
	baseUrl: string;
	apiKey: string;
	model?: string;
}

/**
 * Parse opencode.jsonc leniently (strip // and /* *​/ comments) and return the
 * trustable provider entry, if any.
 */
async function readRawConfig(): Promise<Record<string, unknown>> {
	try {
		const text = await readFile(opencodeConfigPath(), "utf8");
		const stripped = text
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/.*$/gm, "$1");
		return JSON.parse(stripped);
	} catch {
		return {};
	}
}

/** Read the current trustable provider entry from opencode.jsonc (if any). */
export async function readOpencodeConfig(): Promise<Partial<OpencodeConfig>> {
	const json = await readRawConfig();
	const provider = (json.provider as Record<string, unknown>) ?? {};
	const p = provider[OC_PROVIDER] as
		| { options?: { baseURL?: string; apiKey?: string }; models?: object }
		| undefined;
	if (!p) return {};
	const modelId = p.models ? Object.keys(p.models)[0] : "";
	return {
		baseUrl: p.options?.baseURL ?? "",
		apiKey: p.options?.apiKey ?? "",
		model: modelId ?? "",
	};
}

/**
 * Write/merge a custom OpenAI-compatible provider named OC_PROVIDER into
 * opencode.jsonc, preserving other keys. Select it in OpenCode with the model id
 * `trustable/<model>`.
 */
export async function writeOpencodeProvider(
	cfg: OpencodeConfig,
): Promise<void> {
	const baseUrl = cfg.baseUrl.trim();
	const apiKey = cfg.apiKey.trim();
	// The user supplies only base URL + API key; discover ALL models from the
	// endpoint so the model selector lists every one (not just the first).
	const discovered = await listModelsFromEndpoint(baseUrl, apiKey);
	const modelIds = cfg.model?.trim() ? [cfg.model.trim()] : discovered;
	if (modelIds.length === 0) {
		throw new Error(
			"Could not list models from the endpoint — check the base URL and API key.",
		);
	}

	const path = opencodeConfigPath();
	const json = await readRawConfig();
	if (!json["$schema"]) json["$schema"] = "https://opencode.ai/config.json";
	const provider =
		(json.provider as Record<string, unknown>) ??
		(json.provider = {} as Record<string, unknown>);
	(provider as Record<string, unknown>)[OC_PROVIDER] = {
		npm: "@ai-sdk/openai-compatible",
		name: "Trustable",
		options: { baseURL: baseUrl, apiKey },
		models: Object.fromEntries(modelIds.map((id) => [id, {}])),
	};
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(json, null, 2), { mode: 0o600 });
}

/** Outcome of an OpenCode connectivity probe. */
export interface OpencodeHelloResult {
	ok: boolean;
	detail: string;
}

/**
 * Probe OpenCode connectivity by listing the configured endpoint's models
 * (`GET /models`) — fast and robust, unlike a full `opencode run` which can hang
 * on cold/large models. Reachability + auth are both exercised.
 */
export async function opencodeHello(): Promise<OpencodeHelloResult> {
	const cfg = await readOpencodeConfig();
	if (!cfg.baseUrl || !cfg.apiKey) {
		return { ok: false, detail: "OpenCode is not configured." };
	}
	const probe = await probeModels(cfg.baseUrl, cfg.apiKey);
	return { ok: probe.ok, detail: probe.detail };
}
