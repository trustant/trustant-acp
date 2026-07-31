import {
	addNotebookIndexEntry,
	parseNotebookIndex,
	parseNotebookMarkdown,
	removeNotebookIndexEntry,
	serializeNotebookMarkdown,
} from "../src/services/notebook";
import type {
	NotebookDocumentResponse,
	NotebookIndexEntry,
	NotebookIndexResponse,
	NotebookMutationResponse,
	NotebookSource,
} from "../src/types/notebook";

export const DEFAULT_NOTEBOOK_SOURCE = "trustable-ai/templates";
export const DEFAULT_NOTEBOOK_REF = "main";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

class GitHubRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

interface GitHubContent {
	sha: string;
	path: string;
	encoding: string;
	content: string;
}

interface GitHubWriteResult {
	content?: { sha?: string };
}

function redact(value: string, token: string): string {
	return token ? value.split(token).join("[REDACTED]") : value;
}

function validateRef(ref: string): string {
	const normalized = (ref || DEFAULT_NOTEBOOK_REF).trim();
	if (
		!normalized ||
		normalized.length > 200 ||
		normalized.startsWith("/") ||
		normalized.endsWith("/") ||
		normalized.includes("..") ||
		normalized.includes("\\") ||
		!/[A-Za-z0-9]/.test(normalized) ||
		!/^[A-Za-z0-9._/-]+$/.test(normalized)
	) {
		throw new Error("Bad request: invalid notebook branch/ref");
	}
	return normalized;
}

export function normalizeNotebookRepository(source: string): string {
	let raw = (source || DEFAULT_NOTEBOOK_SOURCE).trim();
	if (/^https?:\/\//i.test(raw)) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error("Bad request: invalid notebook GitHub URL");
		}
		if (url.hostname.toLowerCase() !== "github.com") {
			throw new Error("Bad request: notebook source must use github.com");
		}
		raw = url.pathname.replace(/^\/+|\/+$/g, "");
	}
	raw = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
	const parts = raw.split("/");
	const segment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
	if (
		parts.length !== 2 ||
		!segment.test(parts[0]) ||
		!segment.test(parts[1])
	) {
		throw new Error(
			"Bad request: notebook source must be owner/repository or a GitHub repository URL",
		);
	}
	return `${parts[0]}/${parts[1]}`;
}

export function validateNotebookPath(path: string): string {
	const normalized = path.trim();
	if (
		!normalized ||
		normalized.length > 500 ||
		normalized.startsWith("/") ||
		normalized.includes("\\") ||
		normalized.split("/").some((part) => !part || part === "." || part === "..") ||
		!/\.md$/i.test(normalized) ||
		normalized.toLowerCase() === "readme.md"
	) {
		throw new Error("Bad request: invalid notebook Markdown path");
	}
	return normalized;
}

function validateName(name: string): string {
	const normalized = name.trim();
	if (!normalized || normalized.length > 200 || /[\r\n[\]]/.test(normalized)) {
		throw new Error("Bad request: invalid notebook name");
	}
	return normalized;
}

function validateComment(comment: string): string {
	const normalized = comment.trim();
	if (normalized.length > 500 || /[\r\n]/.test(normalized)) {
		throw new Error("Bad request: invalid notebook comment");
	}
	return normalized;
}

function encodedPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export class NotebookGitHubService {
	constructor(
		// Resolved per call rather than captured at construction: the route
		// module builds one service at import time, and binding fetch there
		// would freeze it before a test could substitute one.
		private readonly fetchImpl: FetchLike = (input, init) =>
			fetch(input, init),
		private readonly tokenProvider: () => string = () =>
			process.env.NOTEBOOK_GITHUB_TOKEN?.trim() ?? "",
	) {}

	hasToken(): boolean {
		return Boolean(this.tokenProvider());
	}

	private source(repository?: string, ref?: string): NotebookSource {
		const managed = process.env.TRUSTABLE_MANAGED_RUNTIME === "1";
		const selectedRepository = managed
			? process.env.NOTEBOOK_GITHUB_REPOSITORY
			: repository;
		const selectedRef = managed ? process.env.NOTEBOOK_GITHUB_REF : ref;
		return {
			repository: normalizeNotebookRepository(
				selectedRepository || DEFAULT_NOTEBOOK_SOURCE,
			),
			ref: validateRef(selectedRef || DEFAULT_NOTEBOOK_REF),
		};
	}

	private requireToken(): string {
		const token = this.tokenProvider();
		if (!token) {
			throw new Error(
				process.env.TRUSTABLE_MANAGED_RUNTIME === "1"
					? "Forbidden: configure notebook GitHub write access in Trustable Configure"
					: "Forbidden: set NOTEBOOK_GITHUB_TOKEN in the server .env to modify notebooks",
			);
		}
		return token;
	}

	private async request<T>(
		source: NotebookSource,
		path: string,
		init: RequestInit = {},
		token = this.tokenProvider(),
	): Promise<T> {
		const [owner, repo] = source.repository.split("/");
		const url = new URL(
			`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
				repo,
			)}/contents/${encodedPath(path)}`,
		);
		if (!init.method || init.method === "GET") {
			url.searchParams.set("ref", source.ref);
		}
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"user-agent": "trustable-acp-notebooks",
			...(init.headers as Record<string, string> | undefined),
		};
		if (token) headers.authorization = `Bearer ${token}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, { ...init, headers });
		} catch (error) {
			throw new Error(
				`Upstream: GitHub request failed: ${redact(
					String((error as Error).message ?? error),
					token,
				)}`,
			);
		}
		const payload = (await response.json().catch(() => ({}))) as {
			message?: string;
		};
		if (!response.ok) {
			const detail = redact(
				payload.message || `GitHub returned ${response.status}`,
				token,
			);
			throw new GitHubRequestError(response.status, detail);
		}
		return payload as T;
	}

	private async readContent(
		source: NotebookSource,
		path: string,
	): Promise<{ sha: string; text: string }> {
		let content: GitHubContent;
		try {
			content = await this.request<GitHubContent>(source, path);
		} catch (error) {
			if (error instanceof GitHubRequestError) throw error;
			throw error;
		}
		if (
			content.encoding !== "base64" ||
			typeof content.content !== "string" ||
			typeof content.sha !== "string"
		) {
			throw new Error(`Upstream: invalid GitHub content response for ${path}`);
		}
		return {
			sha: content.sha,
			text: Buffer.from(content.content.replace(/\s/g, ""), "base64").toString(
				"utf8",
			),
		};
	}

	private async writeContent(
		source: NotebookSource,
		path: string,
		text: string,
		message: string,
		sha?: string,
	): Promise<string> {
		const token = this.requireToken();
		let result: GitHubWriteResult;
		try {
			result = await this.request<GitHubWriteResult>(
				source,
				path,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						message,
						content: Buffer.from(text, "utf8").toString("base64"),
						branch: source.ref,
						...(sha ? { sha } : {}),
					}),
				},
				token,
			);
		} catch (error) {
			if (
				error instanceof GitHubRequestError &&
				(error.status === 409 || error.status === 422)
			) {
				throw new Error(`Conflict: ${error.message}`);
			}
			if (
				error instanceof GitHubRequestError &&
				(error.status === 401 || error.status === 403)
			) {
				throw new Error(`Forbidden: ${error.message}`);
			}
			if (error instanceof GitHubRequestError) {
				throw new Error(`Upstream: ${error.message}`);
			}
			throw error;
		}
		const writtenSha = result.content?.sha;
		if (!writtenSha) {
			throw new Error(`Upstream: GitHub did not return a SHA for ${path}`);
		}
		return writtenSha;
	}

	private async deleteContent(
		source: NotebookSource,
		path: string,
		sha: string,
		message: string,
	): Promise<void> {
		const token = this.requireToken();
		try {
			await this.request(
				source,
				path,
				{
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ message, sha, branch: source.ref }),
				},
				token,
			);
		} catch (error) {
			if (
				error instanceof GitHubRequestError &&
				(error.status === 409 || error.status === 422)
			) {
				throw new Error(`Conflict: ${error.message}`);
			}
			if (
				error instanceof GitHubRequestError &&
				(error.status === 401 || error.status === 403)
			) {
				throw new Error(`Forbidden: ${error.message}`);
			}
			if (error instanceof GitHubRequestError) {
				throw new Error(`Upstream: ${error.message}`);
			}
			throw error;
		}
	}

	private indexResult(
		source: NotebookSource,
		readmeSha: string,
		readme: string,
	): NotebookIndexResponse {
		return {
			source,
			hasToken: this.hasToken(),
			readmeSha,
			entries: parseNotebookIndex(readme),
		};
	}

	async readIndex(repository?: string, ref?: string): Promise<NotebookIndexResponse> {
		const source = this.source(repository, ref);
		try {
			const readme = await this.readContent(source, "README.md");
			return this.indexResult(source, readme.sha, readme.text);
		} catch (error) {
			if (error instanceof GitHubRequestError) {
				if (error.status === 404) {
					throw new Error("Upstream: notebook README.md was not found");
				}
				if (error.status === 401 || error.status === 403) {
					throw new Error(`Forbidden: ${error.message}`);
				}
				throw new Error(`Upstream: ${error.message}`);
			}
			throw error;
		}
	}

	async loadNotebook(request: {
		repository: string;
		ref: string;
		name: string;
		path: string;
		readmeSha: string;
	}): Promise<NotebookDocumentResponse> {
		const source = this.source(request.repository, request.ref);
		const path = validateNotebookPath(request.path);
		const name = validateName(request.name);
		const notebook = await this.readContent(source, path).catch((error) => {
			if (error instanceof GitHubRequestError) {
				if (error.status === 404) {
					throw new Error(`Upstream: notebook file was not found: ${path}`);
				}
				throw new Error(`Upstream: ${error.message}`);
			}
			throw error;
		});
		return {
			source,
			hasToken: this.hasToken(),
			name,
			path,
			sha: notebook.sha,
			readmeSha: request.readmeSha,
			prompts: parseNotebookMarkdown(notebook.text),
		};
	}

	/**
	 * Save the workbench working copy back to the template repository.
	 *
	 * Prompts come from the caller's reading of `template.md`, never from the
	 * browser, so a stale client cannot publish prompts the workbench never
	 * held. The target repository is resolved through `source()`, which under a
	 * managed runtime ignores the requested repository entirely — the token was
	 * issued for the configured repository, and honouring a repository named in
	 * a template file would turn any template into a redirect for an
	 * authenticated write.
	 *
	 * The file and the README index are separate commits, so a failure between
	 * them is reported explicitly rather than left silently half-applied.
	 */
	async saveTemplate(request: {
		repository: string;
		ref: string;
		name: string;
		file: string;
		prompts: string[];
	}): Promise<{
		sha: string;
		index: NotebookIndexResponse;
		source: NotebookSource;
		name: string;
		file: string;
	}> {
		const source = this.source(request.repository, request.ref);
		const name = validateName(request.name);
		const path = validateNotebookPath(request.file);
		if (!Array.isArray(request.prompts) || !request.prompts.length) {
			throw new Error("Bad request: template prompts are required");
		}
		this.requireToken();
		const readme = await this.readContent(source, "README.md");
		const entries = parseNotebookIndex(readme.text);
		const indexed = entries.find((candidate) => candidate.path === path);
		// A name already used by a *different* file would make the index
		// ambiguous, so it is rejected before anything is written.
		if (
			entries.some(
				(candidate) => candidate.name === name && candidate.path !== path,
			)
		) {
			throw new Error("Conflict: another template already uses that name");
		}

		let existingSha: string | undefined;
		try {
			existingSha = (await this.readContent(source, path)).sha;
		} catch (error) {
			if (!(error instanceof GitHubRequestError) || error.status !== 404) {
				if (error instanceof GitHubRequestError) {
					throw new Error(`Upstream: ${error.message}`);
				}
				throw error;
			}
		}

		const sha = await this.writeContent(
			source,
			path,
			serializeNotebookMarkdown(request.prompts),
			existingSha ? `Update template ${name}` : `Add template ${name}`,
			existingSha,
		);

		// The index only needs rewriting when the file is new or was renamed.
		const entry: NotebookIndexEntry = {
			name,
			path,
			comment: indexed?.comment ?? "",
		};
		if (indexed && indexed.name === name) {
			return {
				sha,
				index: this.indexResult(source, readme.sha, readme.text),
				source,
				name,
				file: path,
			};
		}
		const updatedReadme = addNotebookIndexEntry(
			indexed ? removeNotebookIndexEntry(readme.text, path) : readme.text,
			entry,
		);
		let readmeSha: string;
		try {
			readmeSha = await this.writeContent(
				source,
				"README.md",
				updatedReadme,
				`Index template ${name}`,
				readme.sha,
			);
		} catch (error) {
			throw new Error(
				`Partial mutation: template file ${path} was saved, but README.md was not updated: ${String(
					(error as Error).message ?? error,
				)}`,
			);
		}
		return {
			sha,
			index: this.indexResult(source, readmeSha, updatedReadme),
			source,
			name,
			file: path,
		};
	}

	async addNotebook(request: {
		repository: string;
		ref: string;
		readmeSha: string;
		name: string;
		path: string;
		comment?: string;
		prompts?: string[];
	}): Promise<NotebookMutationResponse> {
		const source = this.source(request.repository, request.ref);
		const entry: NotebookIndexEntry = {
			name: validateName(request.name),
			path: validateNotebookPath(request.path),
			comment: validateComment(request.comment ?? ""),
		};
		this.requireToken();
		const readme = await this.readContent(source, "README.md");
		if (readme.sha !== request.readmeSha) {
			throw new Error(
				"Conflict: the notebook index changed on GitHub; reload it before adding",
			);
		}
		if (
			parseNotebookIndex(readme.text).some(
				(candidate) =>
					candidate.path === entry.path || candidate.name === entry.name,
			)
		) {
			throw new Error("Conflict: notebook name or path already exists");
		}
		try {
			await this.readContent(source, entry.path);
			throw new Error("Conflict: notebook file already exists");
		} catch (error) {
			if (
				!(error instanceof GitHubRequestError) ||
				error.status !== 404
			) {
				throw error;
			}
		}
		const prompts =
			Array.isArray(request.prompts) && request.prompts.length
				? request.prompts
				: ["New prompt"];
		const fileSha = await this.writeContent(
			source,
			entry.path,
			serializeNotebookMarkdown(prompts),
			`Add notebook ${entry.name}`,
		);
		let readmeSha: string;
		const updatedReadme = addNotebookIndexEntry(readme.text, entry);
		try {
			readmeSha = await this.writeContent(
				source,
				"README.md",
				updatedReadme,
				`Index notebook ${entry.name}`,
				readme.sha,
			);
		} catch (error) {
			throw new Error(
				`Partial mutation: notebook file ${entry.path} was created, but README.md was not updated: ${String(
					(error as Error).message ?? error,
				)}`,
			);
		}
		const index = this.indexResult(source, readmeSha, updatedReadme);
		return {
			index,
			notebook: {
				source,
				hasToken: true,
				name: entry.name,
				path: entry.path,
				sha: fileSha,
				readmeSha,
				prompts,
			},
		};
	}

	async removeNotebook(request: {
		repository: string;
		ref: string;
		readmeSha: string;
		path: string;
	}): Promise<NotebookMutationResponse> {
		const source = this.source(request.repository, request.ref);
		const path = validateNotebookPath(request.path);
		this.requireToken();
		const readme = await this.readContent(source, "README.md");
		if (readme.sha !== request.readmeSha) {
			throw new Error(
				"Conflict: the notebook index changed on GitHub; reload it before removing",
			);
		}
		const entries = parseNotebookIndex(readme.text);
		if (!entries.some((entry) => entry.path === path)) {
			throw new Error("Conflict: notebook is no longer present in README.md");
		}
		const notebook = await this.readContent(source, path).catch((error) => {
			if (error instanceof GitHubRequestError) {
				throw new Error(`Upstream: ${error.message}`);
			}
			throw error;
		});
		const updatedReadme = removeNotebookIndexEntry(readme.text, path);
		const readmeSha = await this.writeContent(
			source,
			"README.md",
			updatedReadme,
			`Remove notebook ${path} from index`,
			readme.sha,
		);
		try {
			await this.deleteContent(
				source,
				path,
				notebook.sha,
				`Remove notebook ${path}`,
			);
		} catch (error) {
			throw new Error(
				`Partial mutation: README.md no longer indexes ${path}, but the notebook file was not deleted: ${String(
					(error as Error).message ?? error,
				)}`,
			);
		}
		return {
			index: this.indexResult(source, readmeSha, updatedReadme),
		};
	}
}
