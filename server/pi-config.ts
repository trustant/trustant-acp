/**
 * Pi provider configuration + connectivity check.
 *
 * Unlike codex/claude (which have their own login CLIs), pi has no headless
 * auth command. An OpenAI-compatible endpoint is configured through pi's own
 * native config files: models.json carries the endpoint/model catalog and
 * auth.json carries the credential. pi-acp discovers both through Pi, so no
 * ~/.truacp.json side-store is needed and the key never reaches the browser.
 *
 * The UI flow is "try, then ask" only for standalone TruACP. A Trustable-managed
 * runtime is configured by Trustable's main Configure screen and reports a
 * managed failure instead of opening a second credential form.
 */
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

/**
 * Standalone TruACP receives a user-supplied endpoint, so it belongs to the
 * neutral local namespace rather than impersonating a Trustable catalog.
 */
export const PI_PROVIDER = "local";
const TRUSTABLE_MANAGED_PI_PROVIDERS = new Set([
	"local",
	"ollama",
	"trustable",
]);
const PI_API_KEY_REF = "$OPENAI_API_KEY";

/** ~/.pi/agent/models.json — pi's native custom-provider config. */
function piModelsPath(): string {
	const dir =
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "models.json");
}

/** ~/.pi/agent/auth.json — Pi's native credential store. */
function piAuthPath(): string {
	return join(dirname(piModelsPath()), "auth.json");
}

/** ~/.pi/agent/settings.json — Pi's global provider/model selection. */
function piSettingsPath(): string {
	return join(dirname(piModelsPath()), "settings.json");
}

interface StoredPiConfig {
	provider: string;
	baseUrl: string;
	apiKeyRef: string;
	model: string;
}

