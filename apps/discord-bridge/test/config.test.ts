import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	test("resolves --dir relative to the home directory", () => {
		const parsed = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--dir",
				"projects/demo",
			],
			{},
		);

		expect(parsed.type).toBe("run");
		if (parsed.type === "run") {
			expect(parsed.config.cwd).toBe(path.join(os.homedir(), "projects/demo"));
		}
	});

	test("expands tilde dir paths from the home directory", () => {
		const parsed = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--dir",
				"~/projects/demo",
			],
			{},
		);

		expect(parsed.type).toBe("run");
		if (parsed.type === "run") {
			expect(parsed.config.cwd).toBe(path.join(os.homedir(), "projects/demo"));
		}
	});

	test("accepts one positional directory for root script usage", () => {
		const parsed = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--local-app-server",
				"~/game-protocol-workspace",
			],
			{ CODEX_DISCORD_DIR: "env-dir" },
		);

		expect(parsed.type).toBe("run");
		if (parsed.type === "run") {
			expect(parsed.localAppServer).toBe(true);
			expect(parsed.config.cwd).toBe(
				path.join(os.homedir(), "game-protocol-workspace"),
			);
		}
	});

	test("rejects multiple directory arguments", () => {
		expect(() =>
			parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"one",
					"two",
				],
				{},
			)
		).toThrow("Unexpected argument: two");
		expect(() =>
			parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"--dir",
					"one",
					"two",
				],
				{},
			)
		).toThrow("Cannot set both positional directory and --dir/--cwd.");
	});

	test("prefers CODEX_DISCORD_DIR over legacy cwd env", () => {
		const parsed = parseConfig(
			["--token", "discord-token", "--allowed-user-ids", "user-1"],
			{
				CODEX_DISCORD_DIR: "current",
				CODEX_DISCORD_CWD: "/legacy",
			},
		);

		expect(parsed.type).toBe("run");
		if (parsed.type === "run") {
			expect(parsed.config.cwd).toBe(path.join(os.homedir(), "current"));
		}
	});

	test("enables debug logging from flag or environment", () => {
		const fromFlag = parseConfig(
			["--token", "discord-token", "--allowed-user-ids", "user-1", "--debug"],
			{},
		);
		const fromEnv = parseConfig(
			["--token", "discord-token", "--allowed-user-ids", "user-1"],
			{ CODEX_DISCORD_DEBUG: "true" },
		);

		expect(fromFlag.type).toBe("run");
		expect(fromEnv.type).toBe("run");
		if (fromFlag.type === "run" && fromEnv.type === "run") {
			expect(fromFlag.config.debug).toBe(true);
			expect(fromEnv.config.debug).toBe(true);
		}
	});

	test("parses progress mode from flag or environment", () => {
		const fromFlag = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--progress-mode",
				"commentary",
			],
			{},
		);
		const fromEnv = parseConfig(
			["--token", "discord-token", "--allowed-user-ids", "user-1"],
			{ CODEX_DISCORD_PROGRESS_MODE: "none" },
		);

		expect(fromFlag.type).toBe("run");
		expect(fromEnv.type).toBe("run");
		if (fromFlag.type === "run" && fromEnv.type === "run") {
			expect(fromFlag.config.progressMode).toBe("commentary");
			expect(fromEnv.config.progressMode).toBe("none");
		}
	});

	test("parses console output and log level from flag or environment", () => {
		const fromFlag = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--console-output",
				"messages",
				"--log-level",
				"warn",
			],
			{},
		);
		const fromEnv = parseConfig(
			["--token", "discord-token", "--allowed-user-ids", "user-1"],
			{
				CODEX_DISCORD_CONSOLE_OUTPUT: "none",
				CODEX_DISCORD_LOG_LEVEL: "silent",
			},
		);

		expect(fromFlag.type).toBe("run");
		expect(fromEnv.type).toBe("run");
		if (fromFlag.type === "run" && fromEnv.type === "run") {
			expect(fromFlag.config.consoleOutput).toBe("messages");
			expect(fromFlag.config.logLevel).toBe("warn");
			expect(fromEnv.config.consoleOutput).toBe("none");
			expect(fromEnv.config.logLevel).toBe("silent");
		}
	});

	test("parses workspace home and main thread ids", () => {
		const fromFlag = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--home-channel-id",
				"home-channel",
				"--main-thread-id",
				"main-thread",
				"--workspace-forum-channel-id",
				"workspace-forum",
				"--task-threads-channel-id",
				"task-channel",
				"--flow-backend-url",
				"http://127.0.0.1:8089",
			],
			{},
		);
		const fromEnv = parseConfig(
			["--token", "discord-token", "--allowed-user-ids", "user-1"],
			{
				CODEX_DISCORD_GATEWAY_HOME_CHANNEL_ID: "env-home",
				CODEX_DISCORD_GATEWAY_MAIN_THREAD_ID: "env-thread",
				CODEX_DISCORD_GATEWAY_WORKSPACE_FORUM_CHANNEL_ID: "env-workspace-forum",
				CODEX_DISCORD_GATEWAY_TASK_THREADS_CHANNEL_ID: "env-task-channel",
				CODEX_FLOW_BACKEND_URL: "http://127.0.0.1:8090",
			},
		);

		expect(fromFlag.type).toBe("run");
		expect(fromEnv.type).toBe("run");
		if (fromFlag.type === "run" && fromEnv.type === "run") {
			expect(fromFlag.config.workspace).toEqual({
				homeChannelId: "home-channel",
				mainThreadId: "main-thread",
				workspaceForumChannelId: "workspace-forum",
				taskThreadsChannelId: "task-channel",
			});
			expect(fromFlag.config.flowBackendUrl).toBe("http://127.0.0.1:8089");
			expect(fromEnv.config.workspace).toEqual({
				homeChannelId: "env-home",
				mainThreadId: "env-thread",
				workspaceForumChannelId: "env-workspace-forum",
				taskThreadsChannelId: "env-task-channel",
			});
			expect(fromEnv.config.flowBackendUrl).toBe("http://127.0.0.1:8090");
		}
	});

	test("parses workspace-owned workspace surfaces and keeps env defaults as fallback", () => {
		const root = workspaceRoot();
		writeWorkspaceToml(root, "crypto-workspace", `
[[discord.workspace.surfaces]]
key = "crypto"
home_channel_id = "home-b"
workspace_forum_channel_id = "forum-b"
task_threads_channel_id = "tasks-b"
`);
		writeWorkspaceToml(root, "research-workspace", `
[[discord.workspace.surfaces]]
key = "crypto"
home_channel_id = "home-b"
workspace_forum_channel_id = "forum-b"
task_threads_channel_id = "tasks-b"
`);
		try {
			const parsed = parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"--dir",
					root,
				],
				{
					CODEX_DISCORD_HOME_CHANNEL_ID: "home-a",
					CODEX_DISCORD_WORKSPACE_FORUM_CHANNEL_ID: "forum-a",
					CODEX_DISCORD_TASK_THREADS_CHANNEL_ID: "tasks-a",
				},
			);

			expect(parsed.type).toBe("run");
			if (parsed.type === "run") {
				expect(parsed.config.workspace).toEqual({
					homeChannelId: "home-a",
					workspaceForumChannelId: "forum-a",
					taskThreadsChannelId: "tasks-a",
					surfaces: [
						{
							key: "default",
							homeChannelId: "home-a",
							workspaceForumChannelId: "forum-a",
							taskThreadsChannelId: "tasks-a",
							workspaceCwds: undefined,
						},
						{
							key: "crypto",
							homeChannelId: "home-b",
							workspaceForumChannelId: "forum-b",
							taskThreadsChannelId: "tasks-b",
							workspaceCwds: [
								path.join(root, "crypto-workspace"),
								path.join(root, "research-workspace"),
							],
						},
					],
				});
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects ambiguous workspace-owned workspace surfaces", () => {
		const multiple = workspaceRoot();
		writeWorkspaceToml(multiple, "crypto-workspace", `
[[discord.workspace.surfaces]]
key = "default"
home_channel_id = "home-a"

[[discord.workspace.surfaces]]
key = "other"
home_channel_id = "home-b"
`);
		try {
			expect(() => parseConfig(baseArgsForRoot(multiple), {})).toThrow(
				"workspace.toml discord.workspace.surfaces must contain one surface",
			);
		} finally {
			rmSync(multiple, { recursive: true, force: true });
		}

		const duplicate = workspaceRoot();
		writeWorkspaceToml(duplicate, "crypto-workspace", `
[[discord.workspace.surfaces]]
key = "default"
home_channel_id = "home-a"
`);
		writeWorkspaceToml(duplicate, "research-workspace", `
[[discord.workspace.surfaces]]
key = "default"
home_channel_id = "home-b"
`);
		try {
			expect(() => parseConfig(baseArgsForRoot(duplicate), {})).toThrow(
				"Workspace surface key default is configured with different channels.",
			);
		} finally {
			rmSync(duplicate, { recursive: true, force: true });
		}

		const channelCollision = workspaceRoot();
		writeWorkspaceToml(channelCollision, "crypto-workspace", `
[[discord.workspace.surfaces]]
key = "crypto"
home_channel_id = "home-a"
`);
		writeWorkspaceToml(channelCollision, "alpha-workspace", `
[[discord.workspace.surfaces]]
key = "alpha"
home_channel_id = "home-a"
`);
		try {
			expect(() => parseConfig(baseArgsForRoot(channelCollision), {})).toThrow(
				"Workspace surface channel is configured more than once: home-a",
			);
		} finally {
			rmSync(channelCollision, { recursive: true, force: true });
		}
	});

	test("ignores workspace.toml without workspace surfaces", () => {
		const root = workspaceRoot();
		writeRootWorkspaceToml(root, `
name = "home"

[tools]
enabled = true
`);
		try {
			const parsed = parseConfig(baseArgsForRoot(root), {});

			expect(parsed.type).toBe("run");
			if (parsed.type === "run") {
				expect(parsed.config.workspace).toBeUndefined();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects workspace main thread without home channel", () => {
		expect(() =>
			parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"--main-thread-id",
					"main-thread",
				],
				{},
			)
		).toThrow("Cannot set a workspace main thread without a workspace home channel.");
	});

	test("rejects partial workspace workbench channel configuration", () => {
		expect(() =>
			parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"--home-channel-id",
					"home-channel",
					"--workspace-forum-channel-id",
					"workspace-forum",
				],
				{},
			)
		).toThrow(
			"Discord workbench requires both workspace forum and task threads channels.",
		);
	});

	test("rejects workspace workbench channels that are not separate", () => {
		expect(() =>
			parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"--home-channel-id",
					"home-channel",
					"--workspace-forum-channel-id",
					"workspace-forum",
					"--task-threads-channel-id",
					"home-channel",
				],
				{},
			)
		).toThrow(
			"Discord workbench channels must be separate from the workspace home channel and each other.",
		);
	});

	test("can force a local app-server even when workspace URL env is set", () => {
		const parsed = parseConfig(
			[
				"--token",
				"discord-token",
				"--allowed-user-ids",
				"user-1",
				"--local-app-server",
			],
			{ CODEX_WORKSPACE_APP_SERVER_WS_URL: "ws://127.0.0.1:9999" },
		);

		expect(parsed.type).toBe("run");
		if (parsed.type === "run") {
			expect(parsed.localAppServer).toBe(true);
			expect(parsed.appServerUrl).toBeUndefined();
		}
	});

	test("rejects mixing local and explicit external app-server modes", () => {
		expect(() =>
			parseConfig(
				[
					"--token",
					"discord-token",
					"--allowed-user-ids",
					"user-1",
					"--local-app-server",
					"--app-server-url",
					"ws://127.0.0.1:9999",
				],
				{},
			)
		).toThrow("Cannot set both --local-app-server and --app-server-url.");
	});
});

function workspaceRoot(): string {
	return mkdtempSync(path.join(os.tmpdir(), "discord-workspace-config-"));
}

function writeRootWorkspaceToml(root: string, toml: string): void {
	const codexDir = path.join(root, ".codex");
	mkdirSync(codexDir, { recursive: true });
	writeFileSync(path.join(codexDir, "workspace.toml"), toml);
}

function writeWorkspaceToml(root: string, workspaceName: string, toml: string): void {
	const workspaceDir = path.join(root, workspaceName);
	const codexDir = path.join(workspaceDir, ".codex");
	mkdirSync(codexDir, { recursive: true });
	writeFileSync(path.join(codexDir, "workspace.toml"), toml);
}

function baseArgsForRoot(root: string): string[] {
	return [
		"--token",
		"discord-token",
		"--allowed-user-ids",
		"user-1",
		"--dir",
		root,
	];
}
