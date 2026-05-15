import type { DiscordBridgeLogger } from "./logger.ts";
import {
	createDiscordBridgeLogger,
} from "./logger.ts";
import type {
	DiscordBridgeConfig,
	DiscordBridgeState,
	DiscordBridgeTransport,
} from "./types.ts";
import type {
	CodexGatewayBackend,
	CodexGatewayPresenter,
} from "./gateway-backend.ts";
import {
	LocalCodexGatewayBackend,
	type LocalCodexGatewayBackendOptions,
	parseThreadStartIntent,
	splitDiscordMessage,
} from "./local-gateway-backend.ts";

export { parseThreadStartIntent, splitDiscordMessage };
export { LocalCodexGatewayBackend };
export type { LocalCodexGatewayBackendOptions };

export type DiscordCodexBridgeLocalOptions =
	Omit<LocalCodexGatewayBackendOptions, "presenter"> & {
		transport: DiscordBridgeTransport;
		backend?: undefined;
	};

export type DiscordCodexBridgeBackendOptions = {
	backend: CodexGatewayBackend;
	transport: DiscordBridgeTransport;
	logger?: DiscordBridgeLogger;
	config?: Pick<DiscordBridgeConfig, "debug" | "logLevel">;
	now?: () => Date;
};

export type DiscordCodexBridgeOptions =
	| DiscordCodexBridgeLocalOptions
	| DiscordCodexBridgeBackendOptions;

export class DiscordCodexBridge {
	readonly transport: DiscordBridgeTransport;
	readonly backend: CodexGatewayBackend;
	#logger: DiscordBridgeLogger;

	constructor(options: DiscordCodexBridgeOptions) {
		this.transport = options.transport;
		this.#logger = options.logger ??
			createDiscordBridgeLogger({
				debug: options.config?.debug,
				logLevel: options.config?.logLevel,
				now: options.now,
			});
		this.backend = options.backend ?? new LocalCodexGatewayBackend({
			...options,
			presenter: discordTransportPresenter(options.transport),
		});
	}

	async start(): Promise<void> {
		await this.backend.start();
		await this.transport.start({
			onInbound: (inbound) => {
				void this.backend.handleInbound(inbound).catch((error) => {
					this.#logger.debug("inbound.error", {
						kind: inbound.kind,
						channelId: inbound.channelId,
						error: errorMessage(error),
					});
					this.#logger.error("inbound.failed", {
						kind: inbound.kind,
						channelId: inbound.channelId,
						error: errorMessage(error),
					});
				});
			},
		});
		await this.backend.startTransportDependentWork?.();
		await this.transport.registerCommands(this.backend.commandRegistration());
		await this.backend.startBackgroundWork?.();
	}

	async stop(): Promise<void> {
		try {
			await this.backend.stop();
		} finally {
			await this.transport.stop();
		}
	}

	stateForTest(): DiscordBridgeState {
		if (!this.backend.stateForTest) {
			throw new Error("Gateway backend does not expose test state.");
		}
		return this.backend.stateForTest();
	}

	async flushSummariesForTest(): Promise<void> {
		await this.backend.flushSummariesForTest?.();
	}
}

function discordTransportPresenter(
	transport: DiscordBridgeTransport,
): CodexGatewayPresenter {
	return {
		createWorkspacePost: transport.createForumPost?.bind(transport),
		createThread: transport.createThread.bind(transport),
		sendMessage: transport.sendMessage.bind(transport),
		updateMessage: transport.updateMessage?.bind(transport),
		deleteMessage: transport.deleteMessage.bind(transport),
		deleteWebhookMessages: transport.deleteWebhookMessages?.bind(transport),
		deleteThread: transport.deleteThread?.bind(transport),
		addThreadMembers: transport.addThreadMembers?.bind(transport),
		addReactions: transport.addReactions?.bind(transport),
		pinMessage: transport.pinMessage?.bind(transport),
		sendTyping: transport.sendTyping.bind(transport),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
