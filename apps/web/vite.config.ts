import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? "")
	.split(",")
	.map((host) => host.trim())
	.filter(Boolean);
const codexAppServerTarget =
	process.env.VITE_CODEX_APP_SERVER_PROXY_TARGET ?? "ws://127.0.0.1:3585";

export default defineConfig({
	base: process.env.VITE_BASE_PATH ?? "/",
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@peezy.tech/codex-flows/browser": path.resolve(
				__dirname,
				"../../packages/codex-client/src/browser.ts",
			),
			"@peezy.tech/codex-flows": path.resolve(
				__dirname,
				"../../packages/codex-client/src/index.ts",
			),
			"@workspace/ui/globals.css": path.resolve(
				__dirname,
				"../../packages/ui/src/styles/globals.css",
			),
			"@workspace/ui/components": path.resolve(
				__dirname,
				"../../packages/ui/src/components",
			),
			"@workspace/ui/lib": path.resolve(
				__dirname,
				"../../packages/ui/src/lib",
			),
			"@workspace/ui": path.resolve(__dirname, "../../packages/ui/src"),
		},
	},
	server: {
		allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
		proxy: {
			"/__codex-app-server": {
				target: codexAppServerTarget,
				ws: true,
				rewrite: () => "/",
				configure: (proxy) => {
					proxy.on("proxyReqWs", (proxyReq) => {
						proxyReq.removeHeader("origin");
					});
				},
			},
		},
	},
});
