import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

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

	test("parses gateway home and main thread ids", () => {
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
			expect(fromFlag.config.gateway).toEqual({
				homeChannelId: "home-channel",
				mainThreadId: "main-thread",
				workspaceForumChannelId: "workspace-forum",
				taskThreadsChannelId: "task-channel",
			});
			expect(fromFlag.config.flowBackendUrl).toBe("http://127.0.0.1:8089");
			expect(fromEnv.config.gateway).toEqual({
				homeChannelId: "env-home",
				mainThreadId: "env-thread",
				workspaceForumChannelId: "env-workspace-forum",
				taskThreadsChannelId: "env-task-channel",
			});
			expect(fromEnv.config.flowBackendUrl).toBe("http://127.0.0.1:8090");
		}
	});

	test("rejects gateway main thread without home channel", () => {
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
		).toThrow("Cannot set a gateway main thread without a gateway home channel.");
	});

	test("rejects partial gateway workbench channel configuration", () => {
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

	test("rejects gateway workbench channels that are not separate", () => {
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
			"Discord workbench channels must be separate from the gateway home channel and each other.",
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
