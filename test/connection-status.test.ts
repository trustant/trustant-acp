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

import { describe, expect, it } from "vitest";
import { headerConnectionState } from "../web/connection-status";

describe("header connection state", () => {
	it("shows connecting only before a usable session is ready", () => {
		expect(headerConnectionState(false, true)).toBe("connecting");
		expect(headerConnectionState(false, false)).toBe("idle");
	});

	it("stays connected while a ready session is busy", () => {
		expect(headerConnectionState(true, false)).toBe("connected");
		expect(headerConnectionState(true, true)).toBe("connected");
	});
});
