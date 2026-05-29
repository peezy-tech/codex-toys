import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));
const codexClientSrc = path.resolve(root, "packages/codex-client/src");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^codex-toys\/browser$/,
				replacement: path.join(codexClientSrc, "browser.ts"),
			},
			{
				find: /^codex-toys\/auth$/,
				replacement: path.join(codexClientSrc, "auth.ts"),
			},
			{
				find: /^codex-toys\/actions$/,
				replacement: path.join(codexClientSrc, "actions.ts"),
			},
			{
				find: /^codex-toys\/memories$/,
				replacement: path.join(codexClientSrc, "memories.ts"),
			},
			{
				find: /^codex-toys\/workbench$/,
				replacement: path.join(codexClientSrc, "workbench.ts"),
			},
			{
				find: /^codex-toys\/threads$/,
				replacement: path.join(codexClientSrc, "threads.ts"),
			},
			{
				find: /^codex-toys\/generated$/,
				replacement: path.join(codexClientSrc, "app-server/generated/index.ts"),
			},
			{
				find: /^codex-toys\/generated\/(.+)$/,
				replacement: path.join(codexClientSrc, "app-server/generated/$1.ts"),
			},
			{
				find: /^codex-toys\/rpc$/,
				replacement: path.join(codexClientSrc, "app-server/rpc.ts"),
			},
			{
				find: /^codex-toys\/toybox$/,
				replacement: path.join(codexClientSrc, "toybox/index.ts"),
			},
			{
				find: /^codex-toys$/,
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
