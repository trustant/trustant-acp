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

/**
 * Server bundle build — packages the standalone ACP server into a single
 * self-contained CommonJS file (dist-bin/truacp.cjs) that `node` can run with
 * no node_modules present.
 *
 * The web UI is already embedded into the server via
 * server/web-bundle.generated.ts (produced by esbuild.web.mjs), so bundling
 * server/index.ts pulls the whole UI in too. Everything except Node builtins is
 * inlined (ws, the ACP SDK, react-markdown, …). Run `npm run build:web` first so
 * the embedded bundle is current.
 *
 * Usage: node esbuild.server.mjs
 */
import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { mkdirSync } from "node:fs";

const outdir = "dist-bin";
const outfile = `${outdir}/truacp.cjs`;

mkdirSync(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ["server/index.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	outfile,
	// Node's own modules stay external; everything else is inlined so the file
	// runs standalone.
	external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	// A shebang so the launcher can exec it directly if desired. Also derive a
	// CJS-safe module URL from __filename for the import.meta define below.
	banner: {
		js: "#!/usr/bin/env node\nconst __IMPORT_META__ = { url: require('node:url').pathToFileURL(__filename).href };",
	},
	// import.meta is invalid in the CJS output; esbuild would rewrite it to `{}`
	// and warn. Define the whole `import.meta` object (covers both the
	// `typeof import.meta` guard and `import.meta.url`) so index.ts's on-disk
	// fallback path still resolves correctly and the build stays warning-free.
	define: { "import.meta": "__IMPORT_META__" },
	logLevel: "info",
	sourcemap: false,
	minify: true,
	treeShaking: true,
});

console.log(`[server] bundled → ${outfile}`);
