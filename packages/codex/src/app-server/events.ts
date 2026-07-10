type Listener = (...args: any[]) => void;

export class CodexEventEmitter {
	#listeners = new Map<string, Set<Listener>>();

	on(event: string, listener: Listener): this {
		let listeners = this.#listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		listeners.add(listener);
		return this;
	}

	off(event: string, listener: Listener): this {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}

	once(event: string, listener: Listener): this {
		const wrapped: Listener = (...args) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	emit(event: string, ...args: any[]): boolean {
		const listeners = this.#listeners.get(event);
		if (!listeners || listeners.size === 0) {
			return false;
		}
		for (const listener of [...listeners]) {
			listener(...args);
		}
		return true;
	}
}
