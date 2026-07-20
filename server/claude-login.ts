/**
 * Claude Code OAuth login helpers, driven via the `claude` CLI.
 *
 * Claude authenticates out-of-band from ACP. Its login is a paste-code OAuth
 * flow (distinct from codex's device-code flow):
 *
 *   claude auth status --text  → "Not logged in…" / logged-in text
 *   claude auth login          → prints an authorize URL, then BLOCKS reading a
 *                                code from stdin ("Paste code here if prompted >")
 *
 * So login is two-phase and stateful: `claudeStartLogin()` spawns `auth login`,
 * scrapes the URL, and keeps the process alive with stdin open;
 * `claudeCompleteLogin(code)` writes the pasted code to that process's stdin and
 * resolves with the outcome. The UI shows the URL, the user authenticates in a
 * browser, copies the code, and submits it.
 */
import { spawn, execFile, type ChildProcess } from "child_process";

/** Result of `claude auth status --text`. */
export interface ClaudeLoginStatus {
	/** True when the CLI reports logged in OR an ANTHROPIC_API_KEY is present. */
	loggedIn: boolean;
	detail: string;
	/** Whether an ANTHROPIC_API_KEY is set — claude works without OAuth login. */
	hasApiKey?: boolean;
}

/** Path/name of the claude binary (overridable for tests / custom installs). */
function claudeCommand(): string {
	return process.env.CLAUDE_COMMAND || "claude";
}

/**
 * Run `claude auth status --text`. "Not logged in" (or a non-zero exit) →
 * loggedIn false; any other text is treated as a logged-in status line.
 */
export function claudeLoginStatus(): Promise<ClaudeLoginStatus> {
	return new Promise((resolve) => {
		execFile(
			claudeCommand(),
			["auth", "status", "--text"],
			{ timeout: 15_000 },
			(err, stdout, stderr) => {
				const detail = `${stdout || ""}${stderr || ""}`.trim();
				// An API key lets claude run without OAuth login — treat as OK.
				const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
				const cliLoggedIn =
					!err && !/not logged in/i.test(detail) && detail.length > 0;
				resolve({
					loggedIn: cliLoggedIn || hasApiKey,
					detail: detail || (err ? String(err) : ""),
					hasApiKey,
				});
			},
		);
	});
}

/** ANSI escape stripper for scraped CLI output. */
function stripAnsi(s: string): string {
	return s.replace(/\[[0-9;]*m/g, "");
}

// The in-flight `auth login` process, kept alive between start and complete so
// its stdin stays open to receive the pasted code.
let loginProc: ChildProcess | null = null;

/**
 * Start `claude auth login` and resolve with the authorize URL once its stdout
 * emits it. The process is kept running (stdin open) awaiting the code; the
 * caller finishes with `claudeCompleteLogin(code)`.
 *
 * Rejects if no URL appears within the timeout.
 */
export function claudeStartLogin(timeoutMs = 20_000): Promise<{ url: string }> {
	// Replace any prior attempt.
	if (loginProc && !loginProc.killed) {
		try {
			loginProc.kill();
		} catch {
			/* ignore */
		}
	}
	loginProc = null;

	return new Promise((resolve, reject) => {
		const child = spawn(claudeCommand(), ["auth", "login"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		loginProc = child;

		let buf = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`claude auth login did not emit a URL within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);

		const tryParse = (): void => {
			if (settled) return;
			const clean = stripAnsi(buf);
			const url = clean.match(
				/https?:\/\/\S*oauth\/authorize\S*/i,
			)?.[0];
			if (url) {
				settled = true;
				clearTimeout(timer);
				resolve({ url });
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
			if (loginProc === child) loginProc = null;
		});
	});
}

/**
 * Write the pasted `code` to the running `auth login` process's stdin and
 * resolve with the outcome. Reads the process's remaining output to detect
 * success vs. "Invalid code". Rejects if no login is in progress.
 */
export function claudeCompleteLogin(
	code: string,
	timeoutMs = 30_000,
): Promise<ClaudeLoginStatus> {
	const child = loginProc;
	if (!child || child.killed || !child.stdin) {
		return Promise.reject(
			new Error("No claude login in progress — start login again."),
		);
	}

	return new Promise((resolve, reject) => {
		let out = "";
		let settled = false;

		const finish = (result: ClaudeLoginStatus): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			// Timed out waiting for the CLI to react; fall back to a fresh
			// status check so we don't hang the request.
			if (settled) return;
			settled = true;
			void claudeLoginStatus().then(resolve, reject);
		}, timeoutMs);

		const onData = (d: Buffer): void => {
			out += stripAnsi(d.toString("utf8"));
			if (/invalid code/i.test(out)) {
				finish({ loggedIn: false, detail: "Invalid code" });
			} else if (/logged in|success|authenticated/i.test(out)) {
				finish({ loggedIn: true, detail: out.trim() });
			}
		};

		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("exit", () => {
			if (settled) return;
			// Process finished; confirm via a status check.
			void claudeLoginStatus().then(finish, reject);
		});

		try {
			child.stdin.write(code.trim() + "\n");
		} catch (e) {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(e as Error);
			}
		}
	});
}
