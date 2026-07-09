import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { codexAppkit } from "@codex-appkit/http/vite";

export default defineConfig({
	plugins: [
		react(),
		codexAppkit({
			basePath: "/__codex_appkit",
			transportOptions: {
				cwd: process.cwd(),
			},
		}),
	],
});
