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
import type {
	SessionUpdate,
	SessionConfigOption,
	SessionInfo,
} from "../src/types/session";
import { AcpTransport, type AgentInfo } from "./transport";
import { modelChoicesForAgent } from "./model-options";
import { copyText } from "./clipboard";
import {
	createPromptHistoryCursor,
	navigatePromptHistory,
} from "./prompt-history";
import {
	applyManagedSessionConfig,
	managedReasoningConfig,
	readReasoningPreference,
	writeReasoningPreference,
	type ManagedReasoningEffort,
} from "./session-config";
import type {
	NotebookIndexEntry,
	NotebookIndexResponse,
	NotebookNode,
	NotebookSessionState,
} from "../src/types/notebook";
import {
	advanceNotebookSelection,
	insertAdHocNode,
	notebookPromptsForSave,
	pinNotebookNode,
	removeNotebookNode,
} from "../src/services/notebook";
import { NotebookPanel } from "./NotebookPanel";
import { NotebookNodeView } from "./NotebookNodeView";
import {
	classifyComposerSubmission,
	formatShellFailure,
	formatShellResult,
	READY_COMPOSER_PLACEHOLDER,
} from "./shell-command";
import { headerConnectionState } from "./connection-status";
import { isChatNearBottom } from "./chat-scroll";
import { HeaderActionButton } from "./HeaderActionButton";
import { toolStatusPresentation } from "./tool-status";

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
interface ShellTurn {
	kind: "shell";
	id: string;
	text: string;
}
type Turn = UserTurn | AssistantTurn | ToolTurn | ShellTurn;

interface PendingPermission {
	requestId: string;
	title: string;
	options: { optionId: string; name: string }[];
}

