import type { MekaProvider, MekaRunState } from "@meka/sdk";
import { MekaClient } from "./client.ts";
import type { MekaRunSummary } from "./protocol.ts";
import { MekaServer } from "./server.ts";

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "serve") {
    return await serve(rest);
  }
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
        const parsed = parseArgs(args, new Set(["provider", "model"]));
        const selectedProvider = parseProvider(requireOption(parsed, "provider"));
        if (parsed.positionals.length === 0) {
          throw new CliError("A prompt is required");
        }
        const run = await client.startRun({
          provider: selectedProvider,
          prompt: parsed.positionals.join(" "),
          ...(parsed.options.model ? { model: parsed.options.model } : {}),
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
  const parsed = parseArgs(args, new Set(["cwd", "runtime-root"]));
  if (parsed.positionals.length > 0) {
    throw new CliError("serve does not accept positional arguments");
  }
  const server = new MekaServer({
    ...(parsed.options.cwd ? { cwd: parsed.options.cwd } : {}),
    ...(parsed.options["runtime-root"] ? { runtimeRoot: parsed.options["runtime-root"] } : {}),
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

async function withClient(
  args: string[],
  action: (client: MekaClient, commandArgs: string[]) => Promise<number>,
): Promise<number> {
  const extracted = extractSocket(args);
  const socketPath = extracted.socketPath ?? process.env.MEKA_SOCKET;
  if (!socketPath) {
    throw new CliError("A Meka socket is required via --socket PATH or MEKA_SOCKET");
  }
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
    const subscribed = await client.subscribe(runId, afterSequence);
    if (isTerminal(subscribed.run.state)) {
      terminal.resolve(subscribed.run);
    }
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

function isTerminal(state: MekaRunState | "starting"): boolean {
  return state !== "running" && state !== "starting";
}

function exitCode(state: MekaRunState | "starting"): number {
  if (state === "completed") {
    return 0;
  }
  return state === "interrupted" ? 130 : 1;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export class CliError extends Error {}

const HELP = `Meka — a private local control plane for coding harnesses

Usage:
  meka serve [--cwd DIR] [--runtime-root DIR]
  meka status [--socket PATH]
  meka run --provider codex|claude [--model MODEL] [--socket PATH] <prompt>
  meka subscribe [--after SEQUENCE] [--socket PATH] <run-id>
  meka interrupt [--socket PATH] <run-id>
  meka close [--socket PATH] <run-id>
  meka plugin install --provider codex|claude [options] [--socket PATH] <plugin>

Client commands also read MEKA_SOCKET. All run events are emitted as NDJSON.
`;
