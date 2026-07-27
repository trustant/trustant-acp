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
