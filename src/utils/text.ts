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

const ELLIPSIS = "...";

/**
 * Truncate a string so its final length (including ellipsis) does not
 * exceed `maxLength`. If `text` already fits, it is returned as-is.
 *
 * For `maxLength <= ELLIPSIS.length`, the ellipsis is omitted to honor
 * the length contract — a small but well-defined edge case.
 */
export function truncateTitle(text: string, maxLength = 50): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= ELLIPSIS.length) return text.slice(0, maxLength);
	return text.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
}
