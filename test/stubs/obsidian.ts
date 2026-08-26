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
 * Lightweight `obsidian` stub for unit tests.
 *
 * The real `obsidian` module only exists inside the Obsidian runtime. The pure
 * utilities under test (`src/utils/platform.ts`, `src/utils/paths.ts`) only need
 * `Platform`, whose flags they read at call time. Tests mutate these flags to
 * exercise the platform-specific branches.
 */
export const Platform = {
	isWin: false,
	isMacOS: false,
	isLinux: false,
	isDesktopApp: true,
};
