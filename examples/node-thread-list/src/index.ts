import { CodexAppServerClient } from "@codex-appkit/app-server";

const client = new CodexAppServerClient({
	transportOptions: {
		cwd: process.cwd(),
	},
	clientName: "codex-appkit-node-example",
	clientTitle: "Codex AppKit Node Example",
	clientVersion: "0.1.0",
});

try {
	await client.connect();
	const response = await client.listThreads({ limit: 10, sourceKinds: [] });
	for (const thread of response.data) {
		console.log(`${thread.id}\t${thread.name ?? "(untitled)"}`);
	}
} finally {
	client.close();
}
