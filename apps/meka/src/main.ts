#!/usr/bin/env node
import { CliError, runCli } from "./cli.ts";

try {
  process.exitCode = await runCli();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`meka: ${message}\n`);
  process.exitCode = error instanceof CliError ? 2 : 1;
}
