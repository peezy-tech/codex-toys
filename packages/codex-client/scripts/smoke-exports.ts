const checks = [
	["@peezy.tech/codex-flows", ["CodexAppServerClient"]],
	["@peezy.tech/codex-flows/browser", ["CodexAppServerClient"]],
	["@peezy.tech/codex-flows/flows", ["CodexFlowClient", "createCodexFlowClient"]],
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
