import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
	announcementFromHookEvent,
	HookSpoolObserver,
} from "../src/hook-spool.ts";
import type { VoiceAnnouncement } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("hook spool announcements", () => {
	test("announces external Stop hook events without archiving files", async () => {
		const root = await mkTempDir();
		const pending = path.join(root, "pending");
		await mkdir(pending, { recursive: true });
		const filePath = path.join(pending, "stop-1.json");
		await writeFile(
			filePath,
			`${JSON.stringify({
				version: 1,
				id: "stop-1",
				eventName: "Stop",
				sessionId: "thread-1",
				turnId: "turn-1",
				cwd: "/home/peezy/meta-workspace/codex-flows",
				lastAssistantMessage: "Done. `vp test` passed.",
				createdAt: new Date().toISOString(),
			})}\n`,
		);

		const announcements: VoiceAnnouncement[] = [];
		const observer = new HookSpoolObserver({
			spoolDir: root,
			logger: testLogger,
			sinceMs: 0,
			onAnnouncement: (announcement) => announcements.push(announcement),
		});

		await observer.start();
		await observer.scan();
		observer.close();

		expect(announcements).toHaveLength(1);
		expect(announcements[0]?.source).toBe("codex-hook-spool");
		expect(announcements[0]?.text).toBe(
			"Hey, about codex-flows. I just finished: Done. vp test passed.",
		);
		expect(await exists(filePath)).toBe(true);
	});

	test("uses a conversational fallback when there is no final text", () => {
		const announcement = announcementFromHookEvent({
			id: "stop-1",
			eventName: "Stop",
			sessionId: "thread-1",
			cwd: "/home/peezy/meta-workspace",
		});
		expect(announcement?.text).toBe(
			"Hey, about meta-workspace. I just finished that turn.",
		);
	});

	test("skips non-Stop and active recursive Stop events", () => {
		expect(announcementFromHookEvent({
			id: "hook-1",
			eventName: "PreToolUse",
			sessionId: "thread-1",
		})).toBeUndefined();
		expect(announcementFromHookEvent({
			id: "stop-1",
			eventName: "Stop",
			sessionId: "thread-1",
			stopHookActive: true,
		})).toBeUndefined();
	});
});

async function mkTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "voice-hook-spool-"));
	tempDirs.push(dir);
	return dir;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

const testLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};
