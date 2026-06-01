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
import { parseJsonText } from "@codex-toys/bridge/json";
import { discoverWorkbenchRoot } from "@codex-toys/workbench";

export type KitKind = "skill" | "plugin" | "automation";

export type KitSourceDescriptor = {
	input: string;
	type: "local" | "github" | "git";
	root: string;
	url?: string;
	ref?: string;
	commit?: string;
};

export type KitMetadata = {
	name: string;
	version?: string;
	description?: string;
	manifestPath?: string;
};

export type KitCapability = {
	name: string;
	kind: KitKind;
	sourcePath: string;
	sourceRelativePath: string;
	contentHash: string;
	bytes: number;
};

export type KitInspection = {
	source: KitSourceDescriptor;
	kit: KitMetadata;
	items: KitCapability[];
	warnings: string[];
};

export type KitItemAction = "add" | "unchanged" | "conflict" | "overwrite" | "skip";

export type KitItemPlan = {
	name: string;
	kind: KitKind;
	sourcePath: string;
	sourceRelativePath: string;
	destinationPath: string;
	destinationRelativePath: string;
	contentHash: string;
	bytes: number;
	action: KitItemAction;
	reason?: string;
	backupPath?: string;
};

export type KitAddPlan = {
	apply: boolean;
	workbenchRoot: string;
	source: KitSourceDescriptor;
	kit: KitMetadata;
	items: KitItemPlan[];
	warnings: string[];
	lockPath: string;
	backupRoot?: string;
	marketplaceBackupPath?: string;
};

export type KitLock = {
	version: 1;
	items: KitLockItem[];
};

export type KitLockItem = {
	name: string;
	kind: KitKind;
	source: Omit<KitSourceDescriptor, "root">;
	sourcePath: string;
	destinationPath: string;
	contentHash: string;
	installedAt: string;
};

export type KitDoctorResult = {
	workbenchRoot: string;
	lockPath: string;
	lockExists: boolean;
	installedItems: number;
	missingDestinations: KitLockItem[];
	changedDestinations: KitChangedDestination[];
	marketplace: JsonFileCheck;
	errors: string[];
};

export type KitChangedDestination = KitLockItem & {
	actualHash?: string;
	reason?: string;
};

export type JsonFileCheck = {
	path: string;
	exists: boolean;
	valid: boolean;
	error?: string;
};

type ResolvedKitSource = {
	root: string;
	descriptor: KitSourceDescriptor;
	cleanup?: () => Promise<void>;
};

type PathInspection =
	| { kind: "missing" }
	| { kind: "directory" }
	| { kind: "file" }
	| { kind: "other"; description: string };

const lockRelativePath = path.join(".codex", "kit-lock.json");
const marketplaceRelativePath = path.join(".agents", "plugins", "marketplace.json");

export async function inspectKitSource(options: {
	source: string;
	ref?: string;
}): Promise<KitInspection> {
	return await withResolvedKitSource(options.source, options.ref, async (resolved) =>
		await inspectResolvedKitSource(resolved)
	);
}

export async function planKitAdd(options: {
	source: string;
	ref?: string;
	workbenchRoot?: string;
	apply?: boolean;
	overwrite?: boolean;
	include?: string[];
	exclude?: string[];
}): Promise<KitAddPlan> {
	return await withResolvedKitSource(options.source, options.ref, async (resolved) => {
		const inspection = await inspectResolvedKitSource(resolved);
		return await buildKitAddPlan(inspection, {
			workbenchRoot: options.workbenchRoot,
			apply: options.apply,
			overwrite: options.overwrite,
			include: options.include,
			exclude: options.exclude,
		});
	});
}

