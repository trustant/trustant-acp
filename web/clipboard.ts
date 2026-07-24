export interface ClipboardRuntime {
	secureContext: boolean;
	writeText?: (text: string) => Promise<void>;
	fallbackCopy: (text: string) => boolean;
}

/**
 * Copy text with a secure Clipboard API first and a user-gesture fallback.
 *
 * WHY: Trustable development is intentionally served from HTTP `*.nip.io`
 * hosts, where Safari and other browsers can deny `navigator.clipboard`.
 * Falling back after either an insecure context or a rejected modern write
 * keeps Copy functional without requiring HTTPS merely for local development.
 */
export async function copyTextWithRuntime(
	text: string,
	runtime: ClipboardRuntime,
): Promise<boolean> {
	if (!text) return false;

	if (runtime.secureContext && runtime.writeText) {
		try {
			await runtime.writeText(text);
			return true;
		} catch {
			// A browser can still reject clipboard permission in a secure
			// context; the click-triggered DOM fallback remains available.
		}
	}

	return runtime.fallbackCopy(text);
}

function fallbackCopyText(text: string): boolean {
	if (typeof document === "undefined" || !document.body) return false;

	const activeElement =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.readOnly = true;
	textarea.setAttribute("aria-hidden", "true");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);

	let copied = false;
	try {
		textarea.focus();
		textarea.select();
		textarea.setSelectionRange(0, textarea.value.length);
		copied = document.execCommand("copy");
	} catch {
		copied = false;
	} finally {
		textarea.remove();
		if (activeElement) {
			try {
				activeElement.focus({ preventScroll: true });
			} catch {
				activeElement.focus();
			}
		}
	}
	return copied;
}

export function copyText(text: string): Promise<boolean> {
	const clipboard =
		typeof navigator !== "undefined" ? navigator.clipboard : undefined;
	return copyTextWithRuntime(text, {
		secureContext:
			typeof globalThis.isSecureContext === "boolean" &&
			globalThis.isSecureContext,
		writeText: clipboard
			? (value) => clipboard.writeText(value)
			: undefined,
		fallbackCopy: fallbackCopyText,
	});
}
