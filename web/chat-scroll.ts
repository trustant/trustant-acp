export interface ChatScrollPosition {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

export const CHAT_FOLLOW_THRESHOLD_PX = 80;

export function isChatNearBottom(
	position: ChatScrollPosition,
	threshold = CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
	const distance =
		position.scrollHeight - position.scrollTop - position.clientHeight;
	return distance <= threshold;
}
