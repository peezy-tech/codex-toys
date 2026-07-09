import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createCodexAppkitBrowserClient } from "@codex-appkit/http/browser";
import "./styles.css";

type ThreadSummary = {
	id: string;
	name?: string | null;
	updatedAt?: number | null;
};

const client = createCodexAppkitBrowserClient({
	basePath: "/__codex_appkit/api",
});

function App() {
	const [threads, setThreads] = useState<ThreadSummary[]>([]);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<ThreadSummary | null>(null);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const response = await client.app.call<{ data: ThreadSummary[] }>(
					"thread/list",
					{ limit: 20, sourceKinds: [] },
				);
				const threads = Array.isArray(response.data) ? response.data : [];
				if (!cancelled) {
					setThreads(threads);
					setSelected(threads[0] ?? null);
					setStatus("ready");
				}
			} catch (loadError) {
				if (!cancelled) {
					setError(loadError instanceof Error ? loadError.message : String(loadError));
					setStatus("error");
				}
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const visibleThreads = useMemo(
		() => threads.slice().sort((left, right) =>
			Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
		),
		[threads],
	);

	return (
		<main className="shell">
			<section className="summary-band">
				<div>
					<p className="eyebrow">Codex AppKit</p>
					<h1>Thread Console</h1>
				</div>
				<div className={`status status-${status}`}>{status}</div>
			</section>

			<section className="workspace">
				<nav className="thread-list" aria-label="Threads">
					{visibleThreads.map((thread) => (
						<button
							className={thread.id === selected?.id ? "thread selected" : "thread"}
							key={thread.id}
							onClick={() => setSelected(thread)}
							type="button"
						>
							<span>{thread.name || "Untitled thread"}</span>
							<small>{thread.id}</small>
						</button>
					))}
					{status === "error" ? <p className="error">{error}</p> : null}
					{status === "ready" && visibleThreads.length === 0 ? (
						<p className="empty">No recent threads returned.</p>
					) : null}
				</nav>

				<article className="detail">
					{selected ? (
						<>
							<p className="eyebrow">Selected Thread</p>
							<h2>{selected.name || "Untitled thread"}</h2>
							<dl>
								<div>
									<dt>ID</dt>
									<dd>{selected.id}</dd>
								</div>
								<div>
									<dt>Updated</dt>
									<dd>{selected.updatedAt ? new Date(selected.updatedAt * 1000).toLocaleString() : "Unknown"}</dd>
								</div>
							</dl>
						</>
					) : (
						<p className="empty">Select a thread to inspect it.</p>
					)}
				</article>
			</section>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
