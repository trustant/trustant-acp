import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	LOCAL_TEMPLATE_FILE,
	readLocalTemplate,
	sanitizeTemplateFrontMatter,
	saveLocalTemplate,
} from "../server/notebook-local";
import type { TemplateFrontMatter } from "../src/types/notebook";

const execFile = promisify(execFileCallback);

async function workbench(): Promise<string> {
	return mkdtemp(join(tmpdir(), "trustable-template-"));
}

function frontMatter(
	overrides: Partial<TemplateFrontMatter> = {},
): TemplateFrontMatter {
	return {
		name: "Build",
		repo: "trustable-ai/templates",
		file: "flows/build.md",
		edited: false,
		extra: {},
		...overrides,
	};
}

describe("workbench working copy", () => {
	it("reports no template when the application has never used one", async () => {
		const result = await readLocalTemplate(await workbench());
		expect(result.exists).toBe(false);
		expect(result.prompts).toEqual([]);
		expect(result.frontMatter.name).toBe("");
	});

	it("writes the documented file format verbatim", async () => {
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter(), ["# Phase 1\n\nSet up.", "Test."]);
		expect(await readFile(join(dir, LOCAL_TEMPLATE_FILE), "utf8")).toBe(
			[
				"---",
				"name: Build",
				"repo: trustable-ai/templates",
				"file: flows/build.md",
				"edited: false",
				"---",
				"",
				"# Phase 1",
				"",
				"Set up.",
				"",
				"---",
				"",
				"Test.",
				"",
			].join("\n"),
		);
	});

	it("round-trips provenance and prompts", async () => {
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter({ edited: true }), [
			"first",
			"second\nline",
		]);
		const result = await readLocalTemplate(dir);
		expect(result.exists).toBe(true);
		expect(result.frontMatter).toEqual(frontMatter({ edited: true }));
		expect(result.prompts).toEqual(["first", "second\nline"]);
	});

	it("overwrites a previously saved template", async () => {
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter(), ["old"]);
		await saveLocalTemplate(dir, frontMatter({ name: "Renamed" }), ["new"]);
		const result = await readLocalTemplate(dir);
		expect(result.prompts).toEqual(["new"]);
		expect(result.frontMatter.name).toBe("Renamed");
	});

	it("still writes the file when the workbench is not a git checkout", async () => {
		const dir = await workbench();
		const result = await saveLocalTemplate(dir, frontMatter(), ["prompt"]);
		expect(result.path).toBe(LOCAL_TEMPLATE_FILE);
		expect(result.staged).toBe(false);
		expect((await readLocalTemplate(dir)).exists).toBe(true);
	});

	it("stages the saved template in a git workbench", async () => {
		const dir = await workbench();
		await execFile("git", ["init", "-q"], { cwd: dir });
		const result = await saveLocalTemplate(dir, frontMatter(), ["prompt"]);
		expect(result.staged).toBe(true);
		const { stdout } = await execFile(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd: dir },
		);
		expect(stdout.trim()).toBe(LOCAL_TEMPLATE_FILE);
	});

	it("writes template.md regardless of the recorded origin path", async () => {
		// `file` records where the template came from inside the template
		// repository; it must never influence the local filesystem path.
		const dir = await workbench();
		await saveLocalTemplate(
			dir,
			frontMatter({ file: "deeply/nested/origin.md" }),
			["prompt"],
		);
		expect((await readLocalTemplate(dir)).exists).toBe(true);
		expect(
			(await readLocalTemplate(dir)).frontMatter.file,
		).toBe("deeply/nested/origin.md");
	});

	it("parses a hand-written template file", async () => {
		const dir = await workbench();
		await writeFile(
			join(dir, LOCAL_TEMPLATE_FILE),
			"---\nname: Hand\nedited: true\n---\n\none\n\n---\n\ntwo\n",
			"utf8",
		);
		const result = await readLocalTemplate(dir);
		expect(result.frontMatter.name).toBe("Hand");
		expect(result.frontMatter.edited).toBe(true);
		expect(result.prompts).toEqual(["one", "two"]);
	});
});

describe("sanitizeTemplateFrontMatter", () => {
	it("accepts an entirely empty template", () => {
		expect(
			sanitizeTemplateFrontMatter({
				name: "",
				repo: "",
				file: "",
				edited: true,
			}),
		).toEqual({ name: "", repo: "", file: "", edited: true, extra: {} });
	});

	it("rejects a traversing origin path", () => {
		expect(() =>
			sanitizeTemplateFrontMatter({ file: "../escape.md" }),
		).toThrow(/Bad request/);
	});

	it("rejects an origin path that is not markdown", () => {
		expect(() => sanitizeTemplateFrontMatter({ file: "notes.txt" })).toThrow(
			/Bad request/,
		);
	});

	it("rejects a name that spans lines or forges a delimiter", () => {
		expect(() =>
			sanitizeTemplateFrontMatter({ name: "evil\n---\nrepo: x/y" }),
		).toThrow(/Bad request/);
	});

	it("rejects a repository that is not owner/name", () => {
		expect(() =>
			sanitizeTemplateFrontMatter({ repo: "not-a-repo" }),
		).toThrow(/Bad request/);
	});

	it("drops unknown extra keys that collide with modelled ones", () => {
		const result = sanitizeTemplateFrontMatter({
			name: "A",
			extra: { author: "me", name: "spoofed", bad: 5 },
		});
		expect(result.extra).toEqual({ author: "me" });
	});
});
