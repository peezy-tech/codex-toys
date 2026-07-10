import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	createAgentHarnessBrowserClient,
	type AgentHarnessBrowserProvider,
	type AgentHarnessBrowserRun,
} from "@codex-appkit/http/browser";
import "./styles.css";

const client = createAgentHarnessBrowserClient({ basePath: "/__agent_harness/api" });

function App() {
	const [provider, setProvider] = useState<AgentHarnessBrowserProvider>("codex");
	const [prompt, setPrompt] = useState("Inspect this repository and summarize the next useful action.");
	const [run, setRun] = useState<AgentHarnessBrowserRun | null>(null);
	const [events, setEvents] = useState<unknown[]>([]);
	const [error, setError] = useState<string | null>(null);
	const unsubscribe = useRef<(() => void) | null>(null);

	useEffect(() => () => unsubscribe.current?.(), []);

	async function start() {
		unsubscribe.current?.();
		setEvents([]);
		setError(null);
		try {
			const started = await client.run({ provider, prompt });
			setRun(started);
			unsubscribe.current = client.events(started.id, (event) => {
				setEvents((current) => [...current, event]);
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function interrupt() {
		if (!run) {
			return;
		}
		await client.interrupt(run.id);
	}

	return (
		<main className="shell">
			<header>
				<p className="eyebrow">Local, unattended runner</p>
				<h1>Agent Harness</h1>
				<p>Uses the configured local Codex or Claude Code installation. The Vite server fixes the workspace; this page only selects a provider and prompt.</p>
			</header>
			<section className="runner" aria-label="Start a run">
				<label>
					Provider
					<select value={provider} onChange={(event) => setProvider(event.target.value as AgentHarnessBrowserProvider)}>
						<option value="codex">Codex</option>
						<option value="claude">Claude Code</option>
					</select>
				</label>
				<label>
					Prompt
					<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} />
				</label>
				<div className="actions">
					<button onClick={() => void start()} type="button">Start run</button>
					<button className="secondary" disabled={!run} onClick={() => void interrupt()} type="button">Interrupt</button>
				</div>
				{run ? <p className="run">Run {run.id} · {run.provider} · {run.sessionId}</p> : null}
				{error ? <p className="error">{error}</p> : null}
			</section>
			<section className="events" aria-live="polite">
				<h2>Provider-native events</h2>
				<pre>{events.length ? events.map((event) => JSON.stringify(event)).join("\n") : "Events will appear here after a run starts."}</pre>
			</section>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
