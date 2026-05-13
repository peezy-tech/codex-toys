#!/usr/bin/env bun
import path from "node:path";
import { dispatchFlowEvent, readFlowEvent, replayFlowEvent } from "./backend.ts";
import { helpText, parseCli } from "./config.ts";
import { serveFlowBackend } from "./server.ts";
import { FlowBackendStore, type FlowRunStatus } from "./store.ts";

await main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const cli = parseCli(Bun.argv.slice(2));
	if (cli.kind === "help") {
		process.stdout.write(helpText());
		return;
	}
	if (cli.kind === "serve") {
		const server = serveFlowBackend(cli.config);
		process.stdout.write(`codex-flow-systemd-local listening on http://${server.hostname}:${server.port}\n`);
		return new Promise(() => undefined);
	}
	const store = new FlowBackendStore(path.join(cli.config.dataDir, "flow-backend.sqlite"));
	try {
		if (cli.kind === "dispatch") {
			const event = await readFlowEvent(cli.eventPath);
			const result = await dispatchFlowEvent({
				config: cli.config,
				store,
				event,
				wait: cli.wait,
				env: process.env,
			});
			writeJson(result);
			return;
		}
		if (cli.kind === "list-events") {
			writeJson({ events: store.listEvents({ type: cli.type, limit: cli.limit }) });
			return;
		}
		if (cli.kind === "show-event") {
			const event = store.getEvent(cli.eventId);
			if (!event) {
				throw new Error(`Unknown event: ${cli.eventId}`);
			}
			writeJson({ event, runs: store.listRunsByEvent(cli.eventId) });
			return;
		}
		if (cli.kind === "replay-event") {
			writeJson(await replayFlowEvent({
				config: cli.config,
				store,
				eventId: cli.eventId,
				wait: cli.wait,
				env: process.env,
			}));
			return;
		}
		if (cli.kind === "list-runs") {
			writeJson({
				runs: store.listRuns({
					eventId: cli.eventId,
					status: cli.status ? requireRunStatus(cli.status) : undefined,
					limit: cli.limit,
				}),
			});
			return;
		}
		if (cli.kind === "show-run") {
			const run = store.getRun(cli.runId);
			if (!run) {
				throw new Error(`Unknown run: ${cli.runId}`);
			}
			writeJson({ run });
			return;
		}
	} finally {
		store.close();
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireRunStatus(value: string): FlowRunStatus {
	if (value === "queued" || value === "running" || value === "completed" || value === "failed") {
		return value;
	}
	throw new Error("run status must be queued, running, completed, or failed");
}
