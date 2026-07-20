/**
 * Pi provider configuration + connectivity check.
 *
 * Unlike codex/claude (which have their own login CLIs), pi has no headless
 * auth command. An OpenAI-compatible endpoint is configured through pi's own
 * native config file `~/.pi/agent/models.json` — a custom provider entry with a
 * base URL + API key + model (see pi docs models.md). pi-acp then discovers it
 * via `get_available_models`, so no ~/.truacp.json side-store is needed.
 *
 * The UI flow is "try, then ask": `piHello()` runs a real one-shot prompt to see
 * whether pi answers; if not, the UI collects base URL + API key + model and
 * `writePiProvider()` writes them here, after which the check is retried.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

/** Provider name we register pi's custom OpenAI-compatible endpoint under. */
export const PI_PROVIDER = "trustable";

/** ~/.pi/agent/models.json — pi's native custom-provider config. */
function piModelsPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "models.json");
}

/** User-facing pi provider config. `model` is optional — resolved from the
 * endpoint's /models list when omitted. */
export interface PiConfig {
	baseUrl: string;
	apiKey: string;
	model?: string;
}

/**
 * Result of an endpoint reachability probe via `GET /models`. */
export interface ModelsProbe {
	ok: boolean;
	models: string[];
	detail: string;
}

/**
 * Probe an OpenAI-compatible endpoint by listing its models. Faster and more
 * robust than generating a completion: reachability + auth are both exercised,
 * and the returned list is what the model selector uses. `timeoutMs` bounds the
 * request so the UI stays responsive.
 */
export async function probeModels(
	baseUrl: string,
	apiKey: string,
	timeoutMs = 10_000,
): Promise<ModelsProbe> {
	if (!baseUrl) return { ok: false, models: [], detail: "No base URL." };
	const url = baseUrl.replace(/\/+$/, "") + "/models";
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: ctrl.signal,
		});
		if (!res.ok) {
			return { ok: false, models: [], detail: `HTTP ${res.status} from ${url}` };
		}
		const json = (await res.json()) as { data?: Array<{ id?: string }> };
		const models = (json.data ?? [])
			.map((m) => m.id)
			.filter((id): id is string => !!id);
		return models.length > 0
			? { ok: true, models, detail: `${models.length} model(s)` }
			: { ok: false, models: [], detail: "Endpoint returned no models." };
	} catch (e) {
		const msg = (e as Error).name === "AbortError" ? "timed out" : String(e);
		return { ok: false, models: [], detail: `Could not reach ${url}: ${msg}` };
	} finally {
		clearTimeout(timer);
	}
}

/** List model ids from an OpenAI-compatible `<baseUrl>/models` ([] on failure). */
export async function listModelsFromEndpoint(
	baseUrl: string,
	apiKey: string,
): Promise<string[]> {
	return (await probeModels(baseUrl, apiKey)).models;
}

/** Read the current trustable provider entry from models.json (if any). */
export async function readPiConfig(): Promise<Partial<PiConfig>> {
	try {
		const text = await readFile(piModelsPath(), "utf8");
		const json = JSON.parse(text);
		const p = json?.providers?.[PI_PROVIDER];
		if (!p) return {};
		return {
			baseUrl: p.baseUrl ?? "",
			apiKey: p.apiKey ?? "",
			model: Array.isArray(p.models) ? (p.models[0]?.id ?? "") : "",
		};
	} catch {
		return {};
	}
}

/**
 * Write/merge a custom OpenAI-compatible provider named PI_PROVIDER into pi's
 * models.json, preserving any other providers the user configured. The chosen
 * model is registered under this provider; select it in pi with
 * `--provider trustable --model trustable/<id>`.
 */
export async function writePiProvider(cfg: PiConfig): Promise<void> {
	const baseUrl = cfg.baseUrl.trim();
	const apiKey = cfg.apiKey.trim();
	// The user supplies only base URL + API key; discover ALL models from the
	// endpoint so the model selector lists every one (not just the first).
	const discovered = await listModelsFromEndpoint(baseUrl, apiKey);
	const models = cfg.model?.trim() ? [cfg.model.trim()] : discovered;
	if (models.length === 0) {
		throw new Error(
			"Could not list models from the endpoint — check the base URL and API key.",
		);
	}

	const path = piModelsPath();
	let json: { providers?: Record<string, unknown> } = {};
	try {
		json = JSON.parse(await readFile(path, "utf8"));
	} catch {
		json = {};
	}
	if (!json.providers || typeof json.providers !== "object") {
		json.providers = {};
	}
	(json.providers as Record<string, unknown>)[PI_PROVIDER] = {
		baseUrl,
		api: "openai-completions",
		apiKey,
		models: models.map((id) => ({ id })),
	};
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(json, null, 2), { mode: 0o600 });
}

/** Outcome of a pi connectivity probe. */
export interface PiHelloResult {
	ok: boolean;
	detail: string;
}

/**
 * Probe pi connectivity by listing the configured endpoint's models. A
 * completion round-trip is slow and can hang on cold/large models; listing
 * `/models` verifies reachability + auth quickly, which is all the gate needs.
 */
export async function piHello(): Promise<PiHelloResult> {
	const cfg = await readPiConfig();
	if (!cfg.baseUrl || !cfg.apiKey) {
		return { ok: false, detail: "Pi is not configured." };
	}
	const probe = await probeModels(cfg.baseUrl, cfg.apiKey);
	return { ok: probe.ok, detail: probe.detail };
}
