import { describe, expect, it, vi } from 'vitest';
import { createBridgeMessageHandler } from '../../../src/bridge/BridgeMessageRouter';
import { TypedEmitter } from '../../../src/general/TypedEmitter';
import { INVALID_SHARD_COUNT_ERROR } from '../../../src/protocol/shared';
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
    const calculator = { getClusterForConnection: vi.fn().mockReturnValue([cluster]), getOldClusterForConnection: vi.fn().mockReturnValue([]) } as any;
    const events = new TypedEmitter<BridgeEvents>();
    const onInstanceStop = vi.fn();
    const connection = fakeConnection();
    const onInvalidShardCount = vi.fn();
    const handler = createBridgeMessageHandler(connection, { calculator, events, onInstanceStop, onInvalidShardCount });
    return { handler, events, onInstanceStop, onInvalidShardCount, connection, calculator };
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
        const oldConnection = { eventManager: { send: vi.fn().mockResolvedValue(undefined) } };
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

    it('CLUSTER_READY reports a failed CLUSTER_STOP to the old connection as ERROR instead of an unhandled rejection', async () => {
        const cluster = fakeCluster(1);
        cluster.spawnedAt = Date.now();
        cluster.oldConnection = { instanceID: 9, eventManager: { send: vi.fn().mockRejectedValue(new Error('closed')) } };
        const { handler, events } = setup(cluster);
        const errors: string[] = [];
        events.on('ERROR', (e) => errors.push(e));

        handler({ type: 'CLUSTER_READY', data: { id: 1 } });
        await Promise.resolve();
        await Promise.resolve();

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/instance 9.*closed/);
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

    it('CLUSTER_STOPPED from the old instance of a move drops it as the serving instance', () => {
        const cluster = fakeCluster(1);
        cluster.oldConnection = {};
        const { handler, calculator } = setup(cluster);
        calculator.getClusterForConnection.mockReturnValue([]);
        calculator.getOldClusterForConnection.mockReturnValue([cluster]);

        handler({ type: 'CLUSTER_STOPPED', data: { id: 1 } });

        expect(cluster.oldConnection).toBeUndefined();
        expect(cluster.setConnection).not.toHaveBeenCalled();
    });

    it('CLUSTER_STOPPED reports a shard count Discord rejected', () => {
        const { handler, onInvalidShardCount } = setup(fakeCluster(0));

        handler({ type: 'CLUSTER_STOPPED', data: { id: 99, reason: `Cluster error: ${INVALID_SHARD_COUNT_ERROR}` } });
        expect(onInvalidShardCount).toHaveBeenCalledTimes(1);

        handler({ type: 'CLUSTER_STOPPED', data: { id: 99, reason: 'Heartbeat missed' } });
        expect(onInvalidShardCount).toHaveBeenCalledTimes(1);
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

describe('BridgeMessageRouter hand-over', () => {
    function withSend(connection: any) {
        connection.instanceID = 2;
        connection.eventManager = { send: vi.fn().mockResolvedValue(undefined) };
        return connection;
    }

    it('CLUSTER_READY of a moved cluster stops the old process, then lets the new one serve', () => {
        const cluster = fakeCluster(1) as any;
        cluster.spawnedAt = Date.now();
        cluster.handoverPending = true;
        const order: string[] = [];
        cluster.oldConnection = { eventManager: { send: vi.fn(async (m: any) => { order.push(`old:${m.type}`); }) } };
        const { handler, connection } = setup(cluster);
        withSend(connection).eventManager.send.mockImplementation(async (m: any) => { order.push(`new:${m.type}`); });

        handler({ type: 'CLUSTER_READY', data: { id: 1 } });

        expect(order).toEqual(['old:CLUSTER_STOP', 'new:CLUSTER_SERVING']);
        expect(cluster.handoverPending).toBe(false);
    });

    it('CLUSTER_READY of a first start sends no hand-over', () => {
        const cluster = fakeCluster(1) as any;
        cluster.spawnedAt = Date.now();
        const { handler, connection } = setup(cluster);
        withSend(connection);

        handler({ type: 'CLUSTER_READY', data: { id: 1 } });

        expect(connection.eventManager.send).not.toHaveBeenCalled();
    });

    it('CLUSTER_STOPPED of the old process lets the new one serve before it is ready', () => {
        const cluster = fakeCluster(1) as any;
        cluster.oldConnection = {};
        cluster.handoverPending = true;
        cluster.connection = withSend({});
        const { handler, calculator } = setup(cluster);
        calculator.getClusterForConnection.mockReturnValue([]);
        calculator.getOldClusterForConnection.mockReturnValue([cluster]);

        handler({ type: 'CLUSTER_STOPPED', data: { id: 1 } });

        expect(cluster.connection.eventManager.send).toHaveBeenCalledWith({ type: 'CLUSTER_SERVING', data: { id: 1 } });
    });

    it('CLUSTER_STOPPED of the new process drops the pending hand-over', () => {
        const cluster = fakeCluster(1) as any;
        cluster.handoverPending = true;
        const { handler } = setup(cluster);

        handler({ type: 'CLUSTER_STOPPED', data: { id: 1 } });

        expect(cluster.handoverPending).toBe(false);
    });

    it('reports a failed CLUSTER_SERVING as ERROR', async () => {
        const cluster = fakeCluster(1) as any;
        cluster.spawnedAt = Date.now();
        cluster.handoverPending = true;
        const { handler, connection, events } = setup(cluster);
        withSend(connection).eventManager.send.mockRejectedValue(new Error('closed'));
        const errors: string[] = [];
        events.on('ERROR', (e) => errors.push(e));

        handler({ type: 'CLUSTER_READY', data: { id: 1 } });
        await Promise.resolve();
        await Promise.resolve();

        expect(errors).toEqual([expect.stringMatching(/CLUSTER_SERVING.*cluster 1.*instance 2.*closed/)]);
    });
});
