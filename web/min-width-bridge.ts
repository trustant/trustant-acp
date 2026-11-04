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

/**
 * Reports the narrowest width the chat header fits in to the embedding host
 * (Trustant's app.html), which stops its divider there (#211).
 *
 * The header never wraps: its dropdowns shrink to their CSS min-width instead.
 * Past that point the icons would overflow, and the frame cannot clamp its own
 * width — only the host owns the divider — so the floor is posted upward.
 */

export const MIN_WIDTH_MESSAGE = "trustant-chat-min-width";

/** Width at which every select sits at its min-width and nothing else shrinks. */
export function headerFloor(topbar: HTMLElement, win: Window = window): number {
	const style = win.getComputedStyle(topbar);
	const gap = parseFloat(style.columnGap) || 0;
	let total =
		(parseFloat(style.paddingLeft) || 0) +
		(parseFloat(style.paddingRight) || 0) +
		(parseFloat(style.borderLeftWidth) || 0) +
		(parseFloat(style.borderRightWidth) || 0);
	const children = Array.from(topbar.children) as HTMLElement[];
	let shown = 0;
	for (const child of children) {
		const cs = win.getComputedStyle(child);
		if (cs.display === "none" || cs.position === "absolute") continue;
		shown++;
		total +=
			child.tagName === "SELECT"
				? parseFloat(cs.minWidth) || child.offsetWidth
				: child.offsetWidth;
		total += (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
	}
	if (shown > 1) total += gap * (shown - 1);
	return Math.ceil(total);
}

/**
 * Watch the header and post its floor to the parent whenever it changes.
 * Inert when not framed. The payload is a bare number, so "*" is safe and
 * spares us learning the host origin (it lives on a different hostname).
 */
export function installMinWidthBridge(win: Window = window): () => void {
	if (win.parent === win) return () => {};
	let last = -1;
	let topbar: HTMLElement | null = null;
	const resize = new ResizeObserver(() => post());
	// The header is rendered by React after mount: watch the root only until
	// it appears, then just its children, which change with the agent
	// (gear/resume buttons, selects appearing after connect). Watching the
	// whole subtree would fire on every streamed chat chunk.
	const mount = new MutationObserver(() => {
		if (!topbar) attach();
	});
	const mutation = new MutationObserver(() => attach());

	function post(): void {
		if (!topbar) return;
		const px = headerFloor(topbar, win);
		if (px === last) return;
		last = px;
		win.parent.postMessage({ type: MIN_WIDTH_MESSAGE, px }, "*");
	}

	function attach(): void {
		const found = win.document.querySelector<HTMLElement>(".topbar");
		if (!found) return;
		if (found !== topbar) {
			topbar = found;
			mount.disconnect();
			mutation.disconnect();
			mutation.observe(found, { childList: true });
		}
		resize.disconnect();
		resize.observe(found);
		for (const child of Array.from(found.children)) resize.observe(child);
		post();
	}

	mount.observe(win.document.body, { childList: true, subtree: true });
	attach();
	return () => {
		resize.disconnect();
		mount.disconnect();
		mutation.disconnect();
	};
}
