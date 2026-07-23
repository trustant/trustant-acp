import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpHandler } from "../src/acp/acp-handler";
import { PermissionManager } from "../src/acp/permission-handler";
import { TerminalManager } from "../src/acp/terminal-handler";
import { Logger } from "../src/utils/logger";

function handler(): AcpHandler {
	return new AcpHandler(
		Object.create(PermissionManager.prototype) as PermissionManager,
		Object.create(TerminalManager.prototype) as TerminalManager,
		() => "/tmp/workbench",
		() => "session-1",
		new Logger({ debugMode: false }),
	);
}

describe("AcpHandler Pi activity metadata", () => {
	it("forwards validated versioned activity without adding chat text", async () => {
		const subject = handler();
		const updates: unknown[] = [];
		subject.onSessionUpdate((update) => updates.push(update));

		// ACP deliberately permits vendor metadata. Cast only at the SDK
		// boundary so the production handler still validates every field.
		const notification = {
			sessionId: "session-1",
			update: {
				sessionUpdate: "session_info_update",
				_meta: {
					piAcp: {
						activity: {
							version: 1,
							state: "running",
							label: "Running browser",
							active: true,
							timestamp: "2026-07-23T12:00:00.000Z",
						},
					},
				},
			},
		} as unknown as acp.SessionNotification;

		await subject.sessionUpdate(notification);

		expect(updates).toEqual([
			{
				type: "session_info_update",
				sessionId: "session-1",
				title: undefined,
				updatedAt: undefined,
				activity: {
					version: 1,
					state: "running",
					label: "Running browser",
					active: true,
					timestamp: "2026-07-23T12:00:00.000Z",
				},
			},
		]);
	});

	it("drops malformed activity metadata", async () => {
		const subject = handler();
		const updates: unknown[] = [];
		subject.onSessionUpdate((update) => updates.push(update));

		await subject.sessionUpdate({
			sessionId: "session-1",
			update: {
				sessionUpdate: "session_info_update",
				_meta: {
					piAcp: {
						activity: {
							version: 99,
							state: "running",
							label: "Untrusted",
							active: "yes",
						},
					},
				},
			},
		} as unknown as acp.SessionNotification);

		expect(updates).toEqual([
			{
				type: "session_info_update",
				sessionId: "session-1",
				title: undefined,
				updatedAt: undefined,
				activity: undefined,
			},
		]);
	});
});
