const checks = [
	["codex-toys", ["CodexAppServerClient", "CodexEventEmitter", "collectHostOverview", "collectWorkbenchOverview"]],
	["codex-toys/actions", ["repoCodexHome", "prepareActionsCodexAuth"]],
	["codex-toys/bridge", ["CodexAppServerClient", "JsonRpcError", "listCodexMemoryArtifacts", "locateThreadRollout"]],
	["codex-toys/bridge/generated", ["v2"]],
	["codex-toys/bridge/json", ["parseJsonText"]],
	["codex-toys/feed", ["createFeedContext", "pollFeedSources", "collectFeedItems"]],
	["codex-toys/kits", ["inspectKitSource", "applyKitAdd"]],
	["codex-toys/runtime", [
		"CodexRuntimeClient",
		"CodexRuntimeProtocolServer",
		"createCodexToysBrowserClient",
		"createCodexToysRuntimeHttpHandler",
		"codexToysRuntime",
		"createSshRuntimeTransport",
		"collectRuntimePreflight",
	]],
	["codex-toys/workbench", ["collectHostOverview", "collectWorkbenchOverview", "createThreadSnapshot", "defineFunctions"]],
] as const;

for (const [specifier, expectedExports] of checks) {
	const module = await import(specifier);
	for (const exportName of expectedExports) {
		if (!(exportName in module)) {
			throw new Error(`${specifier} is missing export ${exportName}`);
		}
	}
}

console.log("export smoke test passed");
