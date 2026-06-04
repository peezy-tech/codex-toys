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
				"primitives/delegation",
				"primitives/deferred-queues",
				"primitives/feed",
			],
		},
		{
			group: "Components",
			pages: [
				"components/toybox",
				"components/proxy",
				"components/kits",
				"components/cli",
			],
		},
		{
			group: "Guides",
			pages: [
				"guides/repository-autonomy",
				"guides/remote-codex-workbench",
				"guides/local-scheduled-workbench",
				"guides/dashboard-over-toybox",
				"guides/feed-to-workflow",
				"guides/capability-kit-setup",
				"guides/delegated-repo-work",
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
