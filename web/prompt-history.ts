export interface PromptHistoryCursor {
	/** -1 means the composer is showing the user's live draft. */
	index: number;
	/** Draft captured before the user entered history navigation. */
	draft: string;
}

export type PromptHistoryDirection = "older" | "newer";

export interface PromptHistoryResult {
	handled: boolean;
	cursor: PromptHistoryCursor;
	value: string;
}

export function createPromptHistoryCursor(draft = ""): PromptHistoryCursor {
	return { index: -1, draft };
}

/**
 * Navigate the user-prompt history without depending on React or the DOM.
 *
 * WHY: the managed web UI and the Obsidian UI must offer the same shell-like
 * prompt recall while preserving an unfinished draft. Keeping the transition
 * pure makes boundary and draft behavior deterministic and independently
 * testable; the caller remains responsible for deciding when arrow keys should
 * be intercepted instead of moving a multiline textarea cursor.
 */
export function navigatePromptHistory(
	prompts: string[],
	currentValue: string,
	cursor: PromptHistoryCursor,
	direction: PromptHistoryDirection,
): PromptHistoryResult {
	if (prompts.length === 0) {
		return { handled: false, cursor, value: currentValue };
	}

	if (direction === "older") {
		const enteringHistory = cursor.index === -1;
		const draft = enteringHistory ? currentValue : cursor.draft;
		const index = Math.min(cursor.index + 1, prompts.length - 1);
		return {
			handled: true,
			cursor: { index, draft },
			value: prompts[prompts.length - 1 - index],
		};
	}

	if (cursor.index === -1) {
		return { handled: false, cursor, value: currentValue };
	}

	const index = cursor.index - 1;
	if (index === -1) {
		return {
			handled: true,
			cursor: { index, draft: cursor.draft },
			value: cursor.draft,
		};
	}

	return {
		handled: true,
		cursor: { index, draft: cursor.draft },
		value: prompts[prompts.length - 1 - index],
	};
}
