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
