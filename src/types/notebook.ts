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
	notebookName: string;
	path: string;
	fileSha: string;
	readmeSha: string;
	nodes: NotebookNode[];
	selectedNodeId: string | null;
	dirty: boolean;
}

export interface NotebookMutationResponse {
	index: NotebookIndexResponse;
	notebook?: NotebookDocumentResponse;
}
