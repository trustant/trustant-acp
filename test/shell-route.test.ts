import { describe, expect, it, vi } from "vitest";
import { routes, type RouteContext } from "../server/routes";

describe("POST /api/session/shell", () => {
	it("uses the server-owned active-session cwd and ignores request cwd", async () => {
		const activeSessionDirectory = vi.fn(() => process.cwd());
		// The route pipes its result through the host's redaction step. With no
		// host-known secrets that is identity, so the stub returns the value
		// unchanged — but it is asserted below, so the route cannot quietly
		// stop redacting shell output.
		const redactSensitive = vi.fn(<T,>(value: T): T => value);
		const ctx = {
			host: { activeSessionDirectory, redactSensitive },
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
		expect(redactSensitive).toHaveBeenCalledOnce();
		expect(result.stdout).toBe("route-ok");
		expect(result.exitCode).toBe(0);
	});
});
