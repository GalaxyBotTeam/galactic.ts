import { EventPayload } from '../protocol/EventPayload';

/**
 * The seam between EventManager (protocol-aware request/response correlation) and whatever
 * actually moves bytes (child_process IPC, a net-ipc Client, a net-ipc Connection). A Transport
 * only ever sees EventPayload envelopes - it never knows what's inside `data`. Implement one
 * per real transport; fake ones in tests avoid needing real sockets/processes.
 */
export interface Transport {
    send(payload: EventPayload): Promise<void>;

    /** Register the single handler that receives every raw incoming payload for this transport. */
    subscribe(onData: (raw: unknown) => void): void;

    close(reason?: string): void;
}
