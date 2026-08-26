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
 * Minimal .env loader for the standalone client.
 *
 * Secrets (API keys) are never stored in config.json. They live in a gitignored
 * .env file as `NAME=value` lines and are loaded into process.env at startup,
 * where config.json's `apiKeyEnvVar` references resolve them. Kept dependency-free
 * (no dotenv) so the server has no extra runtime deps for Phase 1.
 */
import { readFile } from "fs/promises";
import { resolve, isAbsolute } from "path";

/**
 * Parse and apply a .env file into process.env. Existing process.env values are
 * NOT overwritten (real environment wins over the file). Missing file is a no-op.
 *
 * Supported syntax: `KEY=value`, `export KEY=value`, `# comments`, blank lines,
 * and single- or double-quoted values. Intentionally simple.
 */
export async function loadDotEnv(envPath: string): Promise<void> {
	const abs = isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
	let text: string;
	try {
		text = await readFile(abs, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const withoutExport = line.startsWith("export ")
			? line.slice("export ".length)
			: line;
		const eq = withoutExport.indexOf("=");
		if (eq === -1) continue;

		const key = withoutExport.slice(0, eq).trim();
		if (!key) continue;

		let value = withoutExport.slice(eq + 1).trim();
		// Strip matching surrounding quotes
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}

		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}
