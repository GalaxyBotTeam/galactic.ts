import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../../src/bridge/Bridge';
import { BridgeInstanceConnection } from '../../../src/bridge/BridgeInstanceConnection';
import { BridgeClusterConnection } from '../../../src/bridge/BridgeClusterConnection';

function instance(id: number, supportsResume = true) {
    const connection = new BridgeInstanceConnection(id, { id: `c${id}`, connection: { closed: false }, send: async () => {} } as any, undefined, false, false, supportsResume);
    Object.defineProperty(connection, 'eventManager', {
        value: { request: vi.fn().mockResolvedValue({}), send: vi.fn().mockResolvedValue(undefined), onMessage: vi.fn(), onRequest: vi.fn() },
    });
    return connection;
}

function setup(options = {}) {
    const bridge = new Bridge(0, 'token', [], 1, 2, 1000, false, 0, options) as any;
    const cluster = (id: number): BridgeClusterConnection => bridge.getClusters()[id];
    const connect = (connection: BridgeInstanceConnection) => {
        bridge.connectedInstances.set(connection.connection.id, connection);
        bridge.onInstanceConnected(connection);
    };
    const disconnect = (connection: BridgeInstanceConnection) => {
        bridge.connectedInstances.delete(connection.connection.id);
        bridge.onInstanceDisconnected(connection, 'gone');
    };
    return { bridge, cluster, connect, disconnect };
}

function running(cluster: BridgeClusterConnection, on: BridgeInstanceConnection) {
    cluster.setConnection(on);
    cluster.markStarting();
    cluster.markConnected();
}

afterEach(() => vi.useRealTimers());

describe('Bridge disconnect policy', () => {
    it('stops nothing by default: a lost instance frees its clusters at once', () => {
        const { cluster, connect, disconnect } = setup();
        const a = instance(1);
        connect(a);
        running(cluster(0), a);

        disconnect(a);

        expect(cluster(0).isUsed()).toBe(false);
    });

    it('tells every instance that can resume its policy on connect', () => {
        const { connect } = setup({ disconnectPolicy: { keepClusters: true, timeoutMs: 60000 } });
        const [a, old] = [instance(1), instance(2, false)];

        connect(a);
        connect(old);

        expect(a.eventManager.send).toHaveBeenCalledWith({ type: 'INSTANCE_DISCONNECT_POLICY', data: { keepClusters: true, timeoutMs: 60000 } });
        expect(old.eventManager.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'INSTANCE_DISCONNECT_POLICY' }));
    });

    it('keeps the clusters of a lost instance assigned, without heartbeats, while the policy keeps them', async () => {
        const { bridge, cluster, connect, disconnect } = setup({ disconnectPolicy: { keepClusters: true } });
        const a = instance(1);
        connect(a);
        running(cluster(0), a);

        disconnect(a);
        bridge.heartbeat();

        expect(cluster(0).connection).toBe(a);
        expect(cluster(0).reserved).toBe(true);
        expect(a.eventManager.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLUSTER_HEARTBEAT' }), expect.anything());
        await expect(bridge.sendRequestToGuild(cluster(0), '1', {})).rejects.toThrow('No connection defined');
    });

    it('does not start a reserved cluster on another instance', () => {
        const { bridge, cluster, connect, disconnect } = setup({ disconnectPolicy: { keepClusters: true }, resumeWindowMs: 0 });
        bridge.startedAt = 0;
        const [a, b] = [instance(1), instance(2)];
        connect(a);
        connect(b);
        b.markResumed();
        running(cluster(0), a);
        running(cluster(1), b);

        disconnect(a);
        bridge.checkCreate();

        expect(cluster(0).connection).toBe(a);
        expect(b.eventManager.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CLUSTER_CREATE' }));
    });

    it('waits for the resume window before it starts clusters after its own start', () => {
        vi.useFakeTimers();
        const { bridge, cluster, connect } = setup({ disconnectPolicy: { keepClusters: true }, resumeWindowMs: 20000 });
        bridge.startedAt = Date.now();
        const a = instance(1);
        connect(a);
        a.markResumed();

        bridge.checkCreate();
        expect(cluster(0).isUsed()).toBe(false);

        vi.advanceTimersByTime(20001);
        bridge.checkCreate();
        expect(cluster(0).connection).toBe(a);
    });

    it('gives no clusters to an instance before it reported the ones it still runs', () => {
        const { bridge, cluster, connect } = setup();
        bridge.startedAt = 0;
        const a = instance(1);
        connect(a);

        bridge.checkCreate();
        expect(cluster(0).isUsed()).toBe(false);

        a.markResumed();
        bridge.checkCreate();
        expect(cluster(0).connection).toBe(a);
    });

    it('frees every reservation when keeping is switched off, and tells the instances', () => {
        const { bridge, cluster, connect, disconnect } = setup({ disconnectPolicy: { keepClusters: true } });
        const [a, b] = [instance(1), instance(2)];
        connect(a);
        connect(b);
        running(cluster(0), a);
        disconnect(a);

        bridge.setDisconnectPolicy({ keepClusters: false });

        expect(cluster(0).isUsed()).toBe(false);
        expect(b.eventManager.send).toHaveBeenLastCalledWith({ type: 'INSTANCE_DISCONNECT_POLICY', data: { keepClusters: false } });
    });

    it('rejects a timeout that is not a finite number', () => {
        expect(() => setup({ disconnectPolicy: { keepClusters: true, timeoutMs: -1 } })).toThrow('timeoutMs');
        const { bridge } = setup();
        expect(() => bridge.setDisconnectPolicy({ keepClusters: true, timeoutMs: Infinity })).toThrow('timeoutMs');
    });

    it('does not rebalance while a cluster waits for its instance', () => {
        const { bridge, cluster, connect, disconnect } = setup({ disconnectPolicy: { keepClusters: true } });
        const a = instance(1);
        connect(a);
        running(cluster(0), a);
        disconnect(a);
        const checkRecluster = vi.spyOn(bridge.reclusterer, 'checkRecluster');

        bridge.scheduler.tasks.checkRecluster();

        expect(checkRecluster).not.toHaveBeenCalled();
    });
});
