import { describe, expect, it, vi } from 'vitest';
import { NetIpcConnectionTransport } from '../../../src/transport/NetIpcConnectionTransport';

function fakeConnection(closed: boolean) {
    return {
        connection: { closed },
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(true),
    } as any;
}

describe('NetIpcConnectionTransport', () => {
    it('rejects sending when the underlying socket is closed', async () => {
        const connection = fakeConnection(true);
        const transport = new NetIpcConnectionTransport(connection);

        await expect(transport.send({ id: '1', type: 'message', data: {} })).rejects.toThrow();
        expect(connection.send).not.toHaveBeenCalled();
    });

    it('sends through the connection when open', async () => {
        const connection = fakeConnection(false);
        const transport = new NetIpcConnectionTransport(connection);
        const payload = { id: '1', type: 'message' as const, data: {} };

        await transport.send(payload);

        expect(connection.send).toHaveBeenCalledWith(payload);
    });

    it('dispatch() forwards to whatever subscribe() registered', () => {
        const connection = fakeConnection(false);
        const transport = new NetIpcConnectionTransport(connection);
        const handler = vi.fn();
        transport.subscribe(handler);

        transport.dispatch({ id: '1', type: 'message', data: 'x' });

        expect(handler).toHaveBeenCalledWith({ id: '1', type: 'message', data: 'x' });
    });

    it('dispatch() before subscribe() is a no-op, not a throw', () => {
        const connection = fakeConnection(false);
        const transport = new NetIpcConnectionTransport(connection);

        expect(() => transport.dispatch({ any: 'thing' })).not.toThrow();
    });
});
