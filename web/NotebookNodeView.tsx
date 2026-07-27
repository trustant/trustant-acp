import React, { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { notebookPromptSummary } from "../src/services/notebook";
import type {
	NotebookAssistantOutput,
	NotebookNode,
	NotebookToolOutput,
} from "../src/types/notebook";

interface NotebookNodeViewProps {
	node: NotebookNode;
	selected: boolean;
	editing: boolean;
	busy: boolean;
	onSelect: () => void;
	onRun: () => void;
	onEdit: () => void;
	onRemove: () => void;
	onPin: () => void;
}

export function NotebookNodeView({
	node,
	selected,
	editing,
	busy,
	onSelect,
	onRun,
	onEdit,
	onRemove,
	onPin,
}: NotebookNodeViewProps): React.ReactElement {
	const assistantOutputs = node.outputs.filter(
		(output): output is NotebookAssistantOutput =>
			output.kind === "assistant",
	);
	const toolOutputs = node.outputs.filter(
		(output): output is NotebookToolOutput => output.kind === "tool",
	);
	const latestTool = toolOutputs[toolOutputs.length - 1];
	const activityRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const activity = activityRef.current;
		if (activity) activity.scrollTop = activity.scrollHeight;
	}, [toolOutputs.length, latestTool?.id, latestTool?.status]);

	return (
		<section
			className={`notebook-node ${node.kind} ${
				selected ? "selected" : ""
			} ${editing ? "editing" : ""}`}
			data-node-kind={node.kind}
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
				<div className="notebook-node-actions">
					{node.kind === "input" ? (
						<button title="Pin as notebook node" disabled={busy} onClick={onPin}>
							Pin
						</button>
					) : (
						<>
							<button title="Run node" disabled={busy} onClick={onRun}>
								Run
							</button>
							<button title="Edit and run" disabled={busy} onClick={onEdit}>
								Edit
							</button>
						</>
					)}
					<button title="Remove node" disabled={busy} onClick={onRemove}>
						Remove
					</button>
				</div>
			</div>
			<div className="notebook-node-task">
				<h3 className="notebook-node-title">
					{notebookPromptSummary(node.prompt)}
				</h3>
				<details className="notebook-node-details">
					<summary>Task details</summary>
					<div className="notebook-node-prompt">{node.prompt}</div>
				</details>
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
						{toolOutputs.map((output) => (
							<div
								className={`turn tool status-${output.status}`}
								key={output.id}
								title={`${output.title} - ${output.status}`}
							>
								<span className="tool-icon">Tool</span>
								<span className="tool-title">{output.title}</span>
								<span className="tool-status">{output.status}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</section>
	);
}
