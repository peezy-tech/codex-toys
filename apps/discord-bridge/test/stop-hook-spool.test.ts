import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import {
	archiveStopHookSpoolFile,
	readPendingStopHookSpoolFiles,
	writeStopHookSpoolEvent,
} from "../src/stop-hook-spool.ts";

describe("stop hook spool", () => {
	test("writes stable Stop events into the pending spool", async () => {
		const spoolDir = await mkdtemp(path.join(os.tmpdir(), "stop-hook-spool-"));
		try {
			const input = {
				hook_event_name: "Stop",
				session_id: "session-1",
				turn_id: "turn-1",
				cwd: "/workspace",
				transcript_path: "/tmp/session.jsonl",
				last_assistant_message: "Finished.",
				stop_hook_active: false,
			};

			const first = await writeStopHookSpoolEvent(input, {
				spoolDir,
				now: () => new Date("2026-05-14T12:00:00.000Z"),
			});
			const second = await writeStopHookSpoolEvent(input, {
				spoolDir,
				now: () => new Date("2026-05-14T12:01:00.000Z"),
			});
			const third = await writeStopHookSpoolEvent(
				{ ...input, last_assistant_message: "Finished again." },
				{
					spoolDir,
					now: () => new Date("2026-05-14T12:02:00.000Z"),
				},
			);

			expect(second.id).toBe(first.id);
			expect(third.id).toBe(first.id);
			const pending = await readPendingStopHookSpoolFiles(spoolDir);
			expect(pending).toHaveLength(1);
			expect(pending[0]).toEqual(
				expect.objectContaining({
					event: expect.objectContaining({
						id: first.id,
						eventName: "Stop",
						sessionId: "session-1",
						turnId: "turn-1",
						lastAssistantMessage: "Finished again.",
						stopHookActive: false,
					}),
				}),
			);
		} finally {
			await rm(spoolDir, { recursive: true, force: true });
		}
	});

	test("writes passive lifecycle hook events with previews", async () => {
		const spoolDir = await mkdtemp(path.join(os.tmpdir(), "hook-spool-"));
		try {
			const event = await writeStopHookSpoolEvent(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "session-observed",
					turn_id: "turn-observed",
					cwd: "/workspace/observed",
					transcript_path: "/tmp/session-observed.jsonl",
					model: "gpt-test",
					prompt: "Inspect the observed workspace without routing through Discord.",
				},
				{
					spoolDir,
					now: () => new Date("2026-05-14T12:00:00.000Z"),
				},
			);

			expect(event).toEqual(
				expect.objectContaining({
					eventName: "UserPromptSubmit",
					sessionId: "session-observed",
					turnId: "turn-observed",
					cwd: "/workspace/observed",
					model: "gpt-test",
					promptPreview:
						"Inspect the observed workspace without routing through Discord.",
				}),
			);
			const pending = await readPendingStopHookSpoolFiles(spoolDir);
			expect(pending[0]).toEqual(
				expect.objectContaining({
					event: expect.objectContaining({
						id: event.id,
						eventName: "UserPromptSubmit",
						promptPreview:
							"Inspect the observed workspace without routing through Discord.",
					}),
				}),
			);
		} finally {
			await rm(spoolDir, { recursive: true, force: true });
		}
	});

	test("archives processed files out of pending", async () => {
		const spoolDir = await mkdtemp(path.join(os.tmpdir(), "stop-hook-spool-"));
		try {
			await writeStopHookSpoolEvent(
				{
					hook_event_name: "Stop",
					session_id: "session-1",
					turn_id: "turn-1",
				},
				{ spoolDir },
			);
			const [file] = await readPendingStopHookSpoolFiles(spoolDir);
			expect(file).toBeDefined();
			await archiveStopHookSpoolFile(file!, spoolDir, "processed");

			expect(await readPendingStopHookSpoolFiles(spoolDir)).toEqual([]);
		} finally {
			await rm(spoolDir, { recursive: true, force: true });
		}
	});
});
