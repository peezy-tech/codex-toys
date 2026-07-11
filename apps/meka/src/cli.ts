import type { MekaProvider, MekaRunState } from "@meka/sdk";
import { Effect } from "effect";
import { AutomationRuntime } from "./automation-runtime.ts";
import type { DurableJobStatus } from "./automation/types.ts";
import { MekaClient } from "./client.ts";
import { installCliShim, statusCliShim, uninstallCliShim } from "./cli-shim.ts";
import { runMekaDoctor } from "./doctor.ts";
import {
  NodeIntegrationPlatformLive,
  installIntegrations,
  repairIntegrations,
  statusIntegrations,
  uninstallIntegrations,
  type IntegrationProvider,
} from "./integrations/index.ts";
import type { MekaRunSummary } from "./protocol.ts";
import { discoverRuntimeMetadata } from "./runtime-path.ts";
import { MekaServer } from "./server.ts";

const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const ACTIVE_JOB_CANCEL_MESSAGE =
  "Active jobs cannot be canceled from the state CLI. For a managed provider run, use " +
  "`meka interrupt <run-id>`; other active workers must be controlled by their owning daemon";

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const groupHelp = GROUP_HELP[command];
  if (groupHelp && isGroupHelpRequest(rest)) {
    process.stdout.write(groupHelp);
    return 0;
  }
  if (command === "serve") {
    return await serve(rest);
  }
  if (command === "doctor") {
    return await doctor(rest);
  }
  if (command === "setup") {
    return await setup(rest);
  }
  if (command === "integration") {
    const [subcommand, ...integrationArgs] = rest;
    if (
      subcommand !== "install" &&
      subcommand !== "status" &&
      subcommand !== "repair" &&
      subcommand !== "uninstall"
    ) {
      throw new CliError(
        "Usage: meka integration <install|status|repair|uninstall> [--provider all|codex|claude]",
      );
    }
    return await integration(subcommand, integrationArgs);
  }
  if (command === "queue") return await queueCommand(rest);
  if (command === "jobs") return await jobsCommand(rest);
  if (command === "workflow") return await workflowCommand(rest);
  if (command === "event") return await eventCommand(rest);
  if (command === "source") return await sourceCommand(rest);
  if (command === "agents") return await agentsCommand(rest);
  if (command === "plugin") {
    const [subcommand, ...pluginArgs] = rest;
    if (subcommand !== "install") {
      throw new CliError("Usage: meka plugin install --provider <provider> <plugin>");
    }
    return await withClient(pluginArgs, async (client, args) => {
      const parsed = parseArgs(
        args,
        new Set(["provider", "scope", "marketplace-path", "remote-marketplace-name"]),
      );
      const selectedProvider = parseProvider(requireOption(parsed, "provider"));
      const plugin = onePositional(parsed, "plugin");
      const result =
        selectedProvider === "codex"
          ? await client.installPlugin({
              provider: "codex",
              plugin,
              ...(parsed.options["marketplace-path"]
                ? { marketplacePath: parsed.options["marketplace-path"] }
                : {}),
              ...(parsed.options["remote-marketplace-name"]
                ? { remoteMarketplaceName: parsed.options["remote-marketplace-name"] }
                : {}),
            })
          : await client.installPlugin({
              provider: "claude",
              plugin,
              scope: parseScope(parsed.options.scope),
            });
      print(result);
      return 0;
    });
  }

  switch (command) {
    case "status":
      return await withClient(rest, async (client, args) => {
        assertNoArguments(args);
        print(await client.status());
        return 0;
      });
    case "run":
      return await withClient(rest, async (client, args) => {
        const parsed = parseArgs(args, new Set(["provider", "model", "queue"]));
        const selectedProvider = parseProvider(requireOption(parsed, "provider"));
        if (parsed.positionals.length === 0) {
          throw new CliError("A prompt is required");
        }
        const run = await client.startRun({
          provider: selectedProvider,
          prompt: parsed.positionals.join(" "),
          ...(parsed.options.model ? { model: parsed.options.model } : {}),
          ...(parsed.options.queue ? { queue: parsed.options.queue } : {}),
        });
        print({ type: "run.started", run });
        return await streamRun(client, run.id, 0);
      });
    case "subscribe":
      return await withClient(rest, async (client, args) => {
        const parsed = parseArgs(args, new Set(["after"]));
        const runId = onePositional(parsed, "run id");
        const after =
          parsed.options.after === undefined ? 0 : parseInteger(parsed.options.after, "after");
        return await streamRun(client, runId, after);
      });
    case "interrupt":
      return await runAction(rest, async (client, runId) => await client.interrupt(runId));
    case "close":
      return await runAction(rest, async (client, runId) => await client.closeRun(runId));
    default:
      throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

async function serve(args: string[]): Promise<number> {
  const parsed = parseArgs(args, new Set(["cwd", "runtime-root", "state-root"]));
  if (parsed.positionals.length > 0) {
    throw new CliError("serve does not accept positional arguments");
  }
  const server = new MekaServer({
    ...(parsed.options.cwd ? { cwd: parsed.options.cwd } : {}),
    ...(parsed.options["runtime-root"] ? { runtimeRoot: parsed.options["runtime-root"] } : {}),
    ...(parsed.options["state-root"] ? { stateRoot: parsed.options["state-root"] } : {}),
  });
  const ready = await server.start();
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void server.close().then(stopped.resolve, stopped.reject);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await stopped.promise;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close();
  }
  return 0;
}

