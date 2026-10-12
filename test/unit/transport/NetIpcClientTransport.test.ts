import { describe, expect, it, vi } from 'vitest';
import { NetIpcClientTransport } from '../../../src/transport/NetIpcClientTransport';

// net-ipc's ClientStatus is a type-only const enum (no runtime export) - use the documented
// numeric values directly, same reasoning as src/transport/NetIpcClientTransport.ts.
const CONNECTING = 1;
const READY = 3;

function fakeClient(status: number) {
    return {
        status,
        send: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        close: vi.fn().mockResolvedValue(true),
    } as any;
}

describe('NetIpcClientTransport', () => {
    it('rejects sending when the client is not READY', async () => {
        const client = fakeClient(CONNECTING);
        const transport = new NetIpcClientTransport(client);

        await expect(transport.send({ id: '1', type: 'message', data: {} })).rejects.toThrow();
        expect(client.send).not.toHaveBeenCalled();
    });

    it('sends through the client when READY', async () => {
        const client = fakeClient(READY);
        const transport = new NetIpcClientTransport(client);
        const payload = { id: '1', type: 'message' as const, data: {} };

        await transport.send(payload);

        expect(client.send).toHaveBeenCalledWith(payload);
    });

    it('subscribe() wires through to the client "message" event', () => {
        const client = fakeClient(READY);
        const transport = new NetIpcClientTransport(client);
        const handler = vi.fn();

        transport.subscribe(handler);

        expect(client.on).toHaveBeenCalledWith('message', handler);
    });
});
