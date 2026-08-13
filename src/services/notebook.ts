import type {
	NotebookIndexEntry,
	NotebookNode,
	NotebookOutput,
	NotebookSessionState,
	ParsedTemplate,
	TemplateFrontMatter,
} from "../types/notebook";

const INDEX_ENTRY =
	/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+(.*?))?\s*$/;

/** A line that is exactly `---`, which is both delimiter and prompt separator. */
const DELIMITER = /^\s*---\s*$/;

/** Flat `key: value` front matter line. Nested YAML is deliberately not supported. */
const FRONT_MATTER_ENTRY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/**
 * Upper bound on the front matter block, in lines.
 *
 * Without a cap, a template whose first prompt happens to be followed by a
 * separator far down the file would have everything above it swallowed as
 * metadata. Four modelled keys plus room for hand-added ones.
 */
const FRONT_MATTER_MAX_LINES = 20;

export const EMPTY_TEMPLATE_FRONT_MATTER: TemplateFrontMatter = {
	name: "",
	repo: "",
	file: "",
	edited: false,
	extra: {},
};

/** Strip the delimiters a value could otherwise forge when re-serialized. */
function frontMatterValue(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function parseBoolean(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "yes" || normalized === "1";
}

/**
 * Split a leading front matter block from the prompt body.
 *
 * MUST run before `parseNotebookMarkdown`. The front matter delimiter and the
 * prompt separator are the same `---` token, so the block can only be
 * identified positionally, as a strict file prefix — handing a front-mattered
 * document straight to the prompt splitter silently turns the metadata into
 * the first prompt.
 */
export function splitTemplateFrontMatter(markdown: string): {
	frontMatter: TemplateFrontMatter;
	hasFrontMatter: boolean;
	body: string;
} {
	// A leading BOM would hide the opening delimiter behind an invisible
	// character, so it is stripped before the first line is examined.
	const lines = markdown
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	// The opener must be the very first line: a leading blank line means the
	// document simply starts with a horizontal rule or an empty prompt.
	if (!lines.length || !DELIMITER.test(lines[0])) {
		return {
			frontMatter: { ...EMPTY_TEMPLATE_FRONT_MATTER, extra: {} },
			hasFrontMatter: false,
			body: markdown,
		};
	}
	const limit = Math.min(lines.length, FRONT_MATTER_MAX_LINES + 1);
	let end = -1;
	for (let i = 1; i < limit; i++) {
		if (DELIMITER.test(lines[i])) {
			end = i;
			break;
		}
	}
	if (end < 0) {
		return {
			frontMatter: { ...EMPTY_TEMPLATE_FRONT_MATTER, extra: {} },
			hasFrontMatter: false,
			body: markdown,
		};
	}
	const frontMatter: TemplateFrontMatter = {
		...EMPTY_TEMPLATE_FRONT_MATTER,
		extra: {},
	};
	for (const line of lines.slice(1, end)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const match = FRONT_MATTER_ENTRY.exec(line);
		if (!match) continue;
		const key = match[1];
		const value = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
		if (key === "name") frontMatter.name = value;
		else if (key === "repo") frontMatter.repo = value;
		else if (key === "file") frontMatter.file = value;
		else if (key === "edited") frontMatter.edited = parseBoolean(value);
		else frontMatter.extra[key] = value;
	}
	const body = lines.slice(end + 1);
	while (body.length && body[0].trim() === "") body.shift();
	return { frontMatter, hasFrontMatter: true, body: body.join("\n") };
}

/** Read a `template.md`: provenance plus the prompts beneath it. */
export function parseTemplateDocument(markdown: string): ParsedTemplate {
	const { frontMatter, hasFrontMatter, body } =
		splitTemplateFrontMatter(markdown);
	return {
		frontMatter,
		hasFrontMatter,
		prompts: parseNotebookMarkdown(body),
	};
}

/**
 * Inverse of `parseTemplateDocument`. The four modelled keys are always
 * emitted, in a fixed order, even when empty — an explicit blank `name:` is how
 * a template started from pinned chat announces that it has no origin yet.
 * The body is `serializeNotebookMarkdown` unchanged, so a template saved
 * locally is byte-identical to the same template saved upstream.
 */
export function serializeTemplateDocument(
	frontMatter: TemplateFrontMatter,
	prompts: string[],
): string {
	const lines = [
		"---",
		`name: ${frontMatterValue(frontMatter.name)}`,
		`repo: ${frontMatterValue(frontMatter.repo)}`,
		`file: ${frontMatterValue(frontMatter.file)}`,
		`edited: ${frontMatter.edited ? "true" : "false"}`,
	];
	for (const [key, value] of Object.entries(frontMatter.extra ?? {})) {
		if (FRONT_MATTER_ENTRY.test(`${key}: `)) {
			lines.push(`${key}: ${frontMatterValue(value)}`);
		}
	}
	lines.push("---", "");
	return `${lines.join("\n")}\n${serializeNotebookMarkdown(prompts)}`;
}

function trimBlankEdges(lines: string[]): string {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end).join("\n");
}

