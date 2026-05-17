const checks = [
	["@peezy.tech/codex-flows", ["CodexAppServerClient"]],
	["@peezy.tech/codex-flows/browser", ["CodexAppServerClient"]],
	["@peezy.tech/codex-flows/flows", ["CodexFlowClient", "createCodexFlowClient"]],
	["@peezy.tech/codex-flows/auth", ["CodexAuthClient", "createCodexAuthClient"]],
	["@peezy.tech/codex-flows/workbench", ["createThreadSnapshot", "turnStartDescriptor"]],
	["@peezy.tech/codex-flows/workspace-backend", ["CodexWorkspaceBackendClient"]],
	["@peezy.tech/codex-flows/flow-runtime", ["discoverFlows", "runFlowStep"]],
	["@peezy.tech/codex-flows/flow-runtime/client", ["createFlowClient"]],
	[
		"@peezy.tech/codex-flows/flow-runtime/local-client",
		["createLocalFlowClient", "LocalFlowClient"],
	],
	[
		"@peezy.tech/codex-flows/flow-runtime/backend-client",
		["createFlowBackendHttpClient", "FlowBackendHttpClient"],
	],
	[
		"@peezy.tech/codex-flows/flow-runtime/bun",
		["defineBunFlow", "readFlowContext"],
	],
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
