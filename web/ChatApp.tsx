/**
 * Lean standalone browser chat UI.
 *
 * Deliberately does NOT reuse the Obsidian-coupled ChatPanel/MessageBubble
 * (which require an AgentClientPlugin instance). Instead it builds its own view
 * model straight from streamed SessionUpdates over AcpTransport, covering the
 * "core chat" scope: agent picker, streaming assistant text (react-markdown),
 * thoughts, tool calls, permission prompts, and an input box.
 */
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionUpdate, SessionConfigOption } from "../src/types/session";
import { AcpTransport, type AgentInfo } from "./transport";
import { managedModelChoices } from "./model-options";

// ---- view model -----------------------------------------------------------

interface UserTurn {
	kind: "user";
	id: string;
	text: string;
}
interface AssistantTurn {
	kind: "assistant";
	id: string;
	text: string;
	thoughts: string;
}
interface ToolTurn {
	kind: "tool";
	id: string; // toolCallId
	title: string;
	status: string;
}
type Turn = UserTurn | AssistantTurn | ToolTurn;

interface PendingPermission {
	requestId: string;
	title: string;
	options: { optionId: string; name: string }[];
}

/**
 * OpenAI-compatible endpoint form (base URL + API key + model) for agents
 * configured through their own native config file: **pi** (models.json).
 * `agent` selects which. `pendingConnect` = opened during agent select
 * (connect after save).
 */
interface EndpointConfigModal {
	agent: "pi";
	baseUrl: string;
	apiKey: string;
	pendingConnect: boolean;
	saving: boolean;
}

/** codex device-auth prompt. `pendingConnect` = opened during agent select. */
interface CodexAuthModal {
	url: string;
	code: string;
	pendingConnect: boolean;
	checking: boolean;
}

/**
 * claude OAuth prompt: show the authorize URL, user pastes the returned code.
 * `pendingConnect` = opened during agent select.
 */
interface ClaudeAuthModal {
	url: string;
	code: string;
	pendingConnect: boolean;
	submitting: boolean;
}

// ---- component ------------------------------------------------------------

const transport = new AcpTransport("");
const MANAGED_PI_CONFIG_MESSAGE =
	"Pi is configured by Trustable. Return to the Trustable application list and use Configure to change the endpoint, API key, or model.";

