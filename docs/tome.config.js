/** @type {import('@tomehq/core').TomeConfig} */
export default {
	name: "codex-toys",
	basePath: process.env.CODEX_TOYS_DOCS_BASE_PATH ?? "/codex-toys",
	theme: {
		preset: "editorial",
		mode: "auto",
		accent: "#2563eb",
	},
	navigation: [
		{ group: "Overview", pages: ["index"] },
		{
			group: "Primitives",
			pages: [
				"primitives/workflow",
				"primitives/workbench",
				"primitives/dispatch-queues",
				"primitives/feed",
			],
		},
		{
			group: "Components",
			pages: [
				"components/runtime",
				"components/kits",
				"components/cli",
			],
		},
		{
			group: "Guides",
			pages: [
				"guides/repository-autonomy",
				"guides/remote-runtime",
				"guides/local-scheduled-workbench",
				"guides/dashboard-over-runtime",
				"guides/feed-to-workflow",
				"guides/capability-kit-setup",
			],
		},
		{
			group: "Operations",
			pages: [
				"operations/codex-state",
				"operations/plugins",
			],
		},
		{
			group: "Reference",
			pages: [
				"reference/packages",
			],
		},
	],
	topNav: [
		{ label: "GitHub", href: "https://github.com/peezy-tech/codex-toys" },
		{ label: "Release", href: "https://github.com/peezy-tech/codex-toys/blob/main/RELEASE.md" },
	],
};
