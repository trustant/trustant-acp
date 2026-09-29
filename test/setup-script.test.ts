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

import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("setup.sh Pi runtime sources", () => {
	it("verifies upstream Pi and keeps only the pi-acp fork", async () => {
		const setup = await readFile(join(process.cwd(), "setup.sh"), "utf8");
		const versions = await readFile(
			join(process.cwd(), "pi.version"),
			"utf8",
		);
		const integrities = await readFile(
			join(process.cwd(), "pi.integrity"),
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
			'cp "$TRUSTANT_EXTENSION_SOURCE" "$LIB_DIR/extensions/trustant-runtime.ts"',
		);
		expect(setup).toContain(
			'"$SCRIPT_DIR/extensions/trustant-runtime.ts"',
		);
		expect(setup).toContain(
			'cp "$TRUSTANT_REQUIREMENTS_SOURCE" "$LIB_DIR/extensions/requirements.txt"',
		);
		expect(setup).toContain('INTEGRITY_FILE="$SCRIPT_DIR/pi.integrity"');
		expect(setup).toContain('npm view "$spec" dist.integrity');
		expect(setup).toContain(
			'actual_integrity=$(npm view "$spec" dist.integrity)',
		);
		expect(setup).toContain(
			'PI_MCP_ADAPTER_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-mcp-adapter"',
		);
		expect(setup).toContain(
			"/Session not found for MCP Streamable HTTP transport/i",
		);
		expect(setup).toContain("async callToolWithSessionRecovery(");
		expect(setup).toContain(
			"state.manager.callToolWithSessionRecovery(serverName, {",
		);
		expect(setup).toContain(
			"state.manager.callToolWithSessionRecovery(spec.serverName, {",
		);
		expect(setup).toContain(
			"options.manager.callToolWithSessionRecovery(options.serverName, {",
		);
		expect(setup).toContain(
			"this is the single allowed retry",
		);
		expect(versions).not.toMatch(/^pi-acp@/m);
		for (const name of [
			"pi-ai",
			"pi-tui",
			"pi-agent-core",
			"pi-storage-sqlite-node",
			"pi-coding-agent",
		]) {
			expect(versions).toContain(`@earendil-works/${name}@0.82.0`);
			expect(integrities).toContain(
				`@earendil-works/${name}@0.82.0 sha512-`,
			);
		}
		expect(setup).not.toContain("PI_SOURCE_DIR");
		expect(setup).not.toContain("PI_PREBUILT_DIR");
		expect(setup).not.toContain("PI_LOCAL_RELEASE_USE_CHECKED_IN_MODELS");
	});
});
