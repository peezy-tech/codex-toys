#!/usr/bin/env node
import type { DiscordBridgeLogLevel } from "./logger.ts";

type PrettyLogOptions = {
	color?: boolean;
	name?: string;
	now?: () => Date;
};

type PrettyLogRecord = Record<string, unknown> & {
	component?: unknown;
	event?: unknown;
	level?: unknown;
	message?: unknown;
	time?: unknown;
};

const reservedFields = new Set(["time", "component", "level", "event"]);
const resetColor = "\x1b[0m";
const levelColors: Record<DiscordBridgeLogLevel, string> = {
	debug: "\x1b[90m",
	info: "\x1b[36m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
};

export function formatPrettyLogLine(
	line: string,
	options: PrettyLogOptions = {},
): string {
	const now = options.now ?? (() => new Date());
	const record = parseRecord(line);
	if (!record) {
		return formatParts({
			color: options.color ?? false,
			component: options.name ?? "process",
			fields: "",
			level: "info",
			message: line,
			time: formatTime(now()),
		});
	}

	const level = normalizeLevel(record.level);
	const message = stringifyMainMessage(record);
	return formatParts({
		color: options.color ?? false,
		component: stringifyComponent(record.component, options.name),
		fields: stringifyFields(record),
		level,
		message,
		time: formatTime(record.time, now),
	});
}

export async function runPrettyLogCli(
	args: string[],
	input: AsyncIterable<string | Uint8Array>,
	output: Pick<NodeJS.WriteStream, "write">,
): Promise<void> {
	const options = parseCliArgs(args);
	let buffer = "";
	for await (const chunk of input) {
		buffer += typeof chunk === "string"
			? chunk
			: Buffer.from(chunk).toString("utf8");
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = trimTrailingCarriageReturn(buffer.slice(0, newlineIndex));
			output.write(`${formatPrettyLogLine(line, options)}\n`);
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) {
		output.write(
			`${formatPrettyLogLine(trimTrailingCarriageReturn(buffer), options)}\n`,
		);
	}
}

function parseCliArgs(args: string[]): PrettyLogOptions {
	const options: PrettyLogOptions = {
		color: Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--name") {
			const name = args[index + 1];
			if (!name) {
				throw new Error("Missing value for --name");
			}
			options.name = name;
			index += 1;
			continue;
		}
		if (arg === "--color") {
			options.color = true;
			continue;
		}
		if (arg === "--no-color") {
			options.color = false;
			continue;
		}
		throw new Error(`Unexpected argument: ${arg ?? ""}`);
	}
	return options;
}

function parseRecord(line: string): PrettyLogRecord | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value !== null && typeof value === "object"
			? value as PrettyLogRecord
			: undefined;
	} catch {
		return undefined;
	}
}

function normalizeLevel(level: unknown): DiscordBridgeLogLevel {
	if (typeof level !== "string") {
		return "info";
	}
	const normalized = level.toLowerCase();
	if (
		normalized === "debug" || normalized === "info" || normalized === "warn" ||
		normalized === "error"
	) {
		return normalized;
	}
	return "info";
}

function stringifyComponent(component: unknown, fallback: string | undefined): string {
	return typeof component === "string" && component.length > 0
		? component
		: fallback ?? "process";
}

function stringifyMainMessage(record: PrettyLogRecord): string {
	if (typeof record.event === "string" && record.event.length > 0) {
		return record.event;
	}
	if (typeof record.message === "string" && record.message.length > 0) {
		return record.message;
	}
	return "log";
}

function stringifyFields(record: PrettyLogRecord): string {
	const fields: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (reservedFields.has(key) || value === undefined) {
			continue;
		}
		if (key === "message" && typeof record.event !== "string") {
			continue;
		}
		fields.push(`${key}=${stringifyFieldValue(value)}`);
	}
	return fields.join(" ");
}

function stringifyFieldValue(value: unknown): string {
	if (typeof value === "string") {
		return /^[^\s=]+$/.test(value) ? value : JSON.stringify(value);
	}
	if (
		typeof value === "number" || typeof value === "boolean" || value === null
	) {
		return String(value);
	}
	return JSON.stringify(value) ?? String(value);
}

function formatTime(time: unknown, now?: () => Date): string {
	const date = time instanceof Date
		? time
		: typeof time === "string" || typeof time === "number"
		? new Date(time)
		: now?.() ?? new Date();
	if (Number.isNaN(date.getTime())) {
		const fallback = now?.() ?? new Date();
		return fallback.toISOString().slice(11, 23);
	}
	return date.toISOString().slice(11, 23);
}

function formatParts(options: {
	color: boolean;
	component: string;
	fields: string;
	level: DiscordBridgeLogLevel;
	message: string;
	time: string;
}): string {
	const level = options.level.toUpperCase().padEnd(5);
	const coloredLevel = colorize(level, levelColors[options.level], options.color);
	const message = options.fields.length > 0
		? `${options.message} ${options.fields}`
		: options.message;
	return `[${options.time}] ${coloredLevel} ${options.component} ${message}`;
}

function colorize(text: string, color: string, enabled: boolean): string {
	return enabled ? `${color}${text}${resetColor}` : text;
}

function trimTrailingCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

if (import.meta.main) {
	try {
		await runPrettyLogCli(process.argv.slice(2), process.stdin, process.stdout);
	} catch (error) {
		process.stderr.write(
			`pretty-log failed: ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
		process.exitCode = 1;
	}
}
