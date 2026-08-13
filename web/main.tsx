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
