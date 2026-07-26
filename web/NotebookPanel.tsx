import React, { useState } from "react";
import type {
	NotebookIndexEntry,
	NotebookIndexResponse,
	NotebookSessionState,
} from "../src/types/notebook";

interface NotebookPanelProps {
	source: string;
	sourceRef: string;
	index: NotebookIndexResponse | null;
	activeNotebook: NotebookSessionState | null;
	busy: boolean;
	onSourceChange: (source: string) => void;
	onRefChange: (ref: string) => void;
	onRefresh: () => void;
	onLoad: (entry: NotebookIndexEntry) => void;
	onSave: () => void;
	onAdd: (name: string, path: string) => void;
	onRemove: (entry: NotebookIndexEntry) => void;
	onClose: () => void;
}

function defaultPath(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug || "notebook"}.md`;
}

export function NotebookPanel({
	source,
	sourceRef,
	index,
	activeNotebook,
	busy,
	onSourceChange,
	onRefChange,
	onRefresh,
	onLoad,
	onSave,
	onAdd,
	onRemove,
	onClose,
}: NotebookPanelProps): React.ReactElement {
	const [newName, setNewName] = useState("");
	const [newPath, setNewPath] = useState("");
	const hasToken = index?.hasToken ?? false;

	return (
		<aside className="notebook-panel" aria-label="Notebook panel">
			<div className="notebook-panel-header">
				<div>
					<strong>Notebooks</strong>
					<div className="notebook-panel-subtitle">
						GitHub-backed prompt workflows
					</div>
				</div>
				<button className="icon-button" title="Close" onClick={onClose}>
					×
				</button>
			</div>

			<label className="notebook-field">
				<span>Source</span>
				<input
					aria-label="Notebook source"
					value={source}
					onChange={(event) => onSourceChange(event.target.value)}
					placeholder="trustable-ai/notebooks"
				/>
			</label>
			<label className="notebook-field notebook-ref-field">
				<span>Branch / ref</span>
				<input
					aria-label="Notebook branch"
					value={sourceRef}
					onChange={(event) => onRefChange(event.target.value)}
					placeholder="main"
				/>
			</label>
			<button
				className="notebook-primary"
				disabled={busy || !source.trim() || !sourceRef.trim()}
				onClick={onRefresh}
			>
				{busy ? "Loading…" : "Load source"}
			</button>

			{index && !hasToken && (
				<div className="notebook-warning">
					Read-only. Set <code>NOTEBOOK_GITHUB_TOKEN</code> in the
					server <code>.env</code> to enable save, add, and remove.
				</div>
			)}

			<div className="notebook-list" aria-label="Available notebooks">
				{index?.entries.map((entry) => (
					<div
						className={`notebook-list-entry ${
							activeNotebook?.path === entry.path ? "active" : ""
						}`}
						key={entry.path}
					>
						<button
							className="notebook-list-load"
							disabled={busy}
							onClick={() => onLoad(entry)}
						>
							<span>{entry.name}</span>
							{entry.comment && <small>{entry.comment}</small>}
						</button>
						<button
							className="icon-button danger"
							title={`Remove ${entry.name}`}
							disabled={busy || !hasToken}
							onClick={() => onRemove(entry)}
						>
							×
						</button>
					</div>
				))}
				{index && index.entries.length === 0 && (
					<div className="notebook-list-empty">No notebooks indexed.</div>
				)}
			</div>

			{activeNotebook && (
				<div className="notebook-active">
					<div>
						<strong>{activeNotebook.notebookName}</strong>
						<code>{activeNotebook.path}</code>
					</div>
					<button
						className="notebook-primary"
						disabled={busy || !hasToken || !activeNotebook.dirty}
						onClick={onSave}
					>
						Save
					</button>
				</div>
			)}

			<div className="notebook-add">
				<strong>Add notebook</strong>
				<input
					aria-label="New notebook name"
					value={newName}
					disabled={!hasToken || busy}
					placeholder="Notebook name"
					onChange={(event) => {
						const value = event.target.value;
						setNewName(value);
						if (!newPath || newPath === defaultPath(newName)) {
							setNewPath(defaultPath(value));
						}
					}}
				/>
				<input
					aria-label="New notebook path"
					value={newPath}
					disabled={!hasToken || busy}
					placeholder="notebook-file.md"
					onChange={(event) => setNewPath(event.target.value)}
				/>
				<button
					disabled={
						!hasToken || busy || !newName.trim() || !newPath.trim()
					}
					onClick={() => {
						onAdd(newName.trim(), newPath.trim());
						setNewName("");
						setNewPath("");
					}}
				>
					Add
				</button>
			</div>
		</aside>
	);
}
