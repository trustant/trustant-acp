import { describe, expect, it, vi } from "vitest";
import { routes, type RouteContext } from "../server/routes";

function context(deleteAgentSession: () => Promise<void>) {
	const deleteMetadata = vi.fn(async () => undefined);
	const requireClient = vi.fn(() => ({
		deleteSession: deleteAgentSession,
	}));

	return {
		ctx: {
			host: { requireClient },
			store: { deleteSession: deleteMetadata },
			config: {},
		} as unknown as RouteContext,
		deleteMetadata,
		requireClient,
	};
}

describe("POST /api/session/delete", () => {
	it("removes local metadata only after the ACP agent deletes the session", async () => {
		const order: string[] = [];
		const { ctx, deleteMetadata, requireClient } = context(async () => {
			order.push("agent");
		});
		deleteMetadata.mockImplementation(async () => {
			order.push("metadata");
		});

		const result = await routes["POST /api/session/delete"](ctx, {
			agentId: "pi",
			sessionId: "session-old",
		});

		expect(result).toEqual({ ok: true });
		expect(requireClient).toHaveBeenCalledWith("pi");
		expect(order).toEqual(["agent", "metadata"]);
		expect(deleteMetadata).toHaveBeenCalledWith("session-old");
	});

	it("keeps metadata when the ACP agent refuses deletion", async () => {
		const { ctx, deleteMetadata } = context(async () => {
			throw new Error("Cannot delete active session");
		});

		await expect(
			routes["POST /api/session/delete"](ctx, {
				agentId: "pi",
				sessionId: "session-active",
			}),
		).rejects.toThrow("Cannot delete active session");

		// WHY: retaining metadata keeps the UI consistent with the canonical
		// Pi session whenever the agent rejects or cannot complete deletion.
		expect(deleteMetadata).not.toHaveBeenCalled();
	});
});
