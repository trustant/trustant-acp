/**
 * Runtime dependencies for the ACP layer, independent of any host (Obsidian
 * plugin, Node server, Electron main process).
 *
 * `AcpClient` and `TerminalManager` originally took the whole `AgentClientPlugin`
 * instance to read a handful of settings and to resolve API-key secrets from
 * Obsidian's secret storage. In the standalone client there is no plugin, so the
 * exact surface they need is captured here and injected instead. Any host builds
 * one of these — the Node server derives it from `config.json` + `process.env`.
 */
export interface AcpRuntimeConfig {
	/**
	 * Explicit Node.js path/dir setting. Empty or a bare command name means the
	 * login shell resolves node from PATH; an absolute path is prepended to PATH.
	 */
	nodePath: string;

	/** Windows-only: run agents inside WSL. */
	windowsWslMode: boolean;

	/** Windows-only: which WSL distribution to launch. */
	windowsWslDistribution: string;

	/** Auto-approve every permission request without prompting. */
	autoAllowPermissions: boolean;

	/** Version string reported to the agent as clientInfo.version. */
	clientVersion: string;

	/**
	 * Resolve a secret value by its reference id, or "" if unavailable.
	 *
	 * In the standalone client the "secret id" is an environment variable name
	 * (see config.json `apiKeyEnvVar`); the server implementation reads
	 * `process.env[id]`. The plugin's implementation reads Obsidian secret
	 * storage. Called just before spawn so the latest value is used.
	 */
	resolveSecret(secretId: string): string;
}
