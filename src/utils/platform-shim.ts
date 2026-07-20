/**
 * Standalone replacement for Obsidian's `Platform` object.
 *
 * The plugin originally imported `{ Platform }` from "obsidian" purely for OS
 * detection (macOS / Windows / Linux / desktop-vs-mobile). In the standalone
 * ACP client there is no Obsidian runtime, so OS detection is derived from
 * Node's `process.platform` instead. The shape matches the subset of Obsidian's
 * `Platform` API this codebase actually uses, so imports can be swapped 1:1.
 */

const platform = typeof process !== "undefined" ? process.platform : "";

/**
 * OS-detection flags, derived once from `process.platform`. The object is
 * mutable (not `as const`) so unit tests can override individual flags to
 * exercise platform-specific branches, mirroring how Obsidian's own `Platform`
 * behaves under the test stub.
 *
 * `isDesktopApp` is always true: the standalone client runs on a Node/desktop
 * or Electron-like runtime, never Obsidian mobile, so subprocess/terminal
 * features are always available.
 */
export const Platform = {
	isMacOS: platform === "darwin",
	isWin: platform === "win32",
	isLinux: platform === "linux",
	isDesktopApp: true,
	isMobile: false,
};
