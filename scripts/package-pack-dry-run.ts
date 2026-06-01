import { spawn } from "node:child_process";

type PackFile = {
	path: string;
	size: number;
};

type PackResult = {
	name: string;
	version: string;
	filename: string;
	files: PackFile[];
	unpackedSize: number;
	size: number;
};

async function main(): Promise<void> {
	const proc = spawn("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);

	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);

	if (exitCode !== 0) {
		process.stderr.write(stderr);
		process.stderr.write(stdout);
		process.exit(exitCode);
	}

	const results = JSON.parse(stdout) as PackResult[];
	const result = results[0];

	if (!result) {
		throw new Error("npm pack did not return package metadata");
	}

	const byTopLevel = new Map<string, number>();
	for (const file of result.files) {
		const [topLevel = file.path] = file.path.split("/");
		byTopLevel.set(topLevel, (byTopLevel.get(topLevel) ?? 0) + 1);
	}

	const topLevelSummary = [...byTopLevel.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, count]) => `${name}: ${count}`)
		.join(", ");

	console.log(`${result.name}@${result.version}`);
	console.log(`tarball: ${result.filename}`);
	console.log(`files: ${result.files.length} (${topLevelSummary})`);
	console.log(`package size: ${formatBytes(result.size)}`);
	console.log(`unpacked size: ${formatBytes(result.unpackedSize)}`);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	const kib = bytes / 1024;
	if (kib < 1024) {
		return `${kib.toFixed(1)} KiB`;
	}

	return `${(kib / 1024).toFixed(1)} MiB`;
}

function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		if (!stream) {
			resolve(output);
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			output += chunk;
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
	});
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
