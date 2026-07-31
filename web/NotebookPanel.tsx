import React, { useState } from "react";
import type {
	NotebookIndexEntry,
	NotebookIndexResponse,
	NotebookSessionState,
} from "../src/types/notebook";

interface NotebookPanelProps {
	index: NotebookIndexResponse | null;
	activeNotebook: NotebookSessionState | null;
	/** True when a local template.md exists in the launched application. */
	hasLocalTemplate: boolean;
	busy: boolean;
	onRefresh: () => void;
	onLoad: (entry: NotebookIndexEntry) => void;
	onLoadLocal: () => void;
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
	return `${slug || "template"}.md`;
}

export function NotebookPanel({
	index,
	activeNotebook,
	hasLocalTemplate,
	busy,
	onRefresh,
	onLoad,
	onLoadLocal,
	onSave,
	onAdd,
	onRemove,
	onClose,
}: NotebookPanelProps): React.ReactElement {
	const [newName, setNewName] = useState("");
	const [newPath, setNewPath] = useState("");
	// A repository without a write token is read-only. Rather than rendering
	// disabled write controls plus a warning, the panel hides everything that
	// cannot work and closes with a single quiet hint.
	const hasToken = index?.hasToken ?? false;

	return (
		<aside className="notebook-panel" aria-label="Template panel">
			<div className="notebook-panel-header">
				<div>
					<strong>Templates</strong>
					<div className="notebook-panel-subtitle">
						GitHub-backed prompt templates
					</div>
				</div>
				<button className="icon-button" title="Close" onClick={onClose}>
					×
				</button>
			</div>

			<div className="notebook-active">
				<div>
					<strong>Source</strong>
					<code>
						{index
							? `${index.source.repository} · ${index.source.ref}`
							: "Configured in Trustable"}
					</code>
				</div>
				<button
					className="notebook-primary"
					disabled={busy}
					onClick={onRefresh}
				>
					{busy ? "Loading…" : "Refresh"}
				</button>
			</div>

			<div className="notebook-list" aria-label="Available templates">
				{hasLocalTemplate && (
					<div
						className={`notebook-list-entry saved ${
							activeNotebook?.local ? "active" : ""
						}`}
					>
						<button
							className="notebook-list-load"
							disabled={busy}
							onClick={onLoadLocal}
						>
							<span>Saved Template</span>
							<small>Saved in this application</small>
						</button>
					</div>
				)}
				{index?.entries.map((entry) => (
					<div
						className={`notebook-list-entry ${
							!activeNotebook?.local && activeNotebook?.path === entry.path
								? "active"
								: ""
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
						{hasToken && (
							<button
								className="icon-button danger"
								title={`Remove ${entry.name}`}
								disabled={busy}
								onClick={() => onRemove(entry)}
							>
								×
							</button>
						)}
					</div>
				))}
				{index && index.entries.length === 0 && !hasLocalTemplate && (
					<div className="notebook-list-empty">No templates indexed.</div>
				)}
			</div>

			{hasToken && activeNotebook && (
				<div className="notebook-active">
					<div>
						<strong>{activeNotebook.notebookName}</strong>
						<code>{activeNotebook.path}</code>
					</div>
					<button
						className="notebook-primary"
						disabled={busy || !activeNotebook.dirty}
						onClick={onSave}
					>
						Save
					</button>
				</div>
			)}

			{hasToken && (
				<div className="notebook-add">
					<strong>Add template</strong>
					<input
						aria-label="New template name"
						value={newName}
						disabled={busy}
						placeholder="Template name"
						onChange={(event) => {
							const value = event.target.value;
							setNewName(value);
							if (!newPath || newPath === defaultPath(newName)) {
								setNewPath(defaultPath(value));
							}
						}}
					/>
					<input
						aria-label="New template path"
						value={newPath}
						disabled={busy}
						placeholder="template-file.md"
						onChange={(event) => setNewPath(event.target.value)}
					/>
					<button
						disabled={busy || !newName.trim() || !newPath.trim()}
						onClick={() => {
							onAdd(newName.trim(), newPath.trim());
							setNewName("");
							setNewPath("");
						}}
					>
						Add
					</button>
				</div>
			)}

			{index && !hasToken && (
				<div className="notebook-hint">
					add in configuration your github token to edit templates
				</div>
			)}
		</aside>
	);
}
