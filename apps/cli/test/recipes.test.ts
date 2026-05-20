import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { extractCodeModeToolInputCandidates } from "../src/recipes.ts";

test("extracts Code Mode exec source from PreToolUse tool input", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "codex-cli-extract-"));
	const transcriptPath = path.join(directory, "transcript.jsonl");
	const source = "const answer = 42;\ntext(answer);";

	try {
		const result = await extractCodeModeToolInputCandidates({
			stdin: Readable.from([
				JSON.stringify({
					hook_event_name: "PreToolUse",
					tool_name: "exec",
					session_id: "session-1",
					turn_id: "turn-1",
					tool_use_id: "tool-1",
					cwd: directory,
					transcript_path: transcriptPath,
					tool_input: { source },
				}),
			]),
			outputDir: ".candidates",
			now: new Date("2026-01-02T03:04:05.000Z"),
		});

		expect(result.saved).toHaveLength(1);
		const saved = result.saved[0];
		expect(saved).toBeDefined();
		if (!saved) {
			throw new Error("expected a saved candidate");
		}

		expect(path.dirname(saved.codePath)).toBe(path.join(directory, ".candidates"));
		expect(await readFile(saved.codePath, "utf8")).toBe(`${source}\n`);

		const metadata = JSON.parse(await readFile(saved.metadataPath, "utf8")) as Record<string, unknown>;
		expect(metadata.version).toBe(1);
		expect(metadata.sessionId).toBe("session-1");
		expect(metadata.turnId).toBe("turn-1");
		expect(metadata.toolUseId).toBe("tool-1");
		expect(metadata.transcriptPath).toBe(transcriptPath);
		expect(metadata.cwd).toBe(directory);
		expect(metadata.codePath).toBe(saved.codePath);
		expect(metadata.createdAt).toBe("2026-01-02T03:04:05.000Z");
		expect(metadata.source).toBe("codex-pre-tool-use-exec");
		expect(metadata.status).toBe("candidate");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("ignores non-exec PreToolUse payloads", async () => {
	const result = await extractCodeModeToolInputCandidates({
		stdin: Readable.from([
			JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "wait",
				tool_input: { source: "text('not exec');" },
			}),
		]),
		outputDir: ".candidates",
	});

	expect(result).toEqual({ continue: true, saved: [] });
});