export function ChatApp(): React.ReactElement {
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentId, setAgentId] = useState<string>("");
	const [defaultAgentId, setDefaultAgentId] = useState<string>("");
	const [projectDir, setProjectDir] = useState<string>("");
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [turns, setTurns] = useState<Turn[]>([]);
	const [permission, setPermission] = useState<PendingPermission | null>(null);
	const [input, setInput] = useState("");

	// Session config options (model/mode/…) exposed by the agent after connect.
	const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>(
		[],
	);

	// Gear config / auth popups.
	const [endpointCfg, setEndpointCfg] = useState<EndpointConfigModal | null>(
		null,
	);
	const [codexAuth, setCodexAuth] = useState<CodexAuthModal | null>(null);
	const [claudeAuth, setClaudeAuth] = useState<ClaudeAuthModal | null>(null);

	const sessionRef = useRef<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Load agent catalog. The server's defaultAgentId (pi by default) is
	// preselected and auto-connected below; the pull-down still lets the user
	// switch or fall back to the "Select agent" placeholder.
	const autoSelectedRef = useRef(false);
	useEffect(() => {
		transport
			.getAgents()
			.then((info) => {
				setAgents(info.agents);
				setProjectDir(info.projectDir);
				setDefaultAgentId(info.defaultAgentId);
			})
			.catch((e) => setError(String(e.message ?? e)));
	}, []);

	// Subscribe to the streamed updates once.
	useEffect(() => {
		return transport.onSessionUpdate((u) => applyUpdate(u));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Auto-scroll on new content.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [turns, permission]);

	const applyUpdate = useCallback((u: SessionUpdate) => {
		switch (u.type) {
			case "agent_message_chunk":
				appendAssistant(u.text, "text");
				break;
			case "agent_thought_chunk":
				appendAssistant(u.text, "thoughts");
				break;
			case "tool_call":
				setTurns((prev) => [
					...prev,
					{
						kind: "tool",
						id: u.toolCallId,
						title: u.title ?? "(tool)",
						status: u.status,
					},
				]);
				if (u.permissionRequest && !u.permissionRequest.isCancelled) {
					setPermission({
						requestId: u.permissionRequest.requestId,
						title: u.title ?? "Permission required",
						options: u.permissionRequest.options.map((o) => ({
							optionId: o.optionId,
							name: o.name,
						})),
					});
				}
				break;
			case "tool_call_update":
				setTurns((prev) =>
					prev.map((t) =>
						t.kind === "tool" && t.id === u.toolCallId
							? {
									...t,
									status: u.status ?? t.status,
									title: u.title ?? t.title,
								}
							: t,
					),
				);
				break;
			case "config_option_update":
				setConfigOptions(u.configOptions);
				break;
			case "process_error":
				setError(`${u.error.title}: ${u.error.message}`);
				break;
			default:
				break;
		}
	}, []);

	/** Append streamed text to the trailing assistant turn (create if needed). */
	function appendAssistant(text: string, field: "text" | "thoughts"): void {
		setTurns((prev) => {
			const last = prev[prev.length - 1];
			if (last && last.kind === "assistant") {
				const updated: AssistantTurn = {
					...last,
					[field]: (last[field] as string) + text,
				} as AssistantTurn;
				return [...prev.slice(0, -1), updated];
			}
			return [
				...prev,
				{
					kind: "assistant",
					id: `a-${prev.length}`,
					text: field === "text" ? text : "",
					thoughts: field === "thoughts" ? text : "",
				},
			];
		});
	}

	// Endpoint-config helpers for agents that follow the "hello probe +
	// native-config write" contract (currently pi).
	const endpointHello = useCallback(
		(_agent: "pi") => transport.piHello(),
		[],
	);
	const endpointConfigGet = useCallback(
		(_agent: "pi") => transport.piConfigGet(),
		[],
	);
	const endpointConfigSet = useCallback(
		(_agent: "pi", cfg: { baseUrl: string; apiKey: string }) =>
			transport.piConfigSet(cfg),
		[],
	);

	/** Initialize + open a session for `id`, flipping the chat to ready. */
	const doConnect = useCallback(
		async (id: string) => {
			setError(null);
			setBusy(true);
			try {
				await transport.initialize(id);
				const session = await transport.newSession(id);
				sessionRef.current = session.sessionId;
				// Model/mode selectors come from the session's config options,
				// available immediately after connect.
				setConfigOptions(session.configOptions ?? []);
				setReady(true);
			} catch (e) {
				const msg = String((e as Error).message ?? e);
				// pi with a saved-but-invalid endpoint: reopen config.
				if (
					id === "pi" &&
					/auth|api key|unauthor|invalid|provider/i.test(msg)
				) {
					const agent = id as "pi";
					const hello = await endpointHello(agent).catch(() => null);
					if (hello?.managed) {
						setBusy(false);
						setError(`${MANAGED_PI_CONFIG_MESSAGE} (${msg})`);
						return;
					}
					const cfg = await endpointConfigGet(agent).catch(() => ({}));
					setBusy(false);
					setError(`${agent} connection failed: ${msg}`);
					setEndpointCfg({
						agent,
						baseUrl: cfg.baseUrl ?? "",
						apiKey: cfg.apiKey ?? "",
						pendingConnect: true,
						saving: false,
					});
					return;
				}
				setError(msg);
			} finally {
				setBusy(false);
			}
		},
		[endpointConfigGet, endpointHello],
	);

	/**
	 * Select an agent from the pull-down. The pull-down stays active, so this
	 * also handles switching: prior session/turns are cleared first.
	 *
	 * Before connecting, agents with prerequisites are gated:
	 *  - **claude** needs a login (or ANTHROPIC_API_KEY). If not authenticated,
	 *    the paste-code OAuth popup opens.
	 *  - **pi** must expose its configured model catalog: a hello probe runs
	 *    first; if it fails,
	 *    the endpoint config popup (base URL + API key + model) opens and, on
	 *    save, writes the agent's native config and retries.
	 *  - **codex** needs a ChatGPT login. If `codex login status` reports not
	 *    logged in, the device-auth popup opens and connection waits until the
	 *    user confirms completion.
	 * Selecting the empty placeholder tears the chat back down.
	 */
	const selectAgent = useCallback(
		async (id: string) => {
			setAgentId(id);
			setError(null);
			setPermission(null);
			setTurns([]);
			sessionRef.current = null;
			setReady(false);
			setConfigOptions([]);
			setEndpointCfg(null);
			setCodexAuth(null);
			setClaudeAuth(null);

			if (!id) return; // placeholder — leave chat disabled

			setBusy(true);
			try {
				if (id === "claude") {
					const status = await transport.claudeLoginStatus();
					if (!status.loggedIn) {
						setBusy(false);
						const { url } = await transport.claudeLoginStart();
						setClaudeAuth({
							url,
							code: "",
							pendingConnect: true,
							submitting: false,
						});
						return;
					}
				} else if (id === "pi") {
					// Probe endpoint reachability/auth through /models; avoid a real
					// completion here because cold coding models can stall the UI.
					const agent = id as "pi";
					const hello = await endpointHello(agent);
					if (!hello.ok) {
						// Trustable owns provider credentials in managed mode. Opening
						// TruACP's standalone form would duplicate or expose that secret.
						if (hello.managed) {
							setBusy(false);
							setError(
								`${MANAGED_PI_CONFIG_MESSAGE} (${hello.detail})`,
							);
							return;
						}
						const cfg = await endpointConfigGet(agent).catch(
							() => ({}),
						);
						setBusy(false);
						setEndpointCfg({
							agent,
							baseUrl: cfg.baseUrl ?? "",
							apiKey: cfg.apiKey ?? "",
							pendingConnect: true,
							saving: false,
						});
						return;
					}
				} else if (id === "codex") {
					const status = await transport.codexLoginStatus();
					if (!status.loggedIn) {
						setBusy(false);
						const auth = await transport.codexLoginDevice();
						setCodexAuth({
							url: auth.url,
							code: auth.code,
							pendingConnect: true,
							checking: false,
						});
						return;
					}
				}
			} catch (e) {
				setBusy(false);
				setError(String((e as Error).message ?? e));
				return;
			}

			await doConnect(id);
		},
		[doConnect, endpointHello, endpointConfigGet],
	);

	// Auto-connect to the server's default agent (pi by default) once the agent
	// catalog is loaded, so a new session starts on pi without a manual pick.
	// Runs once; the user can still switch agents afterward.
	useEffect(() => {
		if (autoSelectedRef.current) return;
		if (!defaultAgentId || agents.length === 0) return;
		if (!agents.some((a) => a.id === defaultAgentId)) return;
		autoSelectedRef.current = true;
		void selectAgent(defaultAgentId);
	}, [defaultAgentId, agents, selectAgent]);

	const send = useCallback(async () => {
		const text = input.trim();
		const sessionId = sessionRef.current;
		if (!text || !sessionId) return;
		setInput("");
		setTurns((prev) => [
			...prev,
			{ kind: "user", id: `u-${prev.length}`, text },
		]);
		setBusy(true);
		setError(null);
		try {
			await transport.sendPrompt(sessionId, [{ type: "text", text }]);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [input]);

	const respond = useCallback(
		async (optionId: string) => {
			if (!permission) return;
			const { requestId } = permission;
			setPermission(null);
			try {
				await transport.respondToPermission(requestId, optionId);
			} catch (e) {
				setError(String((e as Error).message ?? e));
			}
		},
		[permission],
	);

	/**
	 * Save the endpoint config (pi models.json), verify with a hello probe,
	 * then connect if the popup was gating one.
	 */
	const saveEndpointConfig = useCallback(async () => {
		if (!endpointCfg) return;
		const { agent, baseUrl, apiKey, pendingConnect } = endpointCfg;
		setEndpointCfg({ ...endpointCfg, saving: true });
		try {
			await endpointConfigSet(agent, {
				baseUrl: baseUrl.trim(),
				apiKey: apiKey.trim(),
			});
			const hello = await endpointHello(agent);
			if (!hello.ok) {
				setError(
					`${agent} did not respond: ${hello.detail || "unknown error"}`,
				);
				setEndpointCfg((c) => (c ? { ...c, saving: false } : c));
				return;
			}
			setEndpointCfg(null);
			if (pendingConnect) await doConnect(agent);
		} catch (e) {
			setError(String((e as Error).message ?? e));
			setEndpointCfg((c) => (c ? { ...c, saving: false } : c));
		}
	}, [endpointCfg, doConnect, endpointConfigSet, endpointHello]);

	/** Re-check codex login after the user completes device-auth in the browser. */
	const confirmCodexLogin = useCallback(async () => {
		if (!codexAuth) return;
		setCodexAuth({ ...codexAuth, checking: true });
		try {
			const status = await transport.codexLoginStatus();
			if (!status.loggedIn) {
				setError(
					"Codex still not logged in — finish the browser sign-in, then retry.",
				);
				setCodexAuth((c) => (c ? { ...c, checking: false } : c));
				return;
			}
			const pending = codexAuth.pendingConnect;
			setCodexAuth(null);
			if (pending) await doConnect("codex");
		} catch (e) {
			setError(String((e as Error).message ?? e));
			setCodexAuth((c) => (c ? { ...c, checking: false } : c));
		}
	}, [codexAuth, doConnect]);

	/** Submit the pasted claude code; connect if the popup was gating one. */
	const submitClaudeCode = useCallback(async () => {
		if (!claudeAuth || !claudeAuth.code.trim()) return;
		setClaudeAuth({ ...claudeAuth, submitting: true });
		try {
			const status = await transport.claudeLoginComplete(
				claudeAuth.code,
			);
			if (!status.loggedIn) {
				setError(
					status.detail === "Invalid code"
						? "Invalid code — copy the full code and try again."
						: "Claude login not completed — try again.",
				);
				setClaudeAuth((c) =>
					c ? { ...c, submitting: false, code: "" } : c,
				);
				return;
			}
			const pending = claudeAuth.pendingConnect;
			setClaudeAuth(null);
			if (pending) await doConnect("claude");
		} catch (e) {
			setError(String((e as Error).message ?? e));
			setClaudeAuth((c) => (c ? { ...c, submitting: false } : c));
		}
	}, [claudeAuth, doConnect]);

	/**
	 * Gear action: reconfigure/re-authenticate the current agent WITHOUT
	 * reconnecting (pendingConnect=false). pi reopens the endpoint form
	 * (base URL + API key); codex/claude restart their login flow.
	 */
	const openConfig = useCallback(async () => {
		setError(null);
		try {
			if (agentId === "pi") {
				const agent = agentId as "pi";
				const hello = await endpointHello(agent);
				if (hello.managed) {
					setError(MANAGED_PI_CONFIG_MESSAGE);
					return;
				}
				const cfg = await endpointConfigGet(agent).catch(() => ({}));
				setEndpointCfg({
					agent,
					baseUrl: cfg.baseUrl ?? "",
					apiKey: cfg.apiKey ?? "",
					pendingConnect: false,
					saving: false,
				});
			} else if (agentId === "codex") {
				const auth = await transport.codexLoginDevice();
				setCodexAuth({
					url: auth.url,
					code: auth.code,
					pendingConnect: false,
					checking: false,
				});
			} else if (agentId === "claude") {
				const { url } = await transport.claudeLoginStart();
				setClaudeAuth({
					url,
					code: "",
					pendingConnect: false,
					submitting: false,
				});
			}
		} catch (e) {
			setError(String((e as Error).message ?? e));
		}
	}, [agentId, endpointConfigGet, endpointHello]);

	const agentName = useMemo(
		() => agents.find((a) => a.id === agentId)?.displayName ?? agentId,
		[agents, agentId],
	);

	// The model config option (a `select` of category/id "model"), if the agent
	// exposes one. Drives the header model dropdown.
	const modelOption = useMemo(() => {
		const opt = configOptions.find(
			(o) =>
				o.type === "select" &&
				(o.category === "model" || o.id === "model"),
		);
		return opt && opt.type === "select" ? opt : null;
	}, [configOptions]);

	// pi-acp advertises Pi's full built-in catalog even when settings.json scopes
	// the active local/ollama/trustable provider. Mirror that exact prefix here
	// so stale or built-in providers cannot be selected from the managed UI.
	const modelChoices = useMemo(
		() => managedModelChoices(modelOption),
		[modelOption],
	);

	/** Set the model via the ACP config-option API; refresh options from result. */
	const setModel = useCallback(
		async (value: string) => {
			const sessionId = sessionRef.current;
			if (!sessionId || !modelOption) return;
			try {
				const updated = await transport.setSessionConfigOption(
					sessionId,
					modelOption.id,
					value,
				);
				setConfigOptions(updated);
			} catch (e) {
				setError(String((e as Error).message ?? e));
			}
		},
		[modelOption],
	);

	return (
		<div className="app">
			<header className="topbar">
				{/* Agent pull-down stays active so the agent can be switched at
				    any time; changing it reconnects to the new agent. */}
				<select
					value={agentId}
					disabled={busy}
					onChange={(e) => void selectAgent(e.target.value)}
				>
					<option value="">Select agent</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>
							{a.displayName}
						</option>
					))}
				</select>
				{busy ? (
					<span className="status">Connecting…</span>
				) : ready ? (
					<span className="status">● {agentName}</span>
				) : null}
				{/* Model selector (config options exposed after connect). */}
				{ready && modelOption && modelChoices.length > 0 && (
					<select
						className="model-select"
						title="Model"
						value={modelOption.currentValue}
						disabled={busy}
						onChange={(e) => void setModel(e.target.value)}
					>
						{modelChoices.map((o) => (
							<option key={o.value} value={o.value}>
								{o.name}
							</option>
						))}
					</select>
				)}
				{/* Gear: reconfigure endpoint (pi) or renew login
				    (codex/claude) for the selected agent. */}
				{(agentId === "pi" ||
					agentId === "codex" ||
					agentId === "claude") && (
					<button
						className="gear"
						title={
							agentId === "codex" || agentId === "claude"
								? "Renew login"
								: "Reconfigure endpoint"
						}
						disabled={busy}
						onClick={() => void openConfig()}
					>
						⚙
					</button>
				)}
				<span className="cwd" title={projectDir}>
					{projectDir}
				</span>
			</header>

			{error && (
				<div className="error" onClick={() => setError(null)}>
					{error}
				</div>
			)}

			{endpointCfg && (
				<div
					className="modal-backdrop"
					onClick={() => setEndpointCfg(null)}
				>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<div className="modal-title">
							Configure Pi
						</div>
						<p className="modal-desc">
							Couldn't connect. Enter an OpenAI-compatible endpoint:
							server base URL and API key.
						</p>
						<label className="modal-field">
							<span>Base URL</span>
							<input
								type="text"
								placeholder="https://api.openai.com/v1"
								value={endpointCfg.baseUrl}
								onChange={(e) =>
									setEndpointCfg({
										...endpointCfg,
										baseUrl: e.target.value,
									})
								}
							/>
						</label>
						<label className="modal-field">
							<span>API Key</span>
							<input
								type="password"
								placeholder="sk-…"
								value={endpointCfg.apiKey}
								onChange={(e) =>
									setEndpointCfg({
										...endpointCfg,
										apiKey: e.target.value,
									})
								}
							/>
						</label>
						<div className="modal-actions">
							<button
								className="secondary"
								onClick={() => setEndpointCfg(null)}
							>
								Cancel
							</button>
							<button
								onClick={() => void saveEndpointConfig()}
								disabled={
									endpointCfg.saving ||
									!endpointCfg.baseUrl.trim() ||
									!endpointCfg.apiKey.trim()
								}
							>
								{endpointCfg.saving
									? "Testing…"
									: endpointCfg.pendingConnect
										? "Save & Connect"
										: "Save"}
							</button>
						</div>
					</div>
				</div>
			)}

			{codexAuth && (
				<div className="modal-backdrop" onClick={() => setCodexAuth(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<div className="modal-title">Sign in to Codex</div>
						<p className="modal-desc">
							Open this URL and enter the one-time code to
							authenticate with ChatGPT:
						</p>
						<div className="modal-field">
							<span>URL</span>
							<a
								href={codexAuth.url}
								target="_blank"
								rel="noreferrer"
							>
								{codexAuth.url}
							</a>
						</div>
						<div className="modal-field">
							<span>Code</span>
							<code className="auth-code">{codexAuth.code}</code>
						</div>
						<div className="modal-actions">
							<button
								className="secondary"
								onClick={() => setCodexAuth(null)}
							>
								Cancel
							</button>
							<button
								onClick={() => void confirmCodexLogin()}
								disabled={codexAuth.checking}
							>
								{codexAuth.checking ? "Checking…" : "Ho completato"}
							</button>
						</div>
					</div>
				</div>
			)}

			{claudeAuth && (
				<div
					className="modal-backdrop"
					onClick={() => setClaudeAuth(null)}
				>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<div className="modal-title">Sign in to Claude</div>
						<p className="modal-desc">
							Open this URL, sign in, then paste the code shown by
							the browser:
						</p>
						<div className="modal-field">
							<span>URL</span>
							<a
								href={claudeAuth.url}
								target="_blank"
								rel="noreferrer"
							>
								{claudeAuth.url}
							</a>
						</div>
						<label className="modal-field">
							<span>Code</span>
							<input
								type="text"
								placeholder="Paste code here"
								value={claudeAuth.code}
								autoFocus
								onChange={(e) =>
									setClaudeAuth({
										...claudeAuth,
										code: e.target.value,
									})
								}
								onKeyDown={(e) => {
									if (e.key === "Enter")
										void submitClaudeCode();
								}}
							/>
						</label>
						<div className="modal-actions">
							<button
								className="secondary"
								onClick={() => setClaudeAuth(null)}
							>
								Cancel
							</button>
							<button
								onClick={() => void submitClaudeCode()}
								disabled={
									claudeAuth.submitting ||
									!claudeAuth.code.trim()
								}
							>
								{claudeAuth.submitting
									? "Signing in…"
									: "Complete"}
							</button>
						</div>
					</div>
				</div>
			)}

			<div className="messages" ref={scrollRef}>
				{turns.map((t) => (
					<TurnView key={t.id} turn={t} />
				))}
				{permission && (
					<div className="permission">
						<div className="perm-title">🔐 {permission.title}</div>
						<div className="perm-options">
							{permission.options.map((o) => (
								<button
									key={o.optionId}
									onClick={() => respond(o.optionId)}
								>
									{o.name}
								</button>
							))}
						</div>
					</div>
				)}
				{!ready && !busy && turns.length === 0 && (
					<div className="empty">Please Select Agent</div>
				)}
				{ready && turns.length === 0 && (
					<div className="empty">
						Connected to {agentName}. Send a message to start.
					</div>
				)}
			</div>

			<footer className="composer">
				<textarea
					value={input}
					placeholder={
						ready ? "Message the agent…" : "Please Select Agent"
					}
					disabled={!ready}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<button onClick={() => void send()} disabled={!ready || !input.trim()}>
					Send
				</button>
			</footer>
		</div>
	);
}

// ---- turn rendering -------------------------------------------------------

function TurnView({ turn }: { turn: Turn }): React.ReactElement | null {
	if (turn.kind === "user") {
		return (
			<div className="turn user">
				<div className="bubble">{turn.text}</div>
			</div>
		);
	}
	if (turn.kind === "assistant") {
		return (
			<div className="turn assistant">
				{turn.thoughts && (
					<details className="thoughts">
						<summary>Reasoning</summary>
						<div className="thought-body">{turn.thoughts}</div>
					</details>
				)}
				{turn.text && (
					<div className="bubble markdown">
						<ReactMarkdown remarkPlugins={[remarkGfm]}>
							{turn.text}
						</ReactMarkdown>
					</div>
				)}
			</div>
		);
	}
	// tool
	return (
		<div className={`turn tool status-${turn.status}`}>
			<span className="tool-icon">🛠</span>
			<span className="tool-title">{turn.title}</span>
			<span className="tool-status">{turn.status}</span>
		</div>
	);
}
