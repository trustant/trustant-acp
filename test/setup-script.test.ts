import { spawnSync } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("setup.sh Pi ACP compatibility", () => {
	it("suppresses the adapter update lookup when Pi update checks are disabled", async () => {
		const setup = await readFile(join(process.cwd(), "setup.sh"), "utf8");
		const patch = setup.match(
			/node - "\$PI_ACP_ENTRYPOINT" <<'NODE'\n([\s\S]*?)\nNODE/,
		);

		expect(setup).toContain(
			"$INSTALL_PREFIX/lib/node_modules/pi-acp/dist/index.js",
		);
		expect(patch).not.toBeNull();

		const dir = await mkdtemp(join(tmpdir(), "truacp-setup-"));
		const entrypoint = join(dir, "index.js");
		try {
			await writeFile(
				entrypoint,
				'function buildUpdateNotice() {\n  return "banner";\n}\n',
			);
			const firstRun = spawnSync(process.execPath, ["-", entrypoint], {
				input: patch![1],
				encoding: "utf8",
			});
			expect(firstRun.status, firstRun.stderr).toBe(0);

			const patched = await readFile(entrypoint, "utf8");
			const guard =
				"process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE";
			expect(patched).toContain(guard);

			const secondRun = spawnSync(process.execPath, ["-", entrypoint], {
				input: patch![1],
				encoding: "utf8",
			});
			expect(secondRun.status, secondRun.stderr).toBe(0);
			expect(
				(await readFile(entrypoint, "utf8")).split(guard),
			).toHaveLength(2);

			await writeFile(entrypoint, "function renamedUpdateNotice() {}\n");
			const incompatibleRun = spawnSync(
				process.execPath,
				["-", entrypoint],
				{
					input: patch![1],
					encoding: "utf8",
				},
			);
			expect(incompatibleRun.status).toBe(1);
			expect(incompatibleRun.stderr).toContain(
				"cannot apply the pi-acp update-check compatibility patch",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
