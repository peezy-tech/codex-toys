import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseJsonText } from "./json.ts";
import { discoverWorkspaceRoot } from "./workspace-autonomy.ts";

export type PackKind = "skill" | "plugin" | "hook";

export type PackSourceDescriptor = {
	input: string;
	type: "local" | "github" | "git";
	root: string;
	url?: string;
	ref?: string;
	commit?: string;
};

export type PackMetadata = {
	name: string;
	version?: string;
	description?: string;
	manifestPath?: string;
};

export type PackCapability = {
	name: string;
	kind: PackKind;
	sourcePath: string;
	sourceRelativePath: string;
	contentHash: string;
	bytes: number;
	pluginHasHooks?: boolean;
};

export type PackInspection = {
	source: PackSourceDescriptor;
	pack: PackMetadata;
	items: PackCapability[];
	warnings: string[];
};

export type PackItemAction = "add" | "unchanged" | "conflict" | "overwrite" | "skip";

export type PackItemPlan = {
	name: string;
	kind: PackKind;
	sourcePath: string;
	sourceRelativePath: string;
	destinationPath: string;
	destinationRelativePath: string;
	contentHash: string;
	bytes: number;
	action: PackItemAction;
	reason?: string;
	backupPath?: string;
};

export type PackAddPlan = {
	apply: boolean;
	workspaceRoot: string;
	source: PackSourceDescriptor;
	pack: PackMetadata;
	items: PackItemPlan[];
	warnings: string[];
	lockPath: string;
	backupRoot?: string;
	marketplaceBackupPath?: string;
};

export type PackLock = {
	version: 1;
	items: PackLockItem[];
};

export type PackLockItem = {
	name: string;
	kind: PackKind;
	source: Omit<PackSourceDescriptor, "root">;
	sourcePath: string;
	destinationPath: string;
	contentHash: string;
	installedAt: string;
};

export type PackDoctorResult = {
	workspaceRoot: string;
	lockPath: string;
	lockExists: boolean;
	installedItems: number;
	missingDestinations: PackLockItem[];
	changedDestinations: PackChangedDestination[];
	marketplace: JsonFileCheck;
	hooks: JsonFileCheck;
	errors: string[];
};

export type PackChangedDestination = PackLockItem & {
	actualHash?: string;
	reason?: string;
};

export type JsonFileCheck = {
	path: string;
	exists: boolean;
	valid: boolean;
	error?: string;
};

type ResolvedPackSource = {
	root: string;
	descriptor: PackSourceDescriptor;
	cleanup?: () => Promise<void>;
};

type PathInspection =
	| { kind: "missing" }
	| { kind: "directory" }
	| { kind: "file" }
	| { kind: "other"; description: string };

const lockRelativePath = path.join(".codex", "pack-lock.json");
const marketplaceRelativePath = path.join(".agents", "plugins", "marketplace.json");
const hooksRelativePath = path.join(".codex", "hooks.json");
const hookEventNames = [
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"UserPromptSubmit",
	"Stop",
] as const;

export async function inspectPackSource(options: {
	source: string;
	ref?: string;
}): Promise<PackInspection> {
	return await withResolvedPackSource(options.source, options.ref, async (resolved) =>
		await inspectResolvedPackSource(resolved)
	);
}

export async function planPackAdd(options: {
	source: string;
	ref?: string;
	workspaceRoot?: string;
	apply?: boolean;
	overwrite?: boolean;
	include?: string[];
	exclude?: string[];
}): Promise<PackAddPlan> {
	return await withResolvedPackSource(options.source, options.ref, async (resolved) => {
		const inspection = await inspectResolvedPackSource(resolved);
		return await buildPackAddPlan(inspection, {
			workspaceRoot: options.workspaceRoot,
			apply: options.apply,
			overwrite: options.overwrite,
			include: options.include,
			exclude: options.exclude,
		});
	});
}

export async function applyPackAdd(options: {
	source: string;
	ref?: string;
	workspaceRoot?: string;
	apply?: boolean;
	overwrite?: boolean;
	include?: string[];
	exclude?: string[];
}): Promise<PackAddPlan> {
	return await withResolvedPackSource(options.source, options.ref, async (resolved) => {
		const inspection = await inspectResolvedPackSource(resolved);
		const plan = await buildPackAddPlan(inspection, {
			workspaceRoot: options.workspaceRoot,
			apply: options.apply,
			overwrite: options.overwrite,
			include: options.include,
			exclude: options.exclude,
		});
		if (!options.apply) {
			return plan;
		}
		await applyPlan(plan);
		return plan;
	});
}

