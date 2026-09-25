import { Connection } from 'net-ipc';
import { EventPayload } from '../protocol/EventPayload';
import { Transport } from './Transport';

/**
 * Wraps a net-ipc `Connection` (used by BridgeInstanceConnection). net-ipc's `Server` emits
 * `message` once at the server level, demuxed by connection - there is no per-connection
 * `on('message', ...)` to subscribe to. `dispatch()` is the escape hatch: BridgeServer's
 * server-level message handler looks up the right BridgeInstanceConnection and calls
 * `.transport.dispatch(raw)` on it, which forwards to whatever `subscribe()` registered.
 */
export class NetIpcConnectionTransport implements Transport {
    private handler?: (raw: unknown) => void;

    constructor(private readonly connection: Connection) {}

    send(payload: EventPayload): Promise<void> {
        if ((this.connection.connection as any)?.closed) {
            return Promise.reject(new Error('Connection is closed, cannot send message'));
        }
        return this.connection.send(payload);
    }

    subscribe(onData: (raw: unknown) => void): void {
        this.handler = onData;
    }

    dispatch(raw: unknown): void {
        this.handler?.(raw);
    }

    close(reason?: string): void {
        this.connection.close(reason, false).catch(() => {});
    }
}
