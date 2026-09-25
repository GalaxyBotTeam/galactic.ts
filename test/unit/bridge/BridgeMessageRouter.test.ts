import { describe, expect, it, vi } from 'vitest';
import { createBridgeMessageHandler } from '../../../src/bridge/BridgeMessageRouter';
import { TypedEmitter } from '../../../src/general/TypedEmitter';
import type { BridgeEvents } from '../../../src/bridge/Bridge';

function fakeCluster(clusterID: number) {
    return {
        clusterID,
        markStarting: vi.fn(),
        markConnected: vi.fn(),
        setConnection: vi.fn(),
        spawnedAt: undefined as number | undefined,
        readyAt: undefined as number | undefined,
        oldConnection: undefined as any,
    };
}

function fakeConnection() {
    return {} as any;
}

function setup(cluster: ReturnType<typeof fakeCluster>) {
    const calculator = { getClusterForConnection: vi.fn().mockReturnValue([cluster]) } as any;
    const events = new TypedEmitter<BridgeEvents>();
    const onInstanceStop = vi.fn();
    const connection = fakeConnection();
    const handler = createBridgeMessageHandler(connection, { calculator, events, onInstanceStop });
    return { handler, events, onInstanceStop, connection };
}

describe('BridgeMessageRouter', () => {
    it('CLUSTER_SPAWNED marks the matching cluster STARTING and stamps spawnedAt', () => {
        const cluster = fakeCluster(1);
        const { handler } = setup(cluster);

        handler({ type: 'CLUSTER_SPAWNED', data: { id: 1 } });

        expect(cluster.markStarting).toHaveBeenCalled();
        expect(cluster.spawnedAt).toBeTypeOf('number');
    });

    it('CLUSTER_READY marks CONNECTED, emits CLUSTER_READY, and stops the old connection if any', () => {
        const cluster = fakeCluster(1);
        cluster.spawnedAt = Date.now() - 10;
        const oldConnection = { eventManager: { send: vi.fn() } };
        cluster.oldConnection = oldConnection;
        const { handler, events } = setup(cluster);
        const listener = vi.fn();
        events.on('CLUSTER_READY', listener);

        handler({ type: 'CLUSTER_READY', data: { id: 1, guilds: 5, members: 10 } });

        expect(cluster.markConnected).toHaveBeenCalled();
        expect(listener).toHaveBeenCalledWith(cluster, 5, 10, expect.any(Number));
        expect(oldConnection.eventManager.send).toHaveBeenCalledWith({ type: 'CLUSTER_STOP', data: { id: 1 } });
        expect(cluster.oldConnection).toBeUndefined();
    });

    it('CLUSTER_STOPPED emits CLUSTER_STOPPED and clears the connection', () => {
        const cluster = fakeCluster(1);
        const { handler, events } = setup(cluster);
        const listener = vi.fn();
        events.on('CLUSTER_STOPPED', listener);

        handler({ type: 'CLUSTER_STOPPED', data: { id: 1 } });

        expect(listener).toHaveBeenCalledWith(cluster);
        expect(cluster.setConnection).toHaveBeenCalledWith(undefined);
    });

    it('INSTANCE_STOP invokes the onInstanceStop callback with the connection', () => {
        const cluster = fakeCluster(1);
        const { handler, onInstanceStop, connection } = setup(cluster);

        handler({ type: 'INSTANCE_STOP' });

        expect(onInstanceStop).toHaveBeenCalledWith(connection);
    });

    it('messages the Bridge only ever sends (never receives) are safely ignored', () => {
        const cluster = fakeCluster(1);
        const { handler } = setup(cluster);

        expect(() => handler({ type: 'CLUSTER_CREATE', data: { clusterID: 1, instanceID: 1, totalShards: 1, shardList: [0], token: 't', intents: [] } })).not.toThrow();
        expect(() => handler({ type: 'CLUSTER_STOP', data: { id: 1 } })).not.toThrow();
        expect(() => handler({ type: 'CLUSTER_RECLUSTER', data: { clusterID: 1 } })).not.toThrow();
        expect(() => handler({ type: 'INSTANCE_STOP_ACK' })).not.toThrow();
    });

    it('a message type this version does not know (peer on another version) is dropped, not thrown', () => {
        const cluster = fakeCluster(1);
        const { handler } = setup(cluster);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => handler({ type: 'INSTANCE_STOPPED' } as any)).not.toThrow();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('INSTANCE_STOPPED'));
        warn.mockRestore();
    });
});
