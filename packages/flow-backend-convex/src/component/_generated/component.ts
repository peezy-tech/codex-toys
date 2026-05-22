/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    backend: {
      appendRunOutput: FunctionReference<
        "mutation",
        "internal",
        {
          attemptId: string;
          kind: "system" | "stdout" | "stderr" | "agent";
          leaseToken: string;
          text: string;
        },
        any,
        Name
      >;
      cancelRun: FunctionReference<
        "mutation",
        "internal",
        { runId: string },
        any,
        Name
      >;
      claimRun: FunctionReference<
        "mutation",
        "internal",
        { leaseMs?: number; workerId: string },
        any,
        Name
      >;
      completeRun: FunctionReference<
        "mutation",
        "internal",
        { attemptId: string; leaseToken: string; result: any },
        any,
        Name
      >;
      dispatchEvent: FunctionReference<
        "mutation",
        "internal",
        {
          event: {
            id: string;
            occurredAt?: string;
            payload: any;
            receivedAt?: string;
            source?: string;
            type: string;
          };
        },
        any,
        Name
      >;
      failRun: FunctionReference<
        "mutation",
        "internal",
        { attemptId: string; error: string; leaseToken: string },
        any,
        Name
      >;
      getEvent: FunctionReference<
        "query",
        "internal",
        { eventId: string },
        any,
        Name
      >;
      getRun: FunctionReference<
        "query",
        "internal",
        { runId: string },
        any,
        Name
      >;
      heartbeatRun: FunctionReference<
        "mutation",
        "internal",
        { attemptId: string; leaseMs?: number; leaseToken: string },
        any,
        Name
      >;
      listEvents: FunctionReference<
        "query",
        "internal",
        { limit?: number; type?: string },
        any,
        Name
      >;
      listRuns: FunctionReference<
        "query",
        "internal",
        {
          eventId?: string;
          limit?: number;
          status?: "queued" | "running" | "completed" | "failed" | "canceled";
        },
        any,
        Name
      >;
      replayEvent: FunctionReference<
        "mutation",
        "internal",
        { eventId: string },
        any,
        Name
      >;
      syncFlowManifest: FunctionReference<
        "mutation",
        "internal",
        {
          config?: any;
          description?: string;
          name: string;
          root?: string;
          steps: Array<{
            cwd?: string;
            name: string;
            runner: "node";
            script: string;
            timeoutMs: number;
            trigger?: { schema?: string; schemaJson?: any; type: string };
          }>;
          version: number;
        },
        any,
        Name
      >;
    };
  };
