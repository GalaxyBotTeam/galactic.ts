import { EventPayload } from '../../../src/protocol/EventPayload';
import { Transport } from '../../../src/transport/Transport';

/** In-memory Transport for tests - no real socket/process needed. */
export class FakeTransport implements Transport {
    public sent: EventPayload[] = [];
    public closedReason: string | undefined;
    private handler?: (raw: unknown) => void;

    send(payload: EventPayload): Promise<void> {
        this.sent.push(payload);
        return Promise.resolve();
    }

    subscribe(onData: (raw: unknown) => void): void {
        this.handler = onData;
    }

    close(reason?: string): void {
        this.closedReason = reason;
    }

    /** Test helper: simulate an incoming payload from "the other side". */
    receiveFromPeer(raw: unknown): void {
        this.handler?.(raw);
    }
}
