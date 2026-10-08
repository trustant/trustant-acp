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
 * Pinned npm specs for Claude Code, installed on demand by claude-install.ts.
 *
 * WHY this is not in pi.version: `@anthropic-ai/claude-code` is proprietary
 * (Anthropic Commercial Terms, no redistribution grant), and everything in
 * pi.version is installed by setup.sh and therefore baked into the published
 * image. These pins are only ever installed on the user's machine, from npm,
 * after the user accepts Anthropic's terms. Kept as a TS module (not a text
 * file) so both `tsx` and the self-contained truacp.cjs bundle carry it.
 *
 * To upgrade, edit a version here; an existing install with a different
 * version is reported as not installed and the user is asked again.
 */
export const CLAUDE_PACKAGES = [
	{ name: "@anthropic-ai/claude-code", version: "2.1.216" },
	{ name: "@agentclientprotocol/claude-agent-acp", version: "0.60.0" },
] as const;

/** Anthropic's terms the user must accept before Claude Code is installed. */
export const CLAUDE_TERMS_URL = "https://www.anthropic.com/legal/commercial-terms";
