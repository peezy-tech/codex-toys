/** @type {import('@tomehq/core').TomeConfig} */
export default {
	name: "codex-flows",
	basePath: "/docs",
	theme: {
		preset: "editorial",
		mode: "auto",
		accent: "#2563eb",
	},
	navigation: [
		{ group: "Overview", pages: ["index"] },
		{
			group: "Tutorials",
			pages: [
				"tutorials/first-flow",
				"tutorials/dispatch-release-event",
			],
		},
		{
			group: "Guides",
			pages: [
				"guides/author-flow-package",
				"guides/run-flows-locally",
				"guides/dispatch-and-replay-events",
				"guides/workspace-autonomy",
				"guides/memory-transplant",
				"guides/install-pack-repos",
				"guides/operate-workspace-flow-backend",
				"guides/use-convex-backend",
				"guides/enable-code-mode",
				"guides/operate-codex-release-flows",
				"guides/run-discord-local-backend",
				"guides/run-web-over-local-workspace-backend",
			],
		},
		{
			group: "Reference",
			pages: [
				"reference/flow-event",
				"reference/flow-toml",
				"reference/flow-client",
				"reference/backend-http",
				"reference/cli",
				"reference/discord-bridge",
				"reference/workspace-voice-gateway",
				"reference/packages",
			],
		},
		{
			group: "Concepts",
			pages: [
				"concepts/architecture",
				"concepts/backends",
				"concepts/domain-boundaries",
				"concepts/workspace-backends",
				"concepts/workspace-backend-deployments",
				"concepts/code-mode",
			],
		},
	],
	topNav: [
		{ label: "GitHub", href: "https://github.com/peezy-tech/codex-flows" },
		{ label: "Release", href: "https://github.com/peezy-tech/codex-flows/blob/main/RELEASE.md" },
	],
};
