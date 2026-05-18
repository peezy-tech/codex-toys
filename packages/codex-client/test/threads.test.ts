import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	exportThreadBundle,
	importThreadBundle,
	inspectThreadBundle,
	locateThreadRollout,
	transplantThreadRollout,
	type ThreadBundleManifest,
} from "../src/threads.ts";

const threadId = "019e3654-1492-70d0-9b01-46b17d6444a9";
const otherThreadId = "019e3654-1492-70d0-9b01-46b17d6444aa";

describe("thread transplant", () => {
	test("locates rollouts by parsed session metadata", async () => {
		const home = await codexHome();
		const rollout = await writeRollout(home, threadId, {
			cwd: "/workspace/project",
			body: "hello thread\n",
		});

		const located = await locateThreadRollout({ threadId, codexHome: home });

		expect(located.path).toBe(rollout);
		expect(located.relativePath).toBe(
			`sessions/2026/05/17/rollout-2026-05-17T00-00-00-${threadId}.jsonl`,
		);
		expect(located.cwd).toBe("/workspace/project");
		expect(located.matchedBy).toBe("session_meta");
		expect(located.bytes).toBe((await stat(rollout)).size);
		expect(located.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("falls back to the filename when session metadata has no id", async () => {
		const home = await codexHome();
		await writeRollout(home, threadId, { includeSessionMeta: false });

		const located = await locateThreadRollout({ threadId, codexHome: home });

		expect(located.threadId).toBe(threadId);
		expect(located.matchedBy).toBe("filename");
	});

	test("fails when multiple parsed rollouts match one thread id", async () => {
		const home = await codexHome();
		await writeRollout(home, threadId);
		await writeRollout(home, threadId, {
			day: "18",
			fileThreadId: otherThreadId,
		});

		await expect(locateThreadRollout({ threadId, codexHome: home }))
			.rejects.toThrow("Multiple rollouts");
	});

	test("exports, inspects, and imports a byte-exact bundle", async () => {
		const sourceHome = await codexHome();
		const targetHome = await codexHome();
		const bundleDir = await emptyDir("thread-bundle-");
		const rollout = await writeRollout(sourceHome, threadId, {
			cwd: "/workspace/source",
			body: "byte exact payload\n",
		});
		const sourceBytes = await readFile(rollout);

		const exported = await exportThreadBundle({
			threadId,
			codexHome: sourceHome,
			outputDir: bundleDir,
		});
		const inspected = await inspectThreadBundle({ bundleDir });
		const imported = await importThreadBundle({ bundleDir, codexHome: targetHome });
		const targetPath = path.join(targetHome, exported.manifest.files[0]?.relativePath ?? "");

		expect(exported.manifest).toMatchObject({
			schemaVersion: 1,
			kind: "codex-flows.thread-bundle",
			threadId,
			source: {
				originalRelativePath: exported.rollout.relativePath,
				cwd: "/workspace/source",
			},
		});
		expect(exported.manifest.files).toEqual([
			{
				role: "rollout",
				relativePath: exported.rollout.relativePath,
				bytes: sourceBytes.byteLength,
				sha256: exported.rollout.sha256,
			},
		]);
		expect(inspected.manifest).toEqual(exported.manifest);
		expect(imported.imported[0]?.path).toBe(targetPath);
		expect(await readFile(targetPath)).toEqual(sourceBytes);
	});

	test("rejects import conflicts unless replace creates a backup", async () => {
		const sourceHome = await codexHome();
		const targetHome = await codexHome();
		const bundleDir = await emptyDir("thread-bundle-");
		await writeRollout(sourceHome, threadId, { body: "source rollout\n" });
		const exported = await exportThreadBundle({
			threadId,
			codexHome: sourceHome,
			outputDir: bundleDir,
		});
		const targetPath = path.join(targetHome, exported.manifest.files[0]?.relativePath ?? "");
		await mkdir(path.dirname(targetPath), { recursive: true });
		await writeFile(targetPath, "existing rollout\n");

		await expect(importThreadBundle({ bundleDir, codexHome: targetHome }))
			.rejects.toThrow("already exists");

		const imported = await importThreadBundle({
			bundleDir,
			codexHome: targetHome,
			replace: true,
		});

		expect(await readFile(targetPath, "utf8")).toContain("source rollout");
		expect(imported.imported[0]?.backupPath).toBeDefined();
		expect(await readFile(imported.imported[0]?.backupPath ?? "", "utf8"))
			.toBe("existing rollout\n");
	});

	test("transplants directly between Codex homes with checksum validation and backups", async () => {
		const sourceHome = await codexHome();
		const targetHome = await codexHome();
		const rollout = await writeRollout(sourceHome, threadId, {
			cwd: "/workspace/source",
			body: "direct transplant payload\n",
		});
		const sourceBytes = await readFile(rollout);

		const first = await transplantThreadRollout({
			threadId,
			fromCodexHome: sourceHome,
			toCodexHome: targetHome,
		});

		expect(first.threadId).toBe(threadId);
		expect(first.fromCodexHome).toBe(sourceHome);
		expect(first.toCodexHome).toBe(targetHome);
		expect(first.transplanted.relativePath).toBe(first.source.relativePath);
		expect(await readFile(first.transplanted.path)).toEqual(sourceBytes);

		await expect(transplantThreadRollout({
			threadId,
			fromCodexHome: sourceHome,
			toCodexHome: targetHome,
		})).rejects.toThrow("already exists");

		await writeFile(first.transplanted.path, "existing target\n");
		const replaced = await transplantThreadRollout({
			threadId,
			fromCodexHome: sourceHome,
			toCodexHome: targetHome,
			replace: true,
		});

		expect(await readFile(replaced.transplanted.path)).toEqual(sourceBytes);
		expect(replaced.transplanted.backupPath).toBeDefined();
		expect(await readFile(replaced.transplanted.backupPath ?? "", "utf8"))
			.toBe("existing target\n");
	});

	test("rejects missing manifests, checksum mismatches, and unsafe paths", async () => {
		const sourceHome = await codexHome();
		const missingManifestDir = await emptyDir("thread-bundle-missing-");
		const checksumBundleDir = await emptyDir("thread-bundle-checksum-");
		const unsafeBundleDir = await emptyDir("thread-bundle-unsafe-");
		await writeRollout(sourceHome, threadId, { body: "original\n" });
		const exported = await exportThreadBundle({
			threadId,
			codexHome: sourceHome,
			outputDir: checksumBundleDir,
		});
		const bundleRolloutPath = path.join(
			checksumBundleDir,
			exported.manifest.files[0]?.relativePath ?? "",
		);
		const tampered = Buffer.from(await readFile(bundleRolloutPath));
		const tamperIndex = Math.max(0, tampered.length - 2);
		const currentByte = tampered[tamperIndex] ?? 0;
		tampered[tamperIndex] = currentByte === 65 ? 66 : 65;
		await writeFile(bundleRolloutPath, tampered);
		await writeManifest(unsafeBundleDir, {
			...exported.manifest,
			source: { originalRelativePath: "../escape.jsonl" },
			files: [
				{
					role: "rollout",
					relativePath: "../escape.jsonl",
					bytes: 0,
					sha256: "0".repeat(64),
				},
			],
		});

		await expect(inspectThreadBundle({ bundleDir: missingManifestDir }))
			.rejects.toThrow("manifest");
		await expect(inspectThreadBundle({ bundleDir: checksumBundleDir }))
			.rejects.toThrow("checksum mismatch");
		await expect(inspectThreadBundle({ bundleDir: unsafeBundleDir }))
			.rejects.toThrow("unsafe segments");
	});
});

async function codexHome(): Promise<string> {
	const home = await mkdtemp(path.join(os.tmpdir(), "codex-thread-home-"));
	await mkdir(path.join(home, "sessions"), { recursive: true });
	return home;
}

async function emptyDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	for (const entry of await readdir(directory)) {
		throw new Error(`Temporary directory unexpectedly contained ${entry}`);
	}
	return directory;
}

async function writeRollout(
	home: string,
	metadataThreadId: string,
	options: {
		fileThreadId?: string;
		includeSessionMeta?: boolean;
		cwd?: string;
		day?: string;
		body?: string;
	} = {},
): Promise<string> {
	const day = options.day ?? "17";
	const fileThreadId = options.fileThreadId ?? metadataThreadId;
	const rolloutDir = path.join(home, "sessions", "2026", "05", day);
	const rolloutPath = path.join(
		rolloutDir,
		`rollout-2026-05-${day}T00-00-00-${fileThreadId}.jsonl`,
	);
	await mkdir(rolloutDir, { recursive: true });
	const records = [];
	if (options.includeSessionMeta ?? true) {
		records.push({
			timestamp: `2026-05-${day}T00:00:00.000Z`,
			type: "session_meta",
			payload: {
				id: metadataThreadId,
				cwd: options.cwd ?? "/workspace",
				timestamp: `2026-05-${day}T00:00:00.000Z`,
				cli_version: "test",
				source: "test",
				thread_source: null,
				model_provider: "openai",
				originator: "codex-flows-test",
			},
		});
	}
	records.push({
		timestamp: `2026-05-${day}T00:00:01.000Z`,
		type: "event_msg",
		payload: {
			type: "agent_message",
			message: options.body ?? "thread body\n",
		},
	});
	await writeFile(
		rolloutPath,
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
	);
	return rolloutPath;
}

async function writeManifest(
	bundleDir: string,
	manifest: ThreadBundleManifest,
): Promise<void> {
	await writeFile(
		path.join(bundleDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}
