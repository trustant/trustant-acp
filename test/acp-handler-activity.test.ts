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