async function doctor(args: string[]): Promise<number> {
  const parsed = parseArgs(args, new Set(["cwd", "runtime-root"]));
  assertNoArguments(parsed.positionals);
  const report = await runMekaDoctor({
    ...(parsed.options.cwd ? { cwd: parsed.options.cwd } : {}),
    ...(parsed.options["runtime-root"] ? { runtimeRoot: parsed.options["runtime-root"] } : {}),
  });
  print(report);
  return report.ready ? 0 : 1;
}

async function integration(
  operation: "install" | "status" | "repair" | "uninstall",
  args: string[],
): Promise<number> {
  const parsed = parseArgs(args, new Set(["provider"]));
  assertNoArguments(parsed.positionals);
  const providers = parseIntegrationProviders(parsed.options.provider);
  return await runIntegration(operation, providers);
}

async function setup(args: string[]): Promise<number> {
  const parsed = parseArgs(args, new Set(["provider"]));
  assertNoArguments(parsed.positionals);
  if (parsed.options.provider !== undefined) {
    return await runIntegration("install", parseIntegrationProviders(parsed.options.provider));
  }

  const availability = await Effect.runPromise(
    statusIntegrations({ providers: ["codex", "claude"] }).pipe(
      Effect.provide(NodeIntegrationPlatformLive),
    ),
  );
  const providers = availability.hosts
    .filter((host) => host.state !== "unavailable")
    .map((host) => host.provider);
  if (providers.length === 0) {
    const cliShim = await statusCliShim();
    print({
      ...availability,
      operation: "install",
      ready: false,
      skippedProviders: ["codex", "claude"],
      cliShim,
    });
    return 1;
  }
  const skippedProviders = (["codex", "claude"] as const).filter(
    (provider) => !providers.includes(provider),
  );
  return await runIntegration("install", providers, { skippedProviders });
}

async function runIntegration(
  operation: "install" | "status" | "repair" | "uninstall",
  providers: IntegrationProvider[],
  extra: Record<string, unknown> = {},
): Promise<number> {
  const action =
    operation === "install"
      ? installIntegrations
      : operation === "status"
        ? statusIntegrations
        : operation === "repair"
          ? repairIntegrations
          : uninstallIntegrations;
  const report = await Effect.runPromise(
    action({ providers }).pipe(Effect.provide(NodeIntegrationPlatformLive)),
  );
  const managesAllProviders = providers.length === 2;
  const cliShim =
    operation === "install" || operation === "repair"
      ? await installCliShim()
      : operation === "uninstall" && managesAllProviders
        ? await uninstallCliShim()
        : await statusCliShim();
  print({ ...report, ...extra, cliShim });
  const shimReady =
    operation === "uninstall"
      ? !managesAllProviders ||
        cliShim.state === "not-installed" ||
        (cliShim.state as string) === "external"
      : cliShim.state === "installed" || (cliShim.state as string) === "external";
  return report.ready && shimReady ? 0 : 1;
}

