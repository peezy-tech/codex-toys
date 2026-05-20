import fs from "node:fs";
import path from "node:path";

const workflowReviewLabel = "ci:reviewed-workflow";
const maxChangedFiles = 500;
const maxCommits = 100;
const forbiddenFiles = new Set([
	"bun.lock",
	"bun.lockb",
	"bunfig.toml",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
]);

const eventPath = process.env.GITHUB_EVENT_PATH ?? process.env.FORGEJO_EVENT_PATH;
if (!eventPath) {
	fail("GITHUB_EVENT_PATH/FORGEJO_EVENT_PATH is not set.");
}

const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request;
if (!pullRequest) {
	fail("This policy check only supports pull request events.");
}

const repository = event.repository;
const repoFullName = repository?.full_name;
if (!repoFullName) {
	fail("Pull request event is missing repository.full_name.");
}

const serverUrl = process.env.GITHUB_SERVER_URL ??
	process.env.FORGEJO_SERVER_URL ??
	repository.html_url?.replace(`/${repoFullName}`, "");
if (!serverUrl) {
	fail("Unable to determine Forgejo server URL.");
}

const token = process.env.FORGEJO_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
	fail("FORGEJO_TOKEN/GITHUB_TOKEN is not set.");
}

const [owner, repo] = repoFullName.split("/");
const apiBase = `${serverUrl.replace(/\/$/, "")}/api/v1`;
const prNumber = pullRequest.number;
const labels = new Set((pullRequest.labels ?? []).map((label) => label.name));

const files = await fetchAllPages(
	`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files`,
);
const commits = await fetchAllPages(
	`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/commits`,
);

const failures = [];
const warnings = [];
const filenames = files.map((file) => file.filename).filter(Boolean);

if (pullRequest.base?.ref !== repository.default_branch) {
	failures.push(
		`PR targets ${pullRequest.base?.ref ?? "unknown"}; expected ${repository.default_branch}.`,
	);
}

if (filenames.length > maxChangedFiles) {
	failures.push(`PR changes ${filenames.length} files; limit is ${maxChangedFiles}.`);
}

if (commits.length > maxCommits) {
	failures.push(`PR contains ${commits.length} commits; limit is ${maxCommits}.`);
}

for (const file of files) {
	const filename = file.filename;
	if (forbiddenFiles.has(path.posix.basename(filename)) && file.status !== "deleted") {
		failures.push(`Forbidden package-manager file added or modified: ${filename}.`);
	}
}

const workflowFiles = filenames.filter((filename) => filename.startsWith(".forgejo/workflows/"));
if (workflowFiles.length > 0 && !labels.has(workflowReviewLabel)) {
	failures.push(
		`Workflow changes require maintainer label ${workflowReviewLabel}: ${workflowFiles.join(", ")}.`,
	);
}

for (const filename of filenames) {
	if (
		filename === "pnpm-lock.yaml" ||
		filename.endsWith("/package.json") ||
		filename === "package.json" ||
		filename.startsWith("scripts/") ||
		filename.startsWith(".github/workflows/")
	) {
		warnings.push(`High-impact file changed: ${filename}.`);
	}
}

console.log(`PR #${prNumber}: ${filenames.length} changed files, ${commits.length} commits.`);
console.log(`Head: ${pullRequest.head?.label ?? pullRequest.head?.ref ?? "unknown"}`);
console.log(`Base: ${pullRequest.base?.label ?? pullRequest.base?.ref ?? "unknown"}`);

if (warnings.length > 0) {
	console.log("\nPolicy warnings:");
	for (const warning of warnings) {
		console.log(`- ${warning}`);
	}
}

if (failures.length > 0) {
	console.error("\nPolicy failures:");
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log("\nPR policy check passed.");

async function fetchAllPages(url) {
	const results = [];
	const limit = 50;
	for (let page = 1; page <= 20; page += 1) {
		const pageUrl = new URL(url);
		pageUrl.searchParams.set("limit", String(limit));
		pageUrl.searchParams.set("page", String(page));
		const response = await fetch(pageUrl, {
			headers: {
				Accept: "application/json",
				Authorization: `token ${token}`,
			},
		});
		if (!response.ok) {
			const body = await response.text();
			fail(`Forgejo API request failed: ${response.status} ${response.statusText}\n${body}`);
		}
		const pageItems = await response.json();
		if (!Array.isArray(pageItems)) {
			fail(`Forgejo API returned a non-array response for ${pageUrl}.`);
		}
		results.push(...pageItems);
		if (pageItems.length < limit) {
			return results;
		}
	}
	fail(`Forgejo API pagination exceeded the policy limit for ${url}.`);
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
