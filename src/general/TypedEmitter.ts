import { EventEmitter } from 'node:events';

/**
 * Thin generic wrapper over Node's EventEmitter - kills the repeated
 * `if (this.eventMap.X) this.eventMap.X(...)` pattern without reinventing pub/sub.
 * Unlike the old eventMap, several listeners per event are allowed; `off()` removes one again.
 */
export class TypedEmitter<Events extends Record<string, (...args: any[]) => void>> {
    private readonly emitter = new EventEmitter();

    on<K extends keyof Events & string>(event: K, listener: Events[K]): void {
        this.emitter.on(event, listener as (...args: any[]) => void);
    }

    off<K extends keyof Events & string>(event: K, listener: Events[K]): void {
        this.emitter.off(event, listener as (...args: any[]) => void);
    }

    emit<K extends keyof Events & string>(event: K, ...args: Parameters<Events[K]>): void {
        this.emitter.emit(event, ...args);
    }
}
