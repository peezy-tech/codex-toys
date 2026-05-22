import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PackageJson = {
	name?: string;
	version?: string;
	publishConfig?: {
		access?: string;
	};
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

const publicPackageJsonPaths = [
	"packages/codex-client/package.json",
	"packages/flow-runtime/package.json",
	"packages/flow-backend-convex/package.json",
];

const dependencyFields = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

const invalidProtocols = ["workspace:", "catalog:"] as const;
const failures: string[] = [];

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});

async function main(): Promise<void> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-flows-publish-metadata-"));

	try {
		for (const manifestPath of publicPackageJsonPaths) {
			const packageDir = path.dirname(manifestPath);
			const packDir = path.join(tempRoot, packageDir.replaceAll("/", "-"));
			const pack = spawnSync(
				"pnpm",
				[
					"--dir",
					packageDir,
					"--config.ignore-scripts=true",
					"pack",
					"--pack-destination",
					packDir,
				],
				{ encoding: "utf8" },
			);

			if (pack.status !== 0) {
				failures.push(`${manifestPath}: pnpm pack failed\n${pack.stderr || pack.stdout}`);
				continue;
			}

			const tarball = (await readdir(packDir)).find((file) => file.endsWith(".tgz"));
			if (!tarball) {
				failures.push(`${manifestPath}: pnpm pack did not create a tarball`);
				continue;
			}

			const packedManifest = spawnSync(
				"tar",
				["-xOf", path.join(packDir, tarball), "package/package.json"],
				{ encoding: "utf8" },
			);

			if (packedManifest.status !== 0) {
				failures.push(`${manifestPath}: failed to inspect packed package.json`);
				continue;
			}

			const manifest = JSON.parse(packedManifest.stdout) as PackageJson;
			if (manifest.publishConfig?.access !== "public") {
				failures.push(`${manifestPath}: expected packed publishConfig.access to be public`);
			}

			for (const field of dependencyFields) {
				const dependencies = manifest[field] ?? {};
				for (const [dependencyName, range] of Object.entries(dependencies)) {
					if (invalidProtocols.some((protocol) => range.startsWith(protocol))) {
						failures.push(
							`${manifestPath}: packed ${field}.${dependencyName} uses non-publishable range ${range}`,
						);
					}
				}
			}
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}

	if (failures.length > 0) {
		console.error("Public package metadata is not publishable:");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exit(1);
	}

	console.log(
		`publish metadata ok: ${publicPackageJsonPaths.map((manifestPath) => path.dirname(manifestPath)).join(", ")}`,
	);
}
