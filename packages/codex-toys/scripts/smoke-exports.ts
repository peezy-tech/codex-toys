const checks = [
	["codex-toys", ["CodexAppServerClient", "CodexEventEmitter", "collectHostOverview", "collectWorkbenchOverview"]],
	["@codex-toys/actions", ["repoCodexHome", "prepareActionsCodexAuth"]],
	["@codex-toys/bridge", ["CodexAppServerClient", "JsonRpcError", "listCodexMemoryArtifacts", "locateThreadRollout"]],
	["@codex-toys/kits", ["inspectKitSource", "applyKitAdd"]],
	["@codex-toys/proxy", ["createCodexToysProxyHandler"]],
	["@codex-toys/proxy/browser", ["createCodexToysBrowserClient", "codexToys"]],
	["@codex-toys/proxy/vite", ["codexToysRemote"]],
	["@codex-toys/remote", ["createSshToyboxTransport", "collectRemotePreflight"]],
	["@codex-toys/toybox", ["CodexToyboxClient", "CodexToyboxProtocolServer"]],
	["@codex-toys/workbench", ["collectHostOverview", "collectWorkbenchOverview", "createThreadSnapshot", "defineFunctions"]],
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
