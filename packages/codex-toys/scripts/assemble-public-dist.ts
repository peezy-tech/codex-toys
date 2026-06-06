import { chmod, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type InternalPackage = {
	name: string;
	dir: string;
};

type PackageManifest = {
	name?: string;
	version?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const publicDistDir = path.join(packageRoot, "dist");
const publicInternalDistDir = path.join(publicDistDir, "internal");

const internalPackages: InternalPackage[] = [
	{ name: "actions", dir: "packages/actions" },
	{ name: "bridge", dir: "packages/bridge" },
	{ name: "feed", dir: "packages/feed" },
	{ name: "kits", dir: "packages/kits" },
	{ name: "proxy", dir: "packages/proxy" },
	{ name: "remote", dir: "packages/remote" },
	{ name: "toybox", dir: "packages/toybox" },
	{ name: "workbench", dir: "packages/workbench" },
];

await main();

async function main(): Promise<void> {
	await rm(publicInternalDistDir, { recursive: true, force: true });

	for (const internalPackage of internalPackages) {
		const sourceDistDir = path.join(repoRoot, internalPackage.dir, "dist");
		const targetDistDir = path.join(publicInternalDistDir, internalPackage.name);
		await cp(sourceDistDir, targetDistDir, { recursive: true });
	}

	const emittedFiles = await listEmittedFiles(publicDistDir);
	for (const filePath of emittedFiles) {
		await rewriteInternalPackageSpecifiers(filePath);
	}

	await writeInternalPackageManifest();
	await chmod(path.join(publicInternalDistDir, "proxy", "bin", "codex-toys-proxy.js"), 0o755);
}

async function listEmittedFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listEmittedFiles(entryPath)));
		} else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
			files.push(entryPath);
		}
	}

	return files;
}

async function rewriteInternalPackageSpecifiers(filePath: string): Promise<void> {
	const original = await readFile(filePath, "utf8");
	const updated = original.replace(
		/(["'])@codex-toys\/([a-z-]+)(\/[^"']*)?\1/g,
		(match, quote: string, packageName: string, subpath: string | undefined) => {
			const targetPath = resolveInternalPackagePath(packageName, subpath?.slice(1));
			if (targetPath === null) {
				return match;
			}
			return `${quote}${relativeModuleSpecifier(filePath, targetPath)}${quote}`;
		},
	);

	if (updated !== original) {
		await writeFile(filePath, updated);
	}
}

async function writeInternalPackageManifest(): Promise<void> {
	const packageJson = JSON.parse(
		await readFile(path.join(packageRoot, "package.json"), "utf8"),
	) as PackageManifest;
	await writeFile(
		path.join(publicInternalDistDir, "package.json"),
		`${JSON.stringify(
			{
				name: packageJson.name ?? "codex-toys",
				version: packageJson.version ?? "unknown",
				type: "module",
			},
			null,
			2,
		)}\n`,
	);
}

function resolveInternalPackagePath(packageName: string, subpath?: string): string | null {
	if (!internalPackages.some((internalPackage) => internalPackage.name === packageName)) {
		return null;
	}

	const packageDistDir = path.join(publicInternalDistDir, packageName);
	if (!subpath || subpath.length === 0) {
		return path.join(packageDistDir, "index.js");
	}

	if (packageName === "bridge") {
		if (subpath === "generated") {
			return path.join(packageDistDir, "app-server", "generated", "index.js");
		}
		if (subpath.startsWith("generated/")) {
			return withJsExtension(
				path.join(packageDistDir, "app-server", "generated", subpath.slice("generated/".length)),
			);
		}
		if (subpath === "rpc") {
			return path.join(packageDistDir, "app-server", "rpc.js");
		}
	}

	return withJsExtension(path.join(packageDistDir, subpath));
}

function withJsExtension(filePath: string): string {
	return filePath.endsWith(".js") ? filePath : `${filePath}.js`;
}

function relativeModuleSpecifier(fromFilePath: string, targetFilePath: string): string {
	const relativePath = toPosixPath(path.relative(path.dirname(fromFilePath), targetFilePath));
	return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function toPosixPath(filePath: string): string {
	return filePath.split(path.sep).join(path.posix.sep);
}
