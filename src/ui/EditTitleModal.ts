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

/**
 * Modal for editing a session title.
 *
 * Displays a text input pre-filled with the current title.
 * Calls onSave callback with the new title when user clicks Save.
 */

import { Modal, App, Menu } from "obsidian";
import type AgentClientPlugin from "../plugin";

export class EditTitleModal extends Modal {
	private currentTitle: string;
	private onSave: (newTitle: string) => void | Promise<void>;

	constructor(
		app: App,
		currentTitle: string,
		onSave: (newTitle: string) => void | Promise<void>,
	) {
		super(app);
		this.currentTitle = currentTitle;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Edit session title" });

		const inputEl = contentEl.createEl("input", {
			type: "text",
			cls: "agent-client-edit-title-input",
			attr: { maxlength: "100" },
		});
		// createEl sets HTML attribute; explicit assignment sets DOM property (displayed value)
		inputEl.value = this.currentTitle;

		// Focus and select all text for easy replacement
		window.setTimeout(() => {
			inputEl.focus();
			inputEl.select();
		}, 10);

		// Enter key to save
		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.saveAndClose(inputEl.value);
			}
		});

		const buttonContainer = contentEl.createDiv({
			cls: "agent-client-edit-title-buttons",
		});

		buttonContainer
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => {
				this.close();
			});

		buttonContainer
			.createEl("button", {
				text: "Save",
				cls: "mod-cta",
			})
			.addEventListener("click", () => {
				this.saveAndClose(inputEl.value);
			});
	}

	private saveAndClose(rawValue: string) {
		const value = rawValue.trim();
		if (!value) return;
		this.close();
		void this.onSave(value);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Open the EditTitleModal for renaming a saved session.
 * Used by ChatPanel's More menu and SessionManagerView's item context menu.
 */
export function openRenameSessionModal(
	plugin: AgentClientPlugin,
	sessionId: string,
	currentTitle: string,
): void {
	const modal = new EditTitleModal(
		plugin.app,
		currentTitle,
		async (newTitle) => {
			await plugin.settingsService.updateSessionTitle(
				sessionId,
				newTitle,
			);
		},
	);
	modal.open();
}

/**
 * Add a "Rename session" menu item that opens the rename modal.
 * Centralizes the disabled/enabled label so all call sites stay in sync.
 *
 * @param menu - The menu to which the item is added.
 * @param plugin - The plugin instance.
 * @param sessionId - The session ID to rename (null when not yet saved).
 * @param currentTitle - The current title (used as the modal's initial value).
 * @param options.label - Override the menu item label (default: "Rename session").
 */
export function addRenameSessionMenuItem(
	menu: Menu,
	plugin: AgentClientPlugin,
	sessionId: string | null,
	currentTitle: string,
	options?: { label?: string },
): void {
	const baseLabel = options?.label ?? "Rename session";
	const hasSavedSession = sessionId
		? plugin.settingsService
				.getSavedSessions()
				.some((s) => s.sessionId === sessionId)
		: false;

	menu.addItem((item) => {
		item.setTitle(
			hasSavedSession
				? baseLabel
				: `${baseLabel} (send a message first)`,
		)
			.setIcon("pencil")
			.setDisabled(!hasSavedSession)
			.onClick(() => {
				if (!sessionId || !hasSavedSession) return;
				openRenameSessionModal(plugin, sessionId, currentTitle);
			});
	});
}
