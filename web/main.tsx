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

/**
 * Browser bundle entry. Mounts the standalone ChatApp into #root.
 * Bundled by esbuild.web.mjs → dist-web/, served by the Node server at /.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./ChatApp";
import { installTourBridge } from "./tour-bridge";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// The embedding Trustable host drives guided tutorials across the origin
// boundary; the bridge stays dormant until that host asks for target rects.
installTourBridge();
createRoot(container).render(
	<React.StrictMode>
		<ChatApp />
	</React.StrictMode>,
);
