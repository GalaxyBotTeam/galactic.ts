import { describe, expect, it, vi } from 'vitest';
import { Server } from 'net-ipc';
import {
    Bridge,
    BridgeConnectionStatus,
    BridgeInstanceConnection,
    ManagedInstanceConnectionStatus,
    type BridgeEventListeners,
    type BridgeEvents,
    type BotInstanceEventListeners,
    type BotInstanceListeners,
} from '../../src/index';

// Pins the deprecated aliases kept for consumers of the pre-rework API.
describe('backwards-compatible exports', () => {
    it('BridgeConnectionStatus aliases ManagedInstanceConnectionStatus', () => {
        expect(BridgeConnectionStatus).toBe(ManagedInstanceConnectionStatus);
        expect(BridgeConnectionStatus.CONNECTED).toBe('connected');
    });

    it('renamed listener types stay assignable under their old names', () => {
        const bridge: BridgeEventListeners['ERROR'] = (e: string) => e;
        const instance: BotInstanceEventListeners['message'] = (_cp, m) => m;
        const check: [BridgeEvents['ERROR'], BotInstanceListeners['message']] = [bridge, instance];
        expect(check).toHaveLength(2);
    });

    it('Bridge.server still exposes the net-ipc Server', () => {
        const bridge = new Bridge(0, 'token', [], 1, 1, 1000);
        expect(bridge.server).toBeInstanceOf(Server);
    });

    it('BridgeInstanceConnection.onMessage / onRequest / messageReceive delegate to the transport', async () => {
        const connection = { id: 'c1', send: vi.fn().mockResolvedValue(undefined), connection: {} } as any;
        const instance = new BridgeInstanceConnection(1, connection, undefined, false);
        const onMessage = vi.fn();
        const onRequest = vi.fn().mockReturnValue('answer');
        instance.onMessage(onMessage);
        instance.onRequest(onRequest);

        instance.messageReceive({ id: 'm1', type: 'message', data: { type: 'X' } });
        instance.messageReceive({ id: 'r1', type: 'request', data: { type: 'Y' }, timeout: 42 });
        await Promise.resolve();

        expect(onMessage).toHaveBeenCalledWith({ type: 'X' });
        expect(onRequest).toHaveBeenCalledWith({ type: 'Y' }, 42);
        expect(connection.send).toHaveBeenCalledWith({ id: 'r1', type: 'response', data: 'answer' });
    });
});