async function queueCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "configure") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "concurrency", "window-ms", "max-starts", "lease-ms"]),
      async (automation, parsed) => {
        const queueName = onePositional(parsed, "queue name");
        const current = await Effect.runPromise(
          automation.store.getQueuePolicyTemplate(queueName),
        );
        const policy = await automation.configureQueue({
          queueName,
          concurrency: optionInteger(parsed, "concurrency", current.concurrency, true),
          startWindowMs: optionInteger(parsed, "window-ms", current.startWindowMs, true),
          maxStartsPerWindow: optionInteger(parsed, "max-starts", current.maxStartsPerWindow, true),
          leaseMs: optionInteger(parsed, "lease-ms", current.leaseMs, true),
        });
        print(policy);
        return 0;
      },
    );
  }
  if (subcommand === "list") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        assertNoArguments(parsed.positionals);
        print(await Effect.runPromise(automation.store.listQueueUsage()));
        return 0;
      },
    );
  }
  throw new CliError(
    "Usage: meka queue configure <name> [--concurrency N --window-ms N --max-starts N --lease-ms N] | meka queue list",
  );
}

async function jobsCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "queue", "status", "limit"]),
      async (automation, parsed) => {
        assertNoArguments(parsed.positionals);
        print(
          await Effect.runPromise(
            automation.store.listJobs({
              ...(parsed.options.queue ? { queueName: parsed.options.queue } : {}),
              ...(parsed.options.status
                ? { statuses: parseJobStatuses(parsed.options.status) }
                : {}),
              ...(parsed.options.limit
                ? { limit: parseInteger(parsed.options.limit, "limit") }
                : {}),
            }),
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "show") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        const id = onePositional(parsed, "job id");
        const detail = await Effect.runPromise(automation.store.getJobDetail(id));
        if (!detail) throw new CliError(`Job not found: ${id}`);
        print({
          job: detail,
          attempts: await Effect.runPromise(automation.store.getJobAttempts(id)),
        });
        return 0;
      },
    );
  }
  if (subcommand === "retry") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "not-before"]),
      async (automation, parsed) => {
        print(
          await Effect.runPromise(
            automation.store.retryJob({
              jobId: onePositional(parsed, "job id"),
              ...(parsed.options["not-before"] ? { notBefore: parsed.options["not-before"] } : {}),
            }),
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "cancel") {
    return await withAutomation(
      rest,
      // Parse the old lease option only to return safe migration guidance.
      // Lease-bearing settlement remains available to the owning daemon.
      new Set(["cwd", "state-root", "lease-token", "reason"]),
      async (automation, parsed) => {
        const jobId = onePositional(parsed, "job id");
        if (parsed.options["lease-token"]) {
          throw new CliError(
            `--lease-token cannot be used from the state CLI; cancel pending jobs without it. ${ACTIVE_JOB_CANCEL_MESSAGE}`,
          );
        }
        const job = await Effect.runPromise(automation.store.getJob(jobId));
        if (job?.status === "leased" || job?.status === "running") {
          throw new CliError(ACTIVE_JOB_CANCEL_MESSAGE);
        }
        print(
          await Effect.runPromise(
            automation.store.cancelJob({
              jobId,
              ...(parsed.options.reason ? { reason: parsed.options.reason } : {}),
            }),
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "resolve") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "status"]),
      async (automation, parsed) => {
        const jobId = onePositional(parsed, "job id");
        const status = requireOption(parsed, "status");
        if (status !== "succeeded" && status !== "failed" && status !== "canceled") {
          throw new CliError("resolved status must be succeeded, failed, or canceled");
        }
        const detail = await readStdinJson();
        print(
          await Effect.runPromise(
            status === "succeeded"
              ? automation.store.reconcileUncertainJob({ jobId, status, result: detail })
              : automation.store.reconcileUncertainJob({ jobId, status, error: detail }),
          ),
        );
        return 0;
      },
    );
  }
  throw new CliError("Usage: meka jobs <list|show|retry|cancel|resolve> [options]");
}

async function workflowCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "queue"]),
      async (automation, parsed) => {
        print(
          await automation.registerWorkflow(
            onePositional(parsed, "TypeScript workflow file"),
            parsed.options.queue ?? "default",
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "list") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        assertNoArguments(parsed.positionals);
        print(await Effect.runPromise(automation.store.listWorkflowRegistrations()));
        return 0;
      },
    );
  }
  if (subcommand === "remove") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        print({
          removed: await Effect.runPromise(
            automation.store.deleteWorkflowRegistration(onePositional(parsed, "workflow id")),
          ),
        });
        return 0;
      },
    );
  }
  if (subcommand === "enable" || subcommand === "disable") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        print(
          await Effect.runPromise(
            automation.store.updateWorkflowRegistration({
              id: onePositional(parsed, "workflow id"),
              enabled: subcommand === "enable",
            }),
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "run") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        const id = onePositional(parsed, "workflow id");
        const payload = await readStdinJson();
        print(await automation.runWorkflow(id, payload));
        return 0;
      },
    );
  }
  throw new CliError("Usage: meka workflow <add|list|remove|enable|disable|run> [options]");
}