/** Parse prompts separated by a line containing only `---`. */
export function parseNotebookMarkdown(markdown: string): string[] {
	const prompts: string[] = [];
	let current: string[] = [];
	for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		if (/^\s*---\s*$/.test(line)) {
			const prompt = trimBlankEdges(current);
			if (prompt) prompts.push(prompt);
			current = [];
		} else {
			current.push(line);
		}
	}
	const prompt = trimBlankEdges(current);
	if (prompt) prompts.push(prompt);
	return prompts;
}

/** Serialize prompts in the deterministic repository representation. */
export function serializeNotebookMarkdown(prompts: string[]): string {
	const normalized = prompts
		.map((prompt) =>
			trimBlankEdges(prompt.replace(/\r\n?/g, "\n").split("\n")),
		)
		.filter(Boolean);
	return normalized.length ? `${normalized.join("\n\n---\n\n")}\n` : "";
}

/**
 * Derive the compact task label shown by the notebook conversation UI.
 * Detailed prompt text remains unchanged and is available through disclosure.
 */
export function notebookPromptSummary(prompt: string, max = 96): string {
	const lines = prompt.replace(/\r\n?/g, "\n").split("\n");
	const meaningful = lines.filter((line) => line.trim() !== "");
	const heading = meaningful.find((line) => /^\s*#{1,6}\s+\S/.test(line));
	const source = heading ?? meaningful[0] ?? "";
	const compact = source
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!compact) return "Untitled task";
	const limit = Math.max(8, max);
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, limit - 3).trimEnd()}...`;
}

/** Parse only README lines matching the notebook index grammar. */
export function parseNotebookIndex(markdown: string): NotebookIndexEntry[] {
	const entries: NotebookIndexEntry[] = [];
	for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		const match = INDEX_ENTRY.exec(line);
		if (!match) continue;
		entries.push({
			name: match[1].trim(),
			path: match[2].trim(),
			comment: (match[3] ?? "").trim(),
		});
	}
	return entries;
}

function indexLine(entry: NotebookIndexEntry): string {
	const comment = entry.comment.trim();
	return `- [${entry.name.trim()}](${entry.path.trim()})${
		comment ? ` ${comment}` : ""
	}`;
}

/** Canonical serializer used by unit tests and newly-created indexes. */
export function serializeNotebookIndex(entries: NotebookIndexEntry[]): string {
	return entries.length ? `${entries.map(indexLine).join("\n")}\n` : "";
}

/**
 * Append an entry while preserving all README content that is not an index
 * entry. Existing headings and prose are never rewritten.
 */
export function addNotebookIndexEntry(
	markdown: string,
	entry: NotebookIndexEntry,
): string {
	const normalized = markdown.replace(/\r\n?/g, "\n").replace(/\s*$/, "");
	return `${normalized}${normalized ? "\n\n" : ""}${indexLine(entry)}\n`;
}

/** Remove exactly one indexed path while preserving unrelated README lines. */
export function removeNotebookIndexEntry(
	markdown: string,
	path: string,
): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const kept = lines.filter((line) => {
		const match = INDEX_ENTRY.exec(line);
		return !match || match[2].trim() !== path;
	});
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * Outcome of running one notebook step.
 *
 * "cancelled" is distinct from "failed" because a stop is a deliberate user
 * action, not an error: it ends the run without an error banner and leaves the
 * selection on the stopped step. A bare boolean cannot express that — and a
 * cancelled ACP turn resolves successfully, so the send path alone cannot tell
 * a cancel from a completion.
 */
export type NotebookRunResult = "ok" | "failed" | "cancelled";

/**
 * Whether a run-all sequence should proceed to the next step.
 *
 * `runAllActive` is the caller's run flag, which a stop clears — it covers a
 * stop landing in the gap between two steps, where no step result reports it.
 */
export function shouldContinueRunAll(
	result: NotebookRunResult,
	runAllActive: boolean,
): boolean {
	if (!runAllActive) return false;
	return result === "ok";
}

/** Select the next persisted notebook node, skipping unpinned input nodes. */
export function advanceNotebookSelection(
	nodes: NotebookNode[],
	currentNodeId: string,
): string | null {
	const current = nodes.findIndex((node) => node.id === currentNodeId);
	for (let i = current + 1; i < nodes.length; i++) {
		if (nodes[i].kind === "notebook") return nodes[i].id;
	}
	return null;
}

/** Insert an ad-hoc input immediately before the selected notebook node. */
export function insertAdHocNode(
	nodes: NotebookNode[],
	node: NotebookNode,
	selectedNodeId: string | null,
): NotebookNode[] {
	const selected = selectedNodeId
		? nodes.findIndex((candidate) => candidate.id === selectedNodeId)
		: -1;
	if (selected < 0) return [...nodes, node];
	return [...nodes.slice(0, selected), node, ...nodes.slice(selected)];
}

/** Promote an ad-hoc input to a persisted notebook node. */
export function pinNotebookNode(
	nodes: NotebookNode[],
	nodeId: string,
): NotebookNode[] {
	return nodes.map((node) =>
		node.id === nodeId ? { ...node, kind: "notebook" } : node,
	);
}

/**
 * Swap a notebook step with the nearest step in `direction`.
 *
 * WHY the nearest *step* rather than the adjacent node: only notebook nodes are
 * written to `template.md`, so a move that merely hopped an ad-hoc input would
 * change the visible order while leaving the saved prompt order untouched —
 * reading as a move that did nothing. Stepping over inputs keeps the two orders
 * in agreement, which is what makes the confirmed write meaningful.
 *
 * Returns the array unchanged when the node is absent, is not a notebook node,
 * or already sits at the end it is moving toward, so the caller does not have
 * to special-case the boundary.
 */
export function moveNotebookNode(
	nodes: NotebookNode[],
	nodeId: string,
	direction: -1 | 1,
): NotebookNode[] {
	const from = nodes.findIndex((node) => node.id === nodeId);
	if (from < 0 || nodes[from].kind !== "notebook") return nodes;
	for (let to = from + direction; to >= 0 && to < nodes.length; to += direction) {
		if (nodes[to].kind !== "notebook") continue;
		const next = [...nodes];
		next[from] = nodes[to];
		next[to] = nodes[from];
		return next;
	}
	return nodes;
}

export function removeNotebookNode(
	nodes: NotebookNode[],
	nodeId: string,
	selectedNodeId: string | null,
): { nodes: NotebookNode[]; selectedNodeId: string | null } {
	const removedAt = nodes.findIndex((node) => node.id === nodeId);
	const nextNodes = nodes.filter((node) => node.id !== nodeId);
	if (selectedNodeId !== nodeId) {
		return { nodes: nextNodes, selectedNodeId };
	}
	for (let i = Math.max(0, removedAt); i < nextNodes.length; i++) {
		if (nextNodes[i].kind === "notebook") {
			return { nodes: nextNodes, selectedNodeId: nextNodes[i].id };
		}
	}
	for (let i = Math.min(removedAt - 1, nextNodes.length - 1); i >= 0; i--) {
		if (nextNodes[i].kind === "notebook") {
			return { nodes: nextNodes, selectedNodeId: nextNodes[i].id };
		}
	}
	return { nodes: nextNodes, selectedNodeId: null };
}

/** Only notebook nodes, including pinned inputs, are written to GitHub. */
export function notebookPromptsForSave(nodes: NotebookNode[]): string[] {
	return nodes
		.filter((node) => node.kind === "notebook")
		.map((node) => node.prompt);
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Bad request: invalid notebook session state");
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 200_000): string {
	if (typeof value !== "string" || value.length > max) {
		throw new Error(`Bad request: invalid notebook ${field}`);
	}
	return value;
}

/**
 * Tool title/status are adapter-owned display metadata, not structural state.
 * Normalize them instead of rejecting the complete notebook when an ACP
 * adapter emits a missing, structured, or unexpectedly large value.
 */
function toolDisplayText(
	value: unknown,
	fallback: string,
	max: number,
): string {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	return value.slice(0, max);
}

function normalizeOutput(value: unknown): NotebookOutput {
	const output = record(value);
	const kind = output.kind;
	if (kind === "assistant") {
		return {
			kind,
			id: text(output.id, "output id", 200),
			text: text(output.text, "output text"),
			thoughts: text(output.thoughts, "output thoughts"),
		};
	}
	if (kind === "tool") {
		return {
			kind,
			id: text(output.id, "tool id", 200),
			title: toolDisplayText(output.title, "(tool)", 2_000),
			status: toolDisplayText(output.status, "unknown", 200),
		};
	}
	throw new Error("Bad request: invalid notebook output kind");
}

/**
 * Bound the provenance block of a sidecar.
 *
 * A sidecar written before templates became workbench working copies carries
 * `local: true` instead of a `template` block; seeding from the session's own
 * name and path keeps a resumed session showing what it showed before, rather
 * than presenting itself as an unnamed template.
 */
function normalizeTemplateFrontMatter(
	state: Record<string, unknown>,
	notebookName: string,
	path: string,
): TemplateFrontMatter {
	const value = state.template;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		if (state.local === true) {
			return {
				...EMPTY_TEMPLATE_FRONT_MATTER,
				name: notebookName,
				file: path,
				edited: true,
				extra: {},
			};
		}
		return { ...EMPTY_TEMPLATE_FRONT_MATTER, extra: {} };
	}
	const template = value as Record<string, unknown>;
	const extra: Record<string, string> = {};
	if (
		template.extra &&
		typeof template.extra === "object" &&
		!Array.isArray(template.extra)
	) {
		for (const [key, entry] of Object.entries(
			template.extra as Record<string, unknown>,
		)) {
			if (typeof entry === "string" && entry.length <= 500) {
				extra[key] = entry;
			}
		}
	}
	return {
		name: text(template.name ?? "", "template name", 300),
		repo: text(template.repo ?? "", "template repo", 300),
		file: text(template.file ?? "", "template file", 500),
		edited: template.edited === true,
		extra,
	};
}

/**
 * Whitelist and bound session state before writing it. Unknown fields are
 * discarded, so a malicious client cannot smuggle a token into the sidecar.
 */
export function normalizeNotebookSessionState(
	value: unknown,
): NotebookSessionState {
	const state = record(value);
	if (state.version !== 1) {
		throw new Error("Bad request: unsupported notebook state version");
	}
	const source = record(state.source);
	if (!Array.isArray(state.nodes) || state.nodes.length > 500) {
		throw new Error("Bad request: invalid notebook nodes");
	}
	const ids = new Set<string>();
	const nodes: NotebookNode[] = state.nodes.map((value) => {
		const node = record(value);
		const id = text(node.id, "node id", 200);
		if (ids.has(id)) throw new Error("Bad request: duplicate notebook node id");
		ids.add(id);
		if (node.kind !== "notebook" && node.kind !== "input") {
			throw new Error("Bad request: invalid notebook node kind");
		}
		if (!Array.isArray(node.outputs) || node.outputs.length > 1_000) {
			throw new Error("Bad request: invalid notebook outputs");
		}
		return {
			id,
			kind: node.kind,
			prompt: text(node.prompt, "prompt"),
			outputs: node.outputs.map(normalizeOutput),
		};
	});
	const selectedNodeId =
		typeof state.selectedNodeId === "string" &&
		nodes.some(
			(node) =>
				node.id === state.selectedNodeId && node.kind === "notebook",
		)
			? state.selectedNodeId
			: null;
	const notebookName = text(state.notebookName, "name", 300);
	const path = text(state.path, "path", 500);
	return {
		version: 1,
		source: {
			repository: text(source.repository, "repository", 300),
			ref: text(source.ref, "ref", 300),
		},
		notebookName,
		path,
		fileSha: text(state.fileSha, "file sha", 200),
		readmeSha: text(state.readmeSha, "README sha", 200),
		nodes,
		selectedNodeId,
		dirty: state.dirty === true,
		template: normalizeTemplateFrontMatter(state, notebookName, path),
	};
}
