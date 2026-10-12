import { Client } from 'net-ipc';
import { EventPayload } from '../protocol/EventPayload';
import { Transport } from './Transport';

// net-ipc declares ClientStatus as an ambient `const enum` (type-only, no runtime export),
// so it can't be imported as a value here - esbuild/vite (unlike tsc) doesn't inline const
// enums across module boundaries, and `ClientStatus` would be `undefined` at runtime.
// READY = 3 per net-ipc's documented enum order (IDLE, CONNECTING, CONNECTED, READY, ...).
const CLIENT_STATUS_READY = 3;

/** Wraps a net-ipc `Client` (used by ManagedInstance to talk to a Bridge). */
export class NetIpcClientTransport implements Transport {
    constructor(private readonly client: Client) {}

    send(payload: EventPayload): Promise<void> {
        if (this.client.status !== CLIENT_STATUS_READY) {
            return Promise.reject(new Error('Client is not ready to send messages'));
        }
        return this.client.send(payload);
    }

    subscribe(onData: (raw: unknown) => void): void {
        this.client.on('message', onData);
    }

    close(reason?: string): void {
        this.client.close(reason).catch(() => {});
    }
}