async function eventCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "emit") {
    throw new CliError(
      "Usage: meka event emit <type> --source <name> [--delivery-id ID] [--verified true|false]",
    );
  }
  return await withAutomation(
    rest,
    new Set(["cwd", "state-root", "source", "delivery-id", "verified"]),
    async (automation, parsed) => {
      const type = onePositional(parsed, "event type");
      const source = requireOption(parsed, "source");
      const payload = await readStdinJson();
      print(
        await automation.ingestEvent({
          type,
          source,
          payload,
          ...(parsed.options["delivery-id"] ? { deliveryId: parsed.options["delivery-id"] } : {}),
          verified: parseBoolean(parsed.options.verified ?? "false", "verified"),
        }),
      );
      return 0;
    },
  );
}

async function sourceCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "url", "event", "timeout-ms", "secret-env", "events"]),
      async (automation, parsed) => {
        const [kind, id, workflowId, ...command] = parsed.positionals;
        if (!kind || !id || !workflowId || !["rss", "github", "command"].includes(kind)) {
          throw new CliError(
            "Usage: meka source add <rss|github|command> <id> <workflow-id> [options]",
          );
        }
        let config: Record<string, unknown>;
        if (kind === "rss") {
          if (command.length > 0) throw new CliError("RSS source does not accept command argv");
          config = {
            url: requireOption(parsed, "url"),
            ...(parsed.options.event ? { eventType: parsed.options.event } : {}),
            ...(parsed.options["timeout-ms"]
              ? { timeoutMs: parseInteger(parsed.options["timeout-ms"], "timeout-ms") }
              : {}),
          };
        } else if (kind === "github") {
          if (command.length > 0) throw new CliError("GitHub source does not accept command argv");
          config = {
            secretEnv: requireOption(parsed, "secret-env"),
            ...(parsed.options.events
              ? { eventNames: parsed.options.events.split(",").filter(Boolean) }
              : {}),
          };
        } else {
          if (command.length === 0) {
            throw new CliError("Command source requires argv after `--`");
          }
          config = {
            argv: command,
            ...(parsed.options.event ? { eventType: parsed.options.event } : {}),
            ...(parsed.options["timeout-ms"]
              ? { timeoutMs: parseInteger(parsed.options["timeout-ms"], "timeout-ms") }
              : {}),
          };
        }
        print(await automation.createSource({ id, kind, workflowId, config }));
        return 0;
      },
    );
  }
  if (subcommand === "list") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        assertNoArguments(parsed.positionals);
        print(await Effect.runPromise(automation.store.listSourceRegistrations()));
        return 0;
      },
    );
  }
  if (subcommand === "remove") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        print({
          removed: await Effect.runPromise(
            automation.store.deleteSourceRegistration(onePositional(parsed, "source id")),
          ),
        });
        return 0;
      },
    );
  }
  if (subcommand === "poll") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        print(await automation.pollRssSource(onePositional(parsed, "RSS source id")));
        return 0;
      },
    );
  }
  if (subcommand === "run") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        print(await automation.runCommandSource(onePositional(parsed, "command source id")));
        return 0;
      },
    );
  }
  if (subcommand === "github") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "event", "delivery", "signature"]),
      async (automation, parsed) => {
        const id = onePositional(parsed, "GitHub source id");
        const eventName = requireOption(parsed, "event");
        const deliveryId = requireOption(parsed, "delivery");
        const signature = requireOption(parsed, "signature");
        const body = await readStdin(MAX_STDIN_BYTES);
        print(
          await automation.ingestGitHubSource(id, {
            eventName,
            deliveryId,
            signature,
            body,
          }),
        );
        return 0;
      },
    );
  }
  throw new CliError("Usage: meka source <add|list|remove|poll|run|github> [options]");
}

