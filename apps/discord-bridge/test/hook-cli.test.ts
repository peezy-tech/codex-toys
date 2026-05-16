import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
	enableHooksFeature,
	installStopHook,
	upsertStopHookConfig,
} from "../src/hook-cli.ts";

describe("discord workspace hook CLI", () => {
	test("enables the current hooks feature in config.toml", () => {
		expect(enableHooksFeature("model = \"gpt-5\"\n")).toBe(
			"model = \"gpt-5\"\n\n[features]\nhooks = true\n",
		);
		expect(enableHooksFeature("[features]\ngoals = true\n")).toBe(
			"[features]\nhooks = true\ngoals = true\n",
		);
		expect(enableHooksFeature("[features]\nhooks = false\ngoals = true\n")).toBe(
			"[features]\nhooks = true\ngoals = true\n",
		);
	});

	test("upserts package-bin observability hooks while preserving unrelated hooks", () => {
		const updated = upsertStopHookConfig(
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [{ type: "command", command: "echo pre" }],
						},
					],
					Stop: [
						{
							hooks: [
								{
									type: "command",
									command:
										"bun /home/peezy/codex-fork-workspace/codex-flows/apps/discord-bridge/src/stop-hook.ts",
								},
								{ type: "command", command: "echo other-stop" },
							],
						},
					],
				},
			}),
			"codex-discord-bridge hook event",
		);

		expect(updated).toEqual({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: "codex-discord-bridge hook event",
								timeout: 10,
							},
						],
					},
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo pre" }],
					},
				],
				PermissionRequest: [
					{
						hooks: [
							{
								type: "command",
								command: "codex-discord-bridge hook event",
								timeout: 10,
							},
						],
					},
				],
				PostToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: "codex-discord-bridge hook event",
								timeout: 10,
							},
						],
					},
				],
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: "codex-discord-bridge hook event",
								timeout: 10,
							},
						],
					},
				],
				Stop: [
					{
						hooks: [
							{
								type: "command",
								command: "codex-discord-bridge hook event",
								timeout: 10,
							},
						],
					},
					{
						hooks: [{ type: "command", command: "echo other-stop" }],
					},
				],
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "command",
								command: "codex-discord-bridge hook event",
								timeout: 10,
							},
						],
					},
				],
			},
		});
	});

	test("install writes config and hooks files", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "discord-hook-cli-"));
		try {
			const configPath = path.join(dir, "config.toml");
			const hooksPath = path.join(dir, "hooks.json");
			await writeFile(configPath, "[features]\ngoals = true\n");
			const result = await installStopHook({
				configPath,
				hooksPath,
				useBunx: true,
				bunxPackage: "@peezy.tech/codex-flows",
			});

			expect(result).toEqual({
				command:
					"bunx --package @peezy.tech/codex-flows codex-discord-bridge hook event",
				configPath,
				hooksPath,
				dryRun: false,
			});
			expect(await readFile(configPath, "utf8")).toBe(
				"[features]\nhooks = true\ngoals = true\n",
			);
			expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual(
				expect.objectContaining({
					hooks: expect.objectContaining({
						UserPromptSubmit: [
							{
								hooks: [
									expect.objectContaining({
										command:
											"bunx --package @peezy.tech/codex-flows codex-discord-bridge hook event",
									}),
								],
							},
						],
						Stop: [
							{
								hooks: [
									expect.objectContaining({
										command:
											"bunx --package @peezy.tech/codex-flows codex-discord-bridge hook event",
									}),
								],
							},
						],
					}),
				}),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
