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
const { useState, useRef, useEffect } = React;
import type { AcpClient } from "../acp/acp-client";
import { getLogger } from "../utils/logger";
interface TerminalBlockProps {
	terminalId: string;
	terminalClient: AcpClient | null;
}

export const TerminalBlock = React.memo(function TerminalBlock({
	terminalId,
	terminalClient,
}: TerminalBlockProps) {
	const logger = getLogger();
	const [output, setOutput] = useState("");
	const [exitStatus, setExitStatus] = useState<{
		exitCode: number | null;
		signal: string | null;
	} | null>(null);
	const [isRunning, setIsRunning] = useState(true);
	const intervalRef = useRef<number | null>(null);

	logger.log(
		`[TerminalBlock] Component rendered for terminal ${terminalId}, terminalClient: ${!!terminalClient}`,
	);

	useEffect(() => {
		logger.log(
			`[TerminalBlock] useEffect triggered for ${terminalId}, terminalClient: ${!!terminalClient}`,
		);
		if (!terminalId || !terminalClient) return;

		const pollOutput = async () => {
			try {
				const result =
					await terminalClient.getTerminalOutput(terminalId);
				logger.log(
					`[TerminalBlock] Poll result for ${terminalId}:`,
					result,
				);
				setOutput(result.output);
				if (result.exitStatus) {
					setExitStatus({
						exitCode: result.exitStatus.exitCode ?? null,
						signal: result.exitStatus.signal ?? null,
					});
					setIsRunning(false);
					if (intervalRef.current) {
						window.clearInterval(intervalRef.current);
						intervalRef.current = null;
					}
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);

				logger.log(
					`[TerminalBlock] Polling error for terminal ${terminalId}: ${errorMessage}`,
				);

				setIsRunning(false);
				if (intervalRef.current) {
					window.clearInterval(intervalRef.current);
					intervalRef.current = null;
				}
			}
		};

		// Start polling immediately
		void pollOutput();

		// Set up polling interval with shorter interval to catch fast commands
		intervalRef.current = window.setInterval(() => {
			void pollOutput();
		}, 100);

		return () => {
			if (intervalRef.current) {
				window.clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [terminalId, terminalClient, logger]);

	// Separate effect to stop polling when no longer running
	useEffect(() => {
		if (!isRunning && intervalRef.current) {
			window.clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
	}, [isRunning]);

	return (
		<div className="agent-client-terminal-renderer">
			{output || (isRunning ? "Waiting for output..." : "No output")}

			{exitStatus && (
				<div
					className={`agent-client-terminal-renderer-exit ${exitStatus.exitCode === 0 ? "agent-client-success" : "agent-client-error"}`}
				>
					Exit Code: {exitStatus.exitCode}
					{exitStatus.signal && ` | Signal: ${exitStatus.signal}`}
				</div>
			)}
		</div>
	);
});