async function agentsCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "state"]),
      async (automation, parsed) => {
        assertNoArguments(parsed.positionals);
        await automation.drainHookSpool();
        await Effect.runPromise(automation.store.recoverExpiredExternalAgentSessions());
        print(
          await Effect.runPromise(
            automation.store.listExternalAgentSessions(
              parsed.options.state ? { states: parseAgentStates(parsed.options.state) } : {},
            ),
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "events") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root", "provider", "session", "limit"]),
      async (automation, parsed) => {
        assertNoArguments(parsed.positionals);
        await automation.drainHookSpool();
        print(
          await Effect.runPromise(
            automation.store.listAgentEvents({
              ...(parsed.options.provider ? { provider: parsed.options.provider } : {}),
              ...(parsed.options.session ? { sessionId: parsed.options.session } : {}),
              ...(parsed.options.limit
                ? { limit: parseInteger(parsed.options.limit, "limit") }
                : {}),
            }),
          ),
        );
        return 0;
      },
    );
  }
  if (subcommand === "show") {
    return await withAutomation(
      rest,
      new Set(["cwd", "state-root"]),
      async (automation, parsed) => {
        await automation.drainHookSpool();
        const id = onePositional(parsed, "agent event id");
        const event = await Effect.runPromise(automation.store.getAgentEvent(id));
        if (!event) throw new CliError(`Agent event not found: ${id}`);
        print(event);
        return 0;
      },
    );
  }
  throw new CliError("Usage: meka agents <list|events|show> [options]");
}

async function withAutomation(
  args: string[],
  valueOptions: Set<string>,
  action: (automation: AutomationRuntime, parsed: ParsedArgs) => Promise<number>,
): Promise<number> {
  const parsed = parseArgs(args, valueOptions);
  const automation = await AutomationRuntime.open({
    ...(parsed.options.cwd ? { cwd: parsed.options.cwd } : {}),
    ...(parsed.options["state-root"] ? { stateRoot: parsed.options["state-root"] } : {}),
  });
  try {
    return await action(automation, parsed);
  } finally {
    await automation.close();
  }
}

async function withClient(
  args: string[],
  action: (client: MekaClient, commandArgs: string[]) => Promise<number>,
): Promise<number> {
  const extracted = extractSocket(args);
  const socketPath =
    extracted.socketPath ??
    process.env.MEKA_SOCKET ??
    (await discoverRuntimeMetadata({ cwd: process.cwd() })).socketPath;
  const client = new MekaClient({ socketPath });
  try {
    await client.connect();
    return await action(client, extracted.args);
  } finally {
    client.close();
  }
}

