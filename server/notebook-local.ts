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
 * The workbench working copy of a template.
 *
 * A template lives as `template.md` at the root of the launched application's
 * workbench checkout, carrying front matter that records where it was copied
 * from and whether it has since been edited. Editing writes here; saving to
 * GitHub reads from here. The file travels with the application and is
 * published alongside it.
 *
 * The path is a module constant, never request data: nothing the browser sends
 * selects a file, so this module has no traversal surface. Note in particular
 * that `frontMatter.file` records the *origin* path inside the template
 * repository — it is metadata written into the file's body and must never be
 * joined onto a filesystem path.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	EMPTY_TEMPLATE_FRONT_MATTER,
	parseTemplateDocument,
	serializeTemplateDocument,
} from "../src/services/notebook";
import type { TemplateFrontMatter } from "../src/types/notebook";
import { executeShellCommand } from "./shell-executor";

/** Workbench-relative name of the working copy. Never request-controlled. */
export const LOCAL_TEMPLATE_FILE = "template.md";

export interface LocalTemplate {
	exists: boolean;
	frontMatter: TemplateFrontMatter;
	prompts: string[];
}

export interface LocalTemplateSaveResult {
	path: string;
	staged: boolean;
}

function templatePath(projectDir: string): string {
	return join(projectDir, LOCAL_TEMPLATE_FILE);
}

/**
 * Read the working copy, if any. A missing file is an ordinary state — an
 * application that has never used a template — so it resolves to
 * `exists: false` instead of throwing.
 */
export async function readLocalTemplate(
	projectDir: string,
): Promise<LocalTemplate> {
	let markdown: string;
	try {
		markdown = await readFile(templatePath(projectDir), "utf8");
	} catch {
		return {
			exists: false,
			frontMatter: { ...EMPTY_TEMPLATE_FRONT_MATTER, extra: {} },
			prompts: [],
		};
	}
	const parsed = parseTemplateDocument(markdown);
	return {
		exists: true,
		frontMatter: parsed.frontMatter,
		prompts: parsed.prompts,
	};
}

/**
 * Write the working copy and stage it.
 *
 * Staging is best-effort and deliberately stops short of committing: the
 * application's own save in Trustable already runs `git add -A` followed by a
 * commit and push, so the template rides along with the user's other changes
 * instead of producing commits they did not ask for. A workbench that is not a
 * git checkout still gets the file, reported as `staged: false`.
 */
export async function saveLocalTemplate(
	projectDir: string,
	frontMatter: TemplateFrontMatter,
	prompts: string[],
): Promise<LocalTemplateSaveResult> {
	await writeFile(
		templatePath(projectDir),
		serializeTemplateDocument(frontMatter, prompts),
		"utf8",
	);
	let staged = false;
	try {
		const result = await executeShellCommand({
			command: `git add -- ${LOCAL_TEMPLATE_FILE}`,
			cwd: projectDir,
		});
		staged = result.exitCode === 0;
	} catch {
		staged = false;
	}
	return { path: LOCAL_TEMPLATE_FILE, staged };
}

/**
 * Bound front matter arriving from the browser before it reaches the disk.
 *
 * Same posture as `normalizeNotebookSessionState`: whitelist, bound, never
 * trust. `repo` and `file` are validated for shape so the recorded provenance
 * cannot be nonsense, even though neither ever selects a write destination.
 */
export function sanitizeTemplateFrontMatter(
	value: unknown,
): TemplateFrontMatter {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Bad request: invalid template front matter");
	}
	const input = value as Record<string, unknown>;
	const scalar = (field: string, max: number): string => {
		const entry = input[field] ?? "";
		if (typeof entry !== "string" || entry.length > max) {
			throw new Error(`Bad request: invalid template ${field}`);
		}
		if (/[\r\n]/.test(entry)) {
			throw new Error(`Bad request: template ${field} cannot span lines`);
		}
		return entry.trim();
	};
	const name = scalar("name", 200);
	if (/[[\]]/.test(name)) {
		throw new Error("Bad request: template name cannot contain brackets");
	}
	const repo = scalar("repo", 300);
	if (repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
		throw new Error("Bad request: template repo must be owner/repository");
	}
	const file = scalar("file", 500);
	if (file && (file.includes("..") || file.startsWith("/") || !file.endsWith(".md"))) {
		throw new Error("Bad request: template file must be a repository .md path");
	}
	const extra: Record<string, string> = {};
	const rawExtra = input.extra;
	if (rawExtra && typeof rawExtra === "object" && !Array.isArray(rawExtra)) {
		for (const [key, entry] of Object.entries(
			rawExtra as Record<string, unknown>,
		)) {
			if (
				typeof entry === "string" &&
				entry.length <= 500 &&
				/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) &&
				!["name", "repo", "file", "edited"].includes(key)
			) {
				extra[key] = entry.replace(/[\r\n]+/g, " ");
			}
		}
	}
	return { name, repo, file, edited: input.edited === true, extra };
}
