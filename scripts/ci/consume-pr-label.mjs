import fs from "node:fs";

const labelName = process.argv[2];
if (!labelName) {
	fail("Usage: node scripts/ci/consume-pr-label.mjs <label-name>");
}

const eventPath = process.env.GITHUB_EVENT_PATH ?? process.env.FORGEJO_EVENT_PATH;
if (!eventPath) {
	fail("GITHUB_EVENT_PATH/FORGEJO_EVENT_PATH is not set.");
}

const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request;
const repository = event.repository;
if (!pullRequest || !repository?.full_name) {
	fail("This helper only supports pull request events.");
}

const label = (pullRequest.labels ?? []).find((candidate) => candidate.name === labelName);
if (!label?.id) {
	console.log(`Label ${labelName} is already absent.`);
	process.exit(0);
}

const token = process.env.FORGEJO_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
	fail("FORGEJO_TOKEN/GITHUB_TOKEN is not set.");
}

const serverUrl = process.env.GITHUB_SERVER_URL ??
	process.env.FORGEJO_SERVER_URL ??
	repository.html_url?.replace(`/${repository.full_name}`, "");
if (!serverUrl) {
	fail("Unable to determine Forgejo server URL.");
}

const [owner, repo] = repository.full_name.split("/");
const url = `${serverUrl.replace(/\/$/, "")}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullRequest.number}/labels/${label.id}`;
const response = await fetch(url, {
	method: "DELETE",
	headers: {
		Accept: "application/json",
		Authorization: `token ${token}`,
	},
});

if (!response.ok && response.status !== 404) {
	const body = await response.text();
	fail(`Failed to remove ${labelName}: ${response.status} ${response.statusText}\n${body}`);
}

console.log(`Consumed label ${labelName}.`);

function fail(message) {
	console.error(message);
	process.exit(1);
}