export async function collectPackDoctor(options: {
	workspaceRoot?: string;
}): Promise<PackDoctorResult> {
	const workspaceRoot = path.resolve(options.workspaceRoot ?? await discoverWorkspaceRoot());
	const lockPath = path.join(workspaceRoot, lockRelativePath);
	const errors: string[] = [];
	let lock: PackLock = emptyLock();
	let lockExists = false;
	try {
		lockExists = await exists(lockPath);
		if (lockExists) {
			lock = parsePackLock(await readFile(lockPath, "utf8"), lockPath);
		}
	} catch (error) {
		errors.push(errorMessage(error));
	}
	const missingDestinations: PackLockItem[] = [];
	const changedDestinations: PackChangedDestination[] = [];
	for (const item of lock.items) {
		const destinationPath = path.join(workspaceRoot, item.destinationPath);
		const destination = await inspectPath(destinationPath);
		if (destination.kind === "missing") {
			missingDestinations.push(item);
			continue;
		}
		if (destination.kind !== "directory") {
			changedDestinations.push({
				...item,
				reason: `destination is ${pathInspectionLabel(destination)}`,
			});
			continue;
		}
		try {
			const actual = await hashDirectory(destinationPath);
			if (actual.hash !== item.contentHash) {
				changedDestinations.push({
					...item,
					actualHash: actual.hash,
					reason: "content hash differs",
				});
			}
		} catch (error) {
			changedDestinations.push({
				...item,
				reason: `failed to hash destination: ${errorMessage(error)}`,
			});
		}
	}
	return {
		workspaceRoot,
		lockPath,
		lockExists,
		installedItems: lock.items.length,
		missingDestinations,
		changedDestinations,
		marketplace: await checkJsonFile(path.join(workspaceRoot, marketplaceRelativePath)),
		hooks: await checkJsonFile(path.join(workspaceRoot, hooksRelativePath)),
		errors,
	};
}

export async function listInstalledPacks(options: {
	workspaceRoot?: string;
}): Promise<{ workspaceRoot: string; lockPath: string; items: PackLockItem[] }> {
	const workspaceRoot = path.resolve(options.workspaceRoot ?? await discoverWorkspaceRoot());
	const lockPath = path.join(workspaceRoot, lockRelativePath);
	return {
		workspaceRoot,
		lockPath,
		items: (await readPackLock(workspaceRoot)).items,
	};
}

