import { describe, expect, it } from "vitest";
import {
	NotebookGitHubService,
	normalizeNotebookRepository,
	validateNotebookPath,
} from "../server/notebook-github";

function content(text: string, sha: string): Response {
	return new Response(
		JSON.stringify({
			sha,
			path: "README.md",
			encoding: "base64",
			content: Buffer.from(text).toString("base64"),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("NotebookGitHubService", () => {
	it("reads a public index without an authorization header", async () => {
		const calls: RequestInit[] = [];
		const service = new NotebookGitHubService(
			async (_url, init = {}) => {
				calls.push(init);
				return content("- [One](one.md)\n", "readme-sha");
			},
			() => "",
		);
		const index = await service.readIndex("trustable-ai/notebooks", "main");
		expect(index.hasToken).toBe(false);
		expect(index.entries[0].path).toBe("one.md");
		expect(
			(calls[0].headers as Record<string, string>).authorization,
		).toBeUndefined();
	});

	it("uses the server token for writes but never returns it", async () => {
		const token = "github-secret";
		const calls: RequestInit[] = [];
		let count = 0;
		const service = new NotebookGitHubService(
			async (_url, init = {}) => {
				calls.push(init);
				count++;
				if (count === 1) return content("Prompt\n", "old-sha");
				return new Response(
					JSON.stringify({ content: { sha: "new-sha" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			() => token,
		);
		const result = await service.saveNotebook({
			repository: "trustable-ai/notebooks",
			ref: "main",
			path: "one.md",
			sha: "old-sha",
			prompts: ["Updated"],
		});
		expect(result).toEqual({ sha: "new-sha", hasToken: true });
		expect(
			(calls[1].headers as Record<string, string>).authorization,
		).toBe(`Bearer ${token}`);
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("rejects stale SHA before attempting a write", async () => {
		let calls = 0;
		const service = new NotebookGitHubService(
			async () => {
				calls++;
				return content("Remote", "remote-sha");
			},
			() => "token",
		);
		await expect(
			service.saveNotebook({
				repository: "trustable-ai/notebooks",
				ref: "main",
				path: "one.md",
				sha: "stale-sha",
				prompts: ["Local"],
			}),
		).rejects.toThrow(/Conflict/);
		expect(calls).toBe(1);
	});

	it("redacts the token from GitHub failures", async () => {
		const token = "secret-in-error";
		const service = new NotebookGitHubService(
			async () =>
				new Response(JSON.stringify({ message: `failed ${token}` }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
			() => token,
		);
		await expect(
			service.readIndex("trustable-ai/notebooks", "main"),
		).rejects.not.toThrow(token);
	});
});

describe("notebook GitHub validation", () => {
	it("accepts owner/repo and github.com URLs", () => {
		expect(normalizeNotebookRepository("owner/repo")).toBe("owner/repo");
		expect(
			normalizeNotebookRepository("https://github.com/owner/repo.git"),
		).toBe("owner/repo");
	});

	it("rejects traversal and non-Markdown paths", () => {
		expect(() => validateNotebookPath("../secret.md")).toThrow(/invalid/);
		expect(() => validateNotebookPath("prompt.txt")).toThrow(/invalid/);
		expect(() => validateNotebookPath("README.md")).toThrow(/invalid/);
	});
});
