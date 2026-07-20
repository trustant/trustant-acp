/**
 * Browser bundle entry. Mounts the standalone ChatApp into #root.
 * Bundled by esbuild.web.mjs → dist-web/, served by the Node server at /.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./ChatApp";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
	<React.StrictMode>
		<ChatApp />
	</React.StrictMode>,
);
