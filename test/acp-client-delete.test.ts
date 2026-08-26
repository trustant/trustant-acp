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

import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp/acp-client";
import type { AcpRuntimeConfig } from "../src/acp/acp-runtime";

function clientWithConnection(request: ReturnType<typeof vi.fn>): AcpClient {
	const runtime: AcpRuntimeConfig = {
		nodePath: "",
		windowsWslMode: false,
		windowsWslDistribution: "",
		autoAllowPermissions: false,
		clientVersion: "test",
		resolveSecret: () => "",
	};
	const client = new AcpClient(runtime);
	Object.assign(client, {
		connection: { agent: { request } },
		currentSessionId: "session-active",
	});
	return client;
}

describe("AcpClient.deleteSession", () => {
	it("uses the portable ACP request path for session/delete", async () => {
		const request = vi.fn(async () => ({}));
		const client = clientWithConnection(request);

		await client.deleteSession("session-old");

		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith("session/delete", {
			sessionId: "session-old",
		});
	});

	it("rejects deletion of the active session before sending a request", async () => {
		const request = vi.fn(async () => ({}));
		const client = clientWithConnection(request);

		await expect(client.deleteSession("session-active")).rejects.toThrow(
			"Cannot delete the active session",
		);
		expect(request).not.toHaveBeenCalled();
	});
});
