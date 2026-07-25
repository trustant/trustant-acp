import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("setup.sh Trustable Pi forks", () => {
	it("builds the nested forks or consumes packaged forks without npm fallbacks", async () => {
		const setup = await readFile(join(process.cwd(), "setup.sh"), "utf8");
		const piLocalRelease = await readFile(
			join(process.cwd(), "pi", "scripts", "local-release.mjs"),
			"utf8",
		);
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
			'cp "$TRUSTABLE_EXTENSION_SOURCE" "$LIB_DIR/extensions/trustable-runtime.ts"',
		);
		expect(setup).toContain(
			'"$SCRIPT_DIR/extensions/trustable-runtime.ts"',
		);
		expect(setup).toContain('PI_SOURCE_DIR="$SCRIPT_DIR/pi"');
		expect(setup).toContain(
			'PI_PREBUILT_DIR="$SCRIPT_DIR/pi-packages"',
		);
		expect(setup).toContain("node scripts/local-release.mjs");
		expect(setup).toContain("npm ci --ignore-scripts");
		expect(setup).toContain(
			"PI_LOCAL_RELEASE_USE_CHECKED_IN_MODELS=1",
		);
		expect(setup).toContain(
			'"$PI_PACKAGE_DIR"/earendil-works-pi-storage-sqlite-node-*.tgz',
		);
		expect(setup).toContain(
			'"$PI_PACKAGE_DIR"/earendil-works-pi-coding-agent-*.tgz',
		);
		expect(piLocalRelease).toContain(
			'{ directory: "packages/storage/sqlite-node", name: "@earendil-works/pi-storage-sqlite-node" }',
		);
		expect(piLocalRelease).toContain(
			'pkg.directory === "packages/ai" ? "build:offline" : "build"',
		);
		expect(piLocalRelease).toContain(
			'process.env.PI_LOCAL_RELEASE_USE_CHECKED_IN_MODELS !== "1"',
		);
		expect(versions).not.toMatch(/^pi-acp@/m);
		expect(versions).not.toMatch(
			/^@earendil-works\/pi-coding-agent@/m,
		);
		expect(setup).not.toContain("npm view");
	});
});
