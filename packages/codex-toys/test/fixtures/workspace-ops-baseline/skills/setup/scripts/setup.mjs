#!/usr/bin/env node
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

const setupId = "workspace-ops-baseline";
const receiptRelativePath = ".codex/setup-receipts/workspace-ops-baseline.json";
const runbookReadme = "# Runbooks\n\nOperational procedures for this workspace.\n";

const workspaceRoot = process.cwd();
const receiptPath = path.join(workspaceRoot, receiptRelativePath);
const setupSkillPath = path.join(workspaceRoot, ".agents/skills/setup/SKILL.md");
const retiredSkillPath = path.join(workspaceRoot, ".agents/skills/setup/SKILL.retired.md");

const command = process.argv[2] ?? "validate";
const json = process.argv.includes("--json");

try {
	if (command === "setup") {
		await setup();
		console.log(`setup complete: ${receiptRelativePath}`);
	} else if (command === "validate") {
		const result = await validate();
		if (json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(result.ok ? "validation ok" : "validation failed");
		}
		process.exitCode = result.ok ? 0 : 1;
	} else if (command === "retire") {
		const result = await validate();
		if (!result.ok) {
			console.error(JSON.stringify(result, null, 2));
			process.exitCode = 1;
		} else {
			await retire();
			console.log("setup skill retired");
		}
	} else if (command === "teardown") {
		await teardown();
		console.log("teardown complete");
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

async function setup() {
	await mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
	await mkdir(path.join(workspaceRoot, "runbooks"), { recursive: true });
	await mkdir(path.dirname(receiptPath), { recursive: true });
	await writeIfMissing(path.join(workspaceRoot, "runbooks/README.md"), runbookReadme);
	await writeReceipt({
		version: 1,
		setupId,
		state: "active",
		workspaceRoot,
		receiptPath: receiptRelativePath,
		managedPaths: [
			"notes/",
			"runbooks/README.md",
			receiptRelativePath,
		],
		setupAt: new Date().toISOString(),
	});
}

async function validate() {
	const checks = [
		await checkDirectory("notes directory", "notes"),
		await checkFile("runbooks readme", "runbooks/README.md"),
		await checkReceipt(),
	];
	return {
		ok: checks.every((check) => check.ok),
		setupId,
		checks,
	};
}

async function retire() {
	const receipt = await readReceipt();
	await writeReceipt({
		...receipt,
		state: "retired",
		retiredAt: new Date().toISOString(),
	});
	try {
		await rename(setupSkillPath, retiredSkillPath);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) {
			throw error;
		}
	}
}

async function teardown() {
	await removeIfExact(path.join(workspaceRoot, "runbooks/README.md"), runbookReadme);
	await removeEmptyDirectory(path.join(workspaceRoot, "runbooks"));
	await removeEmptyDirectory(path.join(workspaceRoot, "notes"));
	await rm(receiptPath, { force: true });
	await removeEmptyDirectory(path.dirname(receiptPath));
	await removeEmptyDirectory(path.join(workspaceRoot, ".codex"));
}

async function writeIfMissing(filePath, contents) {
	try {
		await readFile(filePath, "utf8");
	} catch (error) {
		if (!isErrno(error, "ENOENT")) {
			throw error;
		}
		await writeFile(filePath, contents);
	}
}

async function writeReceipt(receipt) {
	await mkdir(path.dirname(receiptPath), { recursive: true });
	await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function readReceipt() {
	return JSON.parse(await readFile(receiptPath, "utf8"));
}

async function checkDirectory(id, relativePath) {
	try {
		await readdir(path.join(workspaceRoot, relativePath));
		return { id, ok: true, summary: `${relativePath} exists` };
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return { id, ok: false, summary: `${relativePath} is missing` };
		}
		throw error;
	}
}

async function checkFile(id, relativePath) {
	try {
		await readFile(path.join(workspaceRoot, relativePath), "utf8");
		return { id, ok: true, summary: `${relativePath} exists` };
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return { id, ok: false, summary: `${relativePath} is missing` };
		}
		throw error;
	}
}

async function checkReceipt() {
	try {
		const receipt = await readReceipt();
		const ok = receipt.setupId === setupId && receipt.receiptPath === receiptRelativePath;
		return {
			id: "receipt",
			ok,
			summary: ok ? `${receiptRelativePath} matches ${setupId}` : `${receiptRelativePath} is not for ${setupId}`,
		};
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return { id: "receipt", ok: false, summary: `${receiptRelativePath} is missing` };
		}
		throw error;
	}
}

async function removeIfExact(filePath, contents) {
	try {
		const current = await readFile(filePath, "utf8");
		if (current === contents) {
			await rm(filePath);
		}
	} catch (error) {
		if (!isErrno(error, "ENOENT")) {
			throw error;
		}
	}
}

async function removeEmptyDirectory(directoryPath) {
	try {
		await rmdir(directoryPath);
	} catch (error) {
		if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) {
			throw error;
		}
	}
}

function isErrno(error, code) {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
