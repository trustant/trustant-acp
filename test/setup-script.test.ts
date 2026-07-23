import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("setup.sh Trustable Pi ACP fork", () => {
	it("builds the nested fork or consumes the packaged fork without an npm fallback", async () => {
		const setup = await readFile(join(process.cwd(), "setup.sh"), "utf8");
		const versions = await readFile(
			join(process.cwd(), "pi.version"),
			"utf8",
		);

		expect(setup).toContain('PI_ACP_SOURCE_DIR="$SCRIPT_DIR/pi-acp"');
		expect(setup).toContain(
			'PI_ACP_PREBUILT="$SCRIPT_DIR/pi-acp-package.tgz"',
		);
		expect(setup).toContain(
			'npm install -g --force $PREFIX_ARGS "$PI_ACP_PACKAGE"',
		);
		expect(setup).toContain(
			"$INSTALL_PREFIX/lib/node_modules/pi-acp/dist/index.js",
		);
		expect(setup).toContain(
			'export TRUSTABLE_PI_EXTENSION="$EXTENSION_DIR/trustable-guardrails.ts"',
		);
		expect(versions).not.toMatch(/^pi-acp@/m);
		expect(setup).not.toContain("npm view");
	});
});
