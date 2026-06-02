import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type DependencyField =
	| "dependencies"
	| "devDependencies"
	| "peerDependencies"
	| "optionalDependencies";

type PackageJson = {
	name?: string;
	version?: string;
	private?: boolean;
	bin?: Record<string, string>;
	bundledDependencies?: string[];
	bundleDependencies?: string[];
	exports?: Record<string, unknown>;
	publishConfig?: {
		access?: string;
	};
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

const publicManifestPath = "packages/codex-toys/package.json";

const internalPackageJsonPaths = [
	"packages/actions/package.json",
	"packages/bridge/package.json",
	"packages/feed/package.json",
	"packages/kits/package.json",
	"packages/proxy/package.json",
	"packages/remote/package.json",
	"packages/toybox/package.json",
	"packages/workbench/package.json",
];

const bundledInternalPackages = [
	"@codex-toys/actions",
	"@codex-toys/bridge",
	"@codex-toys/feed",
	"@codex-toys/kits",
	"@codex-toys/proxy",
	"@codex-toys/remote",
	"@codex-toys/toybox",
	"@codex-toys/workbench",
] as const;

const bundledRuntimePackages = [
	"smol-toml",
	"tsx",
	"esbuild",
	"@esbuild/linux-x64",
] as const;

const publicSubpathExports = [
	".",
	"./actions",
	"./bridge",
	"./bridge/auth",
	"./bridge/generated",
	"./bridge/json",
	"./bridge/memories",
	"./bridge/rpc",
	"./bridge/threads",
	"./feed",
	"./kits",
	"./proxy",
	"./proxy/browser",
	"./proxy/vite",
	"./remote",
	"./toybox",
	"./workbench",
] as const;

const dependencyFields: DependencyField[] = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

const invalidProtocols = ["workspace:", "catalog:"] as const;
const failures: string[] = [];

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});

