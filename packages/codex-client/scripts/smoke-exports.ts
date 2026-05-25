const checks = [
	["@peezy.tech/codex-flows", ["CodexAppServerClient", "CodexEventEmitter"]],
	["@peezy.tech/codex-flows/browser", ["CodexAppServerClient"]],
	["@peezy.tech/codex-flows/auth", ["CodexAuthClient", "createCodexAuthClient"]],
	["@peezy.tech/codex-flows/actions", ["repoCodexHome", "prepareActionsCodexAuth"]],
	["@peezy.tech/codex-flows/memories", ["listCodexMemoryArtifacts"]],
	["@peezy.tech/codex-flows/workbench", ["createThreadSnapshot", "turnStartDescriptor"]],
	[
		"@peezy.tech/codex-flows/threads",
		["locateThreadRollout", "inspectThreadRollout", "installThreadRollout", "transplantThreadRollout"],
	],
	["@peezy.tech/codex-flows/workspace-backend", ["CodexWorkspaceBackendClient"]],
	["@peezy.tech/codex-flows/rpc", ["JsonRpcError"]],
	["@peezy.tech/codex-flows/generated", ["v2"]],
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
