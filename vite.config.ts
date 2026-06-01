import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));
const packageSrc = (name: string) => path.resolve(root, "packages", name, "src");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@codex-toys\/bridge\/generated$/,
				replacement: path.join(packageSrc("bridge"), "app-server/generated/index.ts"),
			},
			{
				find: /^@codex-toys\/bridge\/generated\/(.+)$/,
				replacement: path.join(packageSrc("bridge"), "app-server/generated/$1.ts"),
			},
			{
				find: /^@codex-toys\/bridge\/rpc$/,
				replacement: path.join(packageSrc("bridge"), "app-server/rpc.ts"),
			},
			{
				find: /^@codex-toys\/bridge\/app-server\/(.+)$/,
				replacement: path.join(packageSrc("bridge"), "app-server/$1.ts"),
			},
			{
				find: /^@codex-toys\/proxy\/browser$/,
				replacement: path.join(packageSrc("proxy"), "browser.ts"),
			},
			{
				find: /^@codex-toys\/proxy\/vite$/,
				replacement: path.join(packageSrc("proxy"), "vite.ts"),
			},
			{
				find: /^@codex-toys\/(actions|bridge|kits|proxy|remote|toybox|workbench)\/(.+)$/,
				replacement: path.resolve(root, "packages/$1/src/$2.ts"),
			},
			{
				find: /^@codex-toys\/([^/]+)$/,
				replacement: path.resolve(root, "packages/$1/src/index.ts"),
			},
			{
				find: /^codex-toys$/,
				replacement: path.join(packageSrc("codex-toys"), "index.ts"),
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
