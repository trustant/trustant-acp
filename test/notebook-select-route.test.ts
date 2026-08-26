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

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { routes, type RouteContext } from "../server/routes";
import { readLocalTemplate, saveLocalTemplate } from "../server/notebook-local";
import type { TemplateFrontMatter } from "../src/types/notebook";

async function workbench(): Promise<string> {
	return mkdtemp(join(tmpdir(), "truacp-select-"));
}

function context(projectDir: string): RouteContext {
	return {
		host: { projectDir: vi.fn(() => projectDir) },
		store: {},
		config: {},
	} as unknown as RouteContext;
}

function frontMatter(
	overrides: Partial<TemplateFrontMatter> = {},
): TemplateFrontMatter {
	return {
		name: "Existing",
		repo: "trustable-ai/templates",
		file: "existing.md",
		edited: false,
		extra: {},
		...overrides,
	};
}

/** Serve a catalog file plus its README through the fetch the service uses. */
function stubGitHub(): void {
	vi.stubGlobal("fetch", async (url: string | URL) => {
		const body = String(url).includes("README.md")
			? "- [Build](build.md)\n"
			: "step one\n\n---\n\nstep two\n";
		return new Response(
			JSON.stringify({
				sha: "sha",
				path: "build.md",
				encoding: "base64",
				content: Buffer.from(body).toString("base64"),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
}

const selectBody = {
	repository: "trustable-ai/templates",
	ref: "main",
	name: "Build",
	path: "build.md",
	readmeSha: "sha",
};

describe("POST /api/notebooks/select", () => {
	it("copies a catalog entry into the workbench with its provenance", async () => {
		stubGitHub();
		const dir = await workbench();
		const result = await routes["POST /api/notebooks/select"](
			context(dir),
			selectBody,
		);
		expect(result.prompts).toEqual(["step one", "step two"]);
		expect(result.frontMatter).toEqual({
			name: "Build",
			repo: "trustable-ai/templates",
			file: "build.md",
			edited: false,
			extra: {},
		});
		// It is the file on disk that matters, not just the response.
		const local = await readLocalTemplate(dir);
		expect(local.exists).toBe(true);
		expect(local.frontMatter.edited).toBe(false);
		expect(local.prompts).toEqual(["step one", "step two"]);
		vi.unstubAllGlobals();
	});

	it("replaces an unedited working copy without asking", async () => {
		stubGitHub();
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter(), ["old"]);
		await routes["POST /api/notebooks/select"](context(dir), selectBody);
		expect((await readLocalTemplate(dir)).prompts).toEqual([
			"step one",
			"step two",
		]);
		vi.unstubAllGlobals();
	});

	it("refuses to discard an edited working copy", async () => {
		stubGitHub();
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter({ edited: true }), ["mine"]);
		await expect(
			routes["POST /api/notebooks/select"](context(dir), selectBody),
		).rejects.toThrow(/Conflict/);
		// The user's work is still there.
		expect((await readLocalTemplate(dir)).prompts).toEqual(["mine"]);
		vi.unstubAllGlobals();
	});

	it("replaces an edited working copy once confirmed", async () => {
		stubGitHub();
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter({ edited: true }), ["mine"]);
		await routes["POST /api/notebooks/select"](context(dir), {
			...selectBody,
			force: true,
		});
		expect((await readLocalTemplate(dir)).prompts).toEqual([
			"step one",
			"step two",
		]);
		vi.unstubAllGlobals();
	});
});

describe("PUT /api/notebooks/save-local", () => {
	it("forces the edited flag even when the client claims otherwise", async () => {
		// Clearing the flag is the server's conclusion after an upstream save;
		// a client must not be able to mark diverged work as pristine.
		const dir = await workbench();
		await routes["PUT /api/notebooks/save-local"](context(dir), {
			frontMatter: { ...frontMatter(), edited: false },
			prompts: ["local edit"],
		});
		expect((await readLocalTemplate(dir)).frontMatter.edited).toBe(true);
	});

	it("rejects a traversing origin path", async () => {
		const dir = await workbench();
		await expect(
			routes["PUT /api/notebooks/save-local"](context(dir), {
				frontMatter: { ...frontMatter(), file: "../escape.md" },
				prompts: ["p"],
			}),
		).rejects.toThrow(/Bad request/);
	});
});

describe("PUT /api/notebooks/save-template", () => {
	it("refuses when there is no working copy", async () => {
		const dir = await workbench();
		await expect(
			routes["PUT /api/notebooks/save-template"](context(dir), {
				name: "Build",
				file: "build.md",
			}),
		).rejects.toThrow(/no working copy/);
	});

	it("refuses when the working copy has no changes", async () => {
		const dir = await workbench();
		await saveLocalTemplate(dir, frontMatter({ edited: false }), ["p"]);
		await expect(
			routes["PUT /api/notebooks/save-template"](context(dir), {
				name: "Build",
				file: "build.md",
			}),
		).rejects.toThrow(/no changes to save/);
	});

	it("ignores prompts a client might try to supply", async () => {
		// Prompts come from template.md so a stale client cannot publish
		// content the workbench never held.
		const dir = await workbench();
		await writeFile(
			join(dir, "template.md"),
			"---\nname: Build\nrepo: trustable-ai/templates\nfile: build.md\nedited: true\n---\n\nreal content\n",
			"utf8",
		);
		const written: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
			if (init.method === "PUT") {
				const body = JSON.parse(String(init.body)) as { content: string };
				written.push(Buffer.from(body.content, "base64").toString("utf8"));
				return new Response(
					JSON.stringify({ content: { sha: "new-sha" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			const text = String(url).includes("README.md")
				? "- [Build](build.md)\n"
				: "old\n";
			return new Response(
				JSON.stringify({
					sha: "sha",
					path: "build.md",
					encoding: "base64",
					content: Buffer.from(text).toString("base64"),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		process.env.NOTEBOOK_GITHUB_TOKEN = "token";
		try {
			const result = await routes["PUT /api/notebooks/save-template"](
				context(dir),
				{ name: "Build", file: "build.md", prompts: ["injected"] } as never,
			);
			expect(written.join("\n")).toContain("real content");
			expect(written.join("\n")).not.toContain("injected");
			// A successful upstream save clears the edited flag.
			expect(result.frontMatter.edited).toBe(false);
			expect((await readLocalTemplate(dir)).frontMatter.edited).toBe(false);
		} finally {
			delete process.env.NOTEBOOK_GITHUB_TOKEN;
			vi.unstubAllGlobals();
		}
	});
});
