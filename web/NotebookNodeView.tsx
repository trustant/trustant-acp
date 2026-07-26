import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NotebookNode } from "../src/types/notebook";

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
			<div className="notebook-node-prompt">{node.prompt}</div>
			{node.outputs.map((output) =>
				output.kind === "assistant" ? (
					<div className="notebook-node-output" key={output.id}>
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
					</div>
				) : (
					<div
						className={`turn tool status-${output.status}`}
						key={output.id}
					>
						<span className="tool-icon">Tool</span>
						<span className="tool-title">{output.title}</span>
						<span className="tool-status">{output.status}</span>
					</div>
				),
			)}
		</section>
	);
}
