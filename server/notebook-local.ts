/**
 * Local template fallback.
 *
 * When the configured template repository is read-only (no GitHub write token),
 * an edited template cannot go back to GitHub. It is instead written to a fixed
 * `template.md` at the root of the launched application's workbench checkout and
 * staged with `git add`, so the saved template travels with the application and
 * is published alongside it.
 *
 * The path is a module constant rather than request data: nothing the browser
 * sends selects a file, so this module has no traversal surface.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	parseNotebookMarkdown,
	serializeNotebookMarkdown,
} from "../src/services/notebook";
import { executeShellCommand } from "./shell-executor";

/** Workbench-relative name of the saved template. Never request-controlled. */
export const LOCAL_TEMPLATE_FILE = "template.md";

/** Display name used for the saved template's entry in the template list. */
export const LOCAL_TEMPLATE_NAME = "Saved Template";

export interface LocalTemplate {
	exists: boolean;
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
 * Read the saved template, if any. A missing file is an ordinary state — the
 * common case is an application that has never saved one — so it resolves to
 * `exists: false` instead of throwing.
 */
export async function readLocalTemplate(
	projectDir: string,
): Promise<LocalTemplate> {
	let markdown: string;
	try {
		markdown = await readFile(templatePath(projectDir), "utf8");
	} catch {
		return { exists: false, prompts: [] };
	}
	return { exists: true, prompts: parseNotebookMarkdown(markdown) };
}

/**
 * Write the saved template and stage it. Serialization is shared with the
 * GitHub path so a template saved locally and one saved upstream are
 * byte-identical.
 *
 * Staging is best-effort: a workbench that is not a git checkout, or a git
 * invocation that fails, still leaves a written file the user can recover, so
 * the failure is reported as `staged: false` rather than losing the save.
 */
export async function saveLocalTemplate(
	projectDir: string,
	prompts: string[],
): Promise<LocalTemplateSaveResult> {
	await writeFile(
		templatePath(projectDir),
		serializeNotebookMarkdown(prompts),
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
