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
import {
	CHAT_FOLLOW_THRESHOLD_PX,
	isChatNearBottom,
} from "../web/chat-scroll";

describe("chat output following", () => {
	it("follows output while the reader is near the bottom", () => {
		expect(
			isChatNearBottom({
				scrollHeight: 1000,
				scrollTop: 500,
				clientHeight: 420,
			}),
		).toBe(true);
		expect(CHAT_FOLLOW_THRESHOLD_PX).toBe(80);
	});

	it("preserves the reader position after they scroll upward", () => {
		expect(
			isChatNearBottom({
				scrollHeight: 1000,
				scrollTop: 300,
				clientHeight: 420,
			}),
		).toBe(false);
	});
});
