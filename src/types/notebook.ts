/**
 * Notebook data shared by the server, browser, and pure workflow services.
 *
 * The GitHub token is intentionally absent from every type in this module.
 * Browser-visible state exposes only `hasToken`.
 */

export interface NotebookSource {
	repository: string;
	ref: string;
}

/**
 * Provenance recorded in the workbench `template.md` front matter.
 *
 * `repo` is informational: it records where a template was copied from so the
 * origin stays visible, but it never selects a write destination — save-back
 * resolves the repository through the managed source, so a template file can
 * never redirect an authenticated write.
 */
export interface TemplateFrontMatter {
	/** Catalog display name. Empty for a template started from pinned chat. */
	name: string;
	/** owner/repo the template was copied from. Empty when it has no origin. */
	repo: string;
	/** Repository-relative path it was copied from. Empty when it has no origin. */
	file: string;
	/**
	 * True once the working copy diverges from its origin. Set by any local
	 * edit, cleared by a successful save back to GitHub. This flag — not a
	 * content comparison — is what "changed" means.
	 */
	edited: boolean;
	/**
	 * Front matter keys this version does not model, preserved so a hand-added
	 * key survives a read/write round trip instead of being silently dropped.
	 */
	extra: Record<string, string>;
}

export interface ParsedTemplate {
	frontMatter: TemplateFrontMatter;
	/** False when the file carried no front matter block at all. */
	hasFrontMatter: boolean;
	prompts: string[];
}

export interface NotebookIndexEntry {
	name: string;
	path: string;
	comment: string;
}

export interface NotebookIndexResponse {
	source: NotebookSource;
	hasToken: boolean;
	readmeSha: string;
	entries: NotebookIndexEntry[];
}

export interface NotebookDocumentResponse {
	source: NotebookSource;
	hasToken: boolean;
	name: string;
	path: string;
	sha: string;
	readmeSha: string;
	prompts: string[];
}

export interface NotebookAssistantOutput {
	kind: "assistant";
	id: string;
	text: string;
	thoughts: string;
}

export interface NotebookToolOutput {
	kind: "tool";
	id: string;
	title: string;
	status: string;
}

export type NotebookOutput = NotebookAssistantOutput | NotebookToolOutput;

export interface NotebookNode {
	id: string;
	kind: "notebook" | "input";
	prompt: string;
	outputs: NotebookOutput[];
}

/**
 * Per-ACP-session notebook sidecar. Ordinary ACP messages remain in the
 * existing session message store; this state exists only while a notebook is
 * loaded.
 */
export interface NotebookSessionState {
	version: 1;
	source: NotebookSource;
	/** In-session display name; the panel's editable name field binds to it. */
	notebookName: string;
	/** In-session file path; the panel's editable file field binds to it. */
	path: string;
	/**
	 * Legacy. Save-back re-reads SHAs server-side from the working copy, so
	 * these are no longer consulted. Retained so existing sidecars keep
	 * validating without a version bump.
	 */
	fileSha: string;
	readmeSha: string;
	nodes: NotebookNode[];
	selectedNodeId: string | null;
	dirty: boolean;
	/**
	 * Provenance of the workbench working copy, as last written to disk.
	 *
	 * Always present: every loaded template is now the workbench `template.md`.
	 * Replaces the former `local` flag, whose only job was routing saves —
	 * routing is now uniform (edits always write locally) and `edited` instead
	 * answers whether the copy has diverged from its origin.
	 */
	template: TemplateFrontMatter;
}

export interface NotebookMutationResponse {
	index: NotebookIndexResponse;
	notebook?: NotebookDocumentResponse;
}