async function streamRun(
  client: MekaClient,
  runId: string,
  afterSequence: number,
): Promise<number> {
  const terminal = Promise.withResolvers<MekaRunSummary>();
  const removeClose = client.onClose((error) => terminal.reject(error));
  const remove = client.onNotification((message) => {
    if (message.method !== "run.event" && message.method !== "run.state") {
      return;
    }
    const params = message.params ?? {};
    if (params.runId !== runId && (params.run as MekaRunSummary | undefined)?.id !== runId) {
      return;
    }
    print(message);
    if (message.method === "run.state") {
      const run = params.run as MekaRunSummary;
      if (isTerminal(run.state)) {
        terminal.resolve(run);
      }
    }
  });
  try {
    // The subscribe response deliberately precedes replay notifications. Even
    // when its snapshot is terminal, wait for the trailing run.state so every
    // replayed run.event has been delivered before removing the listener.
    await client.subscribe(runId, afterSequence);
    const run = await terminal.promise;
    return exitCode(run.state);
  } finally {
    remove();
    removeClose();
  }
}

async function runAction(
  args: string[],
  action: (client: MekaClient, runId: string) => Promise<unknown>,
): Promise<number> {
  return await withClient(args, async (client, commandArgs) => {
    const parsed = parseArgs(commandArgs, new Set());
    print(await action(client, onePositional(parsed, "run id")));
    return 0;
  });
}

type ParsedArgs = {
  options: Record<string, string>;
  positionals: string[];
};

function parseArgs(args: string[], valueOptions: Set<string>): ParsedArgs {
  const parsed: ParsedArgs = { options: {}, positionals: [] };
  let positionalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    if (positionalOnly || !value.startsWith("--")) {
      parsed.positionals.push(value);
      continue;
    }
    if (value === "--") {
      positionalOnly = true;
      continue;
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals < 0 ? undefined : equals);
    if (!valueOptions.has(name)) {
      throw new CliError(`Unknown option: --${name}`);
    }
    const optionValue = equals >= 0 ? value.slice(equals + 1) : args[++index];
    if (!optionValue) {
      throw new CliError(`Option --${name} requires a value`);
    }
    parsed.options[name] = optionValue;
  }
  return parsed;
}

function extractSocket(args: string[]): { socketPath?: string; args: string[] } {
  const remaining: string[] = [];
  let socketPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    if (value === "--") {
      remaining.push(...args.slice(index));
      break;
    }
    if (value === "--socket") {
      socketPath = args[++index];
      if (!socketPath) {
        throw new CliError("Option --socket requires a value");
      }
    } else if (value.startsWith("--socket=")) {
      socketPath = value.slice("--socket=".length);
      if (!socketPath) {
        throw new CliError("Option --socket requires a value");
      }
    } else {
      remaining.push(value);
    }
  }
  return { ...(socketPath ? { socketPath } : {}), args: remaining };
}

function requireOption(parsed: ParsedArgs, name: string): string {
  const value = parsed.options[name];
  if (!value) {
    throw new CliError(`Option --${name} is required`);
  }
  return value;
}

function onePositional(parsed: ParsedArgs, label: string): string {
  if (parsed.positionals.length !== 1) {
    throw new CliError(`Expected exactly one ${label}`);
  }
  return parsed.positionals[0] as string;
}

function assertNoArguments(args: string[]): void {
  if (args.length > 0) {
    throw new CliError(`Unexpected argument: ${args[0]}`);
  }
}

function parseProvider(value: string): MekaProvider {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new CliError("provider must be codex or claude");
}

function parseIntegrationProviders(value: string | undefined): IntegrationProvider[] {
  if (value === undefined || value === "all") return ["codex", "claude"];
  if (value === "codex" || value === "claude") return [value];
  throw new CliError("provider must be all, codex, or claude");
}

function parseScope(value: string | undefined): "user" | "project" | "local" {
  if (value === undefined || value === "user") {
    return "user";
  }
  if (value === "project" || value === "local") {
    return value;
  }
  throw new CliError("scope must be user, project, or local");
}

function parseInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliError(`${label} must be a non-negative integer`);
  }
  return number;
}

function optionInteger(
  parsed: ParsedArgs,
  name: string,
  fallback: number,
  positive = false,
): number {
  const value = parsed.options[name];
  if (value === undefined) return fallback;
  const parsedValue = parseInteger(value, name);
  if (positive && parsedValue === 0) throw new CliError(`${name} must be greater than zero`);
  return parsedValue;
}

