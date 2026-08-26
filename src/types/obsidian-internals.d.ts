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

export {};

/**
 * Type augmentation for unofficial Obsidian APIs.
 *
 * These methods exist at runtime but are not in the public type definitions.
 * Only add methods that are widely used by the plugin community and unlikely
 * to be removed without notice.
 */
declare module "obsidian" {
	interface Vault {
		getConfig(key: string): unknown;
	}
}
