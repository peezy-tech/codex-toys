import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { Effect } from "effect";
import { openAutomationStore } from "../src/automation/index.ts";

test("persists workflow realpaths and generic source config/cursor/dedupe state", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-automation-registration-test-"));
  const modulePath = path.join(temporary, "workflow.mjs");
  await writeFile(modulePath, "export default {}\n");
  const store = await run(openAutomationStore({ stateRoot: path.join(temporary, "state") }));
  try {
    for (const queueName of ["feeds", "manual"]) {
      await run(
        store.configureQueue({
          queueName,
          concurrency: 1,
          startWindowMs: 60_000,
          maxStartsPerWindow: 60,
          leaseMs: 60_000,
        }),
      );
    }
    const workflow = await run(
      store.createWorkflowRegistration({
        id: "feed-workflow",
        modulePath,
        revisionHash: "sha256:abc",
        triggerTypes: ["rss.entry", "github.issue"],
        queueName: "feeds",
      }),
    );
    expect(workflow).toMatchObject({
      moduleRealpath: realpathSync(modulePath),
      triggerTypes: ["github.issue", "rss.entry"],
      enabled: true,
    });
    expect(await run(store.listWorkflowRegistrations({ triggerType: "rss.entry" }))).toEqual([
      workflow,
    ]);
    const manual = await run(
      store.createWorkflowRegistration({
        id: "manual-workflow",
        modulePath,
        revisionHash: "sha256:manual",
        triggerTypes: [],
        queueName: "manual",
      }),
    );
    expect(manual.triggerTypes).toEqual([]);
    const updatedWorkflow = await run(
      store.updateWorkflowRegistration({
        id: workflow.id,
        enabled: false,
        revisionHash: "sha256:def",
      }),
    );
    expect(updatedWorkflow).toMatchObject({ enabled: false, revisionHash: "sha256:def" });

    const source = await run(
      store.createSourceRegistration({
        id: "feed-source",
        kind: "rss",
        workflowId: workflow.id,
        config: { url: "https://example.test/feed.xml" },
        cursor: { etag: "first" },
        dedupeState: { seen: ["one"] },
      }),
    );
    expect(source).toMatchObject({
      kind: "rss",
      enabled: true,
      config: { url: "https://example.test/feed.xml" },
      cursor: { etag: "first" },
    });
    const updatedSource = await run(
      store.updateSourceRegistration({
        id: source.id,
        cursor: { etag: "second" },
        dedupeState: { seen: ["one", "two"] },
        enabled: false,
      }),
    );
    expect(updatedSource).toMatchObject({
      enabled: false,
      cursor: { etag: "second" },
      dedupeState: { seen: ["one", "two"] },
    });
    expect(
      await run(store.listSourceRegistrations({ workflowId: workflow.id, enabled: false })),
    ).toEqual([updatedSource]);

    await expect(run(store.deleteWorkflowRegistration(workflow.id))).rejects.toThrow();
    expect(await run(store.deleteSourceRegistration(source.id))).toBe(true);
    expect(await run(store.deleteWorkflowRegistration(workflow.id))).toBe(true);
    expect(await run(store.deleteWorkflowRegistration(manual.id))).toBe(true);
  } finally {
    await run(store.close());
    await rm(temporary, { recursive: true, force: true });
  }
});

async function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return await Effect.runPromise(effect);
}