interface ActivityState {
	state: string;
	label: string;
	active: boolean;
	timestamp: string;
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

function browserPreferenceStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

let localId = 0;

function nextId(prefix: string): string {
	localId += 1;
	return `${prefix}-${Date.now()}-${localId}`;
}

/**
 * ACP adapters do not all emit the same runtime shape for optional tool
 * display metadata. Keep malformed metadata out of React and the notebook
 * sidecar without discarding the structural tool-call event.
 */
function toolDisplayText(
	value: unknown,
	fallback: string,
	max: number,
): string {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	return value.slice(0, max);
}

function nodesFromPrompts(prompts: string[]): NotebookNode[] {
	return prompts.map((prompt) => ({
		id: nextId("notebook"),
		kind: "notebook",
		prompt,
		outputs: [],
	}));
}

export function ChatApp(): React.ReactElement {
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentId, setAgentId] = useState<string>("");
	const [defaultAgentId, setDefaultAgentId] = useState<string>("");
	const [projectDir, setProjectDir] = useState<string>("");
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [running, setRunning] = useState(false);
	const [shellRunning, setShellRunning] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [activity, setActivity] = useState<ActivityState | null>(null);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [turns, setTurns] = useState<Turn[]>([]);
	const [permission, setPermission] = useState<PendingPermission | null>(
		null,
	);
	const [input, setInput] = useState("");
	const [piManaged, setPiManaged] = useState<boolean | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [deleteCandidate, setDeleteCandidate] = useState<SessionInfo | null>(
		null,
	);
	const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
		null,
	);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [notebookPanelOpen, setNotebookPanelOpen] = useState(false);
	const [notebookIndex, setNotebookIndex] =
		useState<NotebookIndexResponse | null>(null);
	const [notebook, setNotebook] = useState<NotebookSessionState | null>(null);
	const [notebookBusy, setNotebookBusy] = useState(false);
	const [editingNotebookNode, setEditingNotebookNode] = useState<string | null>(
		null,
	);

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
	const configReconcileRef = useRef(false);
	const activityStartedAtRef = useRef<number | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const followOutputRef = useRef(true);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const promptHistoryRef = useRef(createPromptHistoryCursor());
	const connectionState = headerConnectionState(ready, busy);

	const userPrompts = useMemo(
		() =>
			turns
				.filter((turn): turn is UserTurn => turn.kind === "user")
				.map((turn) => turn.text)
				.filter((text) => text.trim() !== ""),
		[turns],
	);

	const resetPromptHistory = useCallback((draft = "") => {
		promptHistoryRef.current = createPromptHistoryCursor(draft);
	}, []);

	const handleComposerChange = useCallback(
		(value: string) => {
			// WHY: editing a recalled prompt starts a new draft. Continuing to
			// treat it as a historical entry would make the next arrow key jump
			// unpredictably and could discard what the user just changed.
			resetPromptHistory(value);
			setInput(value);
		},
		[resetPromptHistory],
	);
	const activeNotebookNodeRef = useRef<string | null>(null);
	const activeNotebookOutputRef = useRef<string | null>(null);

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

	const handleChatScroll = useCallback(() => {
		const el = scrollRef.current;
		if (el) followOutputRef.current = isChatNearBottom(el);
	}, []);

	// Follow streamed output only while the reader remains near the bottom.
	// Scrolling upward pauses the follow mode until they return there.
	useEffect(() => {
		const el = scrollRef.current;
		if (el && followOutputRef.current) el.scrollTop = el.scrollHeight;
	}, [turns, permission, notebook]);

	// WHY: provider silence is normal during long reasoning. A local elapsed
	// clock proves the request is still active without inventing a completion
	// percentage or adding heartbeat text to the transcript.
	useEffect(() => {
		if (!running) {
			activityStartedAtRef.current = null;
			setElapsedSeconds(0);
			return;
		}
		if (activityStartedAtRef.current === null) {
			activityStartedAtRef.current = Date.now();
		}
		const updateElapsed = () =>
			setElapsedSeconds(
				Math.max(
					0,
					Math.floor(
						(Date.now() -
							(activityStartedAtRef.current ?? Date.now())) /
							1000,
					),
				),
			);
		updateElapsed();
		const timer = window.setInterval(updateElapsed, 1000);
		return () => window.clearInterval(timer);
	}, [running]);

	const applyUpdate = useCallback((u: SessionUpdate) => {
		const notebookNodeId = activeNotebookNodeRef.current;
		switch (u.type) {
			case "agent_message_chunk":
				if (notebookNodeId) {
					appendNotebookAssistant(notebookNodeId, u.text, "text");
				} else {
					appendAssistant(u.text, "text");
				}
				break;
			case "agent_thought_chunk":
				if (notebookNodeId) {
					appendNotebookAssistant(notebookNodeId, u.text, "thoughts");
				} else {
					appendAssistant(u.text, "thoughts");
				}
				break;
			case "tool_call":
				if (notebookNodeId) {
					setNotebook((state) =>
						state
							? {
									...state,
									nodes: state.nodes.map((node) =>
										node.id === notebookNodeId
											? {
													...node,
													outputs: [
														...node.outputs,
														{
															kind: "tool",
															id: u.toolCallId,
															title: toolDisplayText(
																u.title,
																"(tool)",
																2_000,
															),
															status: toolDisplayText(
																u.status,
																"unknown",
																200,
															),
														},
													],
												}
											: node,
									),
								}
							: state,
					);
				} else {
					setTurns((prev) => [
						...prev,
						{
							kind: "tool",
							id: u.toolCallId,
							title: toolDisplayText(u.title, "(tool)", 2_000),
							status: toolDisplayText(u.status, "unknown", 200),
						},
					]);
				}
				if (u.permissionRequest && !u.permissionRequest.isCancelled) {
					setPermission({
						requestId: u.permissionRequest.requestId,
						title: toolDisplayText(
							u.title,
							"Permission required",
							2_000,
						),
						options: u.permissionRequest.options.map((o) => ({
							optionId: o.optionId,
							name: o.name,
						})),
					});
				}
				break;
			case "tool_call_update":
				setNotebook((state) =>
					state
						? {
								...state,
								nodes: state.nodes.map((node) => ({
									...node,
									outputs: node.outputs.map((output) =>
										output.kind === "tool" &&
										output.id === u.toolCallId
											? {
													...output,
													status:
														u.status == null
															? output.status
															: toolDisplayText(
																	u.status,
																	"unknown",
																	200,
																),
													title:
														u.title == null
															? output.title
															: toolDisplayText(
																	u.title,
																	"(tool)",
																	2_000,
																),
												}
											: output,
									),
								})),
							}
						: state,
				);
				setTurns((prev) =>
					prev.map((t) =>
						t.kind === "tool" && t.id === u.toolCallId
							? {
									...t,
									status:
										u.status == null
											? t.status
											: toolDisplayText(
													u.status,
													"unknown",
													200,
												),
									title:
										u.title == null
											? t.title
											: toolDisplayText(
													u.title,
													"(tool)",
													2_000,
												),
								}
							: t,
					),
				);
				break;
			case "config_option_update":
				setConfigOptions(u.configOptions);
				break;
			case "session_info_update":
				if (u.activity) {
					setActivity(u.activity);
					setRunning(u.activity.active);
					if (!u.activity.active) setStopping(false);
				}
				break;
			case "process_error":
				setError(`${u.error.title}: ${u.error.message}`);
				setRunning(false);
				setStopping(false);
				break;
			default:
				break;
		}
	}, []);

	function appendNotebookAssistant(
		nodeId: string,
		value: string,
		field: "text" | "thoughts",
	): void {
		const outputId = activeNotebookOutputRef.current;
		if (!outputId) return;
		setNotebook((state) =>
			state
				? {
						...state,
						nodes: state.nodes.map((node) =>
							node.id === nodeId
								? {
										...node,
										outputs: node.outputs.map((output) =>
											output.kind === "assistant" &&
											output.id === outputId
												? {
														...output,
														[field]: output[field] + value,
													}
												: output,
										),
									}
								: node,
						),
					}
				: state,
		);
	}

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

	/**
	 * Apply managed config before exposing a session as ready. The ACP adapter
	 * remains the capability source: this path uses its real config ids and
	 * verifies returned state instead of writing provider-specific config files.
	 */
	const configureSession = useCallback(
		async (
			id: string,
			sessionId: string,
			options: SessionConfigOption[],
		): Promise<SessionConfigOption[]> => {
			const result = await applyManagedSessionConfig({
				agentId: id,
				configOptions: options,
				savedReasoningEffort: readReasoningPreference(
					id,
					browserPreferenceStorage(),
				),
				setConfigOption: (configId, value) =>
					transport.setSessionConfigOption(
						sessionId,
						configId,
						value,
					),
			});
			if (result.reasoningEffort) {
				writeReasoningPreference(
					id,
					result.reasoningEffort,
					browserPreferenceStorage(),
				);
			}
			return result.configOptions;
		},
		[],
	);

	useEffect(() => {
		const sessionId = sessionRef.current;
		if (
			!ready ||
			busy ||
			running ||
			!agentId ||
			!sessionId ||
			configReconcileRef.current
		) {
			return;
		}

		// WHY: adapters can publish model/config changes independently of the
		// dropdown response (for example after a slash command). Reconcile those
		// updates once the active turn is idle so unsupported xhigh or a reverted
		// read-only mode never remains as silently inconsistent UI state.
		configReconcileRef.current = true;
		void configureSession(agentId, sessionId, configOptions)
			.then((updated) => setConfigOptions(updated))
			.catch((cause: unknown) =>
				setError(String((cause as Error).message ?? cause)),
			)
			.finally(() => {
				configReconcileRef.current = false;
			});
	}, [agentId, busy, configOptions, configureSession, ready, running]);

	/** Initialize + open a session for `id`, flipping the chat to ready. */
	const doConnect = useCallback(
		async (id: string) => {
			setError(null);
			setBusy(true);
			try {
				await transport.initialize(id);
				const session = await transport.newSession(id);
				const configured = await configureSession(
					id,
					session.sessionId,
					session.configOptions ?? [],
				);
				sessionRef.current = session.sessionId;
				setConfigOptions(configured);
				setNotebook(
					await transport
						.loadNotebookSession(session.sessionId)
						.catch(() => null),
				);
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
					setPiManaged(hello?.managed ?? null);
					if (hello?.managed) {
						setBusy(false);
						setError(`${MANAGED_PI_CONFIG_MESSAGE} (${msg})`);
						return;
					}
					const cfg = await endpointConfigGet(agent).catch(() => ({
						baseUrl: undefined,
						apiKey: undefined,
						model: undefined,
					}));
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
		[configureSession, endpointConfigGet, endpointHello],
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
			setNotebook(null);
			setEditingNotebookNode(null);
			sessionRef.current = null;
			setReady(false);
			setConfigOptions([]);
			setRunning(false);
			setStopping(false);
			setActivity(null);
			setEndpointCfg(null);
			setCodexAuth(null);
			setClaudeAuth(null);
			setPiManaged(null);
			setInput("");
			resetPromptHistory();

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
					setPiManaged(hello.managed);
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
							() => ({
								baseUrl: undefined,
								apiKey: undefined,
								model: undefined,
							}),
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
		[doConnect, endpointHello, endpointConfigGet, resetPromptHistory],
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

	const executeNotebookNode = useCallback(
		async (nodeId: string, prompt: string, advance: boolean) => {
			const sessionId = sessionRef.current;
			if (!sessionId || busy) return;
			const outputId = nextId("notebook-output");
			activeNotebookNodeRef.current = nodeId;
			activeNotebookOutputRef.current = outputId;
			setNotebook((state) =>
				state
					? {
							...state,
							nodes: state.nodes.map((node) =>
								node.id === nodeId
									? {
											...node,
											outputs: [
												...node.outputs,
												{
													kind: "assistant",
													id: outputId,
													text: "",
													thoughts: "",
												},
											],
										}
									: node,
							),
						}
					: state,
			);
			setBusy(true);
			setError(null);
			try {
				await transport.sendPrompt(sessionId, [
					{ type: "text", text: prompt },
				]);
				if (advance) {
					setNotebook((state) =>
						state
							? {
									...state,
									selectedNodeId: advanceNotebookSelection(
										state.nodes,
										nodeId,
									),
								}
							: state,
					);
				}
			} catch (e) {
				setError(String((e as Error).message ?? e));
			} finally {
				activeNotebookNodeRef.current = null;
				activeNotebookOutputRef.current = null;
				setBusy(false);
			}
		},
		[busy],
	);

	const send = useCallback(async () => {
		const submission = classifyComposerSubmission(input);
		const text = submission.display;
		const sessionId = sessionRef.current;
		if (!text || !sessionId || running) return;
		setInput("");
		resetPromptHistory();
		if (notebook) {
			if (editingNotebookNode) {
				const node = notebook.nodes.find(
					(candidate) => candidate.id === editingNotebookNode,
				);
				if (!node) {
					setEditingNotebookNode(null);
					return;
				}
				setNotebook((state) =>
					state
						? {
								...state,
								dirty: true,
								nodes: state.nodes.map((candidate) =>
									candidate.id === editingNotebookNode
										? { ...candidate, prompt: text }
										: candidate,
								),
							}
						: state,
				);
				setEditingNotebookNode(null);
				await executeNotebookNode(node.id, text, true);
				return;
			}
			const inputNode: NotebookNode = {
				id: nextId("input"),
				kind: "input",
				prompt: text,
				outputs: [],
			};
			setNotebook((state) =>
				state
					? {
							...state,
							nodes: insertAdHocNode(
								state.nodes,
								inputNode,
								state.selectedNodeId,
							),
						}
					: state,
			);
			await executeNotebookNode(inputNode.id, text, false);
			return;
		}
		setTurns((prev) => [
			...prev,
			{ kind: "user", id: `u-${prev.length}`, text },
		]);
		setRunning(true);
		setShellRunning(submission.kind === "shell");
		setActivity({
			state: submission.kind === "shell" ? "shell" : "thinking",
			label:
				submission.kind === "shell" ? "Running shell command" : "Thinking",
			active: true,
			timestamp: new Date().toISOString(),
		});
		setError(null);
		try {
			// WHY: a leading `!` is an explicit user shell action, not agent
			// context. Keeping it off sendPrompt prevents model/tool interception
			// and preserves the ordinary ACP path for every non-shell submission.
			if (submission.kind === "shell") {
				const result = await transport.executeShell(
					sessionId,
					submission.command,
				);
				setTurns((prev) => [
					...prev,
					{
						kind: "shell",
						id: `s-${Date.now()}-${prev.length}`,
						text: formatShellResult(submission.command, result),
					},
				]);
			} else {
				await transport.sendPrompt(sessionId, [
					{ type: "text", text: submission.prompt },
				]);
			}
		} catch (e) {
			const message = String((e as Error).message ?? e);
			if (submission.kind === "shell") {
				setTurns((prev) => [
					...prev,
					{
						kind: "shell",
						id: `s-${Date.now()}-${prev.length}`,
						text: formatShellFailure(submission.command, message),
					},
				]);
			} else {
				setError(message);
			}
		} finally {
			setRunning(false);
			setShellRunning(false);
			setStopping(false);
			setActivity({
				state: "idle",
				label: "Idle",
				active: false,
				timestamp: new Date().toISOString(),
			});
		}
	}, [
		input,
		resetPromptHistory,
		running,
		notebook,
		editingNotebookNode,
		executeNotebookNode,
	]);

	const navigateComposerHistory = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (
				(e.key !== "ArrowUp" && e.key !== "ArrowDown") ||
				e.nativeEvent.isComposing ||
				e.altKey ||
				e.ctrlKey ||
				e.metaKey ||
				e.shiftKey
			) {
				return false;
			}

			const textarea = e.currentTarget;
			if (textarea.selectionStart !== textarea.selectionEnd) return false;

			const inHistory = promptHistoryRef.current.index !== -1;
			if (
				e.key === "ArrowUp" &&
				!inHistory &&
				input !== "" &&
				textarea.selectionStart !== 0
			) {
				// WHY: a non-empty multiline composer keeps native cursor
				// movement. History starts from an empty composer or the first
				// character, then owns Up/Down until the draft is restored.
				return false;
			}
			if (e.key === "ArrowDown" && !inHistory) return false;

			const result = navigatePromptHistory(
				userPrompts,
				input,
				promptHistoryRef.current,
				e.key === "ArrowUp" ? "older" : "newer",
			);
			if (!result.handled) return false;

			e.preventDefault();
			promptHistoryRef.current = result.cursor;
			setInput(result.value);
			window.requestAnimationFrame(() => {
				const current = textareaRef.current;
				if (!current) return;
				current.focus();
				current.setSelectionRange(
					result.value.length,
					result.value.length,
				);
			});
			return true;
		},
		[input, userPrompts],
	);

	const stop = useCallback(async () => {
		const sessionId = sessionRef.current;
		if (!sessionId || !running || stopping) return;
		setStopping(true);
		setActivity({
			state: "stopping",
			label: "Stopping",
			active: true,
			timestamp: new Date().toISOString(),
		});
		try {
			await transport.cancel(sessionId);
		} catch (e) {
			setStopping(false);
			setError(`Stop failed: ${String((e as Error).message ?? e)}`);
		}
	}, [running, stopping]);

	const newChat = useCallback(async () => {
		if (!agentId || busy || running) return;
		setBusy(true);
		setError(null);
		try {
			const session = await transport.newSession(agentId, projectDir);
			const configured = await configureSession(
				agentId,
				session.sessionId,
				session.configOptions ?? [],
			);
			sessionRef.current = session.sessionId;
			setNotebook(null);
			setTurns([]);
			setPermission(null);
			setConfigOptions(configured);
			setActivity(null);
			setInput("");
			resetPromptHistory();
			setReady(true);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [
		agentId,
		busy,
		configureSession,
		projectDir,
		resetPromptHistory,
		running,
	]);

	const openHistory = useCallback(async () => {
		if (!agentId || !ready || running) return;
		setHistoryOpen(true);
		setHistoryLoading(true);
		setDeleteCandidate(null);
		setHistoryError(null);
		setError(null);
		try {
			const result = await transport.listSessions(agentId, projectDir);
			setSessions(result.sessions);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setHistoryLoading(false);
		}
	}, [agentId, projectDir, ready, running]);

	const closeHistory = useCallback(() => {
		if (deletingSessionId) return;
		setHistoryOpen(false);
		setDeleteCandidate(null);
		setHistoryError(null);
	}, [deletingSessionId]);

	const deleteHistorySession = useCallback(async () => {
		if (!agentId || !deleteCandidate || deletingSessionId || running)
			return;
		const sessionId = deleteCandidate.sessionId;
		if (sessionRef.current === sessionId) {
			setHistoryError(
				"Start a new session before deleting the active session.",
			);
			return;
		}

		setDeletingSessionId(sessionId);
		setHistoryError(null);
		try {
			// WHY: delete through the agent-owned ACP session API first. The
			// server removes TruACP's secondary index only after Pi succeeds.
			await transport.deleteAgentSession(agentId, sessionId);
			setSessions((current) =>
				current.filter((session) => session.sessionId !== sessionId),
			);
			setDeleteCandidate(null);
		} catch (e) {
			setHistoryError(String((e as Error).message ?? e));
		} finally {
			setDeletingSessionId(null);
		}
	}, [agentId, deleteCandidate, deletingSessionId, running]);

	const loadHistorySession = useCallback(
		async (selected: SessionInfo) => {
			if (!agentId || running) return;
			setHistoryOpen(false);
			setDeleteCandidate(null);
			setHistoryError(null);
			setBusy(true);
			setTurns([]);
			setPermission(null);
			setError(null);
			setInput("");
			resetPromptHistory();
			try {
				const session = await transport.loadSession(
					agentId,
					selected.sessionId,
					selected.cwd,
				);
				const configured = await configureSession(
					agentId,
					session.sessionId,
					session.configOptions ?? [],
				);
				sessionRef.current = session.sessionId;
				setNotebook(
					await transport
						.loadNotebookSession(session.sessionId)
						.catch(() => null),
				);
				setConfigOptions(configured);
				setReady(true);
			} catch (e) {
				setError(String((e as Error).message ?? e));
			} finally {
				setBusy(false);
			}
		},
		[agentId, configureSession, resetPromptHistory, running],
	);


	// Persist notebook workflow state as a server-side session sidecar. It
	// contains prompts and execution output, never NOTEBOOK_GITHUB_TOKEN.
	useEffect(() => {
		const sessionId = sessionRef.current;
		if (!sessionId || !notebook) return;
		const timer = window.setTimeout(() => {
			void transport
				.saveNotebookSession(sessionId, notebook)
				.catch((e) => setError(String((e as Error).message ?? e)));
		}, 150);
		return () => window.clearTimeout(timer);
	}, [notebook]);

	const refreshNotebookIndex = useCallback(async () => {
		setNotebookBusy(true);
		setError(null);
		try {
			const index = await transport.listNotebooks();
			setNotebookIndex(index);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setNotebookBusy(false);
		}
	}, []);

	const openNotebookPanel = useCallback(() => {
		setNotebookPanelOpen(true);
		if (!notebookIndex) void refreshNotebookIndex();
	}, [notebookIndex, refreshNotebookIndex]);

	const loadNotebook = useCallback(
		async (entry: NotebookIndexEntry) => {
			if (!notebookIndex) return;
			setNotebookBusy(true);
			setError(null);
			try {
				const document = await transport.loadNotebook(
					notebookIndex,
					entry,
				);
				const nodes = nodesFromPrompts(document.prompts);
				setNotebook({
					version: 1,
					source: document.source,
					notebookName: document.name,
					path: document.path,
					fileSha: document.sha,
					readmeSha: document.readmeSha,
					nodes,
					selectedNodeId: nodes[0]?.id ?? null,
					dirty: false,
				});
				setEditingNotebookNode(null);
			} catch (e) {
				setError(String((e as Error).message ?? e));
			} finally {
				setNotebookBusy(false);
			}
		},
		[notebookIndex],
	);

	const saveNotebook = useCallback(async () => {
		if (!notebook) return;
		setNotebookBusy(true);
		setError(null);
		try {
			const saved = await transport.saveNotebook(
				notebook,
				notebookPromptsForSave(notebook.nodes),
			);
			setNotebook((state) =>
				state
					? { ...state, fileSha: saved.sha, dirty: false }
					: state,
			);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setNotebookBusy(false);
		}
	}, [notebook]);

	const addNotebook = useCallback(
		async (name: string, path: string) => {
			if (!notebookIndex) return;
			setNotebookBusy(true);
			setError(null);
			try {
				const result = await transport.addNotebook(
					notebookIndex,
					name,
					path,
				);
				setNotebookIndex(result.index);
				if (result.notebook) {
					const nodes = nodesFromPrompts(result.notebook.prompts);
					setNotebook({
						version: 1,
						source: result.notebook.source,
						notebookName: result.notebook.name,
						path: result.notebook.path,
						fileSha: result.notebook.sha,
						readmeSha: result.notebook.readmeSha,
						nodes,
						selectedNodeId: nodes[0]?.id ?? null,
						dirty: false,
					});
				}
			} catch (e) {
				setError(String((e as Error).message ?? e));
			} finally {
				setNotebookBusy(false);
			}
		},
		[notebookIndex],
	);

	const removeRemoteNotebook = useCallback(
		async (entry: NotebookIndexEntry) => {
			if (!notebookIndex) return;
			if (!window.confirm(`Remove notebook "${entry.name}" from GitHub?`)) {
				return;
			}
			setNotebookBusy(true);
			setError(null);
			try {
				const result = await transport.removeNotebook(
					notebookIndex,
					entry,
				);
				setNotebookIndex(result.index);
				if (notebook?.path === entry.path) {
					setNotebook(null);
					setEditingNotebookNode(null);
				}
			} catch (e) {
				setError(String((e as Error).message ?? e));
			} finally {
				setNotebookBusy(false);
			}
		},
		[notebookIndex, notebook],
	);

	const runNextNotebookNode = useCallback(() => {
		if (!notebook?.selectedNodeId) return;
		const node = notebook.nodes.find(
			(candidate) => candidate.id === notebook.selectedNodeId,
		);
		if (node?.kind === "notebook") {
			void executeNotebookNode(node.id, node.prompt, true);
		}
	}, [notebook, executeNotebookNode]);

	const editNotebookNode = useCallback(
		(node: NotebookNode) => {
			setNotebook((state) =>
				state ? { ...state, selectedNodeId: node.id } : state,
			);
			setEditingNotebookNode(node.id);
			setInput(node.prompt);
		},
		[],
	);

	const pinNode = useCallback((nodeId: string) => {
		setNotebook((state) =>
			state
				? {
						...state,
						nodes: pinNotebookNode(state.nodes, nodeId),
						dirty: true,
					}
				: state,
		);
	}, []);

	const removeNode = useCallback((node: NotebookNode) => {
		setNotebook((state) => {
			if (!state) return state;
			const removed = removeNotebookNode(
				state.nodes,
				node.id,
				state.selectedNodeId,
			);
			return {
				...state,
				...removed,
				dirty: state.dirty || node.kind === "notebook",
			};
		});
		setEditingNotebookNode((current) =>
			current === node.id ? null : current,
		);
	}, []);

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
			setPiManaged(hello.managed);
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
			const status = await transport.claudeLoginComplete(claudeAuth.code);
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
				const cfg = await endpointConfigGet(agent).catch(() => ({
					baseUrl: undefined,
					apiKey: undefined,
					model: undefined,
				}));
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

	// WHY: only managed Pi needs provider-prefix filtering. Codex, Claude, and
	// custom agents must keep the complete model catalog advertised over ACP.
	const modelChoices = useMemo(
		() => modelChoicesForAgent(modelOption, agentId, piManaged),
		[agentId, modelOption, piManaged],
	);

	const reasoningConfig = useMemo(
		() => managedReasoningConfig(configOptions),
		[configOptions],
	);

	/**
	 * Set the model through ACP, then re-apply the managed reasoning preference.
	 * Model changes can replace the advertised reasoning choices, so retaining
	 * stale configOptions here could display or submit an unsupported xhigh.
	 */
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
				setConfigOptions(
					await configureSession(agentId, sessionId, updated),
				);
			} catch (e) {
				setError(String((e as Error).message ?? e));
			}
		},
		[agentId, configureSession, modelOption],
	);

	/** Persist and verify a user-selected reasoning effort via its real ACP id. */
	const setReasoningEffort = useCallback(
		async (value: ManagedReasoningEffort) => {
			const sessionId = sessionRef.current;
			if (
				!sessionId ||
				!reasoningConfig ||
				!reasoningConfig.choices.some(
					(choice) => choice.value === value,
				)
			) {
				return;
			}
			try {
				const updated = await transport.setSessionConfigOption(
					sessionId,
					reasoningConfig.option.id,
					value,
				);
				const confirmed = managedReasoningConfig(updated);
				if (!confirmed || confirmed.option.currentValue !== value) {
					throw new Error(
						`The ACP adapter did not apply reasoning effort ${value}.`,
					);
				}
				// WHY: preferences are intentionally per agent. A Codex choice
				// must never become the implicit Pi or Claude default.
				writeReasoningPreference(
					agentId,
					value,
					browserPreferenceStorage(),
				);
				setConfigOptions(updated);
			} catch (e) {
				setError(String((e as Error).message ?? e));
			}
		},
		[agentId, reasoningConfig],
	);

	return (
		<div className="app">
			<header className="topbar">
				{/* Keep agent/model/config changes frozen during a live turn:
				    switching the transport underneath an in-flight Pi request
				    would make Stop target the wrong ACP session. */}
				<select
					value={agentId}
					disabled={busy || running}
					onChange={(e) => void selectAgent(e.target.value)}
				>
					<option value="">Select agent</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>
							{a.displayName}
						</option>
					))}
				</select>
				{connectionState === "connecting" ? (
					<span className="status">Connecting…</span>
				) : connectionState === "connected" ? (
					<span className="status">● {agentName}</span>
				) : null}
				{/* Model selector (config options exposed after connect). */}
				{ready && modelOption && modelChoices.length > 0 && (
					<select
						className="model-select"
						title="Model"
						value={modelOption.currentValue}
						disabled={busy || running}
						onChange={(e) => void setModel(e.target.value)}
					>
						{modelChoices.map((o) => (
							<option key={o.value} value={o.value}>
								{o.name}
							</option>
						))}
					</select>
				)}
				{ready && reasoningConfig && (
					<select
						className="reasoning-select"
						title="Reasoning effort"
						aria-label="Reasoning effort"
						value={reasoningConfig.option.currentValue}
						disabled={busy || running}
						onChange={(e) =>
							void setReasoningEffort(
								e.target.value as ManagedReasoningEffort,
							)
						}
					>
						{reasoningConfig.choices.map((choice) => (
							<option key={choice.value} value={choice.value}>
								{choice.name}
							</option>
						))}
					</select>
				)}
				{/* Gear: reconfigure endpoint (pi) or renew login
				    (codex/claude) for the selected agent. */}
				{/* WHY: Trustable Configure is the only credential/model owner
				    for managed Pi. Hiding its redundant gear avoids a control
				    that can only produce an error, while standalone Pi and the
				    Codex/Claude login-renewal actions remain available. */}
				{((agentId === "pi" && piManaged === false) ||
					agentId === "codex" ||
					agentId === "claude") && (
					<HeaderActionButton
						icon="settings"
						className="gear"
						label={
							agentId === "codex" || agentId === "claude"
								? `Renew ${agentName} login`
								: "Reconfigure Pi endpoint"
						}
						disabled={busy || running}
						onClick={() => void openConfig()}
					/>
				)}
				{ready && (
					<>
						<HeaderActionButton
							icon="new-session"
							label="New session"
							className="secondary header-action new-session-action"
							disabled={busy || running}
							onClick={() => void newChat()}
						/>
						{agentId === "pi" && (
							<HeaderActionButton
								icon="history"
								label="Resume session"
								className="secondary header-action"
								disabled={busy || running}
								onClick={() => void openHistory()}
							/>
						)}
					</>
				)}
				<HeaderActionButton
					icon="notebook"
					label="Open notebook"
					className="notebook-toggle"
					disabled={notebookBusy}
					onClick={openNotebookPanel}
				/>
				<HeaderActionButton
					icon="run-next"
					label="Run next notebook node"
					className="run-next"
					disabled={
						!ready ||
						busy ||
						notebookBusy ||
						!notebook?.selectedNodeId
					}
					onClick={runNextNotebookNode}
				/>
			</header>

			{notebookPanelOpen && (
				<NotebookPanel
					index={notebookIndex}
					activeNotebook={notebook}
					busy={notebookBusy}
					onRefresh={() => void refreshNotebookIndex()}
					onLoad={(entry) => void loadNotebook(entry)}
					onSave={() => void saveNotebook()}
					onAdd={(name, path) => void addNotebook(name, path)}
					onRemove={(entry) => void removeRemoteNotebook(entry)}
					onClose={() => setNotebookPanelOpen(false)}
				/>
			)}

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
						<div className="modal-title">Configure Pi</div>
						<p className="modal-desc">
							Couldn't connect. Enter an OpenAI-compatible
							endpoint: server base URL and API key.
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
				<div
					className="modal-backdrop"
					onClick={() => setCodexAuth(null)}
				>
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
								{codexAuth.checking
									? "Checking…"
									: "Ho completato"}
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

			{historyOpen && (
				<div className="modal-backdrop" onClick={closeHistory}>
					<div
						className="modal history-modal"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="modal-title">Pi sessions</div>
						<p className="modal-desc">
							Resume a session stored by Pi for this workbench.
						</p>
						{historyError && (
							<div className="session-error" role="alert">
								{historyError}
							</div>
						)}
						<div className="session-list">
							{historyLoading ? (
								<div className="empty">Loading sessions…</div>
							) : sessions.length === 0 ? (
								<div className="empty">
									No resumable sessions found.
								</div>
							) : (
								sessions.map((session) => (
									<div
										key={session.sessionId}
										className="session-row"
									>
										<button
											className="session-resume"
											disabled={Boolean(
												deletingSessionId,
											)}
											onClick={() =>
												void loadHistorySession(session)
											}
										>
											<span>
												{session.title ||
													"Untitled session"}
											</span>
											<small>
												{session.updatedAt
													? new Date(
															session.updatedAt,
														).toLocaleString()
													: session.sessionId}
											</small>
										</button>
										<button
											className="session-delete"
											aria-label={`Delete session ${
												session.title ||
												"Untitled session"
											}`}
											title={
												session.sessionId ===
												sessionRef.current
													? "Start a new session before deleting the active session"
													: "Delete session"
											}
											disabled={
												Boolean(deletingSessionId) ||
												session.sessionId ===
													sessionRef.current
											}
											onClick={() => {
												setDeleteCandidate(session);
												setHistoryError(null);
											}}
										>
											×
										</button>
									</div>
								))
							)}
						</div>
						{deleteCandidate && (
							<div className="session-delete-confirm">
								<span>
									Delete “
									{deleteCandidate.title ||
										"Untitled session"}
									” permanently?
								</span>
								<div>
									<button
										className="secondary"
										disabled={Boolean(deletingSessionId)}
										onClick={() => setDeleteCandidate(null)}
									>
										Cancel
									</button>
									<button
										className="danger"
										disabled={Boolean(deletingSessionId)}
										onClick={() =>
											void deleteHistorySession()
										}
									>
										{deletingSessionId
											? "Deleting…"
											: "Delete"}
									</button>
								</div>
							</div>
						)}
						<div className="modal-actions">
							<button
								className="secondary"
								disabled={Boolean(deletingSessionId)}
								onClick={closeHistory}
							>
								Close
							</button>
						</div>
					</div>
				</div>
			)}

			<div
				className="messages"
				ref={scrollRef}
				onScroll={handleChatScroll}
			>
				{turns.map((t, index) => (
					<TurnView
						key={t.id}
						turn={t}
						laterTurns={turns.slice(index + 1)}
						active={running}
					/>
				))}
				{notebook?.nodes.map((node) => (
					<NotebookNodeView
						key={node.id}
						node={node}
						selected={notebook.selectedNodeId === node.id}
						editing={editingNotebookNode === node.id}
						busy={busy || notebookBusy}
						onSelect={() =>
							setNotebook((state) =>
								state
									? { ...state, selectedNodeId: node.id }
									: state,
							)
						}
						onRun={() =>
							void executeNotebookNode(node.id, node.prompt, true)
						}
						onEdit={() => editNotebookNode(node)}
						onRemove={() => removeNode(node)}
						onPin={() => pinNode(node.id)}
					/>
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
				{ready && turns.length === 0 && !notebook && (
					<div className="empty">
						Connected to {agentName}. Send a message to start.
					</div>
				)}
			</div>

			{running && (
				<div className="activity" role="status" aria-live="polite">
					<span className="activity-spinner" aria-hidden="true" />
					<span>{activity?.label || "Working"}</span>
					<span className="activity-elapsed">
						{formatElapsed(elapsedSeconds)}
					</span>
				</div>
			)}

			<footer className="composer">
				<textarea
					ref={textareaRef}
					value={input}
					placeholder={
						ready
							? editingNotebookNode
								? "Edit notebook prompt and run…"
								: READY_COMPOSER_PLACEHOLDER
							: "Please Select Agent"
					}
					disabled={!ready || running || notebookBusy}
					onChange={(e) => handleComposerChange(e.target.value)}
					onKeyDown={(e) => {
						if (navigateComposerHistory(e)) return;
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				{running && shellRunning ? (
					<button disabled>Running…</button>
				) : running ? (
					<button
						className="stop"
						onClick={() => void stop()}
						disabled={stopping}
					>
						{stopping ? "Stopping…" : "Stop"}
					</button>
				) : (
					<button
						onClick={() => void send()}
						disabled={!ready || notebookBusy || !input.trim()}
					>
						Send
					</button>
				)}
			</footer>
		</div>
	);
}

function formatElapsed(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes > 0
		? `${minutes}:${String(remainder).padStart(2, "0")}`
		: `${remainder}s`;
}

// ---- turn rendering -------------------------------------------------------

type CopyState = "idle" | "copied" | "failed";

function CopyAction({
	text,
	code = false,
}: {
	text: string;
	code?: boolean;
}): React.ReactElement {
	const [state, setState] = useState<CopyState>("idle");
	const resetTimerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (resetTimerRef.current !== null) {
				window.clearTimeout(resetTimerRef.current);
			}
		},
		[],
	);

	const handleCopy = useCallback(async () => {
		const copied = await copyText(text);
		setState(copied ? "copied" : "failed");
		if (resetTimerRef.current !== null) {
			window.clearTimeout(resetTimerRef.current);
		}
		resetTimerRef.current = window.setTimeout(
			() => setState("idle"),
			copied ? 1600 : 3000,
		);
	}, [text]);

	const label =
		state === "copied"
			? "Copied"
			: state === "failed"
				? "Copy failed"
				: "Copy";
	return (
		<button
			type="button"
			className={`copy-action${code ? " code-copy-action" : ""} state-${state}`}
			aria-label={code ? "Copy code block" : "Copy message"}
			title={label}
			onClick={() => void handleCopy()}
		>
			{label}
		</button>
	);
}

function reactNodeText(node: React.ReactNode): string {
	if (typeof node === "string" || typeof node === "number") {
		return String(node);
	}
	if (Array.isArray(node)) return node.map(reactNodeText).join("");
	if (React.isValidElement(node)) {
		const props = node.props as { children?: React.ReactNode };
		return reactNodeText(props.children);
	}
	return "";
}

function CopyablePre({
	children,
}: {
	children?: React.ReactNode;
}): React.ReactElement {
	const code = reactNodeText(children).replace(/\n$/, "");
	return (
		<div className="markdown-code-block">
			{code && <CopyAction text={code} code />}
			<pre>{children}</pre>
		</div>
	);
}

function TurnView({
	turn,
	laterTurns,
	active,
}: {
	turn: Turn;
	laterTurns: Turn[];
	active: boolean;
}): React.ReactElement | null {
	if (turn.kind === "user") {
		return (
			<div className="turn user">
				<div className="bubble">{turn.text}</div>
				<div className="turn-actions">
					<CopyAction text={turn.text} />
				</div>
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
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{ pre: CopyablePre }}
						>
							{turn.text}
						</ReactMarkdown>
					</div>
				)}
				{turn.text && (
					<div className="turn-actions">
						{/* Copy the source Markdown, not rendered innerText, so
						    fenced code and structure survive the round-trip. */}
						<CopyAction text={turn.text} />
					</div>
				)}
			</div>
		);
	}
	if (turn.kind === "shell") {
		return (
			<div className="turn assistant shell">
				<div className="bubble markdown">
					<CopyablePre>{turn.text}</CopyablePre>
				</div>
			</div>
		);
	}
	// tool
	const presentation = toolStatusPresentation(
		turn,
		laterTurns.filter(
			(candidate): candidate is ToolTurn => candidate.kind === "tool",
		),
		active,
	);
	return (
		<div
			className={`turn tool status-${presentation.status}`}
			data-acp-status={presentation.rawStatus}
			title={`${turn.title} - ACP status: ${presentation.rawStatus}`}
		>
			<span className="tool-icon">🛠</span>
			<span className="tool-title">{turn.title}</span>
			<span className="tool-status">{presentation.label}</span>
		</div>
	);
}
