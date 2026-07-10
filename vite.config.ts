import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));
const packageSrc = (name: string) => path.resolve(root, "packages", name, "src");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@codex-appkit\/codex\/generated$/,
				replacement: path.join(packageSrc("codex"), "app-server/generated/index.ts"),
			},
			{
				find: /^@codex-appkit\/codex\/generated\/(.+)$/,
				replacement: path.join(packageSrc("codex"), "app-server/generated/$1.ts"),
			},
			{
				find: /^@codex-appkit\/codex\/(auth|client|events|rpc)$/,
				replacement: path.join(packageSrc("codex"), "app-server/$1.ts"),
			},
			{
				find: /^@codex-appkit\/codex\/stdio$/,
				replacement: path.join(packageSrc("codex"), "app-server/stdio-transport.ts"),
			},
			{
				find: /^@codex-appkit\/codex\/json$/,
				replacement: path.join(packageSrc("codex"), "json.ts"),
			},
			{
				find: /^@codex-appkit\/(claude|codex|harness|http)$/,
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
