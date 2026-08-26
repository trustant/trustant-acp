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

import * as React from "react";
const { useRef, useEffect, useImperativeHandle, forwardRef } = React;
import { setIcon } from "obsidian";

/**
 * Renders an Obsidian Lucide icon via setIcon().
 * Used as a replacement for emoji icons to match Obsidian's native UI.
 */
export function LucideIcon({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (ref.current) {
			setIcon(ref.current, name);
		}
	}, [name]);

	return <span ref={ref} className={className} />;
}

interface HeaderButtonProps {
	iconName: string;
	tooltip: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export const HeaderButton = forwardRef<HTMLButtonElement, HeaderButtonProps>(
	function HeaderButton({ iconName, tooltip, onClick }, ref) {
		const buttonRef = useRef<HTMLButtonElement>(null);

		// Expose the button ref to parent components
		useImperativeHandle(ref, () => buttonRef.current!, []);

		useEffect(() => {
			if (buttonRef.current) {
				setIcon(buttonRef.current, iconName);
			}
		}, [iconName]);

		return (
			<button
				ref={buttonRef}
				title={tooltip}
				onClick={onClick}
				className="clickable-icon agent-client-header-button"
			/>
		);
	},
);
