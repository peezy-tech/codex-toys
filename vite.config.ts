import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));
const packageSrc = (name: string) => path.resolve(root, "packages", name, "src");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@codex-appkit\/app-server\/generated$/,
				replacement: path.join(packageSrc("app-server"), "app-server/generated/index.ts"),
			},
			{
				find: /^@codex-appkit\/app-server\/generated\/(.+)$/,
				replacement: path.join(packageSrc("app-server"), "app-server/generated/$1.ts"),
			},
			{
				find: /^@codex-appkit\/app-server\/(auth|client|events|rpc)$/,
				replacement: path.join(packageSrc("app-server"), "app-server/$1.ts"),
			},
			{
				find: /^@codex-appkit\/app-server\/stdio$/,
				replacement: path.join(packageSrc("app-server"), "app-server/stdio-transport.ts"),
			},
			{
				find: /^@codex-appkit\/app-server\/json$/,
				replacement: path.join(packageSrc("app-server"), "json.ts"),
			},
			{
				find: /^@codex-appkit\/(app-server|http|microbridge)$/,
				replacement: path.resolve(root, "packages/$1/src/index.ts"),
			},
			{
				find: /^@codex-appkit\/http\/(browser|vite)$/,
				replacement: path.resolve(root, "packages/http/src/$1.ts"),
			},
		],
	},
	test: {
		include: ["packages/**/test/**/*.test.ts", "examples/**/test/**/*.test.ts"],
	},
});
