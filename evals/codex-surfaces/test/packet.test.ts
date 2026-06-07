import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { loadProfile, loadScenario } from "../src/manifests.ts";
import { createTaskPacket } from "../src/packet.ts";

describe("native App task packets", () => {
	test("creates an operator-mediated packet and manifest", async () => {
		const outDir = await mkdtemp(path.join(tmpdir(), "codex-surface-packet-"));
		const scenario = await loadScenario("workbench-health-triage");
		const profile = await loadProfile("native-app");
		const packet = await createTaskPacket({
			scenario,
			profile,
			outDir,
			now: new Date("2026-06-07T00:00:00.000Z"),
		});
		const text = await readFile(packet.packetPath, "utf8");
		expect(packet.manifest.id).toBe("2026-06-07T00-00-00-000Z-workbench-health-triage-native-app");
		expect(text).toContain("Workbench Health Triage");
		expect(text).toContain("do not translate this into a `codex exec` run.");
		expect(text).toContain("run.ts ingest");
	});
});
