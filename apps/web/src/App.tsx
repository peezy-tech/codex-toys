import { Button } from "@workspace/ui/components/button";
import {
	AlertCircle,
	Copy,
	ExternalLink,
	KeyRound,
	Loader2,
	LogOut,
	Plug,
	RefreshCw,
	Send,
	Square,
	TerminalSquare,
	Unplug,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
	type ReactNode,
} from "react";

import {
	JsonRpcError,
	createCodexAuthClient,
	type CodexAuthClient,
	type CodexAuthState,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type v2,
} from "@peezy.tech/codex-flows/browser";
import {
	CodexWorkspaceBackendClient,
	type WorkspaceBackendEvent,
} from "@peezy.tech/codex-flows/workspace-backend";

import { ThemeProvider } from "./components/theme-provider.tsx";
import { workspaceBackendStorageKey, initialWorkspaceBackendWsUrl } from "./workspace-backend-url.ts";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

type EventLogEntry = {
	id: string;
	at: string;
	kind: "notification" | "request" | "error" | "control";
	title: string;
	body?: string;
};

export function App() {
	return (
		<ThemeProvider>
			<BareCodexApp />
		</ThemeProvider>
	);
}

function BareCodexApp() {
	const clientRef = useRef<CodexWorkspaceBackendClient | null>(null);
	const authRef = useRef<CodexAuthClient | null>(null);
	const [wsUrl, setWsUrl] = useState(() =>
		initialWorkspaceBackendWsUrl({
			envUrl: import.meta.env.VITE_CODEX_WORKSPACE_BACKEND_WS_URL,
			location: window.location,
			storage: window.localStorage,
		})
	);
	const [connectedUrl, setConnectedUrl] = useState<string>();
	const [status, setStatus] = useState<ConnectionStatus>("disconnected");
	const [error, setError] = useState<string>();
	const [threads, setThreads] = useState<v2.Thread[]>([]);
	const [selectedThreadId, setSelectedThreadId] = useState<string>();
	const [selectedThread, setSelectedThread] = useState<v2.Thread>();
	const [authState, setAuthState] = useState<CodexAuthState>();
	const [prompt, setPrompt] = useState("");
	const [cwd, setCwd] = useState("");
	const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
	const [busyAction, setBusyAction] = useState<string>();

	const appendEvent = useCallback((entry: Omit<EventLogEntry, "id" | "at">) => {
		setEventLog((current) =>
			[
				{
					id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
					at: new Date().toISOString(),
					...entry,
				},
				...current,
			].slice(0, 80),
		);
	}, []);

	const readThread = useCallback(
		async (threadId: string, client = clientRef.current) => {
			if (!client) {
				return;
			}
			const response = await client.readThread({ threadId, includeTurns: true });
			setSelectedThread(response.thread);
		},
		[],
	);

	const refreshThreads = useCallback(
		async (client = clientRef.current) => {
			if (!client) {
				return;
			}
			const response = await client.listThreads({
				limit: 60,
				sortKey: "updated_at",
				sortDirection: "desc",
				archived: false,
				sourceKinds: [],
				useStateDbOnly: false,
			});
			setThreads(response.data);
			const nextSelected =
				selectedThreadId ??
				response.data.find((thread) => thread.status.type !== "notLoaded")?.id ??
				response.data[0]?.id;
			if (nextSelected) {
				setSelectedThreadId(nextSelected);
				await readThread(nextSelected, client);
			}
		},
		[readThread, selectedThreadId],
	);

	const refreshAuthState = useCallback(async (auth = authRef.current) => {
		if (!auth) {
			return;
		}
		try {
			setAuthState(await auth.getState());
		} catch {
			setAuthState(undefined);
		}
	}, []);

	const refreshCurrent = useCallback(async () => {
		const client = clientRef.current;
		if (!client) {
			return;
		}
		setBusyAction("refresh");
		try {
			await Promise.all([
				refreshThreads(client),
				refreshAuthState(),
				selectedThreadId ? readThread(selectedThreadId, client) : undefined,
			]);
		} catch (refreshError) {
			setError(errorMessage(refreshError));
		} finally {
			setBusyAction(undefined);
		}
	}, [readThread, refreshAuthState, refreshThreads, selectedThreadId]);

	const handleNotification = useCallback(
		(message: JsonRpcNotification) => {
			appendEvent({
				kind: "notification",
				title: message.method,
				body: previewNotificationParams(message),
			});
			if (
				message.method === "account/updated" ||
				message.method === "account/login/completed"
			) {
				void refreshAuthState().catch((refreshError) =>
					setError(errorMessage(refreshError)),
				);
			}
			const threadId = notificationThreadId(message);
			if (threadId) {
				if (!selectedThreadId || selectedThreadId === threadId) {
					setSelectedThreadId(threadId);
					void readThread(threadId).catch((readError) =>
						setError(errorMessage(readError)),
					);
				}
				void refreshThreads().catch((refreshError) =>
					setError(errorMessage(refreshError)),
				);
			}
		},
		[
			appendEvent,
			readThread,
			refreshAuthState,
			refreshThreads,
			selectedThreadId,
		],
	);

	const connect = useCallback(async () => {
		const url = wsUrl.trim();
		if (!url) {
			setError("WebSocket URL is required");
			setStatus("error");
			return;
		}

		clientRef.current?.close();
		const client = new CodexWorkspaceBackendClient({
			webSocketTransportOptions: { url, requestTimeoutMs: 90_000 },
			clientName: "bare-web",
			clientTitle: "Codex Bare Web",
			clientVersion: "0.1.0",
		});
		clientRef.current = client;
		const auth = createCodexAuthClient(client);
		authRef.current = auth;
		client.on("notification", handleNotification);
		client.on("request", (message: JsonRpcRequest) => {
			appendEvent({
				kind: "request",
				title: message.method,
				body: previewJson(message.params, 900),
			});
		});
		client.on("workspaceBackendEvent", (event: WorkspaceBackendEvent) => {
			appendEvent({
				kind: "control",
				title: `workspace backend ${event.type}`,
				body: previewJson(event, 900),
			});
		});
		client.on("error", (eventError: unknown) => {
			appendEvent({
				kind: "error",
				title: "workspace backend transport error",
				body: errorMessage(eventError),
			});
			setError(errorMessage(eventError));
			setStatus("error");
		});
		client.on("close", (code: number, reason: string) => {
			appendEvent({
				kind: "control",
				title: "closed",
				body: [code, reason].filter(Boolean).join(" "),
			});
			if (clientRef.current === client) {
				setConnectedUrl(undefined);
				setStatus("disconnected");
			}
		});

		setStatus("connecting");
		setError(undefined);
		try {
			await client.connect();
			window.localStorage.setItem(workspaceBackendStorageKey, url);
			setConnectedUrl(url);
			setStatus("connected");
			appendEvent({ kind: "control", title: "connected", body: url });
			await Promise.all([refreshThreads(client), refreshAuthState(auth)]);
		} catch (connectError) {
			if (clientRef.current === client) {
				clientRef.current = null;
				setConnectedUrl(undefined);
				setStatus("error");
			}
			client.close();
			setError(errorMessage(connectError));
		}
	}, [
		appendEvent,
		handleNotification,
		refreshAuthState,
		refreshThreads,
		wsUrl,
	]);

	const disconnect = useCallback(() => {
		clientRef.current?.close();
		clientRef.current = null;
		authRef.current = null;
		setConnectedUrl(undefined);
		setStatus("disconnected");
		setAuthState(undefined);
		appendEvent({ kind: "control", title: "disconnected" });
	}, [appendEvent]);

	useEffect(() => () => clientRef.current?.close(), []);

	const selectThread = async (threadId: string) => {
		setSelectedThreadId(threadId);
		setBusyAction("read");
		try {
			await readThread(threadId);
		} catch (readError) {
			setError(errorMessage(readError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const sendPrompt = async (event: FormEvent) => {
		event.preventDefault();
		const client = clientRef.current;
		const text = prompt.trim();
		if (!client || !text) {
			return;
		}

		setBusyAction("send");
		setError(undefined);
		try {
			let threadId = selectedThreadId;
			if (!threadId) {
				const started = await client.startThread({
					cwd: optionalText(cwd),
					experimentalRawEvents: false,
					persistExtendedHistory: false,
				});
				threadId = started.thread.id;
				setSelectedThreadId(threadId);
				setSelectedThread(started.thread);
			}

			await client.startTurn({
				threadId,
				input: [{ type: "text", text, text_elements: [] }],
				cwd: optionalText(cwd),
			});
			setPrompt("");
			await Promise.all([refreshThreads(client), readThread(threadId, client)]);
		} catch (sendError) {
			setError(errorMessage(sendError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const interruptTurn = async () => {
		const client = clientRef.current;
		const turn = activeTurn(selectedThread);
		if (!client || !selectedThreadId || !turn) {
			return;
		}
		setBusyAction("interrupt");
		try {
			await client.interruptTurn({ threadId: selectedThreadId, turnId: turn.id });
			await readThread(selectedThreadId, client);
		} catch (interruptError) {
			setError(errorMessage(interruptError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const copyThreadId = async () => {
		if (selectedThreadId && navigator.clipboard) {
			await navigator.clipboard.writeText(selectedThreadId);
		}
	};

	const startChatGptLogin = async () => {
		const auth = authRef.current;
		if (!auth) {
			return;
		}
		setBusyAction("auth");
		setError(undefined);
		try {
			const login = await auth.startChatGptLogin();
			window.open(login.authUrl, "_blank", "noopener,noreferrer");
			setAuthState({
				status: "loginPending",
				method: "chatgpt",
				loginId: login.loginId,
				authMode: null,
				planType: null,
				usage: null,
			});
			appendEvent({
				kind: "control",
				title: "chatgpt login started",
				body: login.loginId,
			});
		} catch (authError) {
			setError(errorMessage(authError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const startDeviceCodeLogin = async () => {
		const auth = authRef.current;
		if (!auth) {
			return;
		}
		setBusyAction("auth");
		setError(undefined);
		try {
			const login = await auth.startDeviceCodeLogin();
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(login.userCode);
			}
			window.open(login.verificationUrl, "_blank", "noopener,noreferrer");
			setAuthState({
				status: "loginPending",
				method: "chatgptDeviceCode",
				loginId: login.loginId,
				authMode: null,
				planType: null,
				usage: null,
			});
			appendEvent({
				kind: "control",
				title: "device login started",
				body: `${login.userCode} / ${login.loginId}`,
			});
		} catch (authError) {
			setError(errorMessage(authError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const loginWithApiKey = async () => {
		const auth = authRef.current;
		const apiKey = window.prompt("OpenAI API key");
		if (!auth || !apiKey?.trim()) {
			return;
		}
		setBusyAction("auth");
		setError(undefined);
		try {
			await auth.loginWithApiKey(apiKey.trim());
			await refreshAuthState(auth);
			appendEvent({ kind: "control", title: "api key login completed" });
		} catch (authError) {
			setError(errorMessage(authError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const loginWithChatGptTokens = async () => {
		const auth = authRef.current;
		const accessToken = window.prompt("ChatGPT access token");
		if (!auth || !accessToken?.trim()) {
			return;
		}
		const chatgptAccountId = window.prompt("ChatGPT account/workspace id");
		if (!chatgptAccountId?.trim()) {
			return;
		}
		const chatgptPlanType = window.prompt("Plan type (optional)")?.trim() || null;
		setBusyAction("auth");
		setError(undefined);
		try {
			await auth.loginWithChatGptTokens({
				accessToken: accessToken.trim(),
				chatgptAccountId: chatgptAccountId.trim(),
				chatgptPlanType,
			});
			await refreshAuthState(auth);
			appendEvent({ kind: "control", title: "token login completed" });
		} catch (authError) {
			setError(errorMessage(authError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const logout = async () => {
		const auth = authRef.current;
		if (!auth) {
			return;
		}
		setBusyAction("auth");
		setError(undefined);
		try {
			await auth.logout();
			await refreshAuthState(auth);
			appendEvent({ kind: "control", title: "logged out" });
		} catch (authError) {
			setError(errorMessage(authError));
		} finally {
			setBusyAction(undefined);
		}
	};

	const selectedItems = useMemo(
		() => selectedThread?.turns.flatMap((turn) => turn.items) ?? [],
		[selectedThread],
	);
	const runningTurn = activeTurn(selectedThread);
	const connected = status === "connected";

	return (
		<div className="min-h-screen bg-background text-foreground">
			<header className="border-b border-border bg-background/95">
				<div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-4 py-3 md:flex-row md:items-center">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<TerminalSquare className="size-5 text-primary" />
							<h1 className="truncate text-base font-semibold">Codex Bare</h1>
						</div>
						<p className="truncate text-xs text-muted-foreground">
							{connectedUrl ?? "No workspace backend connection"}
						</p>
					</div>
					<form
						className="grid gap-2 md:flex md:min-w-[620px] md:items-center"
						onSubmit={(event) => {
							event.preventDefault();
							void connect();
						}}
					>
						<input
							className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:flex-1"
							onChange={(event) => setWsUrl(event.target.value)}
							placeholder="ws://127.0.0.1:3586"
							value={wsUrl}
						/>
						<div className="flex gap-2">
							<Button
								className="flex-1 md:flex-none"
								disabled={status === "connecting"}
								size="sm"
								type="submit"
							>
								{status === "connecting" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Plug className="size-4" />
								)}
								Connect
							</Button>
							<Button
								disabled={!clientRef.current}
								onClick={disconnect}
								size="sm"
								type="button"
								variant="outline"
							>
								<Unplug className="size-4" />
								Disconnect
							</Button>
						</div>
					</form>
				</div>
			</header>

			<main className="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 lg:grid-cols-[320px_minmax(0,1fr)_340px]">
				<aside className="space-y-4">
					<Panel
						action={
							<Button
								disabled={!connected || busyAction === "refresh"}
								onClick={() => void refreshCurrent()}
								size="icon-sm"
								title="Refresh"
								variant="ghost"
							>
								<RefreshCw
									className={
										busyAction === "refresh"
											? "size-4 animate-spin"
											: "size-4"
									}
								/>
							</Button>
						}
						title="Threads"
					>
						<div className="space-y-2">
							<Button
								className="w-full"
								disabled={!connected}
								onClick={() => {
									setSelectedThreadId(undefined);
									setSelectedThread(undefined);
								}}
								size="sm"
								variant={!selectedThreadId ? "default" : "outline"}
							>
								New Thread
							</Button>
							<div className="max-h-[52vh] space-y-1 overflow-auto pr-1">
								{threads.map((thread) => (
									<button
										className={cx(
											"w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
											thread.id === selectedThreadId
												? "border-primary bg-primary text-primary-foreground"
												: "border-border bg-background hover:bg-muted",
										)}
										key={thread.id}
										onClick={() => void selectThread(thread.id)}
										type="button"
									>
										<span className="block truncate font-medium">
											{thread.name || thread.preview || compactId(thread.id)}
										</span>
										<span
											className={cx(
												"mt-1 block truncate text-xs",
												thread.id === selectedThreadId
													? "text-primary-foreground/75"
													: "text-muted-foreground",
											)}
										>
											{threadStatusText(thread.status)} / {compactPath(thread.cwd)}
										</span>
									</button>
								))}
								{connected && threads.length === 0 ? (
									<EmptyState>No threads</EmptyState>
								) : null}
								{!connected ? <EmptyState>Disconnected</EmptyState> : null}
							</div>
						</div>
					</Panel>

					<Panel title="Account">
						<div className="space-y-3">
							<dl className="grid gap-2 text-sm">
								<Meta label="Connection" value={statusLabel(status)} />
								<Meta label="Auth" value={authStatusLabel(authState, connected)} />
								<Meta label="Mode" value={authState?.authMode ?? "none"} />
								<Meta label="Plan" value={authState?.planType ?? "unknown"} />
								<Meta label="Usage" value={usageLabel(authState)} />
							</dl>
							<div className="grid gap-2">
								<Button
									className="w-full"
									disabled={!connected || busyAction === "auth"}
									onClick={() => void startChatGptLogin()}
									size="sm"
									type="button"
								>
									<ExternalLink className="size-4" />
									ChatGPT Login
								</Button>
								<div className="grid grid-cols-3 gap-2">
									<Button
										disabled={!connected || busyAction === "auth"}
										onClick={() => void startDeviceCodeLogin()}
										size="sm"
										type="button"
										variant="outline"
									>
										<KeyRound className="size-4" />
										Device
									</Button>
									<Button
										disabled={!connected || busyAction === "auth"}
										onClick={() => void loginWithApiKey()}
										size="sm"
										type="button"
										variant="outline"
									>
										<KeyRound className="size-4" />
										API Key
									</Button>
									<Button
										disabled={!connected || busyAction === "auth"}
										onClick={() => void loginWithChatGptTokens()}
										size="sm"
										type="button"
										variant="outline"
									>
										<KeyRound className="size-4" />
										Tokens
									</Button>
								</div>
								<Button
									disabled={!connected || busyAction === "auth"}
									onClick={() => void logout()}
									size="sm"
									type="button"
									variant="ghost"
								>
									<LogOut className="size-4" />
									Sign Out
								</Button>
							</div>
						</div>
					</Panel>
				</aside>

				<section className="min-w-0 space-y-4">
					{error ? (
						<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							<AlertCircle className="mt-0.5 size-4 shrink-0" />
							<span className="break-words">{error}</span>
						</div>
					) : null}

					<Panel
						action={
							<div className="flex gap-1">
								<Button
									disabled={!selectedThreadId}
									onClick={() => void copyThreadId()}
									size="icon-sm"
									title="Copy thread id"
									variant="ghost"
								>
									<Copy className="size-4" />
								</Button>
								<Button
									disabled={!runningTurn || busyAction === "interrupt"}
									onClick={() => void interruptTurn()}
									size="icon-sm"
									title="Interrupt"
									variant="ghost"
								>
									<Square className="size-4" />
								</Button>
							</div>
						}
						title={selectedThread?.name || selectedThread?.preview || "Thread"}
					>
						<div className="mb-3 grid gap-2 text-sm md:grid-cols-3">
							<InfoPill
								label="Thread"
								value={compactId(selectedThreadId)}
							/>
							<InfoPill
								label="Status"
								value={
									selectedThread
										? threadStatusText(selectedThread.status)
										: "new"
								}
							/>
							<InfoPill
								label="Cwd"
								value={selectedThread ? compactPath(selectedThread.cwd) : "unset"}
							/>
						</div>
						<div className="max-h-[58vh] min-h-[360px] overflow-auto rounded-md border border-border bg-muted/30 p-3">
							{selectedItems.length > 0 ? (
								<div className="space-y-3">
									{selectedItems.map((item) => (
										<ThreadItemView item={item} key={item.id} />
									))}
								</div>
							) : (
								<div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
									{selectedThreadId ? "No loaded items" : "New thread"}
								</div>
							)}
						</div>
					</Panel>

					<form className="rounded-md border border-border bg-card p-3" onSubmit={sendPrompt}>
						<div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_220px_auto]">
							<textarea
								className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
								disabled={!connected || busyAction === "send"}
								onChange={(event) => setPrompt(event.target.value)}
								placeholder="Send a message to Codex"
								value={prompt}
							/>
							<input
								className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
								disabled={!connected || busyAction === "send"}
								onChange={(event) => setCwd(event.target.value)}
								placeholder="cwd"
								value={cwd}
							/>
							<Button
								className="h-10"
								disabled={!connected || !prompt.trim() || busyAction === "send"}
								type="submit"
							>
								{busyAction === "send" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Send className="size-4" />
								)}
								{selectedThreadId ? "Send" : "Start"}
							</Button>
						</div>
					</form>
				</section>

				<aside>
					<Panel title="Events">
						<div className="max-h-[78vh] space-y-2 overflow-auto pr-1">
							{eventLog.map((event) => (
								<div
									className="rounded-md border border-border bg-background px-3 py-2 text-xs"
									key={event.id}
								>
									<div className="mb-1 flex items-center justify-between gap-2">
										<span className="truncate font-medium">{event.title}</span>
										<span className="shrink-0 text-muted-foreground">
											{formatTime(event.at)}
										</span>
									</div>
									{event.body ? (
										<pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
											{event.body}
										</pre>
									) : null}
								</div>
							))}
							{eventLog.length === 0 ? <EmptyState>No events</EmptyState> : null}
						</div>
					</Panel>
				</aside>
			</main>
		</div>
	);
}

function Panel({
	action,
	children,
	title,
}: {
	action?: ReactNode;
	children: ReactNode;
	title: string;
}) {
	return (
		<section className="rounded-md border border-border bg-card">
			<div className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-3">
				<h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
				{action}
			</div>
			<div className="p-3">{children}</div>
		</section>
	);
}

function ThreadItemView({ item }: { item: v2.ThreadItem }) {
	const { title, body, tone } = itemDisplay(item);
	return (
		<article
			className={cx(
				"rounded-md border bg-background px-3 py-2",
				tone === "user"
					? "border-primary/25"
					: tone === "tool"
						? "border-accent/70"
						: "border-border",
			)}
		>
			<div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
				<span className="truncate font-medium uppercase tracking-normal">{title}</span>
				<span className="shrink-0">{compactId(item.id, 4)}</span>
			</div>
			<pre className="whitespace-pre-wrap break-words text-sm leading-6">{body}</pre>
		</article>
	);
}

function itemDisplay(item: v2.ThreadItem): {
	title: string;
	body: string;
	tone: "assistant" | "tool" | "user";
} {
	switch (item.type) {
		case "userMessage":
			return {
				title: "user",
				body: item.content.map(userInputText).join("\n\n"),
				tone: "user",
			};
		case "agentMessage":
			return { title: "assistant", body: item.text, tone: "assistant" };
		case "reasoning":
			return {
				title: "reasoning",
				body: [...item.summary, ...item.content].join("\n"),
				tone: "assistant",
			};
		case "plan":
			return { title: "plan", body: item.text, tone: "assistant" };
		case "commandExecution":
			return {
				title: `command / ${item.status}`,
				body: [item.command, item.aggregatedOutput].filter(Boolean).join("\n\n"),
				tone: "tool",
			};
		case "fileChange":
			return {
				title: `file change / ${item.status}`,
				body: previewJson(item.changes, 1600),
				tone: "tool",
			};
		case "mcpToolCall":
			return {
				title: `mcp / ${item.server}.${item.tool}`,
				body: previewJson(
					{ status: item.status, arguments: item.arguments, result: item.result, error: item.error },
					1600,
				),
				tone: "tool",
			};
		case "dynamicToolCall":
			return {
				title: `tool / ${[item.namespace, item.tool].filter(Boolean).join(".")}`,
				body: previewJson(
					{
						status: item.status,
						arguments: item.arguments,
						contentItems: item.contentItems,
						success: item.success,
					},
					1600,
				),
				tone: "tool",
			};
		case "webSearch":
			return { title: "web search", body: item.query, tone: "tool" };
		case "imageView":
			return { title: "image", body: item.path, tone: "tool" };
		case "imageGeneration":
			return {
				title: `image generation / ${item.status}`,
				body: [item.revisedPrompt, item.savedPath ?? item.result]
					.filter(Boolean)
					.join("\n\n"),
				tone: "tool",
			};
		default:
			return { title: item.type, body: previewJson(item, 1600), tone: "tool" };
	}
}

function InfoPill({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0 rounded-md border border-border bg-background px-3 py-2">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="truncate text-sm font-medium">{value}</div>
		</div>
	);
}

function Meta({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 truncate">{value}</dd>
		</div>
	);
}

function EmptyState({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
			{children}
		</div>
	);
}

function statusLabel(status: ConnectionStatus) {
	if (status === "connected") {
		return "connected";
	}
	if (status === "connecting") {
		return "connecting";
	}
	if (status === "error") {
		return "error";
	}
	return "disconnected";
}

function activeTurn(thread: v2.Thread | undefined) {
	if (!thread) {
		return null;
	}
	for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
		const turn = thread.turns[index];
		if (turn?.status === "inProgress") {
			return turn;
		}
	}
	return null;
}

function threadStatusText(status: v2.ThreadStatus) {
	return status.type === "active"
		? `active${status.activeFlags.length ? `/${status.activeFlags.join(",")}` : ""}`
		: status.type;
}

function userInputText(input: v2.UserInput) {
	switch (input.type) {
		case "text":
			return input.text;
		case "image":
			return input.url;
		case "localImage":
			return input.path;
		case "skill":
			return `${input.name} ${input.path}`;
		case "mention":
			return `${input.name} ${input.path}`;
		default:
			return previewJson(input, 500);
	}
}

function notificationThreadId(message: JsonRpcNotification) {
	const params = record(message.params);
	const direct = stringValue(params.threadId);
	if (direct) {
		return direct;
	}
	const thread = record(params.thread);
	return stringValue(thread.id);
}

function previewNotificationParams(message: JsonRpcNotification) {
	if (message.method === "account/login/completed") {
		const params = record(message.params);
		return previewJson(
			{
				loginId: stringValue(params.loginId),
				success: params.success === true,
				error: stringValue(params.error),
			},
			900,
		);
	}
	if (message.method === "account/updated") {
		return previewJson({ account: "updated" }, 900);
	}
	return previewJson(message.params, 900);
}

function optionalText(value: string) {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function authStatusLabel(
	authState: CodexAuthState | undefined,
	connected: boolean,
) {
	if (!connected) {
		return "offline";
	}
	if (!authState) {
		return "unknown";
	}
	if (authState.status === "loginPending") {
		return `pending ${authState.method}`;
	}
	if (authState.status === "authenticated") {
		return "signed in";
	}
	if (authState.status === "unauthenticated") {
		return authState.requiresOpenaiAuth ? "sign in required" : "signed out";
	}
	return "error";
}

function usageLabel(authState: CodexAuthState | undefined) {
	if (authState?.status !== "authenticated") {
		return "unknown";
	}
	const primary = authState.usage?.primary;
	if (!primary) {
		return "unknown";
	}
	const percent = Math.round(primary.usedPercent);
	const reset = primary.resetsAt
		? ` / resets ${formatTime(new Date(primary.resetsAt * 1000).toISOString())}`
		: "";
	return `${percent}%${reset}`;
}

function compactPath(path: string | undefined) {
	if (!path) {
		return "none";
	}
	const parts = path.split("/").filter(Boolean);
	return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}

function compactId(value: string | undefined, edge = 6) {
	if (!value) {
		return "none";
	}
	if (value.length <= edge * 2 + 1) {
		return value;
	}
	return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function formatTime(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(new Date(value));
}

function previewJson(value: unknown, maxLength = 900) {
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function errorMessage(error: unknown) {
	if (error instanceof JsonRpcError) {
		return `${error.message} (${error.code})`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown) {
	return typeof value === "string" && value ? value : undefined;
}

function cx(...parts: Array<string | false | null | undefined>) {
	return parts.filter(Boolean).join(" ");
}
