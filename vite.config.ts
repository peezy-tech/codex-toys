import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@meka\/sdk$/,
        replacement: path.resolve(root, "packages/sdk/src/index.ts"),
      },
      {
        find: /^@meka\/app$/,
        replacement: path.resolve(root, "apps/meka/src/library.ts"),
      },
      {
        find: /^@meka\/workflow$/,
        replacement: path.resolve(root, "packages/workflow/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
  },
});
