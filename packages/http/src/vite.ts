import type { Plugin } from "vite";
import {
	createAgentHarnessHttpHandler,
	type AgentHarnessHttpOptions,
} from "./server.ts";

export type AgentHarnessVitePluginOptions = AgentHarnessHttpOptions & {
	basePath?: string;
};

export function agentHarness(options: AgentHarnessVitePluginOptions = {}): Plugin {
	const basePath = normalizeBasePath(options.basePath ?? "/__agent_harness");
	const handler = createAgentHarnessHttpHandler({
		...options,
		apiBasePath: `${basePath}/api`,
	});
	return {
		name: "agent-harness",
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
	return path.replace(/\/+$/, "") || "/__agent_harness";
}