async function main(): Promise<void> {
	await checkSourceManifests();

	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-publish-metadata-"));

	try {
		const packDir = path.join(tempRoot, "codex-toys");
		await mkdir(packDir, { recursive: true });
		const pack = spawnSync(
			"tsx",
			["scripts/pack-public-package.ts", "--pack-destination", packDir],
			{ encoding: "utf8" },
		);

		if (pack.status !== 0) {
			failures.push(`${publicManifestPath}: public package pack failed\n${pack.stderr || pack.stdout}`);
		} else {
			const tarball = (await readdir(packDir)).find((file) => file.endsWith(".tgz"));
			if (!tarball) {
				failures.push(`${publicManifestPath}: public package pack did not create a tarball`);
			} else {
				await checkPackedPackage(path.join(packDir, tarball));
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
		`publish metadata ok: codex-toys bundles ${[...bundledInternalPackages, ...bundledRuntimePackages].join(", ")}`,
	);
}

async function checkSourceManifests(): Promise<void> {
	const publicManifest = await readManifest(publicManifestPath);
	if (publicManifest.private === true) {
		failures.push(`${publicManifestPath}: public package must not be private`);
	}
	if (publicManifest.publishConfig?.access !== "public") {
		failures.push(`${publicManifestPath}: expected publishConfig.access to be public`);
	}

	const bundled = new Set([
		...(publicManifest.bundledDependencies ?? []),
		...(publicManifest.bundleDependencies ?? []),
	]);
	for (const packageName of [...bundledInternalPackages, ...bundledRuntimePackages]) {
		if (!bundled.has(packageName)) {
			failures.push(`${publicManifestPath}: missing bundled dependency ${packageName}`);
		}
		if (
			publicManifest.dependencies?.[packageName] === undefined &&
			publicManifest.optionalDependencies?.[packageName] === undefined
		) {
			failures.push(`${publicManifestPath}: missing dependency ${packageName}`);
		}
	}

	for (const subpath of publicSubpathExports) {
		if (publicManifest.exports?.[subpath] === undefined) {
			failures.push(`${publicManifestPath}: missing export ${subpath}`);
		}
	}

	if (publicManifest.bin?.["codex-toys"] !== "dist/cli/index.js") {
		failures.push(`${publicManifestPath}: missing codex-toys bin`);
	}
	if (
		publicManifest.bin?.["codex-toys-proxy"] !==
		"node_modules/@codex-toys/proxy/dist/bin/codex-toys-proxy.js"
	) {
		failures.push(`${publicManifestPath}: missing codex-toys-proxy bin`);
	}

	for (const manifestPath of internalPackageJsonPaths) {
		const manifest = await readManifest(manifestPath);
		if (manifest.private !== true) {
			failures.push(`${manifestPath}: internal package must be private`);
		}
		if (manifest.publishConfig !== undefined) {
			failures.push(`${manifestPath}: internal package must not declare publishConfig`);
		}
	}
}

async function checkPackedPackage(tarballPath: string): Promise<void> {
	const packedManifest = extractTarText(tarballPath, "package/package.json");
	if (packedManifest === null) {
		failures.push(`${publicManifestPath}: failed to inspect packed package.json`);
		return;
	}

	const manifest = JSON.parse(packedManifest) as PackageJson;
	if (manifest.private === true) {
		failures.push(`${publicManifestPath}: packed package must not be private`);
	}
	if (manifest.publishConfig?.access !== "public") {
		failures.push(`${publicManifestPath}: expected packed publishConfig.access to be public`);
	}

	for (const field of dependencyFields) {
		const dependencies = manifest[field] ?? {};
		for (const [dependencyName, range] of Object.entries(dependencies)) {
			if (invalidProtocols.some((protocol) => range.startsWith(protocol))) {
				failures.push(
					`${publicManifestPath}: packed ${field}.${dependencyName} uses non-publishable range ${range}`,
				);
			}
		}
	}

	const tarEntries = listTarEntries(tarballPath);
	for (const entry of [
		"package/dist/index.js",
		"package/dist/feed.js",
		"package/dist/workbench.js",
		"package/dist/proxy/browser.js",
		"package/dist/bridge/json.js",
		"package/node_modules/@codex-toys/proxy/dist/bin/codex-toys-proxy.js",
		"package/node_modules/smol-toml/dist/index.js",
		"package/node_modules/tsx/dist/loader.mjs",
		"package/node_modules/esbuild/lib/main.js",
		"package/node_modules/@esbuild/linux-x64/bin/esbuild",
	]) {
		if (!tarEntries.has(entry)) {
			failures.push(`${publicManifestPath}: packed tarball is missing ${entry}`);
		}
	}

	for (const packageName of bundledInternalPackages) {
		const packagePath = packageName.replace("@codex-toys/", "@codex-toys/");
		const packageJsonPath = `package/node_modules/${packagePath}/package.json`;
		const distPath = `package/node_modules/${packagePath}/dist/index.js`;
		if (!tarEntries.has(packageJsonPath)) {
			failures.push(`${publicManifestPath}: packed tarball is missing ${packageJsonPath}`);
			continue;
		}
		if (!tarEntries.has(distPath)) {
			failures.push(`${publicManifestPath}: packed tarball is missing ${distPath}`);
		}

		const internalManifestText = extractTarText(tarballPath, packageJsonPath);
		if (internalManifestText === null) {
			failures.push(`${publicManifestPath}: failed to inspect ${packageJsonPath}`);
			continue;
		}
		const internalManifest = JSON.parse(internalManifestText) as PackageJson;
		if (internalManifest.private !== true) {
			failures.push(`${packageJsonPath}: bundled internal package must stay private`);
		}
		if (internalManifest.publishConfig !== undefined) {
			failures.push(`${packageJsonPath}: bundled internal package must not declare publishConfig`);
		}
	}

	const tsxManifestText = extractTarText(tarballPath, "package/node_modules/tsx/package.json");
	if (tsxManifestText === null) {
		failures.push(`${publicManifestPath}: failed to inspect bundled tsx package.json`);
	} else {
		const tsxManifest = JSON.parse(tsxManifestText) as PackageJson;
		if (tsxManifest.optionalDependencies?.fsevents !== undefined) {
			failures.push(`${publicManifestPath}: bundled tsx package must not include fsevents`);
		}
	}

	const esbuildManifestText = extractTarText(
		tarballPath,
		"package/node_modules/esbuild/package.json",
	);
	if (esbuildManifestText === null) {
		failures.push(`${publicManifestPath}: failed to inspect bundled esbuild package.json`);
	} else {
		const esbuildManifest = JSON.parse(esbuildManifestText) as PackageJson;
		if (esbuildManifest.scripts !== undefined) {
			failures.push(`${publicManifestPath}: bundled esbuild package must not include scripts`);
		}
	}
}

async function readManifest(manifestPath: string): Promise<PackageJson> {
	return JSON.parse(await readFile(manifestPath, "utf8")) as PackageJson;
}

function extractTarText(tarballPath: string, memberPath: string): string | null {
	const extract = spawnSync("tar", ["-xOf", tarballPath, memberPath], {
		encoding: "utf8",
	});
	if (extract.status !== 0) {
		return null;
	}
	return extract.stdout;
}

function listTarEntries(tarballPath: string): Set<string> {
	const list = spawnSync("tar", ["-tf", tarballPath], { encoding: "utf8" });
	if (list.status !== 0) {
		failures.push(`${publicManifestPath}: failed to list packed tarball`);
		return new Set();
	}
	return new Set(list.stdout.split("\n").filter(Boolean));
}
