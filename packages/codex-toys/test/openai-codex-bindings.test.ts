import { describe, expect, test } from "vite-plus/test";
import {
	branchSlugForRelease,
	codexVersionFromReleaseText,
	compareVersions,
	ensureCodexAtLeast,
	installedCodexVersion,
	releaseInfoFromFeedItem,
	runOpenAiCodexBindings,
	targetBranchForRelease,
	threadBranchForRelease,
} from "../../../automations/openai-codex-bindings/check-release.ts";

describe("openai codex bindings automation", () => {
	test("parses openai/codex release versions", () => {
		expect(codexVersionFromReleaseText("0.136.0")).toBe("0.136.0");
		expect(codexVersionFromReleaseText("rust-v0.136.0")).toBe("0.136.0");
		expect(codexVersionFromReleaseText("https://github.com/openai/codex/releases/tag/rust-v0.136.0"))
			.toBe("0.136.0");
		expect(installedCodexVersion("codex-cli 0.135.0\n")).toBe("0.135.0");
		expect(compareVersions("0.136.0", "0.135.9")).toBe(1);
		expect(compareVersions("0.136.0", "0.136.0")).toBe(0);
		expect(compareVersions("0.135.0", "0.136.0")).toBe(-1);
	});

	test("derives release info from a GitHub Atom feed item", () => {
		expect(releaseInfoFromFeedItem({
			id: "feed-openai-codex-1",
			externalId: "tag:github.com,2008:Repository/965415649/rust-v0.136.0",
			title: "0.136.0",
			url: "https://github.com/openai/codex/releases/tag/rust-v0.136.0",
			updatedAt: "2026-06-01T18:51:30Z",
		})).toMatchObject({
			itemId: "feed-openai-codex-1",
			version: "0.136.0",
			tag: "rust-v0.136.0",
		});
	});

	test("derives ephemeral release branches", () => {
		const release = releaseInfoFromFeedItem({
			id: "feed-openai-codex-1",
			sourceId: "openai-codex-releases",
			title: "0.136.0",
			url: "https://github.com/openai/codex/releases/tag/rust-v0.136.0",
		});
		expect(branchSlugForRelease(release)).toBe("rust-v0.136.0");
		expect(targetBranchForRelease(release)).toBe("codex/openai-codex-bindings/rust-v0.136.0");
		expect(threadBranchForRelease(release)).toBe("thread/openai-codex-bindings/rust-v0.136.0");
	});

	test("updates stale codex through the native update path", async () => {
		const calls: string[] = [];
		let version = "codex-cli 0.135.0\n";
		const result = (command: string, args: string[], stdout = "") => ({
			command,
			args,
			stdout,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		});
		const check = await ensureCodexAtLeast({
			codexCommand: "codex",
			targetVersion: "0.136.0",
			run: async (command, args) => {
				calls.push([command, ...args].join(" "));
				if (args[0] === "--version") {
					return result(command, args, version);
				}
				if (args[0] === "update") {
					version = "codex-cli 0.136.0\n";
				}
				return result(command, args);
			},
		});
		expect(calls).toEqual(["codex --version", "codex update", "codex --version"]);
		expect(check).toMatchObject({
			beforeVersion: "0.135.0",
			afterVersion: "0.136.0",
			actions: ["codex update"],
		});
	});

	test("falls back to the standalone installer when native update is still stale", async () => {
		const calls: string[] = [];
		let version = "codex-cli 0.135.0\n";
		const check = await ensureCodexAtLeast({
			codexCommand: "codex",
			targetVersion: "0.136.0",
			run: async (command, args) => {
				calls.push([command, ...args].join(" "));
				if (args[0] === "--version") {
					return {
						command,
						args,
						stdout: version,
						stderr: "",
						exitCode: 0,
						durationMs: 1,
					};
				}
				if (command === "sh") {
					version = "codex-cli 0.136.0\n";
				}
				return { command, args, stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
			},
		});
		expect(calls).toEqual([
			"codex --version",
			"codex update",
			"codex --version",
			"sh -c curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
			"codex --version",
		]);
		expect(check.actions).toEqual(["codex update", "standalone installer"]);
	});

	test("fails when codex remains older than the release", async () => {
		await expect(ensureCodexAtLeast({
			codexCommand: "codex",
			targetVersion: "0.136.0",
			run: async (command, args) => ({
				command,
				args,
				stdout: args[0] === "--version" ? "codex-cli 0.135.0\n" : "",
				stderr: "",
				exitCode: 0,
				durationMs: 1,
			}),
		})).rejects.toThrow("still older than release 0.136.0");
	});

	test("skips successfully when feed item matches and generated bindings have no diff", async () => {
		const calls: string[] = [];
		const result = (command: string, args: string[], stdout = "") => ({
			command,
			args,
			stdout,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		});
		const output = await runOpenAiCodexBindings({
			automation: { config: { source_id: "openai-codex-releases" } },
			event: {
				type: "feed.item",
				source: "openai-codex-releases",
				payload: {
					id: "feed-openai-codex-1",
					sourceId: "openai-codex-releases",
					title: "0.136.0",
					url: "https://github.com/openai/codex/releases/tag/rust-v0.136.0",
				},
			},
			workbenchRoot: "/repo",
		}, {
			run: async (command, args) => {
				calls.push([command, ...args].join(" "));
				if (args[0] === "--version") {
					return result(command, args, "codex-cli 0.136.0\n");
				}
				if (command === "git" && args[0] === "status") {
					return result(command, args, "");
				}
				return result(command, args);
			},
		});
		expect(output).toMatchObject({
			status: "skipped",
			reason: "generated app-server bindings are already current",
			release: { version: "0.136.0" },
		});
		expect(calls).toContain("codex app-server generate-ts --experimental --out packages/bridge/src/app-server/generated");
	});

	test("opens a PR on a release-scoped branch and reports the thread branch", async () => {
		const calls: string[] = [];
		const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
		const turnStarts: string[] = [];
		const result = (command: string, args: string[], stdout = "") => ({
			command,
			args,
			stdout,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		});
		const fetchImpl: typeof fetch = async (url, init) => {
			const requestUrl = String(url);
			const method = init?.method ?? "GET";
			fetchCalls.push({
				url: requestUrl,
				method,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			if (method === "GET" && requestUrl.includes("head=peezy-tech%3Acodex%2Fopenai-codex-bindings%2Frust-v0.136.0")) {
				return jsonResponse([]);
			}
			if (method === "GET" && requestUrl.includes("base=main")) {
				return jsonResponse([]);
			}
			if (method === "POST" && requestUrl.endsWith("/repos/peezy-tech/codex-toys/pulls")) {
				const body = JSON.parse(String(init?.body));
				return jsonResponse({
					number: 2,
					html_url: "https://github.com/peezy-tech/codex-toys/pull/2",
					state: "open",
					title: body.title,
					body: body.body,
					head: { ref: body.head },
				}, 201);
			}
			throw new Error(`Unexpected fetch ${method} ${requestUrl}`);
		};
		const output = await runOpenAiCodexBindings({
			automation: { config: { source_id: "openai-codex-releases", start_turn: true } },
			event: {
				type: "feed.item",
				source: "openai-codex-releases",
				payload: {
					id: "feed-openai-codex-1",
					sourceId: "openai-codex-releases",
					title: "0.136.0",
					url: "https://github.com/openai/codex/releases/tag/rust-v0.136.0",
				},
			},
			workbenchRoot: "/repo",
			turn: {
				start: async (params) => {
					turnStarts.push(params.prompt);
					return { threadId: "thread-openai-codex-bindings", turnId: "turn-analysis" };
				},
				wait: async () => ({
					status: "completed",
					threadId: "thread-openai-codex-bindings",
					turnId: "turn-analysis",
					outputText: "Codex analysis from hosted turn.",
				}),
			},
		}, {
			env: { ...process.env, WORKSPACE_GITHUB_TOKEN: "test-token" },
			fetch: fetchImpl,
			run: async (command, args) => {
				calls.push([command, ...args].join(" "));
				if (args[0] === "--version") {
					return result(command, args, "codex-cli 0.136.0\n");
				}
				if (command === "git" && args[0] === "status") {
					return result(command, args, " M packages/bridge/src/app-server/generated/index.ts\n");
				}
				if (command === "git" && args[0] === "diff" && args[1] === "--stat") {
					return result(command, args, "packages/bridge/src/app-server/generated/index.ts | 2 ++\n");
				}
				if (command === "git" && args[0] === "diff") {
					return result(command, args, "diff --git a/packages/bridge/src/app-server/generated/index.ts b/packages/bridge/src/app-server/generated/index.ts\n");
				}
				return result(command, args);
			},
		});
		expect(turnStarts[0]).toContain("Review regenerated Codex app-server TypeScript bindings for Codex 0.136.0");
		expect(output).toMatchObject({
			status: "pr-ready",
			targetBranch: "codex/openai-codex-bindings/rust-v0.136.0",
			threadBranch: "thread/openai-codex-bindings/rust-v0.136.0",
			pullRequest: {
				number: 2,
				headRefName: "codex/openai-codex-bindings/rust-v0.136.0",
			},
		});
		expect(calls).toContain("git switch -c codex/openai-codex-bindings/rust-v0.136.0");
		expect(calls.some((call) => call.includes("HEAD:codex/openai-codex-bindings/rust-v0.136.0"))).toBe(true);
		const createBody = fetchCalls.find((call) => call.method === "POST")?.body ?? "";
		expect(createBody).toContain("Thread state branch: `thread/openai-codex-bindings/rust-v0.136.0`");
		expect(createBody).toContain("Codex analysis from hosted turn.");
	});

	test("fails when required Codex analysis has no turn host", async () => {
		const result = (command: string, args: string[], stdout = "") => ({
			command,
			args,
			stdout,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		});
		await expect(runOpenAiCodexBindings({
			automation: { config: { source_id: "openai-codex-releases", start_turn: true } },
			event: {
				type: "feed.item",
				source: "openai-codex-releases",
				payload: {
					id: "feed-openai-codex-1",
					sourceId: "openai-codex-releases",
					title: "0.136.0",
					url: "https://github.com/openai/codex/releases/tag/rust-v0.136.0",
				},
			},
			workbenchRoot: "/repo",
		}, {
			run: async (command, args) => {
				if (args[0] === "--version") {
					return result(command, args, "codex-cli 0.136.0\n");
				}
				if (command === "git" && args[0] === "status") {
					return result(command, args, " M packages/bridge/src/app-server/generated/index.ts\n");
				}
				if (command === "git" && args[0] === "diff" && args[1] === "--stat") {
					return result(command, args, "packages/bridge/src/app-server/generated/index.ts | 2 ++\n");
				}
				if (command === "git" && args[0] === "diff") {
					return result(command, args, "diff --git a/packages/bridge/src/app-server/generated/index.ts b/packages/bridge/src/app-server/generated/index.ts\n");
				}
				return result(command, args);
			},
		})).rejects.toThrow("Codex analysis is required but no turn host is available");
	});
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
