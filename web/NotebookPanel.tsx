/*
 * Copyright 2025-2026 Nuvolaris Inc
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import React, { useEffect, useState } from "react";
import type {
	NotebookIndexEntry,
	NotebookIndexResponse,
	NotebookSessionState,
	TemplateFrontMatter,
} from "../src/types/notebook";

interface NotebookPanelProps {
	index: NotebookIndexResponse | null;
	activeNotebook: NotebookSessionState | null;
	/** Front matter of the workbench template.md, or null when none exists. */
	localTemplate: TemplateFrontMatter | null;
	busy: boolean;
	onRefresh: () => void;
	onSelect: (entry: NotebookIndexEntry) => void;
	onOpenLocal: () => void;
	onSaveToGitHub: (name: string, file: string) => void;
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
	localTemplate,
	busy,
	onRefresh,
	onSelect,
	onOpenLocal,
	onSaveToGitHub,
	onRemove,
	onClose,
}: NotebookPanelProps): React.ReactElement {
	// Editable identity of the working copy. Seeded from front matter and
	// re-seeded whenever it changes, so a save-back or a fresh selection does
	// not leave the previous template's name in the inputs.
	const [saveName, setSaveName] = useState(localTemplate?.name ?? "");
	const [saveFile, setSaveFile] = useState(localTemplate?.file ?? "");
	useEffect(() => {
		setSaveName(localTemplate?.name ?? "");
		setSaveFile(localTemplate?.file ?? "");
	}, [localTemplate?.name, localTemplate?.file, localTemplate?.edited]);

	// A repository without a write token cannot be published to. The catalog
	// still reads, and the working copy still saves locally, so only the
	// upstream controls are withheld.
	const hasToken = index?.hasToken ?? false;
	const changed = localTemplate?.edited ?? false;
	// An unnamed working copy has no upstream file yet; offer one from the name.
	const effectiveFile = saveFile.trim() || defaultPath(saveName);

	return (
		// data-tour markers are read by the guided tutorials the Trustant host
		// runs across the frame boundary (see web/tour-bridge.ts).
		<aside
			className="notebook-panel"
			aria-label="Template panel"
			data-tour="notebook-panel"
		>
			<div className="notebook-panel-header">
				<div>
					<strong>Templates</strong>
					<div className="notebook-panel-subtitle">
						GitHub-backed prompt templates
					</div>
				</div>
				<button
					className="icon-button"
					title="Close"
					data-tour="notebook-close"
					onClick={onClose}
				>
					×
				</button>
			</div>

			<div className="notebook-active" data-tour="notebook-source">
				<div>
					<strong>Source</strong>
					<code>
						{index
							? `${index.source.repository} · ${index.source.ref}`
							: "Configured in Trustant"}
					</code>
				</div>
				<button
					className="notebook-primary"
					data-tour="notebook-refresh"
					disabled={busy}
					onClick={onRefresh}
				>
					{busy ? "Loading…" : "Refresh"}
				</button>
			</div>

			{localTemplate && (
				<div
					className={`notebook-working-copy ${changed ? "changed" : ""}`}
					aria-label="Working copy"
				>
					<div className="notebook-working-copy-header">
						<div>
							<strong>{localTemplate.name || "Unnamed template"}</strong>
							<code>
								{localTemplate.file
									? `${localTemplate.repo || "local"} · ${localTemplate.file}`
									: "not yet saved to a repository"}
							</code>
						</div>
						{changed && (
							<span className="notebook-changed-badge">Changed</span>
						)}
						<button
							className="notebook-primary"
							disabled={busy}
							onClick={onOpenLocal}
						>
							Open
						</button>
					</div>

					{changed && (
						<div className="notebook-save-fields">
							<input
								aria-label="Template name"
								value={saveName}
								disabled={busy}
								placeholder="Template name"
								onChange={(event) => setSaveName(event.target.value)}
							/>
							<input
								aria-label="Template file"
								value={saveFile}
								disabled={busy}
								placeholder={defaultPath(saveName)}
								onChange={(event) => setSaveFile(event.target.value)}
							/>
							{hasToken ? (
								<button
									disabled={busy || !saveName.trim()}
									onClick={() =>
										onSaveToGitHub(saveName.trim(), effectiveFile)
									}
								>
									Save to GitHub
								</button>
							) : (
								<div className="notebook-hint">
									add in configuration your github token to edit templates
								</div>
							)}
						</div>
					)}
				</div>
			)}

			<div className="notebook-list" aria-label="Available templates">
				{index?.entries.map((entry) => (
					<div
						className={`notebook-list-entry ${
							activeNotebook?.template.file === entry.path ? "active" : ""
						}`}
						key={entry.path}
					>
						{/* Every entry carries the marker. The label is explicit
						    rather than read off the rendered text so the host can
						    spotlight a template by name ("App Suite") wherever the
						    catalog happens to order it. */}
						<button
							className="notebook-list-load"
							data-tour="notebook-entry"
							data-tour-entry=""
							data-tour-label={entry.name}
							disabled={busy}
							onClick={() => onSelect(entry)}
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
				{index && index.entries.length === 0 && (
					<div className="notebook-list-empty">No templates indexed.</div>
				)}
			</div>

			{/*
			 * There is deliberately no add-template form: Save to GitHub already
			 * creates and indexes a template that does not exist yet, so a second
			 * creation path would only duplicate it. A new template starts by
			 * pinning a chat message; an existing one is renamed in place.
			 */}

			{index && !hasToken && !changed && (
				<div className="notebook-hint">
					add in configuration your github token to edit templates
				</div>
			)}
		</aside>
	);
}
