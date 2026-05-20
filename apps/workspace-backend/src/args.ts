export type WorkspaceBackendCliArgs =
	| {
			type: "serve";
			port: number;
			hostname: string;
			appServerUrl?: string;
			localAppServer: boolean;
			cwd?: string;
			dataDir?: string;
			secret?: string;
			executor?: string;
			nodeCommand?: string;
			flowRunnerPath?: string;
	  }
	| {
			type: "help";
			text: string;
	  };

export function parseArgs(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): WorkspaceBackendCliArgs {
	if (argv.includes("--help") || argv.includes("-h")) {
		return { type: "help", text: helpText() };
	}
	const command = argv.find((value) => !value.startsWith("--")) ?? "serve";
	if (command !== "serve") {
		throw new Error(`Unknown command: ${command}`);
	}
	const appServerUrl =
		stringFlag(argv, "app-server-url") ?? env.CODEX_WORKSPACE_BACKEND_APP_SERVER_URL;
	const localAppServer = booleanFlag(argv, "local-app-server") ||
		booleanEnv(env.CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER);
	if (appServerUrl && localAppServer) {
		throw new Error("Cannot set both --local-app-server and --app-server-url.");
	}
	return {
		type: "serve",
		port: integerFlag(argv, "port") ??
			integerEnv(env.CODEX_WORKSPACE_BACKEND_PORT) ??
			3586,
		hostname: stringFlag(argv, "host") ?? env.CODEX_WORKSPACE_BACKEND_HOST ?? "127.0.0.1",
		appServerUrl,
		localAppServer,
		cwd: stringFlag(argv, "cwd"),
		dataDir: stringFlag(argv, "data-dir"),
		secret: stringFlag(argv, "secret"),
		executor: stringFlag(argv, "executor"),
		nodeCommand: stringFlag(argv, "node"),
		flowRunnerPath: stringFlag(argv, "flow-runner"),
	};
}

function stringFlag(args: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const inline = args.find((arg) => arg.startsWith(prefix));
	if (inline) {
		return inline.slice(prefix.length) || undefined;
	}
	const index = args.indexOf(`--${name}`);
	if (index >= 0) {
		return args[index + 1]?.trim() || undefined;
	}
	return undefined;
}

function integerFlag(args: string[], name: string): number | undefined {
	const value = stringFlag(args, name);
	return value ? parsePositiveInteger(value) : undefined;
}

function integerEnv(value: string | undefined): number | undefined {
	return value ? parsePositiveInteger(value) : undefined;
}

function parsePositiveInteger(value: string): number | undefined {
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanFlag(args: string[], name: string): boolean {
	return args.includes(`--${name}`);
}

function booleanEnv(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" ||
		normalized === "on";
}

function helpText(): string {
	return `codex-workspace-backend-local serves the local Codex workspace backend protocol.

Usage:
  codex-workspace-backend-local serve [options]

Options:
  --host <host>              Host to bind. Defaults to 127.0.0.1.
  --port <port>              Port to bind. Defaults to 3586.
  --app-server-url <url>     Existing app-server WebSocket URL.
  --local-app-server         Start a local app-server over stdio.
  --cwd <dir>                Workspace root for flow discovery.
  --data-dir <dir>           Durable flow backend state directory.
  --secret <secret>          Optional HMAC secret for HTTP flow dispatch.
  --executor <executor>      Flow executor: direct or systemd-run.
  --node <path>               Node command for flow execution.
  --flow-runner <path>       Flow runner script path.
  --help, -h                 Show this help.

Environment:
  CODEX_WORKSPACE_BACKEND_HOST
  CODEX_WORKSPACE_BACKEND_PORT
  CODEX_WORKSPACE_BACKEND_APP_SERVER_URL
  CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER
`;
}
