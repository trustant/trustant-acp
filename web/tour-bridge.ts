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
 * Spotlight-tour bridge for the embedding Trustable host.
 *
 * WHY: the Trustable workbench runs its guided tutorials from
 * `trustable.<domain>` while this UI is framed from `opencode.<domain>`. The
 * two are different origins, so the host cannot measure our controls or watch
 * our notebook state to decide when a tutorial step has actually completed.
 * While a tour is running the host asks us to report, and we post the viewport
 * rect of every `[data-tour]` element plus the few notebook flags the tour
 * advances on. The host draws the spotlight in its own document; the hole it
 * leaves lets clicks reach the real control inside this frame.
 *
 * Reporting is a poll rather than a React subscription on purpose: rects move
 * for reasons React never re-renders on (scrolling, resizing, font loading),
 * and the bridge stays out of the component tree entirely.
 */

/** Messages the host sends us. */
interface TourHostMessage {
	source: "trustable-tour-host";
	type: "start" | "stop" | "scroll";
	/** `scroll` only: the `data-tour` name to bring into view. */
	target?: string;
	/** `scroll` only: which match of that name, defaulting to the first. */
	index?: number;
}

/** One reported target: viewport rect plus whether it can be acted on. */
export interface TourTargetRect {
	x: number;
	y: number;
	width: number;
	height: number;
	disabled: boolean;
	/**
	 * Human-readable identity of this match. The host picks a specific catalog
	 * entry ("App Suite") by label rather than by position, because the
	 * template order is server data and changes between installations.
	 */
	label: string;
}

/** Notebook state the host advances steps on. */
export interface TourState {
	/** The template panel is open. */
	panelOpen: boolean;
	/** Number of templates in the catalog list. */
	entries: number;
	/** Number of notebook steps in the loaded template. */
	nodes: number;
	/** Run state of the first notebook step, or null when there is none. */
	firstNodeRunState: "pending" | "running" | "done" | null;
	/** Any step is currently running. */
	running: boolean;
}

export interface TourFrame {
	source: "trustable-tour-frame";
	type: "frame";
	/**
	 * Protocol revision. 1 reported a single rect per name; 2 reports every
	 * match. The host needs to tell "no bridge at all" from "a bridge too old
	 * to drive this tutorial", because both otherwise look like a step that
	 * never advances.
	 */
	version: 2;
	targets: Record<string, TourTargetRect[]>;
	state: TourState;
}

const POLL_MS = 200;

function isHostMessage(data: unknown): data is TourHostMessage {
	if (typeof data !== "object" || data === null) return false;
	const msg = data as Partial<TourHostMessage>;
	return (
		msg.source === "trustable-tour-host" &&
		(msg.type === "start" || msg.type === "stop" || msg.type === "scroll")
	);
}

/**
 * An element only counts as a target when it is laid out and on screen: a
 * zero-sized or `display:none` control would otherwise make the host spotlight
 * an empty rectangle.
 */
function visibleRect(el: Element): TourTargetRect | null {
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	const node = el as HTMLElement;
	return {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
		// Duck-typed rather than `instanceof HTMLButtonElement`: the constructor
		// globals only exist in a browser, and this module is unit-tested
		// outside one.
		disabled:
			typeof (node as { disabled?: unknown }).disabled === "boolean"
				? (node as unknown as { disabled: boolean }).disabled
				: false,
		// An explicit marker wins over the rendered text, which carries
		// whitespace and secondary labels the host would have to guess at.
		label: (node.dataset.tourLabel ?? node.textContent ?? "").trim(),
	};
}

/**
 * Collect every `[data-tour]` element by name, keeping all matches in document
 * order. Reporting only the first match used to make any non-first catalog
 * entry impossible to spotlight, so the "select a notebook" step could only
 * ever point at whichever template happened to be listed first.
 */
export function collectTargets(
	root: ParentNode,
): Record<string, TourTargetRect[]> {
	const targets: Record<string, TourTargetRect[]> = {};
	for (const el of Array.from(root.querySelectorAll("[data-tour]"))) {
		const name = (el as HTMLElement).dataset.tour;
		if (!name) continue;
		const rect = visibleRect(el);
		if (!rect) continue;
		(targets[name] ??= []).push(rect);
	}
	return targets;
}

/**
 * Derive the notebook flags from the DOM rather than from React state, so the
 * bridge needs no wiring into ChatApp beyond the `data-tour` markers.
 */
export function collectState(root: ParentNode): TourState {
	const nodes = Array.from(root.querySelectorAll("[data-tour-node]"));
	const first = nodes[0] as HTMLElement | undefined;
	const firstRunState = first?.dataset.runState;
	return {
		panelOpen: !!root.querySelector("[data-tour='notebook-panel']"),
		entries: root.querySelectorAll("[data-tour-entry]").length,
		nodes: nodes.length,
		firstNodeRunState:
			firstRunState === "pending" ||
			firstRunState === "running" ||
			firstRunState === "done"
				? firstRunState
				: null,
		running: nodes.some(
			(node) => (node as HTMLElement).dataset.runState === "running",
		),
	};
}

export function buildFrame(root: ParentNode): TourFrame {
	return {
		source: "trustable-tour-frame",
		type: "frame",
		version: 2,
		targets: collectTargets(root),
		state: collectState(root),
	};
}

/**
 * Bring a target into view on the host's behalf. Wheel events over the host's
 * spotlight overlay scroll the host document, never this frame, so a control
 * below our fold would otherwise be unreachable for the whole tutorial.
 */
export function scrollTargetIntoView(
	root: ParentNode,
	name: string,
	index = 0,
): boolean {
	const matches = Array.from(
		root.querySelectorAll(`[data-tour="${CSS.escape(name)}"]`),
	);
	const el = matches[index];
	if (!el) return false;
	el.scrollIntoView({ block: "center", inline: "nearest" });
	return true;
}

/**
 * Start listening for the host. Safe to call when not framed: without a parent
 * window no host message can ever arrive and the bridge stays idle.
 */
export function installTourBridge(win: Window = window): () => void {
	let timer: ReturnType<typeof setInterval> | null = null;
	// Replies go back to the origin that asked, never to "*": the frame content
	// (template names, run state) is only ever meant for the embedding host.
	let hostOrigin = "";

	const post = (): void => {
		if (!hostOrigin) return;
		win.parent?.postMessage(buildFrame(win.document), hostOrigin);
	};

	const stop = (): void => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		hostOrigin = "";
	};

	const onMessage = (event: MessageEvent): void => {
		if (!isHostMessage(event.data)) return;
		if (event.source !== win.parent) return;
		if (event.data.type === "stop") {
			stop();
			return;
		}
		if (event.data.type === "scroll") {
			// Only honour a scroll from a host that already started a tour, so
			// a stray frame cannot move our viewport.
			if (!hostOrigin || event.origin !== hostOrigin) return;
			if (event.data.target) {
				scrollTargetIntoView(
					win.document,
					event.data.target,
					event.data.index ?? 0,
				);
				// Report the new geometry immediately: the host is waiting to
				// place its hole and would otherwise use pre-scroll rects.
				post();
			}
			return;
		}
		hostOrigin = event.origin;
		post();
		if (timer === null) timer = setInterval(post, POLL_MS);
	};

	win.addEventListener("message", onMessage);
	return () => {
		stop();
		win.removeEventListener("message", onMessage);
	};
}
