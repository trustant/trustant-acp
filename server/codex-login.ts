/**
 * Codex ChatGPT login helpers, driven via the `codex` CLI.
 *
 * Codex authenticates out-of-band from ACP: `codex-acp` only reports that a
 * session needs auth. The actual login is done with the codex CLI, which on a
 * headless machine offers a device-code flow:
 *
 *   codex login status         → "Not logged in" / logged-in account line
 *   codex login --device-auth  → prints a verification URL + one-time code,
 *                                then blocks until the user completes it
 *
 * We run `--device-auth` detached, scrape the URL + code from its stdout, and
 * return them to the UI. The process keeps running (awaiting completion) in the
 * background; the UI re-checks `login status` when the user clicks "done".
 */
import { spawn, execFile } from "child_process";

/** Result of `codex login status`. */
export interface CodexLoginStatus {
	loggedIn: boolean;
	detail: string;
}

/** Device-auth prompt scraped from `codex login --device-auth`. */
export interface CodexDeviceAuth {
	url: string;
	code: string;
	raw: string;
}

/** Path/name of the codex binary (overridable for tests / custom installs). */
function codexCommand(): string {
	return process.env.CODEX_COMMAND || "codex";
}

/**
 * Run `codex login status`. "Not logged in" (or a non-zero exit) → loggedIn
 * false; any other output is treated as a logged-in account line.
 */
export function codexLoginStatus(): Promise<CodexLoginStatus> {
	return new Promise((resolve) => {
		execFile(
			codexCommand(),
			["login", "status"],
			{ timeout: 15_000 },
			(err, stdout, stderr) => {
				const detail = `${stdout || ""}${stderr || ""}`.trim();
				const loggedIn =
					!err && !/not logged in/i.test(detail) && detail.length > 0;
				resolve({ loggedIn, detail: detail || (err ? String(err) : "") });
			},
		);
	});
}

// Track the in-flight device-auth process so a second request doesn't spawn a
// duplicate; killed on a fresh start.
let deviceProc: ReturnType<typeof spawn> | null = null;

/**
 * Start `codex login --device-auth` and resolve once its stdout has emitted the
 * verification URL and one-time code. The child stays alive in the background to
 * await completion; the caller polls `codexLoginStatus()` afterwards.
 *
 * Rejects if no URL+code appears within the timeout.
 */
export function codexStartDeviceAuth(
	timeoutMs = 20_000,
): Promise<CodexDeviceAuth> {
	// Replace any prior attempt.
	if (deviceProc && !deviceProc.killed) {
		try {
			deviceProc.kill();
		} catch {
			/* ignore */
		}
	}

	return new Promise((resolve, reject) => {
		const child = spawn(codexCommand(), ["login", "--device-auth"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});
		deviceProc = child;

		let buf = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`codex device-auth did not emit a code within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);

		const tryParse = (): void => {
			if (settled) return;
			// Strip ANSI escape codes the CLI emits for colored output.
			const clean = buf.replace(/\[[0-9;]*m/g, "");
			const url = clean.match(/https?:\/\/\S*device\S*/i)?.[0];
			// One-time code: a short hyphenated uppercase-alnum token.
			const code = clean.match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/)?.[0];
			if (url && code) {
				settled = true;
				clearTimeout(timer);
				resolve({ url, code, raw: clean.trim() });
			}
		};

		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			tryParse();
		});
		child.stderr?.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			tryParse();
		});
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(e);
		});
		child.on("exit", () => {
			if (deviceProc === child) deviceProc = null;
		});
	});
}