export function formatPackInspection(inspection: PackInspection): string {
	const lines = [
		`source                ${inspection.source.input}`,
		`source type           ${inspection.source.type}`,
		`root                  ${inspection.source.root}`,
		`pack                  ${packLabel(inspection.pack)}`,
		`items                 ${inspection.items.length}`,
	];
	if (inspection.pack.description) {
		lines.push(`description           ${inspection.pack.description}`);
	}
	for (const item of inspection.items) {
		lines.push(`${item.kind.padEnd(21)} ${item.name} (${item.sourceRelativePath})`);
	}
	for (const warning of inspection.warnings) {
		lines.push(`warning               ${warning}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatPackAddPlan(plan: PackAddPlan): string {
	const counts = countPlanActions(plan.items);
	const lines = [
		`mode                  ${plan.apply ? "apply" : "dry-run"}`,
		`workspace             ${plan.workspaceRoot}`,
		`source                ${plan.source.input}`,
		`pack                  ${packLabel(plan.pack)}`,
		`planned               ${counts.add + counts.overwrite}`,
		`unchanged             ${counts.unchanged}`,
		`conflicts             ${counts.conflict}`,
		`skipped               ${counts.skip}`,
	];
	for (const item of plan.items) {
		const target = item.action === "skip"
			? item.sourceRelativePath
			: item.destinationRelativePath;
		const suffix = item.reason ? ` (${item.reason})` : "";
		lines.push(`${item.action.padEnd(21)} ${item.kind}/${item.name} -> ${target}${suffix}`);
	}
	for (const warning of plan.warnings) {
		lines.push(`warning               ${warning}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatPackDoctor(result: PackDoctorResult): string {
	const lines = [
		`workspace             ${result.workspaceRoot}`,
		`lock                  ${result.lockExists ? result.lockPath : "missing"}`,
		`installed items       ${result.installedItems}`,
		`missing destinations  ${result.missingDestinations.length}`,
		`changed destinations  ${result.changedDestinations.length}`,
		`marketplace           ${jsonCheckLabel(result.marketplace)}`,
		`hooks                 ${jsonCheckLabel(result.hooks)}`,
	];
	for (const item of result.missingDestinations) {
		lines.push(`missing               ${item.kind}/${item.name} -> ${item.destinationPath}`);
	}
	for (const item of result.changedDestinations) {
		const suffix = item.reason ? ` (${item.reason})` : "";
		lines.push(`changed               ${item.kind}/${item.name} -> ${item.destinationPath}${suffix}`);
	}
	for (const error of result.errors) {
		lines.push(`error                 ${error}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatPackList(result: {
	workspaceRoot: string;
	lockPath: string;
	items: PackLockItem[];
}): string {
	const lines = [
		`workspace             ${result.workspaceRoot}`,
		`lock                  ${result.lockPath}`,
		`installed items       ${result.items.length}`,
	];
	for (const item of result.items) {
		lines.push(`${item.kind.padEnd(21)} ${item.name} -> ${item.destinationPath}`);
	}
	return `${lines.join("\n")}\n`;
}

async function inspectResolvedPackSource(
	resolved: ResolvedPackSource,
): Promise<PackInspection> {
	const discovered = await discoverPack(resolved.root);
	return {
		source: resolved.descriptor,
		...discovered,
	};
}

async function buildPackAddPlan(
	inspection: PackInspection,
	options: {
		workspaceRoot?: string;
		apply?: boolean;
		overwrite?: boolean;
		include?: string[];
		exclude?: string[];
	},
): Promise<PackAddPlan> {
	const workspaceRoot = path.resolve(options.workspaceRoot ?? await discoverWorkspaceRoot());
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupRoot = path.join(workspaceRoot, ".codex", "pack-backups", timestamp);
	const include = new Set(options.include ?? []);
	const exclude = new Set(options.exclude ?? []);
	const items: PackItemPlan[] = [];
	const warnings = [...inspection.warnings];
	const lock = await readPackLock(workspaceRoot);
	const selectedPlugins = inspection.items.filter((item) =>
		item.kind === "plugin" && !selectionReason(item, include, exclude)
	);
	const marketplaceConflicts = await collectMarketplacePluginConflicts(workspaceRoot, selectedPlugins, lock);
	for (const item of inspection.items) {
		const selection = selectionReason(item, include, exclude);
		const destinationPath = destinationForItem(workspaceRoot, item);
		const destinationRelativePath = toPosix(path.relative(workspaceRoot, destinationPath));
		if (selection) {
			items.push({
				...planBase(item, destinationPath, destinationRelativePath),
				action: "skip",
				reason: selection,
			});
			continue;
		}
		const marketplaceConflictReason = item.kind === "plugin"
			? marketplaceConflicts.get(item.name)
			: undefined;
		if (marketplaceConflictReason && !options.overwrite) {
			items.push({
				...planBase(item, destinationPath, destinationRelativePath),
				action: "conflict",
				reason: marketplaceConflictReason,
			});
			continue;
		}
		const destination = await inspectPath(destinationPath);
		if (destination.kind === "missing") {
			items.push({
				...planBase(item, destinationPath, destinationRelativePath),
				action: "add",
			});
			continue;
		}
		if (destination.kind !== "directory") {
			if (options.overwrite) {
				items.push({
					...planBase(item, destinationPath, destinationRelativePath),
					action: "overwrite",
					backupPath: path.join(backupRoot, destinationRelativePath),
				});
			} else {
				items.push({
					...planBase(item, destinationPath, destinationRelativePath),
					action: "conflict",
					reason: `destination is ${pathInspectionLabel(destination)}; rerun with --overwrite to replace it`,
				});
			}
			continue;
		}
		const destinationHash = await hashDirectory(destinationPath);
		if (destinationHash.hash === item.contentHash) {
			items.push({
				...planBase(item, destinationPath, destinationRelativePath),
				action: "unchanged",
			});
			continue;
		}
		if (options.overwrite) {
			items.push({
				...planBase(item, destinationPath, destinationRelativePath),
				action: "overwrite",
				backupPath: path.join(backupRoot, destinationRelativePath),
			});
		} else {
			items.push({
				...planBase(item, destinationPath, destinationRelativePath),
				action: "conflict",
				reason: "destination differs; rerun with --overwrite to replace it",
			});
		}
	}
	for (const item of inspection.items) {
		if (item.kind === "plugin" && item.pluginHasHooks && isIncludedInPlan(items, item)) {
			warnings.push(
				`Plugin ${item.name} includes plugin-bundled hooks; enable [features].plugin_hooks = true to run them.`,
			);
		}
	}
	if (items.some((item) => item.kind === "hook" && item.action !== "skip")) {
		warnings.push("Direct hook packs update .codex/hooks.json; enable [features].hooks = true to run them.");
	}
	return {
		apply: options.apply ?? false,
		workspaceRoot,
		source: inspection.source,
		pack: inspection.pack,
		items,
		warnings,
		lockPath: path.join(workspaceRoot, lockRelativePath),
		...(items.some((item) => item.action === "overwrite") ? { backupRoot } : {}),
		...(options.overwrite && marketplaceConflicts.size > 0
			? { marketplaceBackupPath: path.join(backupRoot, marketplaceRelativePath) }
			: {}),
	};
}

function planBase(
	item: PackCapability,
	destinationPath: string,
	destinationRelativePath: string,
): Omit<PackItemPlan, "action" | "reason" | "backupPath"> {
	return {
		name: item.name,
		kind: item.kind,
		sourcePath: item.sourcePath,
		sourceRelativePath: item.sourceRelativePath,
		destinationPath,
		destinationRelativePath,
		contentHash: item.contentHash,
		bytes: item.bytes,
	};
}

async function applyPlan(plan: PackAddPlan): Promise<void> {
	const installableItems = plan.items.filter((item) =>
		item.action === "add" || item.action === "overwrite" || item.action === "unchanged"
	);
	for (const item of installableItems) {
		if (item.action === "unchanged") {
			continue;
		}
		await mkdir(path.dirname(item.destinationPath), { recursive: true });
		if (item.action === "overwrite") {
			if (!item.backupPath) {
				throw new Error(`missing backup path for ${item.kind}/${item.name}`);
			}
			await mkdir(path.dirname(item.backupPath), { recursive: true });
			await cp(item.destinationPath, item.backupPath, { recursive: true, force: true });
			await rm(item.destinationPath, { recursive: true, force: true });
		}
		await cp(item.sourcePath, item.destinationPath, { recursive: true, force: true });
	}
	if (installableItems.some((item) => item.kind === "plugin")) {
		await updateMarketplace(plan, installableItems.filter((item) => item.kind === "plugin"));
	}
	if (installableItems.some((item) => item.kind === "hook")) {
		await updateHooksJson(plan, installableItems.filter((item) => item.kind === "hook"));
	}
	await updatePackLock(plan, installableItems);
}

async function updateMarketplace(
	plan: PackAddPlan,
	plugins: PackItemPlan[],
): Promise<void> {
	const marketplacePath = path.join(plan.workspaceRoot, marketplaceRelativePath);
	const marketplace = await readJsonObjectIfExists(marketplacePath);
	const existingPlugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
	const pluginEntries = plugins.map((plugin) => pluginMarketplaceEntry(plugin.name));
	const managedNames = new Set(pluginEntries.map((entry) => entry.name));
	if (plan.marketplaceBackupPath && await exists(marketplacePath)) {
		await mkdir(path.dirname(plan.marketplaceBackupPath), { recursive: true });
		await cp(marketplacePath, plan.marketplaceBackupPath, { force: true });
	}
	marketplace.name = stringValue(marketplace.name) ?? "workspace-packs";
	if (!isRecord(marketplace.interface)) {
		marketplace.interface = { displayName: "Workspace Packs" };
	}
	marketplace.plugins = [
		...existingPlugins.filter((entry) => {
			const plugin = record(entry);
			const name = stringValue(plugin.name);
			return !(name && managedNames.has(name));
		}),
		...pluginEntries,
	];
	await mkdir(path.dirname(marketplacePath), { recursive: true });
	await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
}

function pluginMarketplaceEntry(name: string): Record<string, unknown> {
	return {
		name,
		source: {
			source: "local",
			path: `./plugins/${name}`,
		},
		policy: {
			installation: "AVAILABLE",
			authentication: "ON_INSTALL",
		},
		category: "Productivity",
	};
}

async function updateHooksJson(
	plan: PackAddPlan,
	hookItems: PackItemPlan[],
): Promise<void> {
	const hooksPath = path.join(plan.workspaceRoot, hooksRelativePath);
	const hooksRoot = await readJsonObjectIfExists(hooksPath);
	const hooks = isRecord(hooksRoot.hooks) ? hooksRoot.hooks : {};
	const metadataRoot = isRecord(hooksRoot.codexPack) ? hooksRoot.codexPack : {};
	const metadataHooks = isRecord(metadataRoot.hooks) ? metadataRoot.hooks : {};
	for (const item of hookItems) {
		const sourceHooks = record(await readJsonObject(path.join(item.sourcePath, "hooks.json")));
		const sourceEvents = record(sourceHooks.hooks);
		const previous = record(metadataHooks[item.name]);
		const previousEvents = record(previous.events);
		for (const eventName of hookEventNames) {
			const existingGroups = arrayValue(hooks[eventName]);
			const previousGroups = arrayValue(previousEvents[eventName]);
			const incomingGroups = arrayValue(sourceEvents[eventName]);
			const withoutPrevious = existingGroups.filter((group) =>
				!previousGroups.some((previousGroup) => deepEqual(previousGroup, group))
			);
			hooks[eventName] = appendUniqueGroups(withoutPrevious, incomingGroups);
		}
		metadataHooks[item.name] = {
			kind: "hook",
			destinationPath: item.destinationRelativePath,
			events: pickHookEvents(sourceEvents),
		};
	}
	hooksRoot.hooks = hooks;
	hooksRoot.codexPack = {
		...metadataRoot,
		version: 1,
		hooks: metadataHooks,
	};
	await mkdir(path.dirname(hooksPath), { recursive: true });
	await writeFile(hooksPath, `${JSON.stringify(hooksRoot, null, 2)}\n`);
}

function appendUniqueGroups(existing: unknown[], incoming: unknown[]): unknown[] {
	const result = [...existing];
	for (const group of incoming) {
		if (!result.some((existingGroup) => deepEqual(existingGroup, group))) {
			result.push(group);
		}
	}
	return result;
}

function pickHookEvents(sourceEvents: Record<string, unknown>): Record<string, unknown[]> {
	const events: Record<string, unknown[]> = {};
	for (const eventName of hookEventNames) {
		const groups = arrayValue(sourceEvents[eventName]);
		if (groups.length > 0) {
			events[eventName] = groups;
		}
	}
	return events;
}

async function updatePackLock(
	plan: PackAddPlan,
	installedItems: PackItemPlan[],
): Promise<void> {
	const lock = await readPackLock(plan.workspaceRoot);
	const installedAt = new Date().toISOString();
	const replacements = installedItems.map((item): PackLockItem => ({
		name: item.name,
		kind: item.kind,
		source: sourceForLock(plan.source),
		sourcePath: item.sourceRelativePath,
		destinationPath: item.destinationRelativePath,
		contentHash: item.contentHash,
		installedAt,
	}));
	const replacementKeys = new Set(replacements.map(lockKey));
	lock.items = [
		...lock.items.filter((item) => !replacementKeys.has(lockKey(item))),
		...replacements,
	].sort(compareLockItems);
	await mkdir(path.dirname(plan.lockPath), { recursive: true });
	await writeFile(plan.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function sourceForLock(source: PackSourceDescriptor): Omit<PackSourceDescriptor, "root"> {
	return {
		input: source.input,
		type: source.type,
		...(source.url ? { url: source.url } : {}),
		...(source.ref ? { ref: source.ref } : {}),
		...(source.commit ? { commit: source.commit } : {}),
	};
}

function lockKey(item: Pick<PackLockItem, "kind" | "name">): string {
	return `${item.kind}:${item.name}`;
}

function compareLockItems(left: PackLockItem, right: PackLockItem): number {
	return lockKey(left).localeCompare(lockKey(right));
}

async function discoverPack(root: string): Promise<Omit<PackInspection, "source">> {
	const manifestPath = path.join(root, "codex-pack.toml");
	if (await exists(manifestPath)) {
		return await discoverPackFromManifest(root, manifestPath);
	}
	return await discoverPackByConvention(root);
}

async function discoverPackFromManifest(
	root: string,
	manifestPath: string,
): Promise<Omit<PackInspection, "source">> {
	const warnings: string[] = [];
	const parsed = record(parseToml(await readFile(manifestPath, "utf8")) as unknown);
	const pack = record(parsed.pack);
	const metadata: PackMetadata = {
		name: stringValue(pack.name) ?? path.basename(root),
		...(stringValue(pack.version) ? { version: stringValue(pack.version) } : {}),
		...(stringValue(pack.description) ? { description: stringValue(pack.description) } : {}),
		manifestPath,
	};
	const rawItems = arrayValue(pack.items);
	const items: PackCapability[] = [];
	for (const [index, value] of rawItems.entries()) {
		const raw = record(value);
		const name = stringValue(raw.name);
		const kind = packKind(raw.kind);
		const itemPath = stringValue(raw.path);
		if (!name || !kind || !itemPath) {
			warnings.push(`Skipping codex-pack.toml item ${index}: requires name, kind, and path.`);
			continue;
		}
		const sourcePath = resolvePackRelativePath(root, itemPath, manifestPath);
		const capability = await capabilityFromPath({
			root,
			name,
			kind,
			sourcePath,
			warnings,
		});
		if (capability) {
			items.push(capability);
		}
	}
	return {
		pack: metadata,
		items: dedupeCapabilities(items, warnings),
		warnings,
	};
}

async function discoverPackByConvention(
	root: string,
): Promise<Omit<PackInspection, "source">> {
	const warnings: string[] = [];
	const items = [
		...await discoverSkills(root, warnings),
		...await discoverPlugins(root, warnings),
		...await discoverHooks(root, warnings),
	];
	return {
		pack: { name: path.basename(root) },
		items: dedupeCapabilities(items, warnings),
		warnings,
	};
}

async function discoverSkills(root: string, warnings: string[]): Promise<PackCapability[]> {
	const capabilities: PackCapability[] = [];
	const skillsRoot = path.join(root, "skills");
	for (const file of await walkFiles(skillsRoot)) {
		if (path.basename(file) !== "SKILL.md") {
			continue;
		}
		const sourcePath = path.dirname(file);
		const name = path.basename(sourcePath);
		const capability = await capabilityFromPath({
			root,
			name,
			kind: "skill",
			sourcePath,
			warnings,
		});
		if (capability) {
			capabilities.push(capability);
		}
	}
	return capabilities;
}

async function discoverPlugins(root: string, warnings: string[]): Promise<PackCapability[]> {
	const capabilities: PackCapability[] = [];
	const pluginsRoot = path.join(root, "plugins");
	for (const file of await walkFiles(pluginsRoot)) {
		if (path.basename(file) !== "plugin.json" || path.basename(path.dirname(file)) !== ".codex-plugin") {
			continue;
		}
		const sourcePath = path.dirname(path.dirname(file));
		const manifest = await readJsonObject(file);
		const name = stringValue(record(manifest).name) ?? path.basename(sourcePath);
		const capability = await capabilityFromPath({
			root,
			name,
			kind: "plugin",
			sourcePath,
			warnings,
		});
		if (capability) {
			capabilities.push(capability);
		}
	}
	return capabilities;
}

async function discoverHooks(root: string, warnings: string[]): Promise<PackCapability[]> {
	const capabilities: PackCapability[] = [];
	const hooksRoot = path.join(root, "hooks");
	for (const file of await walkFiles(hooksRoot)) {
		if (path.basename(file) !== "hooks.json") {
			continue;
		}
		const sourcePath = path.dirname(file);
		if (path.resolve(sourcePath) === path.resolve(hooksRoot)) {
			continue;
		}
		const capability = await capabilityFromPath({
			root,
			name: path.basename(sourcePath),
			kind: "hook",
			sourcePath,
			warnings,
		});
		if (capability) {
			capabilities.push(capability);
		}
	}
	return capabilities;
}

async function capabilityFromPath(options: {
	root: string;
	name: string;
	kind: PackKind;
	sourcePath: string;
	warnings: string[];
}): Promise<PackCapability | undefined> {
	if (!safeSegment(options.name)) {
		options.warnings.push(`Skipping ${options.kind} ${options.name}: name is not a safe path segment.`);
		return undefined;
	}
	const expected = expectedFile(options.sourcePath, options.kind);
	if (!await exists(expected)) {
		options.warnings.push(`Skipping ${options.kind} ${options.name}: missing ${path.basename(expected)}.`);
		return undefined;
	}
	const digest = await hashDirectory(options.sourcePath);
	return {
		name: options.name,
		kind: options.kind,
		sourcePath: options.sourcePath,
		sourceRelativePath: toPosix(path.relative(options.root, options.sourcePath)),
		contentHash: digest.hash,
		bytes: digest.bytes,
		...(options.kind === "plugin" && await pluginHasHooks(options.sourcePath)
			? { pluginHasHooks: true }
			: {}),
	};
}

function expectedFile(sourcePath: string, kind: PackKind): string {
	if (kind === "skill") {
		return path.join(sourcePath, "SKILL.md");
	}
	if (kind === "plugin") {
		return path.join(sourcePath, ".codex-plugin", "plugin.json");
	}
	return path.join(sourcePath, "hooks.json");
}

async function pluginHasHooks(pluginRoot: string): Promise<boolean> {
	const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
	try {
		const manifest = record(await readJsonObject(manifestPath));
		if (manifest.hooks !== undefined) {
			return true;
		}
	} catch {
		return false;
	}
	return await exists(path.join(pluginRoot, "hooks", "hooks.json")) ||
		await exists(path.join(pluginRoot, "hooks.json"));
}

function dedupeCapabilities(
	items: PackCapability[],
	warnings: string[],
): PackCapability[] {
	const seen = new Set<string>();
	const result: PackCapability[] = [];
	for (const item of items.sort(compareCapabilities)) {
		const key = `${item.kind}:${item.name}`;
		if (seen.has(key)) {
			warnings.push(`Skipping duplicate ${item.kind} ${item.name}.`);
			continue;
		}
		seen.add(key);
		result.push(item);
	}
	return result;
}

function compareCapabilities(left: PackCapability, right: PackCapability): number {
	return `${left.kind}:${left.name}:${left.sourceRelativePath}`
		.localeCompare(`${right.kind}:${right.name}:${right.sourceRelativePath}`);
}

function destinationForItem(workspaceRoot: string, item: Pick<PackCapability, "kind" | "name">): string {
	if (item.kind === "skill") {
		return path.join(workspaceRoot, ".agents", "skills", item.name);
	}
	if (item.kind === "plugin") {
		return path.join(workspaceRoot, "plugins", item.name);
	}
	return path.join(workspaceRoot, ".codex", "hooks", item.name);
}

async function collectMarketplacePluginConflicts(
	workspaceRoot: string,
	capabilities: PackCapability[],
	lock: PackLock,
): Promise<Map<string, string>> {
	const pluginNames = new Set(capabilities.filter((item) => item.kind === "plugin").map((item) => item.name));
	const conflicts = new Map<string, string>();
	if (pluginNames.size === 0) {
		return conflicts;
	}
	const marketplacePath = path.join(workspaceRoot, marketplaceRelativePath);
	if (!await exists(marketplacePath)) {
		return conflicts;
	}
	const marketplace = await readJsonObjectIfExists(marketplacePath);
	const existingPlugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
	const lockOwnedNames = new Set(lock.items.filter((item) => item.kind === "plugin").map((item) => item.name));
	for (const entry of existingPlugins) {
		const plugin = record(entry);
		const name = stringValue(plugin.name);
		if (!name || !pluginNames.has(name)) {
			continue;
		}
		const sourcePath = stringValue(record(plugin.source).path);
		const expectedPath = `./plugins/${name}`;
		if (sourcePath === expectedPath || lockOwnedNames.has(name)) {
			continue;
		}
		conflicts.set(
			name,
			sourcePath
				? `marketplace already has plugin ${name} from ${sourcePath}; rerun with --overwrite to replace it`
				: `marketplace already has plugin ${name} with an unknown source; rerun with --overwrite to replace it`,
		);
	}
	return conflicts;
}

function selectionReason(
	item: Pick<PackCapability, "kind" | "name">,
	include: Set<string>,
	exclude: Set<string>,
): string | undefined {
	const keys = [item.name, `${item.kind}:${item.name}`];
	if (include.size > 0 && !keys.some((key) => include.has(key))) {
		return "not included";
	}
	if (keys.some((key) => exclude.has(key))) {
		return "excluded";
	}
	return undefined;
}

function isIncludedInPlan(planItems: PackItemPlan[], capability: PackCapability): boolean {
	return planItems.some((item) =>
		item.name === capability.name &&
		item.kind === capability.kind &&
		item.action !== "skip"
	);
}

async function withResolvedPackSource<T>(
	source: string,
	ref: string | undefined,
	callback: (resolved: ResolvedPackSource) => Promise<T>,
): Promise<T> {
	const resolved = await resolvePackSource(source, ref);
	try {
		return await callback(resolved);
	} finally {
		await resolved.cleanup?.();
	}
}

async function resolvePackSource(source: string, ref: string | undefined): Promise<ResolvedPackSource> {
	const localPath = path.resolve(source);
	if (await isDirectory(localPath)) {
		if (ref) {
			throw new Error("--ref is only supported for GitHub shorthand and Git URL pack sources.");
		}
		const commit = await gitCommit(localPath);
		return {
			root: localPath,
			descriptor: {
				input: source,
				type: "local",
				root: localPath,
				...(commit ? { commit } : {}),
			},
		};
	}
	if (githubShorthand(source)) {
		const url = `https://github.com/${source}.git`;
		return await clonePackSource({ input: source, type: "github", url, ref });
	}
	if (gitUrl(source)) {
		return await clonePackSource({ input: source, type: "git", url: source, ref });
	}
	throw new Error(`Pack source is not a local directory, GitHub shorthand, or Git URL: ${source}`);
}

async function clonePackSource(options: {
	input: string;
	type: "github" | "git";
	url: string;
	ref?: string;
}): Promise<ResolvedPackSource> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pack-"));
	const cloneRoot = path.join(tempRoot, "source");
	if (options.ref) {
		await runGit(["init", cloneRoot]);
		await runGit(["-C", cloneRoot, "remote", "add", "origin", options.url]);
		await runGit(["-C", cloneRoot, "fetch", "--depth", "1", "origin", options.ref]);
		await runGit(["-C", cloneRoot, "checkout", "--detach", "FETCH_HEAD"]);
	} else {
		await runGit(["clone", "--depth", "1", options.url, cloneRoot]);
	}
	const commit = await gitCommit(cloneRoot);
	return {
		root: cloneRoot,
		descriptor: {
			input: options.input,
			type: options.type,
			root: cloneRoot,
			url: options.url,
			...(options.ref ? { ref: options.ref } : {}),
			...(commit ? { commit } : {}),
		},
		cleanup: async () => {
			await rm(tempRoot, { recursive: true, force: true });
		},
	};
}

async function gitCommit(root: string): Promise<string | undefined> {
	try {
		const output = await runGit(["-C", root, "rev-parse", "HEAD"]);
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function runGit(args: string[]): Promise<string> {
	const proc = spawn("git", args);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
	}
	return stdout;
}

function githubShorthand(source: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

function gitUrl(source: string): boolean {
	return /^(https?:\/\/|ssh:\/\/|file:\/\/|git@)/.test(source) || source.endsWith(".git");
}

function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		if (!stream) {
			resolve(output);
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			output += chunk;
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
	});
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

async function hashDirectory(root: string): Promise<{ hash: string; bytes: number }> {
	const files = await walkFiles(root);
	const hash = createHash("sha256");
	let bytes = 0;
	for (const file of files) {
		const relative = toPosix(path.relative(root, file));
		const contents = await readFile(file);
		bytes += contents.byteLength;
		hash.update(relative);
		hash.update("\0");
		hash.update(createHash("sha256").update(contents).digest("hex"));
		hash.update("\0");
	}
	return {
		hash: `sha256:${hash.digest("hex")}`,
		bytes,
	};
}

async function walkFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(current: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if (isErrno(error, "ENOENT")) {
				return;
			}
			throw error;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name === ".git") {
				continue;
			}
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	}
	await walk(root);
	return files;
}

async function readPackLock(workspaceRoot: string): Promise<PackLock> {
	const lockPath = path.join(workspaceRoot, lockRelativePath);
	if (!await exists(lockPath)) {
		return emptyLock();
	}
	return parsePackLock(await readFile(lockPath, "utf8"), lockPath);
}

function parsePackLock(text: string, lockPath: string): PackLock {
	try {
			const parsed = record(parseJsonText(text, lockPath));
		const items = arrayValue(parsed.items).map(parsePackLockItem).filter(
			(item): item is PackLockItem => item !== undefined,
		);
		return { version: 1, items };
	} catch (error) {
		throw new Error(`Failed to parse ${lockPath}: ${errorMessage(error)}`);
	}
}

function parsePackLockItem(value: unknown): PackLockItem | undefined {
	const item = record(value);
	const name = stringValue(item.name);
	const kind = packKind(item.kind);
	const source = record(item.source);
	const sourceType = source.type === "local" || source.type === "github" || source.type === "git"
		? source.type
		: undefined;
	const sourceInput = stringValue(source.input);
	const sourcePath = stringValue(item.sourcePath);
	const destinationPath = stringValue(item.destinationPath);
	const contentHash = stringValue(item.contentHash);
	const installedAt = stringValue(item.installedAt);
	if (!name || !kind || !sourceType || !sourceInput || !sourcePath || !destinationPath || !contentHash || !installedAt) {
		return undefined;
	}
	return {
		name,
		kind,
		source: {
			input: sourceInput,
			type: sourceType,
			...(stringValue(source.url) ? { url: stringValue(source.url) } : {}),
			...(stringValue(source.ref) ? { ref: stringValue(source.ref) } : {}),
			...(stringValue(source.commit) ? { commit: stringValue(source.commit) } : {}),
		},
		sourcePath,
		destinationPath,
		contentHash,
		installedAt,
	};
}

function emptyLock(): PackLock {
	return { version: 1, items: [] };
}

async function checkJsonFile(filePath: string): Promise<JsonFileCheck> {
	if (!await exists(filePath)) {
		return { path: filePath, exists: false, valid: false };
	}
	try {
			parseJsonText(await readFile(filePath, "utf8"), filePath);
		return { path: filePath, exists: true, valid: true };
	} catch (error) {
		return {
			path: filePath,
			exists: true,
			valid: false,
			error: errorMessage(error),
		};
	}
}

async function readJsonObjectIfExists(filePath: string): Promise<Record<string, unknown>> {
	if (!await exists(filePath)) {
		return {};
	}
	return record(await readJsonObject(filePath));
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
	try {
			return record(parseJsonText(await readFile(filePath, "utf8"), filePath));
	} catch (error) {
		throw new Error(`Failed to parse JSON at ${filePath}: ${errorMessage(error)}`);
	}
}

function resolvePackRelativePath(root: string, relativePath: string, manifestPath: string): string {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`codex-pack.toml item path must be relative: ${manifestPath}`);
	}
	const resolved = path.resolve(root, relativePath);
	if (!isSubpath(root, resolved)) {
		throw new Error(`codex-pack.toml item path escapes the pack root: ${relativePath}`);
	}
	return resolved;
}

