import { describe, expect, it, vi } from 'vitest';
import { ClusterResumer, RESERVATION_MARGIN_MS } from '../../../src/bridge/ClusterResumer';
import { ClusterCalculator } from '../../../src/bridge/ClusterCalculator';
import { BridgeInstanceConnection } from '../../../src/bridge/BridgeInstanceConnection';
import { BridgeClusterConnection, BridgeClusterConnectionStatus } from '../../../src/bridge/BridgeClusterConnection';
import { TypedEmitter } from '../../../src/general/TypedEmitter';
import type { BridgeEvents } from '../../../src/bridge/Bridge';

function instance(id: number, supportsResume = true) {
    return new BridgeInstanceConnection(id, { id: `c${id}`, connection: { closed: false }, send: async () => {} } as any, undefined, false, false, supportsResume);
}

/** 3 clusters with 2 shards each: 0:[0,1] 1:[2,3] 2:[4,5], 6 shards in total. */
function setup() {
    const calculator = new ClusterCalculator(3, 2);
    const events = new TypedEmitter<BridgeEvents>();
    const resumer = new ClusterResumer(calculator, () => 6, events);
    const cluster = (id: number) => calculator.clusterList[id];
    return { calculator, events, resumer, cluster };
}

function running(cluster: BridgeClusterConnection, on: BridgeInstanceConnection) {
    cluster.setConnection(on);
    cluster.markStarting();
    cluster.markConnected();
}

const report = (id: number, running = true) => ({ id, shardList: [id * 2, id * 2 + 1], totalShards: 6, running });

describe('ClusterResumer.reserve', () => {
    it('keeps the clusters of an instance that may still run them', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        running(cluster(0), gone);

        const reserved = resumer.reserve(gone, { keepClusters: true, timeoutMs: 1000 });

        expect(reserved).toEqual([cluster(0)]);
        expect(cluster(0).isUsed()).toBe(true);
        expect(cluster(0).servingConnection).toBeUndefined();
        expect(cluster(0).reservedUntil).toBeGreaterThanOrEqual(Date.now() + 1000 + RESERVATION_MARGIN_MS - 50);
    });

    it('keeps them forever without a timeout', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        running(cluster(0), gone);

        resumer.reserve(gone, { keepClusters: true });

        expect(cluster(0).reservedUntil).toBe(Infinity);
    });

    it('keeps nothing when the policy stops clusters', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        running(cluster(0), gone);

        expect(resumer.reserve(gone, { keepClusters: false })).toEqual([]);
    });

    it('keeps nothing for an instance that cannot resume - it stops its clusters on its own', () => {
        const { resumer, cluster } = setup();
        const old = instance(1, false);
        running(cluster(0), old);

        expect(resumer.reserve(old, { keepClusters: true })).toEqual([]);
    });

    it('does not keep a cluster that is moving onto the lost instance', () => {
        const { resumer, cluster } = setup();
        const [from, to] = [instance(1), instance(2)];
        running(cluster(0), from);
        cluster(0).reclustering(to);

        expect(resumer.reserve(to, { keepClusters: true })).toEqual([]);
    });
});

describe('ClusterResumer.releaseExpired', () => {
    it('frees a cluster once its time is up and reports it', () => {
        const { resumer, cluster, events } = setup();
        const gone = instance(1);
        running(cluster(0), gone);
        resumer.reserve(gone, { keepClusters: true, timeoutMs: 0 });
        const expired = vi.fn();
        events.on('CLUSTER_RESERVATION_EXPIRED', expired);

        resumer.releaseExpired(Date.now() + RESERVATION_MARGIN_MS + 1);

        expect(cluster(0).isUsed()).toBe(false);
        expect(cluster(0).reserved).toBe(false);
        expect(expired).toHaveBeenCalledWith(cluster(0));
    });

    it('never frees a cluster kept forever, except through releaseAll', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        running(cluster(0), gone);
        resumer.reserve(gone, { keepClusters: true });

        resumer.releaseExpired(Date.now() + 365 * 24 * 60 * 60 * 1000);
        expect(cluster(0).isUsed()).toBe(true);

        resumer.releaseAll();
        expect(cluster(0).isUsed()).toBe(false);
    });
});