export async function applyKitAdd(options: {
	source: string;
	ref?: string;
	workbenchRoot?: string;
	apply?: boolean;
	overwrite?: boolean;
	include?: string[];
	exclude?: string[];
}): Promise<KitAddPlan> {
	return await withResolvedKitSource(options.source, options.ref, async (resolved) => {
		const inspection = await inspectResolvedKitSource(resolved);
		const plan = await buildKitAddPlan(inspection, {
			workbenchRoot: options.workbenchRoot,
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

export async function collectKitDoctor(options: {
	workbenchRoot?: string;
}): Promise<KitDoctorResult> {
	const workbenchRoot = path.resolve(options.workbenchRoot ?? await discoverWorkbenchRoot());
	const lockPath = path.join(workbenchRoot, lockRelativePath);
	const errors: string[] = [];
	let lock: KitLock = emptyLock();
	let lockExists = false;
	try {
		lockExists = await exists(lockPath);
		if (lockExists) {
			lock = parseKitLock(await readFile(lockPath, "utf8"), lockPath);
		}
	} catch (error) {
		errors.push(errorMessage(error));
	}
	const missingDestinations: KitLockItem[] = [];
	const changedDestinations: KitChangedDestination[] = [];
	for (const item of lock.items) {
		const destinationPath = path.join(workbenchRoot, item.destinationPath);
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
		workbenchRoot,
		lockPath,
		lockExists,
		installedItems: lock.items.length,
		missingDestinations,
		changedDestinations,
		marketplace: await checkJsonFile(path.join(workbenchRoot, marketplaceRelativePath)),
		errors,
	};
}

export async function listInstalledKits(options: {
	workbenchRoot?: string;
}): Promise<{ workbenchRoot: string; lockPath: string; items: KitLockItem[] }> {
	const workbenchRoot = path.resolve(options.workbenchRoot ?? await discoverWorkbenchRoot());
	const lockPath = path.join(workbenchRoot, lockRelativePath);
	return {
		workbenchRoot,
		lockPath,
		items: (await readKitLock(workbenchRoot)).items,
	};
}

export function formatKitInspection(inspection: KitInspection): string {
	const lines = [
		`source                ${inspection.source.input}`,
		`source type           ${inspection.source.type}`,
		`root                  ${inspection.source.root}`,
		`kit                  ${kitLabel(inspection.kit)}`,
		`items                 ${inspection.items.length}`,
	];
	if (inspection.kit.description) {
		lines.push(`description           ${inspection.kit.description}`);
	}
	for (const item of inspection.items) {
		lines.push(`${item.kind.padEnd(21)} ${item.name} (${item.sourceRelativePath})`);
	}
	for (const warning of inspection.warnings) {
		lines.push(`warning               ${warning}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatKitAddPlan(plan: KitAddPlan): string {
	const counts = countPlanActions(plan.items);
	const lines = [
		`mode                  ${plan.apply ? "apply" : "dry-run"}`,
		`workbench             ${plan.workbenchRoot}`,
		`source                ${plan.source.input}`,
		`kit                  ${kitLabel(plan.kit)}`,
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

export function formatKitDoctor(result: KitDoctorResult): string {
	const lines = [
		`workbench             ${result.workbenchRoot}`,
		`lock                  ${result.lockExists ? result.lockPath : "missing"}`,
		`installed items       ${result.installedItems}`,
		`missing destinations  ${result.missingDestinations.length}`,
		`changed destinations  ${result.changedDestinations.length}`,
		`marketplace           ${jsonCheckLabel(result.marketplace)}`,
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

export function formatKitList(result: {
	workbenchRoot: string;
	lockPath: string;
	items: KitLockItem[];
}): string {
	const lines = [
		`workbench             ${result.workbenchRoot}`,
		`lock                  ${result.lockPath}`,
		`installed items       ${result.items.length}`,
	];
	for (const item of result.items) {
		lines.push(`${item.kind.padEnd(21)} ${item.name} -> ${item.destinationPath}`);
	}
	return `${lines.join("\n")}\n`;
}

async function inspectResolvedKitSource(
	resolved: ResolvedKitSource,
): Promise<KitInspection> {
	const discovered = await discoverKit(resolved.root);
	return {
		source: resolved.descriptor,
		...discovered,
	};
}

async function buildKitAddPlan(
	inspection: KitInspection,
	options: {
		workbenchRoot?: string;
		apply?: boolean;
		overwrite?: boolean;
		include?: string[];
		exclude?: string[];
	},
): Promise<KitAddPlan> {
	const workbenchRoot = path.resolve(options.workbenchRoot ?? await discoverWorkbenchRoot());
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupRoot = path.join(workbenchRoot, ".codex", "kit-backups", timestamp);
	const include = new Set(options.include ?? []);
	const exclude = new Set(options.exclude ?? []);
	const items: KitItemPlan[] = [];
	const warnings = [...inspection.warnings];
	const lock = await readKitLock(workbenchRoot);
	const selectedPlugins = inspection.items.filter((item) =>
		item.kind === "plugin" && !selectionReason(item, include, exclude)
	);
	const marketplaceConflicts = await collectMarketplacePluginConflicts(workbenchRoot, selectedPlugins, lock);
	for (const item of inspection.items) {
		const selection = selectionReason(item, include, exclude);
		const destinationPath = destinationForItem(workbenchRoot, item);
		const destinationRelativePath = toPosix(path.relative(workbenchRoot, destinationPath));
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
	return {
		apply: options.apply ?? false,
		workbenchRoot,
		source: inspection.source,
		kit: inspection.kit,
		items,
		warnings,
		lockPath: path.join(workbenchRoot, lockRelativePath),
		...(items.some((item) => item.action === "overwrite") ? { backupRoot } : {}),
		...(options.overwrite && marketplaceConflicts.size > 0
			? { marketplaceBackupPath: path.join(backupRoot, marketplaceRelativePath) }
			: {}),
	};
}

function planBase(
	item: KitCapability,
	destinationPath: string,
	destinationRelativePath: string,
): Omit<KitItemPlan, "action" | "reason" | "backupPath"> {
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

async function applyPlan(plan: KitAddPlan): Promise<void> {
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
	await updateKitLock(plan, installableItems);
}

async function updateMarketplace(
	plan: KitAddPlan,
	plugins: KitItemPlan[],
): Promise<void> {
	const marketplacePath = path.join(plan.workbenchRoot, marketplaceRelativePath);
	const marketplace = await readJsonObjectIfExists(marketplacePath);
	const existingPlugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
	const pluginEntries = plugins.map((plugin) => pluginMarketplaceEntry(plugin.name));
	const managedNames = new Set(pluginEntries.map((entry) => entry.name));
	if (plan.marketplaceBackupPath && await exists(marketplacePath)) {
		await mkdir(path.dirname(plan.marketplaceBackupPath), { recursive: true });
		await cp(marketplacePath, plan.marketplaceBackupPath, { force: true });
	}
	marketplace.name = stringValue(marketplace.name) ?? "workbench-kits";
	if (!isRecord(marketplace.interface)) {
		marketplace.interface = { displayName: "Workbench Kits" };
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

async function updateKitLock(
	plan: KitAddPlan,
	installedItems: KitItemPlan[],
): Promise<void> {
	const lock = await readKitLock(plan.workbenchRoot);
	const installedAt = new Date().toISOString();
	const replacements = installedItems.map((item): KitLockItem => ({
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

function sourceForLock(source: KitSourceDescriptor): Omit<KitSourceDescriptor, "root"> {
	return {
		input: source.input,
		type: source.type,
		...(source.url ? { url: source.url } : {}),
		...(source.ref ? { ref: source.ref } : {}),
		...(source.commit ? { commit: source.commit } : {}),
	};
}

function lockKey(item: Pick<KitLockItem, "kind" | "name">): string {
	return `${item.kind}:${item.name}`;
}

function compareLockItems(left: KitLockItem, right: KitLockItem): number {
	return lockKey(left).localeCompare(lockKey(right));
}

async function discoverKit(root: string): Promise<Omit<KitInspection, "source">> {
	const manifestPath = path.join(root, "codex-kit.toml");
	if (await exists(manifestPath)) {
		return await discoverKitFromManifest(root, manifestPath);
	}
	return await discoverKitByConvention(root);
}

async function discoverKitFromManifest(
	root: string,
	manifestPath: string,
): Promise<Omit<KitInspection, "source">> {
	const warnings: string[] = [];
	const parsed = record(parseToml(await readFile(manifestPath, "utf8")) as unknown);
	const kit = record(parsed.kit);
	const metadata: KitMetadata = {
		name: stringValue(kit.name) ?? path.basename(root),
		...(stringValue(kit.version) ? { version: stringValue(kit.version) } : {}),
		...(stringValue(kit.description) ? { description: stringValue(kit.description) } : {}),
		manifestPath,
	};
	const rawItems = arrayValue(kit.items);
	const items: KitCapability[] = [];
	for (const [index, value] of rawItems.entries()) {
		const raw = record(value);
		const name = stringValue(raw.name);
		const kind = kitKind(raw.kind);
		const itemPath = stringValue(raw.path);
		if (!name || !kind || !itemPath) {
			warnings.push(`Skipping codex-kit.toml item ${index}: requires name, kind, and path.`);
			continue;
		}
		const sourcePath = resolveKitRelativePath(root, itemPath, manifestPath);
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
		kit: metadata,
		items: dedupeCapabilities(items, warnings),
		warnings,
	};
}

async function discoverKitByConvention(
	root: string,
): Promise<Omit<KitInspection, "source">> {
	const warnings: string[] = [];
	const items = [
		...await discoverSkills(root, warnings),
		...await discoverPlugins(root, warnings),
		...await discoverAutomations(root, warnings),
	];
	return {
		kit: { name: path.basename(root) },
		items: dedupeCapabilities(items, warnings),
		warnings,
	};
}

async function discoverSkills(root: string, warnings: string[]): Promise<KitCapability[]> {
	const capabilities: KitCapability[] = [];
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

async function discoverPlugins(root: string, warnings: string[]): Promise<KitCapability[]> {
	const capabilities: KitCapability[] = [];
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

async function discoverAutomations(root: string, warnings: string[]): Promise<KitCapability[]> {
	const capabilities: KitCapability[] = [];
	const automationsRoot = path.join(root, "automations");
	for (const file of await walkFiles(automationsRoot)) {
		if (path.basename(file) !== "automation.json") {
			continue;
		}
		const sourcePath = path.dirname(file);
		if (path.resolve(sourcePath) === path.resolve(automationsRoot)) {
			continue;
		}
		const capability = await capabilityFromPath({
			root,
			name: path.basename(sourcePath),
			kind: "automation",
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
	kind: KitKind;
	sourcePath: string;
	warnings: string[];
}): Promise<KitCapability | undefined> {
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
	};
}

function expectedFile(sourcePath: string, kind: KitKind): string {
	if (kind === "skill") {
		return path.join(sourcePath, "SKILL.md");
	}
	if (kind === "plugin") {
		return path.join(sourcePath, ".codex-plugin", "plugin.json");
	}
	if (kind === "automation") {
		return path.join(sourcePath, "automation.json");
	}
	throw new Error(`Unsupported kit kind: ${kind}`);
}

function dedupeCapabilities(
	items: KitCapability[],
	warnings: string[],
): KitCapability[] {
	const seen = new Set<string>();
	const result: KitCapability[] = [];
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

function compareCapabilities(left: KitCapability, right: KitCapability): number {
	return `${left.kind}:${left.name}:${left.sourceRelativePath}`
		.localeCompare(`${right.kind}:${right.name}:${right.sourceRelativePath}`);
}

function destinationForItem(workbenchRoot: string, item: Pick<KitCapability, "kind" | "name">): string {
	if (item.kind === "skill") {
		return path.join(workbenchRoot, ".agents", "skills", item.name);
	}
	if (item.kind === "plugin") {
		return path.join(workbenchRoot, "plugins", item.name);
	}
	if (item.kind === "automation") {
		return path.join(workbenchRoot, ".codex", "automations", item.name);
	}
	throw new Error(`Unsupported kit kind: ${item.kind}`);
}

async function collectMarketplacePluginConflicts(
	workbenchRoot: string,
	capabilities: KitCapability[],
	lock: KitLock,
): Promise<Map<string, string>> {
	const pluginNames = new Set(capabilities.filter((item) => item.kind === "plugin").map((item) => item.name));
	const conflicts = new Map<string, string>();
	if (pluginNames.size === 0) {
		return conflicts;
	}
	const marketplacePath = path.join(workbenchRoot, marketplaceRelativePath);
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
	item: Pick<KitCapability, "kind" | "name">,
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

async function withResolvedKitSource<T>(
	source: string,
	ref: string | undefined,
	callback: (resolved: ResolvedKitSource) => Promise<T>,
): Promise<T> {
	const resolved = await resolveKitSource(source, ref);
	try {
		return await callback(resolved);
	} finally {
		await resolved.cleanup?.();
	}
}

async function resolveKitSource(source: string, ref: string | undefined): Promise<ResolvedKitSource> {
	const localPath = path.resolve(source);
	if (await isDirectory(localPath)) {
		if (ref) {
			throw new Error("--ref is only supported for GitHub shorthand and Git URL kit sources.");
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
		return await cloneKitSource({ input: source, type: "github", url, ref });
	}
	if (gitUrl(source)) {
		return await cloneKitSource({ input: source, type: "git", url: source, ref });
	}
	throw new Error(`Kit source is not a local directory, GitHub shorthand, or Git URL: ${source}`);
}

async function cloneKitSource(options: {
	input: string;
	type: "github" | "git";
	url: string;
	ref?: string;
}): Promise<ResolvedKitSource> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-kit-"));
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

async function readKitLock(workbenchRoot: string): Promise<KitLock> {
	const lockPath = path.join(workbenchRoot, lockRelativePath);
	if (!await exists(lockPath)) {
		return emptyLock();
	}
	return parseKitLock(await readFile(lockPath, "utf8"), lockPath);
}

function parseKitLock(text: string, lockPath: string): KitLock {
	try {
			const parsed = record(parseJsonText(text, lockPath));
		const items = arrayValue(parsed.items).map(parseKitLockItem).filter(
			(item): item is KitLockItem => item !== undefined,
		);
		return { version: 1, items };
	} catch (error) {
		throw new Error(`Failed to parse ${lockPath}: ${errorMessage(error)}`);
	}
}

function parseKitLockItem(value: unknown): KitLockItem | undefined {
	const item = record(value);
	const name = stringValue(item.name);
	const kind = kitKind(item.kind);
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

function emptyLock(): KitLock {
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

function resolveKitRelativePath(root: string, relativePath: string, manifestPath: string): string {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`codex-kit.toml item path must be relative: ${manifestPath}`);
	}
	const resolved = path.resolve(root, relativePath);
	if (!isSubpath(root, resolved)) {
		throw new Error(`codex-kit.toml item path escapes the kit root: ${relativePath}`);
	}
	return resolved;
}

function isSubpath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function kitKind(value: unknown): KitKind | undefined {
	if (value === "skill" || value === "plugin" || value === "automation") {
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

function countPlanActions(items: KitItemPlan[]): Record<KitItemAction, number> {
	const counts: Record<KitItemAction, number> = {
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

function kitLabel(kit: KitMetadata): string {
	return kit.version ? `${kit.name}@${kit.version}` : kit.name;
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