function parseBoolean(value: string, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError(`${label} must be true or false`);
}

function parseJobStatuses(value: string): DurableJobStatus[] {
  const allowed = new Set<DurableJobStatus>([
    "pending",
    "leased",
    "running",
    "succeeded",
    "failed",
    "canceled",
    "uncertain",
  ]);
  const statuses = value.split(",").filter(Boolean);
  if (
    statuses.length === 0 ||
    statuses.some((status) => !allowed.has(status as DurableJobStatus))
  ) {
    throw new CliError("status must be a comma-separated durable job state");
  }
  return statuses as DurableJobStatus[];
}

function parseAgentStates(value: string): Array<"active" | "released" | "expired"> {
  const states = value.split(",").filter(Boolean);
  if (
    states.length === 0 ||
    states.some((state) => state !== "active" && state !== "released" && state !== "expired")
  ) {
    throw new CliError("state must be active, released, expired, or a comma-separated combination");
  }
  return states as Array<"active" | "released" | "expired">;
}

async function readStdinJson(): Promise<unknown> {
  const input = await readStdin(MAX_STDIN_BYTES);
  if (input.length === 0) return {};
  try {
    return JSON.parse(input.toString("utf8")) as unknown;
  } catch {
    throw new CliError("stdin must contain one JSON value");
  }
}

