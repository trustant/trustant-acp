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

import { createContext, useContext } from "react";
import type AgentClientPlugin from "../plugin";
import type { AcpClient } from "../acp/acp-client";
import type { VaultService } from "../services/vault-service";
import type { SettingsService } from "../services/settings-service";

export interface ChatContextValue {
	plugin: AgentClientPlugin;
	acpClient: AcpClient;
	vaultService: VaultService;
	settingsService: SettingsService;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatContextProvider = ChatContext.Provider;

export function useChatContext(): ChatContextValue {
	const ctx = useContext(ChatContext);
	if (!ctx)
		throw new Error(
			"useChatContext must be used within ChatContextProvider",
		);
	return ctx;
}
