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

import { getLogger } from "../utils/logger";
import type { PermissionOption } from "../types/chat";
import { LucideIcon } from "./shared/IconButton";

/** Kind semantics are conveyed by icon shape + color, not button background. */
const KIND_ICONS: Record<PermissionOption["kind"], string> = {
	allow_always: "check-check",
	allow_once: "check",
	reject_once: "x",
	reject_always: "ban",
};

interface PermissionBannerProps {
	permissionRequest: {
		requestId: string;
		options: PermissionOption[];
		selectedOptionId?: string;
		isCancelled?: boolean;
		isActive?: boolean;
	};
	/** Whether to show kind icons (follows displaySettings.showEmojis) */
	showEmojis: boolean;
	/** Callback to approve a permission request */
	onApprovePermission?: (
		requestId: string,
		optionId: string,
	) => Promise<void>;
	onOptionSelected?: (optionId: string) => void;
}

export function PermissionBanner({
	permissionRequest,
	showEmojis,
	onApprovePermission,
	onOptionSelected,
}: PermissionBannerProps) {
	const logger = getLogger();

	const isSelected = permissionRequest.selectedOptionId !== undefined;
	const isCancelled = permissionRequest.isCancelled === true;
	const isActive = permissionRequest.isActive !== false;

	if (!isActive || isSelected || isCancelled) return null;

	return (
		<div className="agent-client-message-permission-request">
			{permissionRequest.options.map((option) => (
				<button
					key={option.optionId}
					className={`agent-client-permission-option agent-client-permission-kind-${option.kind}`}
					title={option.name}
					onClick={() => {
						if (onOptionSelected) {
							onOptionSelected(option.optionId);
						}

						if (onApprovePermission) {
							void onApprovePermission(
								permissionRequest.requestId,
								option.optionId,
							);
						} else {
							logger.warn(
								"Cannot handle permission response: missing onApprovePermission callback",
							);
						}
					}}
				>
					{showEmojis && (
						<LucideIcon
							name={KIND_ICONS[option.kind]}
							className="agent-client-permission-option-icon"
						/>
					)}
					<span className="agent-client-permission-option-label">
						{option.name}
					</span>
				</button>
			))}
		</div>
	);
}
