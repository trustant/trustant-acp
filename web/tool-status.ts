export interface ToolStatusEntry {
	title: string;
	status: string;
}

export type ToolDisplayStatus =
	| "pending"
	| "in-progress"
	| "completed"
	| "issues-found"
	| "attempt-failed"
	| "recovered"
	| "failed";

export interface ToolStatusPresentation {
	status: ToolDisplayStatus;
	label: string;
	rawStatus: string;
}

function toolFamily(title: string): string {
	const head = title.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
	if (head.startsWith("browser_") || head.startsWith("browser.")) {
		return "browser";
	}
	if (head === "mcp" || head.startsWith("mcp_") || head.startsWith("mcp.")) {
		return "mcp";
	}
	if (head.startsWith("react_") || head.startsWith("react.")) {
		return "react";
	}
	return head;
}

function isReactValidator(title: string): boolean {
	const normalized = title.trim().toLowerCase();
	return (
		(normalized.startsWith("react_") || normalized.startsWith("react.")) &&
		normalized.includes("validate")
	);
}

/**
 * Preserve ACP's raw status while deriving a calmer display status only from
 * deterministic timeline evidence. Free-form assistant prose and guessed shell
 * semantics must never turn a real failure into a success.
 */
export function toolStatusPresentation(
	current: ToolStatusEntry,
	laterTools: readonly ToolStatusEntry[],
	active: boolean,
): ToolStatusPresentation {
	const rawStatus = current.status.trim().toLowerCase() || "unknown";
	if (rawStatus === "completed") {
		return { status: "completed", label: "completed", rawStatus };
	}
	if (rawStatus === "pending") {
		return { status: "pending", label: "pending", rawStatus };
	}
	if (rawStatus === "in_progress") {
		return { status: "in-progress", label: "in progress", rawStatus };
	}
	if (rawStatus !== "failed") {
		return {
			status: "pending",
			label: rawStatus.replaceAll("_", " "),
			rawStatus,
		};
	}

	const family = toolFamily(current.title);
	const recovered =
		family !== "" &&
		laterTools.some(
			(candidate) =>
				candidate.status.trim().toLowerCase() === "completed" &&
				toolFamily(candidate.title) === family,
		);
	if (recovered) {
		return { status: "recovered", label: "recovered", rawStatus };
	}
	if (isReactValidator(current.title)) {
		return { status: "issues-found", label: "issues found", rawStatus };
	}
	if (active) {
		return {
			status: "attempt-failed",
			label: "attempt failed",
			rawStatus,
		};
	}
	return { status: "failed", label: "failed", rawStatus };
}
