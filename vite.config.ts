import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));
const codexClientSrc = path.resolve(root, "packages/codex-client/src");
const flowRuntimeSrc = path.resolve(root, "packages/flow-runtime/src");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@peezy\.tech\/codex-flows\/flow-runtime$/,
				replacement: path.join(flowRuntimeSrc, "index.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/flow-runtime\/(.+)$/,
				replacement: path.join(flowRuntimeSrc, "$1.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/browser$/,
				replacement: path.join(codexClientSrc, "browser.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/flows$/,
				replacement: path.join(codexClientSrc, "app-server/flows.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/auth$/,
				replacement: path.join(codexClientSrc, "auth.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/actions$/,
				replacement: path.join(codexClientSrc, "actions.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/memories$/,
				replacement: path.join(codexClientSrc, "memories.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/workbench$/,
				replacement: path.join(codexClientSrc, "workbench.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/threads$/,
				replacement: path.join(codexClientSrc, "threads.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/generated$/,
				replacement: path.join(codexClientSrc, "app-server/generated/index.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/generated\/(.+)$/,
				replacement: path.join(codexClientSrc, "app-server/generated/$1.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/rpc$/,
				replacement: path.join(codexClientSrc, "app-server/rpc.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows\/workspace-backend$/,
				replacement: path.join(codexClientSrc, "workspace-backend/index.ts"),
			},
			{
				find: /^@peezy\.tech\/codex-flows$/,
				replacement: path.join(codexClientSrc, "index.ts"),
			},
		],
	},
	test: {
		include: [
			"apps/**/test/**/*.test.ts",
			"packages/**/test/**/*.test.ts",
		],
	},
});
