import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { agentHarness } from "@codex-appkit/http/vite";

export default defineConfig({
	plugins: [
		react(),
		agentHarness({
			basePath: "/__agent_harness",
			cwd: process.cwd(),
		}),
	],
});
