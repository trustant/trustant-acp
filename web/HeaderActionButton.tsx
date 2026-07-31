import React from "react";

export type HeaderActionIcon =
	| "settings"
	| "new-session"
	| "history"
	| "notebook"
	| "run-next"
	| "run-all";

const ICON_PATHS: Record<HeaderActionIcon, string[]> = {
	settings: [
		"M4 6h6",
		"M14 6h6",
		"M4 12h10",
		"M18 12h2",
		"M4 18h2",
		"M10 18h10",
	],
	"new-session": ["M12 5v14", "M5 12h14"],
	history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 7v5l3 2"],
	notebook: [
		"M9 3h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-1",
		"M6 7h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
		"M8 12h5",
		"M8 16h5",
	],
	"run-next": ["m5 4 11 8-11 8z", "M20 5v14"],
	// Double play: "run every remaining step", distinct at a glance from the
	// single play-with-bar that runs only the next one.
	"run-all": ["m3 4 8 8-8 8z", "m12 4 8 8-8 8z"],
};

interface HeaderActionButtonProps
	extends Omit<
		React.ButtonHTMLAttributes<HTMLButtonElement>,
		"aria-label" | "children" | "title"
	> {
	icon: HeaderActionIcon;
	label: string;
}

export function HeaderActionButton({
	icon,
	label,
	className = "",
	type = "button",
	...props
}: HeaderActionButtonProps): React.ReactElement {
	return (
		<button
			{...props}
			type={type}
			className={`icon-action ${className}`.trim()}
			aria-label={label}
			title={label}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				{ICON_PATHS[icon].map((path) => (
					<path key={path} d={path} />
				))}
			</svg>
		</button>
	);
}
