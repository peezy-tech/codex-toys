const checks = [
	["codex-toys", ["CodexAppServerClient", "CodexEventEmitter", "collectHostOverview", "collectWorkspaceOverview"]],
	["codex-toys/browser", ["createCodexToysBrowserClient", "codexToys"]],
	["codex-toys/functions", ["defineFunctions", "createWorkspaceFunctionMethods"]],
	["codex-toys/vite", ["codexToysRemote"]],
	["codex-toys/proxy", ["createCodexToysProxyHandler"]],
	["codex-toys/auth", ["CodexAuthClient", "createCodexAuthClient"]],
	["codex-toys/actions", ["repoCodexHome", "prepareActionsCodexAuth"]],
	["codex-toys/memories", ["listCodexMemoryArtifacts"]],
	["codex-toys/workbench", ["createThreadSnapshot", "turnStartDescriptor"]],
	[
		"codex-toys/threads",
		["locateThreadRollout", "inspectThreadRollout", "installThreadRollout", "transplantThreadRollout"],
	],
	["codex-toys/toybox", ["CodexToyboxClient"]],
	["codex-toys/rpc", ["JsonRpcError"]],
	["codex-toys/generated", ["v2"]],
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