function isSubpath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packKind(value: unknown): PackKind | undefined {
	if (value === "skill" || value === "plugin" || value === "hook") {
		return value;
	}
	return undefined;
}

function safeSegment(value: string): boolean {
	return value.trim().length > 0 &&
		value !== "." &&
		value !== ".." &&
		!value.includes("/") &&
		!value.includes("\\");
}

async function isDirectory(value: string): Promise<boolean> {
	try {
		return (await stat(value)).isDirectory();
	} catch {
		return false;
	}
}

async function inspectPath(value: string): Promise<PathInspection> {
	try {
		const info = await stat(value);
		if (info.isDirectory()) {
			return { kind: "directory" };
		}
		if (info.isFile()) {
			return { kind: "file" };
		}
		return { kind: "other", description: "unsupported path type" };
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return { kind: "missing" };
		}
		throw error;
	}
}

function pathInspectionLabel(value: Exclude<PathInspection, { kind: "missing" | "directory" }>): string {
	if (value.kind === "file") {
		return "a file";
	}
	return value.description;
}

async function exists(value: string): Promise<boolean> {
	try {
		await stat(value);
		return true;
	} catch {
		return false;
	}
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function countPlanActions(items: PackItemPlan[]): Record<PackItemAction, number> {
	const counts: Record<PackItemAction, number> = {
		add: 0,
		unchanged: 0,
		conflict: 0,
		overwrite: 0,
		skip: 0,
	};
	for (const item of items) {
		counts[item.action] += 1;
	}
	return counts;
}

function packLabel(pack: PackMetadata): string {
	return pack.version ? `${pack.name}@${pack.version}` : pack.name;
}

function jsonCheckLabel(check: JsonFileCheck): string {
	if (!check.exists) {
		return "missing";
	}
	return check.valid ? `valid (${check.path})` : `invalid (${check.error ?? "parse failed"})`;
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function deepEqual(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().map((key) =>
			`${JSON.stringify(key)}:${stableStringify(value[key])}`
		).join(",")}}`;
	}
	return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
