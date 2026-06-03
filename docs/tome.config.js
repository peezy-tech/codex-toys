/** @type {import('@tomehq/core').TomeConfig} */
export default {
	name: "codex-toys",
	basePath: "/docs",
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
				"primitives/toybox",
				"primitives/workbench",
				"primitives/delegation",
				"primitives/deferred-queues",
				"primitives/feed",
				"primitives/proxy",
				"primitives/kits",
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
				"reference/cli",
				"reference/packages",
			],
		},
	],
	topNav: [
		{ label: "GitHub", href: "https://github.com/peezy-tech/codex-toys" },
		{ label: "Release", href: "https://github.com/peezy-tech/codex-toys/blob/main/RELEASE.md" },
	],
};
