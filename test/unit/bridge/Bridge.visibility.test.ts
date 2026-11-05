import { describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../../src/bridge/Bridge';
import { BridgeClusterConnection } from '../../../src/bridge/BridgeClusterConnection';
import { BridgeInstanceConnection } from '../../../src/bridge/BridgeInstanceConnection';
import { MAX_MISSED_HEARTBEATS } from '../../../src/bridge/ClusterScheduler';

const heartbeat = { ping: 1, shardPings: [{ id: 0, ping: -1, status: 7, guilds: 0, members: 0 }] };

function instance(id: number, request = vi.fn().mockResolvedValue(heartbeat)) {
    const connection = new BridgeInstanceConnection(id, { id: `c${id}`, connection: { closed: false }, send: async () => {} } as any, undefined, false);
    Object.defineProperty(connection, 'eventManager', { value: { request, send: vi.fn().mockResolvedValue(undefined) } });
    return connection;
}

function setup() {
    const bridge = new Bridge(0, 'token', [], 1, 1, 1000) as any;
    const cluster: BridgeClusterConnection = bridge.getClusters()[0];
    return { bridge, cluster };
}

function start(cluster: BridgeClusterConnection, connection: BridgeInstanceConnection) {
    cluster.setConnection(connection);
    cluster.markStarting();
}

function moving(cluster: BridgeClusterConnection, from: BridgeInstanceConnection, to: BridgeInstanceConnection) {
    start(cluster, from);
    cluster.markConnected();
    cluster.reclustering(to);
    cluster.markStarting();
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('servingConnection', () => {
    it('is nobody while a cluster starts for the first time', () => {
        const { cluster } = setup();
        start(cluster, instance(1));
        expect(cluster.servingConnection).toBeUndefined();
    });

    it('is the old instance until the move is over', () => {
        const { cluster } = setup();
        const [from, to] = [instance(1), instance(2)];
        moving(cluster, from, to);
        expect(cluster.servingConnection).toBe(from);

        cluster.markConnected();
        cluster.oldConnection = undefined;
        expect(cluster.servingConnection).toBe(to);
    });
});

describe('Bridge during a move', () => {
    it('sends guild requests to the old instance', async () => {
        const { bridge, cluster } = setup();
        const [from, to] = [instance(1, vi.fn().mockResolvedValue('old')), instance(2)];
        moving(cluster, from, to);

        await expect(bridge.sendRequestToGuild(cluster, '1', {})).resolves.toBe('old');
        expect(to.eventManager.request).not.toHaveBeenCalled();
    });

    it('rejects guild requests while nothing answers', async () => {
        const { bridge, cluster } = setup();
        start(cluster, instance(1));

        await expect(bridge.sendRequestToGuild(cluster, '1', {})).rejects.toThrow('No connection defined');
    });

    it('forgets an old instance that went away', () => {
        const { bridge, cluster } = setup();
        const [from, to] = [instance(1), instance(2)];
        moving(cluster, from, to);

        bridge.onInstanceDisconnected(from, 'gone');

        expect(cluster.oldConnection).toBeUndefined();
        expect(cluster.connection).toBe(to);
    });
});

describe('Bridge heartbeats of starting clusters', () => {
    it('reads the shards while the cluster starts', async () => {
        const { bridge, cluster } = setup();
        start(cluster, instance(1));

        bridge.heartbeat();
        await settle();

        expect(cluster.heartbeatResponse).toEqual(heartbeat);
    });

    it('asks the new process during a move', async () => {
        const { bridge, cluster } = setup();
        const [from, to] = [instance(1), instance(2)];
        moving(cluster, from, to);

        bridge.heartbeat();
        await settle();

        expect(to.eventManager.request).toHaveBeenCalled();
        expect(from.eventManager.request).not.toHaveBeenCalled();
    });

    it('does not count a process that cannot answer yet', async () => {
        const { bridge, cluster } = setup();
        start(cluster, instance(1, vi.fn().mockRejectedValue(new Error('Cluster is not here'))));
        cluster.missedHeartbeats = MAX_MISSED_HEARTBEATS;
        const failed = vi.fn();
        bridge.on('CLUSTER_HEARTBEAT_FAILED', failed);

        bridge.heartbeat();
        await settle();

        expect(failed).not.toHaveBeenCalled();
        expect(cluster.missedHeartbeats).toBe(MAX_MISSED_HEARTBEATS);
        expect(cluster.connection).toBeDefined();
        expect(cluster.heartbeatPending).toBe(false);
    });

    it('still counts connected clusters', async () => {
        const { bridge, cluster } = setup();
        start(cluster, instance(1, vi.fn().mockRejectedValue(new Error('timeout'))));
        cluster.markConnected();

        bridge.heartbeat();
        await settle();

        expect(cluster.missedHeartbeats).toBe(1);
    });

    it('ignores an answer from before a move', async () => {
        const { bridge, cluster } = setup();
        let answer!: (r: unknown) => void;
        const from = instance(1, vi.fn(() => new Promise(resolve => { answer = resolve; })));
        start(cluster, from);
        cluster.markConnected();

        bridge.heartbeat();
        cluster.reclustering(instance(2));
        answer(heartbeat);
        await settle();

        expect(cluster.heartbeatResponse).toBeUndefined();
    });
});
