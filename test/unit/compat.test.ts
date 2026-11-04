import { describe, expect, it, vi } from 'vitest';
import { Server } from 'net-ipc';
import {
    Bridge,
    BridgeConnectionStatus,
    BridgeInstanceConnection,
    EventManager,
    ManagedInstanceConnectionStatus,
    NetIpcClientTransport,
    NetIpcConnectionTransport,
    RestartStepError,
    rollingReload,
    sequentialRestart,
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

    it('exports the restart routine API', () => {
        expect(typeof sequentialRestart).toBe('function');
        expect(typeof rollingReload).toBe('function');
        expect(typeof RestartStepError).toBe('function');
    });

    it('stopAllInstancesWithRestart delegates to restartAll', async () => {
        const bridge = new Bridge(0, 'token', [], 1, 1, 1000);
        const restartAll = vi.spyOn(bridge, 'restartAll').mockResolvedValue();

        await bridge.stopAllInstancesWithRestart();
        expect(restartAll).toHaveBeenCalledTimes(1);
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

// `new EventManager(transport)` is the only constructor left, so consumers talking net-ipc
// outside of Bridge/ManagedInstance (e.g. whitelabel links) need these from the package root.
describe('net-ipc transports for external EventManagers', () => {
    it('NetIpcConnectionTransport feeds a server-side EventManager through dispatch()', async () => {
        const connection = { send: vi.fn().mockResolvedValue(undefined), connection: {} } as any;
        const transport = new NetIpcConnectionTransport(connection);
        const manager = new EventManager(transport);
        manager.onRequest((data) => ({ echo: data }));

        transport.dispatch({ id: 'r1', type: 'request', data: 'ping', timeout: 100 });
        await Promise.resolve();

        expect(connection.send).toHaveBeenCalledWith({ id: 'r1', type: 'response', data: { echo: 'ping' } });
    });

    it('NetIpcClientTransport subscribes to the client and refuses to send until it is ready', async () => {
        const listeners: Record<string, (raw: unknown) => void> = {};
        const client = {
            status: 0,
            send: vi.fn().mockResolvedValue(undefined),
            on: (event: string, listener: (raw: unknown) => void) => { listeners[event] = listener; },
        } as any;
        const manager = new EventManager(new NetIpcClientTransport(client));
        const onMessage = vi.fn();
        manager.onMessage(onMessage);

        listeners.message({ id: 'm1', type: 'message', data: 'hello' });
        expect(onMessage).toHaveBeenCalledWith('hello');

        await expect(manager.send('nope')).rejects.toThrow('Client is not ready');
        client.status = 3;
        await manager.send('ok');
        expect(client.send).toHaveBeenCalledOnce();
    });
});