async function readStdin(maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > maxBytes) throw new CliError(`stdin exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function isTerminal(state: MekaRunState | "queued" | "starting"): boolean {
  return state !== "queued" && state !== "running" && state !== "starting";
}

function exitCode(state: MekaRunState | "queued" | "starting"): number {
  if (state === "completed") {
    return 0;
  }
  return state === "interrupted" ? 130 : 1;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isGroupHelpRequest(args: string[]): boolean {
  const candidate = args.length === 1 ? args[0] : args.length === 2 ? args[1] : undefined;
  return candidate === "help" || candidate === "--help" || candidate === "-h";
}

export class CliError extends Error {}

const HELP = `Meka — a private local control plane for coding harnesses

Usage:
  meka serve [--cwd DIR] [--runtime-root DIR] [--state-root DIR]
  meka doctor [--cwd DIR] [--runtime-root DIR]
  meka setup [--provider all|codex|claude]
  meka integration <install|status|repair|uninstall> [--provider all|codex|claude]
  meka queue configure <name> [--concurrency N --window-ms N --max-starts N --lease-ms N]
  meka queue list
  meka jobs <list|show|retry|cancel|resolve> [options]
  meka workflow add <file.ts> [--queue NAME]
  meka workflow <list|remove|enable|disable|run> [options]
  meka event emit <type> --source <name> [--delivery-id ID] [--verified true|false]
  meka source <add|list|remove|poll|run|github> [options]
  meka agents <list|events|show> [options]
  meka status [--socket PATH]
  meka run --provider codex|claude [--queue NAME] [--model MODEL] [--socket PATH] <prompt>
  meka subscribe [--after SEQUENCE] [--socket PATH] <run-id>
  meka interrupt [--socket PATH] <run-id>
  meka close [--socket PATH] <run-id>
  meka plugin install --provider codex|claude [options] [--socket PATH] <plugin>

State commands accept --cwd and --state-root. JSON event/workflow payloads are read from stdin.
Client commands use --socket, then MEKA_SOCKET, then private workspace discovery.
Runs are admitted through durable queues; run notifications are emitted as NDJSON.
Doctor emits one redacted JSON report and does not start a provider run.
Use meka <integration|queue|jobs|workflow|event|source|agents|plugin> --help for exact options.
`;

const GROUP_HELP: Record<string, string> = {
  integration: `Meka integration setup (no daemon required)

Usage:
  meka setup [--provider all|codex|claude]
  meka integration <install|status|repair|uninstall> [--provider all|codex|claude]

Install and repair add the requested host plugins plus an ownership-recorded
~/.local/bin/meka launcher. Provider-specific uninstall keeps the shared launcher;
all-provider uninstall removes it only when the ownership receipt still matches.
Bare setup installs every available host and reports skipped CLIs; pass
--provider all to require both.
`,
  queue: `Meka durable queue policy

Usage:
  meka queue configure <name> [--concurrency N] [--window-ms N] [--max-starts N] [--lease-ms N]
    [--cwd DIR] [--state-root DIR]
  meka queue list [--cwd DIR] [--state-root DIR]

The built-in default queue needs no configuration. Every other queue must be
configured before workflow registration or job admission.
`,
  jobs: `Meka durable jobs

Usage:
  meka jobs list [--queue NAME] [--status STATES] [--limit N] [--cwd DIR] [--state-root DIR]
  meka jobs show <id> [--cwd DIR] [--state-root DIR]
  meka jobs retry <id> [--not-before ISO_TIME] [--cwd DIR] [--state-root DIR]
  meka jobs cancel <id> [--reason TEXT] [--cwd DIR] [--state-root DIR]
  meka jobs resolve <id> --status succeeded|failed|canceled [--cwd DIR] [--state-root DIR]

STATES is a comma-separated durable job-state list. jobs resolve is the explicit
operator path for an uncertain job; pipe one JSON result (succeeded) or error
(failed/canceled) on stdin. jobs cancel only settles pending jobs. For an active
managed provider run, use meka interrupt so its owning daemon aborts the worker
and settles the job together. Other active workers must be controlled by their
owning daemon; lease tokens are internal daemon credentials.
`,
  workflow: `Meka trusted TypeScript workflows

Usage:
  meka workflow add <file.ts> [--queue NAME] [--cwd DIR] [--state-root DIR]
  meka workflow list [--cwd DIR] [--state-root DIR]
  meka workflow remove <id> [--cwd DIR] [--state-root DIR]
  meka workflow enable <id> [--cwd DIR] [--state-root DIR]
  meka workflow disable <id> [--cwd DIR] [--state-root DIR]
  meka workflow run <id> [--cwd DIR] [--state-root DIR]

add imports and fingerprints the trusted local module. run reads one JSON payload
from stdin (an empty stream means {}). Non-default evaluation queues must already
be configured; downstream queues requested by the workflow are independent.
`,
  event: `Meka normalized event ingress

Usage:
  meka event emit <type> --source NAME [--delivery-id ID] [--verified true|false]
    [--cwd DIR] [--state-root DIR]

The event payload is one JSON value read from stdin (an empty stream means {}).
`,
  source: `Meka one-shot sources (scheduling and public HTTP stay outside Meka)

Usage:
  meka source add rss <id> <workflow-id> --url URL [--event TYPE] [--timeout-ms N]
  meka source add github <id> <workflow-id> --secret-env ENV [--events NAME,NAME]
  meka source add command <id> <workflow-id> [--event TYPE] [--timeout-ms N] -- <executable> [args...]
  meka source list
  meka source remove <id>
  meka source poll <rss-id>
  meka source run <command-id>
  meka source github <id> --event NAME --delivery ID --signature SHA256_SIGNATURE

All commands accept --cwd DIR and --state-root DIR. GitHub ingress reads the
original bounded webhook body from stdin and verifies it before normalization.
Command argv is executed directly without a shell and stdout must be JSON.
`,
  agents: `Meka externally observed agent activity

Usage:
  meka agents list [--state active,released,expired] [--cwd DIR] [--state-root DIR]
  meka agents events [--provider codex|claude] [--session ID] [--limit N]
    [--cwd DIR] [--state-root DIR]
  meka agents show <event-id> [--cwd DIR] [--state-root DIR]

These hook observations are informational and do not consume queue capacity.
`,
  plugin: `Install an arbitrary provider-native plugin through a running daemon

Usage:
  meka plugin install --provider claude [--scope user|project|local] [--socket PATH] <plugin>
  meka plugin install --provider codex [--marketplace-path PATH]
    [--remote-marketplace-name NAME] [--socket PATH] <plugin>
`,
};
