import type { Plugin } from "vite";
import {
	createCodexAppkitHttpHandler,
	type CodexAppkitHttpOptions,
} from "./server.ts";

export type CodexAppkitVitePluginOptions = CodexAppkitHttpOptions & {
	basePath?: string;
};

export function codexAppkit(options: CodexAppkitVitePluginOptions = {}): Plugin {
	const basePath = normalizeBasePath(options.basePath ?? "/__codex_appkit");
	const handler = createCodexAppkitHttpHandler({
		...options,
		apiBasePath: `${basePath}/api`,
	});
	return {
		name: "codex-appkit",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				if (!request.url) {
					next();
					return;
				}
				const url = new URL(request.url, "http://codex-appkit.local");
				if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
					next();
					return;
				}
				await handler(request, response, next);
			});
		},
	};
}

function normalizeBasePath(value: string): string {
	const path = value.startsWith("/") ? value : `/${value}`;
	return path.replace(/\/+$/, "") || "/__codex_appkit";
}
