import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	LOCAL_TEMPLATE_FILE,
	readLocalTemplate,
	saveLocalTemplate,
} from "../server/notebook-local";

const execFile = promisify(execFileCallback);

async function workbench(): Promise<string> {
	return mkdtemp(join(tmpdir(), "trustable-template-"));
}

describe("local template fallback", () => {
	it("reports no template when the application has never saved one", async () => {
		expect(await readLocalTemplate(await workbench())).toEqual({
			exists: false,
			prompts: [],
		});
	});

	it("round-trips prompts through the shared notebook serialization", async () => {
		const dir = await workbench();
		await saveLocalTemplate(dir, ["first", "second\nline"]);
		expect(
			await readFile(join(dir, LOCAL_TEMPLATE_FILE), "utf8"),
		).toBe("first\n\n---\n\nsecond\nline\n");
		expect(await readLocalTemplate(dir)).toEqual({
			exists: true,
			prompts: ["first", "second\nline"],
		});
	});

	it("overwrites a previously saved template", async () => {
		const dir = await workbench();
		await saveLocalTemplate(dir, ["old"]);
		await saveLocalTemplate(dir, ["new"]);
		expect((await readLocalTemplate(dir)).prompts).toEqual(["new"]);
	});

	it("still writes the file when the workbench is not a git checkout", async () => {
		const dir = await workbench();
		const result = await saveLocalTemplate(dir, ["prompt"]);
		expect(result.path).toBe(LOCAL_TEMPLATE_FILE);
		expect(result.staged).toBe(false);
		expect((await readLocalTemplate(dir)).exists).toBe(true);
	});

	it("stages the saved template in a git workbench", async () => {
		const dir = await workbench();
		await execFile("git", ["init", "-q"], { cwd: dir });
		const result = await saveLocalTemplate(dir, ["prompt"]);
		expect(result.staged).toBe(true);
		const { stdout } = await execFile(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd: dir },
		);
		expect(stdout.trim()).toBe(LOCAL_TEMPLATE_FILE);
	});

	it("parses a hand-written template file", async () => {
		const dir = await workbench();
		await writeFile(
			join(dir, LOCAL_TEMPLATE_FILE),
			"one\n\n---\n\ntwo\n",
			"utf8",
		);
		expect((await readLocalTemplate(dir)).prompts).toEqual(["one", "two"]);
	});
});
