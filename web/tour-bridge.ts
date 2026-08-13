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
	type: "start" | "stop";
}

/** One reported target: viewport rect plus whether it can be acted on. */
export interface TourTargetRect {
	x: number;
	y: number;
	width: number;
	height: number;
	disabled: boolean;
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
	targets: Record<string, TourTargetRect>;
	state: TourState;
}

const POLL_MS = 200;

function isHostMessage(data: unknown): data is TourHostMessage {
	if (typeof data !== "object" || data === null) return false;
	const msg = data as Partial<TourHostMessage>;
	return (
		msg.source === "trustable-tour-host" &&
		(msg.type === "start" || msg.type === "stop")
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
	return {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
		disabled:
			el instanceof HTMLButtonElement || el instanceof HTMLInputElement
				? el.disabled
				: false,
	};
}

/**
 * Collect every `[data-tour]` element by name. The first match wins, which is
 * what the tutorials want: "the first notebook step", "the first template in
 * the list".
 */
export function collectTargets(
	root: ParentNode,
): Record<string, TourTargetRect> {
	const targets: Record<string, TourTargetRect> = {};
	for (const el of Array.from(root.querySelectorAll("[data-tour]"))) {
		const name = (el as HTMLElement).dataset.tour;
		if (!name || targets[name]) continue;
		const rect = visibleRect(el);
		if (rect) targets[name] = rect;
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
		targets: collectTargets(root),
		state: collectState(root),
	};
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
