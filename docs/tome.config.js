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
			group: "Guides",
			pages: [
				"guides/turn-automation",
				"guides/workbench-autonomy",
				"guides/memory-transplant",
				"guides/thread-transplant",
				"guides/install-codex-plugin",
				"guides/install-kit-repos",
			],
		},
		{
			group: "Reference",
			pages: [
				"reference/cli",
				"reference/packages",
			],
		},
		{
			group: "Concepts",
			pages: [
				"concepts/architecture",
				"concepts/deferred-runs-roadmap",
				"concepts/backends",
				"concepts/domain-boundaries",
				"concepts/package-stack",
				"concepts/toyboxes",
				"concepts/toybox-deployments",
			],
		},
	],
	topNav: [
		{ label: "GitHub", href: "https://github.com/peezy-tech/codex-toys" },
		{ label: "Release", href: "https://github.com/peezy-tech/codex-toys/blob/main/RELEASE.md" },
	],
};
