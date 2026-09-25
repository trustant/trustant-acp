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

	it("falls back to the default template repository when none is given", async () => {
		let requested = "";
		const service = new NotebookGitHubService(async (url) => {
			requested = String(url);
			return content("- [One](one.md)\n", "readme-sha");
		}, () => "");
		const index = await service.readIndex("", "");
		expect(index.source).toEqual({
			repository: "trustable-ai/templates",
			ref: "main",
		});
		expect(requested).toContain("/repos/trustable-ai/templates/");
	});

	it("uses the Trustant-managed source instead of browser input", async () => {
		const previousManaged = process.env.TRUSTANT_MANAGED_RUNTIME;
		const previousRepository = process.env.NOTEBOOK_GITHUB_REPOSITORY;
		const previousRef = process.env.NOTEBOOK_GITHUB_REF;
		process.env.TRUSTANT_MANAGED_RUNTIME = "1";
		process.env.NOTEBOOK_GITHUB_REPOSITORY = "managed/notebooks";
		process.env.NOTEBOOK_GITHUB_REF = "release";
		let requested = "";
		try {
			const service = new NotebookGitHubService(
				async (url) => {
					requested = String(url);
					return content("- [One](one.md)\n", "readme-sha");
				},
				() => "",
			);
			const index = await service.readIndex("browser/override", "other");
			expect(index.source).toEqual({
				repository: "managed/notebooks",
				ref: "release",
			});
			expect(requested).toContain("/repos/managed/notebooks/");
			expect(requested).toContain("ref=release");
		} finally {
			if (previousManaged === undefined) {
				delete process.env.TRUSTANT_MANAGED_RUNTIME;
			} else {
				process.env.TRUSTANT_MANAGED_RUNTIME = previousManaged;
			}
			if (previousRepository === undefined) {
				delete process.env.NOTEBOOK_GITHUB_REPOSITORY;
			} else {
				process.env.NOTEBOOK_GITHUB_REPOSITORY = previousRepository;
			}
			if (previousRef === undefined) {
				delete process.env.NOTEBOOK_GITHUB_REF;
			} else {
				process.env.NOTEBOOK_GITHUB_REF = previousRef;
			}
		}
	});

	it("uses the server token for writes but never returns it", async () => {
		const token = "github-secret";
		const calls: RequestInit[] = [];
		const service = new NotebookGitHubService(
			async (url, init = {}) => {
				calls.push(init);
				if (String(url).includes("README.md")) {
					return content("- [One](one.md)\n", "readme-sha");
				}
				if (!init.method || init.method === "GET") {
					return content("Prompt\n", "old-sha");
				}
				return new Response(
					JSON.stringify({ content: { sha: "new-sha" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			() => token,
		);
		const result = await service.saveTemplate({
			repository: "trustable-ai/templates",
			ref: "main",
			name: "One",
			file: "one.md",
			prompts: ["Updated"],
		});
		expect(result.sha).toBe("new-sha");
		expect(
			calls.some(
				(call) =>
					(call.headers as Record<string, string>)?.authorization ===
					`Bearer ${token}`,
			),
		).toBe(true);
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("leaves the index alone when the name is unchanged", async () => {
		const writes: string[] = [];
		const service = new NotebookGitHubService(
			async (url, init = {}) => {
				if (init.method === "PUT") {
					writes.push(String(url));
					return new Response(
						JSON.stringify({ content: { sha: "new-sha" } }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (String(url).includes("README.md")) {
					return content("- [One](one.md)\n", "readme-sha");
				}
				return content("Prompt\n", "old-sha");
			},
			() => "token",
		);
		await service.saveTemplate({
			repository: "trustable-ai/templates",
			ref: "main",
			name: "One",
			file: "one.md",
			prompts: ["Updated"],
		});
		expect(writes.filter((url) => url.includes("README.md"))).toHaveLength(0);
	});

	it("rewrites the index entry when the template is renamed", async () => {
		let readme = "- [One](one.md) keep me\n";
		const service = new NotebookGitHubService(
			async (url, init = {}) => {
				if (init.method === "PUT") {
					const body = JSON.parse(String(init.body)) as { content: string };
					if (String(url).includes("README.md")) {
						readme = Buffer.from(body.content, "base64").toString("utf8");
					}
					return new Response(
						JSON.stringify({ content: { sha: "new-sha" } }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (String(url).includes("README.md")) {
					return content(readme, "readme-sha");
				}
				return content("Prompt\n", "old-sha");
			},
			() => "token",
		);
		await service.saveTemplate({
			repository: "trustable-ai/templates",
			ref: "main",
			name: "Renamed",
			file: "one.md",
			prompts: ["Updated"],
		});
		expect(readme).toContain("[Renamed](one.md)");
		expect(readme).not.toContain("[One](one.md)");
		expect(readme).toContain("keep me");
	});

	it("indexes a template whose file does not exist yet", async () => {
		let readme = "- [One](one.md)\n";
		const service = new NotebookGitHubService(
			async (url, init = {}) => {
				if (init.method === "PUT") {
					const body = JSON.parse(String(init.body)) as {
						content: string;
						sha?: string;
					};
					if (String(url).includes("README.md")) {
						readme = Buffer.from(body.content, "base64").toString("utf8");
					} else {
						// A new file must be written without a SHA.
						expect(body.sha).toBeUndefined();
					}
					return new Response(
						JSON.stringify({ content: { sha: "new-sha" } }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (String(url).includes("README.md")) {
					return content(readme, "readme-sha");
				}
				return new Response(JSON.stringify({ message: "Not Found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			},
			() => "token",
		);
		await service.saveTemplate({
			repository: "trustable-ai/templates",
			ref: "main",
			name: "Fresh",
			file: "fresh.md",
			prompts: ["Body"],
		});
		expect(readme).toContain("[Fresh](fresh.md)");
	});

	it("reports a partial mutation when the index write fails", async () => {
		const service = new NotebookGitHubService(
			async (url, init = {}) => {
				if (init.method === "PUT") {
					if (String(url).includes("README.md")) {
						return new Response(JSON.stringify({ message: "boom" }), {
							status: 500,
							headers: { "content-type": "application/json" },
						});
					}
					return new Response(
						JSON.stringify({ content: { sha: "new-sha" } }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (String(url).includes("README.md")) {
					return content("- [One](one.md)\n", "readme-sha");
				}
				return content("Prompt\n", "old-sha");
			},
			() => "token",
		);
		await expect(
			service.saveTemplate({
				repository: "trustable-ai/templates",
				ref: "main",
				name: "Renamed",
				file: "one.md",
				prompts: ["Updated"],
			}),
		).rejects.toThrow(/Partial mutation/);
	});

	it("refuses a name already used by another template", async () => {
		const service = new NotebookGitHubService(
			async (url) => {
				if (String(url).includes("README.md")) {
					return content("- [Taken](other.md)\n- [One](one.md)\n", "sha");
				}
				return content("Prompt\n", "old-sha");
			},
			() => "token",
		);
		await expect(
			service.saveTemplate({
				repository: "trustable-ai/templates",
				ref: "main",
				name: "Taken",
				file: "one.md",
				prompts: ["Updated"],
			}),
		).rejects.toThrow(/Conflict/);
	});

	it("ignores a browser-supplied repository under a managed runtime", async () => {
		// The token is issued for the configured repository; honouring a
		// repository named in a template file would make any template a
		// redirect for an authenticated write.
		const previousManaged = process.env.TRUSTANT_MANAGED_RUNTIME;
		const previousRepository = process.env.NOTEBOOK_GITHUB_REPOSITORY;
		process.env.TRUSTANT_MANAGED_RUNTIME = "1";
		process.env.NOTEBOOK_GITHUB_REPOSITORY = "managed/templates";
		const requested: string[] = [];
		try {
			const service = new NotebookGitHubService(
				async (url, init = {}) => {
					requested.push(String(url));
					if (init.method === "PUT") {
						return new Response(
							JSON.stringify({ content: { sha: "new-sha" } }),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					}
					if (String(url).includes("README.md")) {
						return content("- [One](one.md)\n", "readme-sha");
					}
					return content("Prompt\n", "old-sha");
				},
				() => "token",
			);
			const result = await service.saveTemplate({
				repository: "attacker/repo",
				ref: "main",
				name: "One",
				file: "one.md",
				prompts: ["Updated"],
			});
			expect(result.source.repository).toBe("managed/templates");
			expect(
				requested.every((url) => !url.includes("attacker/repo")),
			).toBe(true);
		} finally {
			process.env.TRUSTANT_MANAGED_RUNTIME = previousManaged;
			process.env.NOTEBOOK_GITHUB_REPOSITORY = previousRepository;
		}
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
