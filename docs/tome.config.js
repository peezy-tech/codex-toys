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
				"guides/turn-automation",
				"guides/author-flow-package",
				"guides/run-flows-locally",
				"guides/dispatch-and-replay-events",
				"guides/workspace-autonomy",
				"guides/memory-transplant",
				"guides/thread-transplant",
				"guides/install-codex-plugin",
				"guides/install-pack-repos",
				"guides/operate-workspace-flow-backend",
				"guides/use-convex-backend",
				"guides/operate-codex-release-flows",
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
			],
		},
	],
	topNav: [
		{ label: "GitHub", href: "https://github.com/peezy-tech/codex-flows" },
		{ label: "Release", href: "https://github.com/peezy-tech/codex-flows/blob/main/RELEASE.md" },
	],
};
