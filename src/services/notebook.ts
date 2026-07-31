import type {
	NotebookIndexEntry,
	NotebookNode,
	NotebookOutput,
	NotebookSessionState,
} from "../types/notebook";

const INDEX_ENTRY =
	/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+(.*?))?\s*$/;

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
	return {
		version: 1,
		source: {
			repository: text(source.repository, "repository", 300),
			ref: text(source.ref, "ref", 300),
		},
		notebookName: text(state.notebookName, "name", 300),
		path: text(state.path, "path", 500),
		fileSha: text(state.fileSha, "file sha", 200),
		readmeSha: text(state.readmeSha, "README sha", 200),
		nodes,
		selectedNodeId,
		dirty: state.dirty === true,
		// Whitelisted so a resumed session still knows the template came from the
		// local file and keeps routing saves there instead of to GitHub. Emitted
		// only when set, keeping the sidecar unchanged for GitHub templates.
		...(state.local === true ? { local: true } : {}),
	};
}
