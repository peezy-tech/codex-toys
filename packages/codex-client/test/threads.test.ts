import { describe, expect, test } from "vite-plus/test";
import {
	mkdir,
	mkdtemp,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	installThreadRollout,
	inspectThreadRollout,
	locateThreadRollout,
	transplantThreadRollout,
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

	test("inspects and installs a byte-exact rollout", async () => {
		const sourceHome = await codexHome();
		const targetHome = await codexHome();
		const rollout = await writeRollout(sourceHome, threadId, {
			cwd: "/workspace/source",
			body: "byte exact payload\n",
		});
		const sourceBytes = await readFile(rollout);

		const inspectedById = await inspectThreadRollout({
			threadIdOrPath: threadId,
			codexHome: sourceHome,
		});
		const inspectedByPath = await inspectThreadRollout({ threadIdOrPath: rollout });
		const installed = await installThreadRollout({
			rolloutPath: rollout,
			codexHome: targetHome,
		});
		const targetPath = path.join(targetHome, inspectedById.relativePath);

		expect(inspectedById).toMatchObject({
			threadId,
			cwd: "/workspace/source",
			matchedBy: "session_meta",
		});
		expect(inspectedByPath.relativePath).toBe(inspectedById.relativePath);
		expect(inspectedByPath.bytes).toBe(sourceBytes.byteLength);
		expect(inspectedByPath.sha256).toBe(inspectedById.sha256);
		expect(installed.installed.path).toBe(targetPath);
		expect(await readFile(targetPath)).toEqual(sourceBytes);
	});

	test("rejects install conflicts unless replace creates a backup", async () => {
		const sourceHome = await codexHome();
		const targetHome = await codexHome();
		const rollout = await writeRollout(sourceHome, threadId, { body: "source rollout\n" });
		const inspected = await inspectThreadRollout({ threadIdOrPath: rollout });
		const targetPath = path.join(targetHome, inspected.relativePath);
		await mkdir(path.dirname(targetPath), { recursive: true });
		await writeFile(targetPath, "existing rollout\n");

		await expect(installThreadRollout({ rolloutPath: rollout, codexHome: targetHome }))
			.rejects.toThrow("already exists");

		const installed = await installThreadRollout({
			rolloutPath: rollout,
			codexHome: targetHome,
			replace: true,
		});

		expect(await readFile(targetPath, "utf8")).toContain("source rollout");
		expect(installed.installed.backupPath).toBeDefined();
		expect(await readFile(installed.installed.backupPath ?? "", "utf8"))
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

	test("installs loose rollout files using the native sessions path", async () => {
		const sourceHome = await codexHome();
		const targetHome = await codexHome();
		const rollout = await writeRollout(sourceHome, threadId, { body: "loose rollout\n" });
		const loosePath = path.join(os.tmpdir(), `rollout-2026-05-17T00-00-00-${threadId}.jsonl`);
		await writeFile(loosePath, await readFile(rollout));

		const installed = await installThreadRollout({
			rolloutPath: loosePath,
			codexHome: targetHome,
		});

		expect(installed.installed.relativePath).toBe(
			`sessions/2026/05/17/rollout-2026-05-17T00-00-00-${threadId}.jsonl`,
		);
		expect(await readFile(installed.installed.path, "utf8")).toContain("loose rollout");
	});

	test("rejects invalid rollout files", async () => {
		const invalidPath = path.join(os.tmpdir(), "not-a-rollout.jsonl");
		await writeFile(invalidPath, `${JSON.stringify({ type: "event_msg" })}\n`);

		await expect(inspectThreadRollout({ threadIdOrPath: invalidPath }))
			.rejects.toThrow("filename has no thread id");
	});
});

async function codexHome(): Promise<string> {
	const home = await mkdtemp(path.join(os.tmpdir(), "codex-thread-home-"));
	await mkdir(path.join(home, "sessions"), { recursive: true });
	return home;
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
