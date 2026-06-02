import { spawnSync } from "node:child_process";
import {
	access,
	chmod,
	cp,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DependencyField =
	| "dependencies"
	| "devDependencies"
	| "peerDependencies"
	| "optionalDependencies";

type PackageJson = {
	name?: string;
	version?: string;
	private?: boolean;
	scripts?: Record<string, string>;
	publishConfig?: {
		access?: string;
	};
	bundledDependencies?: string[];
	bundleDependencies?: string[];
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

type InternalPackage = {
	name: string;
	dir: string;
};

type RuntimePackage = {
	name: string;
	executablePaths?: string[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const publicPackageDir = path.join(repoRoot, "packages", "codex-toys");

const internalPackages: InternalPackage[] = [
	{ name: "@codex-toys/actions", dir: "packages/actions" },
	{ name: "@codex-toys/bridge", dir: "packages/bridge" },
	{ name: "@codex-toys/feed", dir: "packages/feed" },
	{ name: "@codex-toys/kits", dir: "packages/kits" },
	{ name: "@codex-toys/proxy", dir: "packages/proxy" },
	{ name: "@codex-toys/remote", dir: "packages/remote" },
	{ name: "@codex-toys/toybox", dir: "packages/toybox" },
	{ name: "@codex-toys/workbench", dir: "packages/workbench" },
];

const runtimePackages: RuntimePackage[] = [
	{ name: "smol-toml" },
	{ name: "tsx" },
	{ name: "esbuild", executablePaths: ["bin/esbuild"] },
	{ name: "@esbuild/linux-x64", executablePaths: ["bin/esbuild"] },
];

const dependencyFields: DependencyField[] = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

async function main(): Promise<void> {
	const packDestination = resolvePackDestination(process.argv);
	await mkdir(packDestination, { recursive: true });

	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-public-pack-"));

	try {
		const stagingDir = path.join(tempRoot, "package");
		await mkdir(stagingDir, { recursive: true });

		const catalog = await readCatalog();
		const publicManifest = await readManifest(path.join(publicPackageDir, "package.json"));
		const publicVersion = requireString(publicManifest.version, "codex-toys version");

		await cp(path.join(publicPackageDir, "dist"), path.join(stagingDir, "dist"), {
			recursive: true,
		});
		await cp(path.join(publicPackageDir, "README.md"), path.join(stagingDir, "README.md"));
		normalizeDependencies(publicManifest, catalog, publicVersion);
		publicManifest.bundledDependencies = [
			...internalPackages.map((internalPackage) => internalPackage.name),
			...runtimePackages.map((runtimePackage) => runtimePackage.name),
		];
		delete publicManifest.bundleDependencies;
		await writeManifest(path.join(stagingDir, "package.json"), publicManifest);
		await chmod(path.join(stagingDir, "dist", "cli", "index.js"), 0o755);

		for (const internalPackage of internalPackages) {
			const sourceDir = path.join(repoRoot, internalPackage.dir);
			const targetDir = path.join(
				stagingDir,
				"node_modules",
				"@codex-toys",
				internalPackage.name.replace("@codex-toys/", ""),
			);
			await mkdir(targetDir, { recursive: true });
			await cp(path.join(sourceDir, "dist"), path.join(targetDir, "dist"), {
				recursive: true,
			});

			const manifest = await readManifest(path.join(sourceDir, "package.json"));
			manifest.private = true;
			delete manifest.publishConfig;
			delete manifest.scripts;
			normalizeDependencies(manifest, catalog, publicVersion);
			await writeManifest(path.join(targetDir, "package.json"), manifest);
		}

		for (const runtimePackage of runtimePackages) {
			await copyRuntimePackage(stagingDir, runtimePackage);
		}

		await chmod(
			path.join(
				stagingDir,
				"node_modules",
				"@codex-toys",
				"proxy",
				"dist",
				"bin",
				"codex-toys-proxy.js",
			),
			0o755,
		);

		const pack = spawnSync(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", packDestination],
			{
				cwd: stagingDir,
				encoding: "utf8",
			},
		);

		if (pack.status !== 0) {
			process.stderr.write(pack.stderr ?? "");
			process.stderr.write(pack.stdout ?? "");
			process.exit(pack.status ?? 1);
		}

		process.stdout.write(pack.stdout);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function resolvePackDestination(argv: string[]): string {
	const destinationArg = argv.findIndex((arg) => arg === "--pack-destination");
	if (destinationArg === -1) {
		return process.cwd();
	}
	const destination = argv[destinationArg + 1];
	if (!destination) {
		throw new Error("--pack-destination requires a value");
	}
	return path.resolve(destination);
}

async function copyRuntimePackage(
	stagingDir: string,
	runtimePackage: RuntimePackage,
): Promise<void> {
	const sourceDir = await findInstalledPackageDir(runtimePackage.name);
	const targetDir = path.join(
		stagingDir,
		"node_modules",
		...packageNamePathSegments(runtimePackage.name),
	);
	await mkdir(path.dirname(targetDir), { recursive: true });
	await cp(sourceDir, targetDir, { recursive: true });

	const manifestPath = path.join(targetDir, "package.json");
	const manifest = await readManifest(manifestPath);
	sanitizeRuntimeManifest(runtimePackage.name, manifest);
	await writeManifest(manifestPath, manifest);

	for (const executablePath of runtimePackage.executablePaths ?? []) {
		await chmod(path.join(targetDir, executablePath), 0o755);
	}
}

async function findInstalledPackageDir(packageName: string): Promise<string> {
	const searchRoots = [
		publicPackageDir,
		path.join(repoRoot, "packages", "workbench"),
		path.join(repoRoot, "packages", "kits"),
		repoRoot,
	];

	for (const root of searchRoots) {
		const candidateDir = path.join(root, "node_modules", ...packageNamePathSegments(packageName));
		if (await pathExists(path.join(candidateDir, "package.json"))) {
			return realpath(candidateDir);
		}
	}

	const pnpmStoreDir = path.join(repoRoot, "node_modules", ".pnpm");
	const packageStorePrefix = `${packageName.replace("/", "+")}@`;
	for (const entry of await readdir(pnpmStoreDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(packageStorePrefix)) {
			continue;
		}
		const candidateDir = path.join(
			pnpmStoreDir,
			entry.name,
			"node_modules",
			...packageNamePathSegments(packageName),
		);
		if (await pathExists(path.join(candidateDir, "package.json"))) {
			return realpath(candidateDir);
		}
	}

	throw new Error(`Could not find installed package ${packageName}`);
}

function packageNamePathSegments(packageName: string): string[] {
	return packageName.split("/");
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

function sanitizeRuntimeManifest(packageName: string, manifest: PackageJson): void {
	delete manifest.devDependencies;
	delete manifest.scripts;

	if (packageName === "tsx") {
		delete manifest.optionalDependencies;
	}
}

async function readCatalog(): Promise<Map<string, string>> {
	const workspaceText = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
	const catalog = new Map<string, string>();
	let inCatalog = false;

	for (const line of workspaceText.split("\n")) {
		if (line === "catalog:") {
			inCatalog = true;
			continue;
		}
		if (inCatalog && line.length > 0 && !line.startsWith(" ")) {
			break;
		}
		if (!inCatalog) {
			continue;
		}
		const match = line.match(/^\s{2}("?[^":]+"?):\s+(.+)$/);
		if (!match) {
			continue;
		}
		const name = match[1].replace(/^"|"$/g, "");
		catalog.set(name, match[2].trim());
	}

	return catalog;
}

async function readManifest(manifestPath: string): Promise<PackageJson> {
	return JSON.parse(await readFile(manifestPath, "utf8")) as PackageJson;
}

async function writeManifest(manifestPath: string, manifest: PackageJson): Promise<void> {
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
}

function normalizeDependencies(
	manifest: PackageJson,
	catalog: Map<string, string>,
	publicVersion: string,
): void {
	for (const field of dependencyFields) {
		const dependencies = manifest[field];
		if (!dependencies) {
			continue;
		}
		for (const [dependencyName, range] of Object.entries(dependencies)) {
			if (range.startsWith("workspace:")) {
				dependencies[dependencyName] = publicVersion;
			} else if (range.startsWith("catalog:")) {
				const catalogRange = catalog.get(dependencyName);
				if (!catalogRange) {
					throw new Error(`No catalog entry for ${dependencyName}`);
				}
				dependencies[dependencyName] = catalogRange;
			}
		}
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing ${label}`);
	}
	return value;
}
