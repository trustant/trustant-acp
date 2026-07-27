export type HeaderConnectionState = "idle" | "connecting" | "connected";

/**
 * General UI work can remain busy after ACP has opened a usable session.
 * Readiness therefore takes precedence over the shared busy flag.
 */
export function headerConnectionState(
	ready: boolean,
	busy: boolean,
): HeaderConnectionState {
	if (ready) return "connected";
	if (busy) return "connecting";
	return "idle";
}
