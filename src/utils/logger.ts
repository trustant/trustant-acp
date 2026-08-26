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

export interface LoggerConfig {
	debugMode: boolean;
}

let globalLogger: Logger | null = null;

export function initializeLogger(config: LoggerConfig): void {
	if (globalLogger) {
		globalLogger.setDebugMode(config.debugMode);
	} else {
		globalLogger = new Logger(config);
	}
}

export function getLogger(): Logger {
	if (!globalLogger) {
		globalLogger = new Logger({ debugMode: false });
	}
	return globalLogger;
}

export function updateDebugMode(debugMode: boolean): void {
	if (globalLogger) {
		globalLogger.setDebugMode(debugMode);
	}
}

export class Logger {
	private debugMode: boolean;

	constructor(config: LoggerConfig) {
		this.debugMode = config.debugMode;
	}

	setDebugMode(debugMode: boolean): void {
		this.debugMode = debugMode;
	}

	log(...args: unknown[]): void {
		if (this.debugMode) {
			console.debug("[Debug]", ...args);
		}
	}

	debug(...args: unknown[]): void {
		if (this.debugMode) {
			console.debug("[Debug]", ...args);
		}
	}

	info(...args: unknown[]): void {
		if (this.debugMode) {
			console.debug("[Debug]", ...args);
		}
	}

	error(...args: unknown[]): void {
		console.error(...args);
	}

	warn(...args: unknown[]): void {
		console.warn(...args);
	}
}
