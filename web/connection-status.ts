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

export type HeaderConnectionState = "idle" | "connecting" | "connected";

/**
 * General UI work can remain busy after ACP has opened a usable session.
 * Readiness therefore takes precedence over the shared busy flag.
 */
export function headerConnectionState(
	ready: boolean,
	busy: boolean,
): HeaderConnectionState {
	if (ready) return "connected";
	if (busy) return "connecting";
	return "idle";
}