describe('ClusterResumer.resume', () => {
    it('hands a reserved cluster back to its instance on the new connection', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        running(cluster(0), gone);
        resumer.reserve(gone, { keepClusters: true });
        const back = instance(1);

        expect(resumer.resume(back, [report(0)])).toEqual({ keep: [0] });

        expect(cluster(0).connection).toBe(back);
        expect(cluster(0).reserved).toBe(false);
        expect(cluster(0).servingConnection).toBe(back);
        expect(back.resumed).toBe(true);
    });

    it('marks a reserved cluster connected that became ready while the Bridge was away', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        cluster(0).setConnection(gone);
        cluster(0).markStarting();
        resumer.reserve(gone, { keepClusters: true });

        resumer.resume(instance(1), [report(0, true)]);

        expect(cluster(0).connectionStatus).toBe(BridgeClusterConnectionStatus.CONNECTED);
    });

    it('takes over clusters nobody holds - after a Bridge restart', () => {
        const { resumer, cluster } = setup();
        const back = instance(1);

        const response = resumer.resume(back, [report(0, true), report(1, false)]);

        expect(response).toEqual({ keep: [0, 1] });
        expect(cluster(0).connection).toBe(back);
        expect(cluster(0).connectionStatus).toBe(BridgeClusterConnectionStatus.CONNECTED);
        expect(cluster(1).connectionStatus).toBe(BridgeClusterConnectionStatus.STARTING);
        expect(cluster(1).spawnedAt).toBeDefined();
    });

    it('rejects a cluster another instance holds', () => {
        const { resumer, cluster, events } = setup();
        running(cluster(0), instance(2));
        const resumed = vi.fn();
        events.on('INSTANCE_RESUMED', resumed);
        const back = instance(1);

        expect(resumer.resume(back, [report(0)])).toEqual({ keep: [] });
        expect(cluster(0).connection?.instanceID).toBe(2);
        expect(resumed).toHaveBeenCalledWith(back, [], [{ id: 0, reason: 'held by instance 2' }]);
    });

    it('rejects a cluster whose old process still runs elsewhere during a move', () => {
        const { resumer, cluster } = setup();
        running(cluster(0), instance(2));
        cluster(0).reclustering(instance(3));
        cluster(0).setConnection(undefined);

        expect(resumer.resume(instance(1), [report(0)])).toEqual({ keep: [] });
    });

    it('rejects clusters with another shard layout', () => {
        const { resumer, cluster } = setup();

        const response = resumer.resume(instance(1), [
            { id: 0, shardList: [0, 1], totalShards: 8, running: true },
            { id: 1, shardList: [2], totalShards: 6, running: true },
            { id: 7, shardList: [14, 15], totalShards: 6, running: true },
        ]);

        expect(response).toEqual({ keep: [] });
        expect(cluster(0).isUsed()).toBe(false);
        expect(cluster(1).isUsed()).toBe(false);
    });

    it('frees reserved clusters the instance no longer runs', () => {
        const { resumer, cluster } = setup();
        const gone = instance(1);
        running(cluster(0), gone);
        running(cluster(1), gone);
        resumer.reserve(gone, { keepClusters: true });

        resumer.resume(instance(1), [report(0)]);

        expect(cluster(0).isUsed()).toBe(true);
        expect(cluster(1).isUsed()).toBe(false);
    });

    it('leaves reservations of other instances alone', () => {
        const { resumer, cluster } = setup();
        const other = instance(2);
        running(cluster(0), other);
        resumer.reserve(other, { keepClusters: true });

        resumer.resume(instance(1), []);

        expect(cluster(0).reserved).toBe(true);
    });
});
