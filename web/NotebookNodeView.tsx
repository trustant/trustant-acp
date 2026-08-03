import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { notebookPromptSummary } from "../src/services/notebook";
import type {
	NotebookAssistantOutput,
	NotebookNode,
	NotebookToolOutput,
} from "../src/types/notebook";
import { toolStatusPresentation } from "./tool-status";

interface NotebookNodeViewProps {
	node: NotebookNode;
	selected: boolean;
	editing: boolean;
	/** True while this node's prompt is in flight. */
	running: boolean;
	/** True while this node is being repositioned by the keyboard. */
	moving: boolean;
	busy: boolean;
	onSelect: () => void;
	onRun: () => void;
	onEdit: () => void;
	onSaveEdit: (prompt: string) => void;
	onCancelEdit: () => void;
	onRemove: () => void;
	onPin: () => void;
	onMove: () => void;
	/** Receives only the four keys move mode acts on. */
	onMoveKey: (key: string) => void;
}

export function NotebookNodeView({
	node,
	selected,
	editing,
	running,
	moving,
	busy,
	onSelect,
	onRun,
	onEdit,
	onSaveEdit,
	onCancelEdit,
	onRemove,
	onPin,
	onMove,
	onMoveKey,
}: NotebookNodeViewProps): React.ReactElement {
	// WHY: the draft lives in the node being edited rather than in the shared
	// composer, so editing one step never competes with ad-hoc input and Cancel
	// can discard the draft without touching persisted state.
	const [draft, setDraft] = useState(node.prompt);

	// Re-seed whenever an edit starts so a cancelled edit does not leave a stale
	// draft behind for the next one.
	useEffect(() => {
		if (editing) setDraft(node.prompt);
	}, [editing, node.prompt]);

	const assistantOutputs = node.outputs.filter(
		(output): output is NotebookAssistantOutput =>
			output.kind === "assistant",
	);
	const toolOutputs = node.outputs.filter(
		(output): output is NotebookToolOutput => output.kind === "tool",
	);
	const latestTool = toolOutputs[toolOutputs.length - 1];
	const activityRef = useRef<HTMLDivElement>(null);
	const sectionRef = useRef<HTMLElement>(null);

	// Move mode is keyboard-driven, so the node itself has to hold focus for the
	// arrows to reach it: without this the keystrokes go to the page and scroll
	// the conversation instead of reordering the step.
	useEffect(() => {
		if (moving) sectionRef.current?.focus();
	}, [moving]);

	useEffect(() => {
		const activity = activityRef.current;
		if (activity) activity.scrollTop = activity.scrollHeight;
	}, [toolOutputs.length, latestTool?.id, latestTool?.status]);

	// A run appends an assistant output before the prompt is sent, so the
	// presence of output is what distinguishes a step that has run from one
	// still pending — including across a session resume, where no transient
	// running flag survives.
	const hasRun = node.outputs.length > 0;
	const runState = running ? "running" : hasRun ? "done" : "pending";

	return (
		<section
			ref={sectionRef}
			className={`notebook-node ${node.kind} ${
				selected ? "selected" : ""
			} ${editing ? "editing" : ""} ${
				moving ? "moving" : ""
			} run-${runState}`}
			data-node-kind={node.kind}
			data-run-state={runState}
			data-moving={moving ? "true" : undefined}
			// Focusable only while moving: the node is not a tab stop in the
			// ordinary reading flow, it just needs to receive the arrows.
			tabIndex={moving ? -1 : undefined}
			onKeyDown={
				moving
					? (event) => {
							if (
								event.key !== "ArrowUp" &&
								event.key !== "ArrowDown" &&
								event.key !== "Enter" &&
								event.key !== "Escape"
							)
								return;
							// Arrows would otherwise scroll the conversation out from
							// under the node the user is positioning.
							event.preventDefault();
							onMoveKey(event.key);
						}
					: undefined
			}
		>
			<div className="notebook-node-header">
				{node.kind === "notebook" ? (
					<input
						type="radio"
						name="selected-notebook-node"
						aria-label="Select notebook node"
						checked={selected}
						disabled={busy}
						onChange={onSelect}
					/>
				) : (
					<span className="input-node-label">Ad-hoc input</span>
				)}
				{/* Named as well as coloured, so run state does not depend on
				    colour perception alone. */}
				<span
					className={`notebook-run-state ${runState}`}
					aria-label={
						running
							? "Running"
							: hasRun
								? "Already run"
								: "Not yet run"
					}
				>
					{running ? "Running…" : hasRun ? "Run" : "Not run"}
				</span>
				<div className="notebook-node-actions">
					{moving ? (
						// The hint replaces the controls, as Save/Cancel do for an edit:
						// while moving, the keyboard is the only way to act on the node.
						<span className="notebook-move-hint" aria-live="polite">
							use arrow to move, enter to confirm esc to cancel
						</span>
					) : node.kind === "input" ? (
						// An ad-hoc node only exists while a template is loaded,
						// so this is always adding to one, never creating one.
						<button title="Add to template" disabled={busy} onClick={onPin}>
							Add to template
						</button>
					) : editing ? (
						<>
							<button
								title="Save prompt"
								disabled={busy || !draft.trim()}
								onClick={() => onSaveEdit(draft.trim())}
							>
								Save
							</button>
							<button title="Cancel edit" onClick={onCancelEdit}>
								Cancel
							</button>
						</>
					) : (
						<>
							<button title="Run step" disabled={busy} onClick={onRun}>
								Run
							</button>
							<button title="Edit prompt in place" disabled={busy} onClick={onEdit}>
								Edit
							</button>
							{/* Only steps are written to the template, so only steps
							    can be reordered. */}
							{node.kind === "notebook" && (
								<button
									title="Move step with the arrow keys"
									disabled={busy}
									onClick={onMove}
								>
									Move
								</button>
							)}
						</>
					)}
					{!editing && !moving && (
						<button title="Remove step" disabled={busy} onClick={onRemove}>
							Remove
						</button>
					)}
				</div>
			</div>
			<div className="notebook-node-task">
				{editing ? (
					<textarea
						className="notebook-node-editor"
						aria-label="Edit prompt"
						value={draft}
						autoFocus
						rows={Math.min(20, Math.max(4, draft.split("\n").length + 1))}
						onChange={(event) => setDraft(event.target.value)}
					/>
				) : (
					<>
						<h3 className="notebook-node-title">
							{notebookPromptSummary(node.prompt)}
						</h3>
						<details className="notebook-node-details">
							<summary>Task details</summary>
							<div className="notebook-node-prompt">{node.prompt}</div>
						</details>
					</>
				)}
			</div>
			{assistantOutputs.map((output) => (
				<div
					className="notebook-agent-response"
					key={output.id}
					aria-live="polite"
				>
					<div className="notebook-agent-label">Agent response</div>
						{output.thoughts && (
							<details className="thoughts">
								<summary>Reasoning</summary>
								<div className="thought-body">{output.thoughts}</div>
							</details>
						)}
						{output.text && (
							<div className="bubble markdown">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>
									{output.text}
								</ReactMarkdown>
							</div>
						)}
					{!output.text && !output.thoughts && (
						<div className="notebook-agent-working">Agent is working...</div>
					)}
				</div>
			))}
			{toolOutputs.length > 0 && (
				<div className="notebook-tool-activity">
					<div className="notebook-tool-activity-header">
						<span>Activity</span>
						<span>{toolOutputs.length} operations</span>
					</div>
					<div className="notebook-tool-window" ref={activityRef}>
						{toolOutputs.map((output, index) => {
							const presentation = toolStatusPresentation(
								output,
								toolOutputs.slice(index + 1),
								busy,
							);
							return (
								<div
									className={`turn tool status-${presentation.status}`}
									data-acp-status={presentation.rawStatus}
									key={output.id}
									title={`${output.title} - ACP status: ${presentation.rawStatus}`}
								>
									<span className="tool-icon">Tool</span>
									<span className="tool-title">{output.title}</span>
									<span className="tool-status">
										{presentation.label}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</section>
	);
}