/** Read a JSON object without making a missing optional Pi file fatal. */
async function readJSONObject(path: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Write private Pi state and reapply its mode even when the file existed. */
async function writePrivateJSON(
	path: string,
	value: Record<string, unknown>,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
	await chmod(path, 0o600);
}

/**
 * Trustable selects one managed provider in settings.json. Falling back to
 * local preserves standalone behavior without allowing arbitrary built-in Pi
 * providers to cross the managed runtime boundary.
 */
async function activePiProvider(): Promise<string> {
	const settings = await readJSONObject(piSettingsPath());
	const configured = settings.defaultProvider;
	return typeof configured === "string" &&
		TRUSTABLE_MANAGED_PI_PROVIDERS.has(configured)
		? configured
		: PI_PROVIDER;
}

/** Read provider metadata without exposing its key/reference to an API caller. */
async function readStoredPiConfig(): Promise<StoredPiConfig | null> {
	const json = await readJSONObject(piModelsPath());
	const providers = json.providers as Record<string, unknown> | undefined;
	const providerName = await activePiProvider();
	const provider = providers?.[providerName] as
		| Record<string, unknown>
		| undefined;
	if (!provider) return null;
	const models = Array.isArray(provider.models)
		? (provider.models as Array<{ id?: unknown }>)
		: [];
	return {
		provider: providerName,
		baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
		apiKeyRef: typeof provider.apiKey === "string" ? provider.apiKey : "",
		model: typeof models[0]?.id === "string" ? models[0].id : "",
	};
}

/**
 * Resolve Pi's provider credential server-side. Trustable writes the real key
 * to auth.json and leaves an environment reference in models.json; standalone
 * configurations can still fall back to an environment variable or legacy
 * literal key. auth.json wins so a generic/dummy process env cannot mask it.
 */
async function resolvePiApiKey(
	providerName: string,
	apiKeyRef: string,
): Promise<string> {
	const auth = await readJSONObject(piAuthPath());
	const entry = auth[providerName];
	if (typeof entry === "string" && entry) return entry;
	if (entry && typeof entry === "object") {
		const key = (entry as Record<string, unknown>).key;
		if (typeof key === "string" && key) return key;
	}
	if (apiKeyRef.startsWith("$") && apiKeyRef.length > 1) {
		return process.env[apiKeyRef.slice(1)] ?? "";
	}
	return apiKeyRef;
}

/** Explicit launch marker: standalone TruACP must retain its local form. */
function isTrustableManagedRuntime(): boolean {
	return process.env.TRUSTABLE_MANAGED_RUNTIME === "1";
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
		// This module runs in the standalone Node server, not inside Obsidian;
		// native fetch supplies AbortSignal support without an Obsidian dependency.
		// eslint-disable-next-line no-restricted-globals
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: ctrl.signal,
		});
		if (!res.ok) {
			return {
				ok: false,
				models: [],
				detail: `HTTP ${res.status} from ${url}`,
			};
		}
		const json = (await res.json()) as { data?: Array<{ id?: string }> };
		const models = (json.data ?? [])
			.map((m) => m.id)
			.filter((id): id is string => !!id);
		return models.length > 0
			? { ok: true, models, detail: `${models.length} model(s)` }
			: { ok: false, models: [], detail: "Endpoint returned no models." };
	} catch (e) {
		const msg =
			(e as Error).name === "AbortError" ? "timed out" : String(e);
		return {
			ok: false,
			models: [],
			detail: `Could not reach ${url}: ${msg}`,
		};
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

/**
 * Read only browser-safe Pi configuration. apiKey is deliberately omitted:
 * neither an auth.json secret nor a legacy literal models.json key may cross
 * the REST boundary.
 */
export async function readPiConfig(): Promise<Partial<PiConfig>> {
	const stored = await readStoredPiConfig();
	if (!stored) return {};
	return { baseUrl: stored.baseUrl, model: stored.model };
}

/**
 * Write/merge a custom OpenAI-compatible provider named `local` into pi's
 * models.json/auth.json, preserving any other providers the user configured.
 * The credential is written only to auth.json; models.json receives the same
 * environment reference used by Trustable-managed installations.
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
	const json = await readJSONObject(path);
	if (!json.providers || typeof json.providers !== "object") {
		json.providers = {};
	}
	(json.providers as Record<string, unknown>)[PI_PROVIDER] = {
		baseUrl,
		api: "openai-completions",
		apiKey: PI_API_KEY_REF,
		models: models.map((id) => ({ id })),
	};
	const auth = await readJSONObject(piAuthPath());
	auth[PI_PROVIDER] = { type: "api_key", key: apiKey };
	await writePrivateJSON(piAuthPath(), auth);
	await writePrivateJSON(path, json);

	// Pi ships a built-in catalog independently from custom models.json
	// providers. Persist an explicit provider scope so standalone TruACP cannot
	// start or cycle outside the local endpoint after saving it.
	const settings = await readJSONObject(piSettingsPath());
	settings.defaultProvider = PI_PROVIDER;
	settings.defaultModel = models[0];
	settings.enabledModels = [`${PI_PROVIDER}/*`];
	await mkdir(dirname(piSettingsPath()), { recursive: true });
	await writeFile(piSettingsPath(), JSON.stringify(settings, null, 2), {
		mode: 0o644,
	});
	await chmod(piSettingsPath(), 0o644);
}

/** Outcome of a pi connectivity probe. */
export interface PiHelloResult {
	ok: boolean;
	detail: string;
	managed: boolean;
}

/**
 * Probe pi connectivity by listing the configured endpoint's models. A
 * completion round-trip is slow and can hang on cold/large models; listing
 * `/models` verifies reachability + auth quickly, which is all the gate needs.
 */
export async function piHello(): Promise<PiHelloResult> {
	const managed = isTrustableManagedRuntime();
	const cfg = await readStoredPiConfig();
	if (!cfg?.baseUrl) {
		return { ok: false, detail: "Pi is not configured.", managed };
	}
	const apiKey = await resolvePiApiKey(cfg.provider, cfg.apiKeyRef);
	if (!apiKey) {
		return {
			ok: false,
			detail: "Pi credential is not configured.",
			managed,
		};
	}
	const probe = await probeModels(cfg.baseUrl, apiKey);
	return { ok: probe.ok, detail: probe.detail, managed };
}
