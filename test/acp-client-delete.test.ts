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
