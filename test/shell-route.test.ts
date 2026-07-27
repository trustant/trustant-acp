import { describe, expect, it, vi } from "vitest";
import { routes, type RouteContext } from "../server/routes";

describe("POST /api/session/shell", () => {
	it("uses the server-owned active-session cwd and ignores request cwd", async () => {
		const activeSessionDirectory = vi.fn(() => process.cwd());
		const ctx = {
			host: { activeSessionDirectory },
			store: {},
			config: {},
		} as unknown as RouteContext;

		const result = await routes["POST /api/session/shell"](
			ctx,
			{
				sessionId: "session-current",
				command: "printf route-ok",
				cwd: "/browser/must/not/control/this",
			} as never,
		);

		expect(activeSessionDirectory).toHaveBeenCalledWith("session-current");
		expect(result.stdout).toBe("route-ok");
		expect(result.exitCode).toBe(0);
	});
});
