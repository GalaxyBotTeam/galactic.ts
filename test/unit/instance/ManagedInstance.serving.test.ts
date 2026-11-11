import { describe, expect, it, vi } from 'vitest';
import { ManagedInstance } from '../../../src/instance/ManagedInstance';

const READY = 3;

// The constructor only builds a net-ipc Client, it does not connect - safe to instantiate here.
function make(resumeResponse: Promise<unknown> = Promise.resolve({ keep: [] })) {
    const instance = new ManagedInstance('entry.js', '127.0.0.1', 1, 1, {}) as any;
    instance.startProcess = vi.fn();
    instance.killProcess = vi.fn(() => Promise.resolve());
    instance.eventManager = { request: vi.fn(() => resumeResponse), send: vi.fn().mockResolvedValue(undefined) };
    return instance;
}

function withCluster(instance: any, id: number, status = 'running') {
    const cluster = { id, shardList: [id], totalShards: 4, status, setServing: vi.fn().mockResolvedValue(undefined) };
    instance.clusters.set(id, cluster);
    return cluster;
}

const create = (serving?: boolean) => ({
    type: 'CLUSTER_CREATE',
    data: { clusterID: 1, instanceID: 1, totalShards: 4, shardList: [1], token: 'token', intents: [], ...(serving === undefined ? {} : { serving }) },
});

describe('ManagedInstance serving', () => {
    it('starts the new process of a move without serving', () => {
        const instance = make();

        instance.onBridgeMessage(create(false));

        expect(instance.startProcess).toHaveBeenCalledWith(1, 1, [1], 4, 'token', [], false);
    });

    it('starts a cluster serving when the Bridge does not say otherwise', () => {
        const instance = make();

        instance.onBridgeMessage(create());

        expect(instance.startProcess).toHaveBeenCalledWith(1, 1, [1], 4, 'token', [], true);
    });

    it('hands the cluster over on CLUSTER_SERVING', () => {
        const instance = make();
        const cluster = withCluster(instance, 1);

        instance.onBridgeMessage({ type: 'CLUSTER_SERVING', data: { id: 1 } });

        expect(cluster.setServing).toHaveBeenCalledTimes(1);
    });

    it('does not hand over a cluster that is stopping', () => {
        const instance = make();
        const cluster = withCluster(instance, 1, 'stopped');

        instance.onBridgeMessage({ type: 'CLUSTER_SERVING', data: { id: 1 } });

        expect(cluster.setServing).not.toHaveBeenCalled();
    });

    it('hands over a cluster whose process spawns after CLUSTER_SERVING', () => {
        const instance = make();
        instance.onBridgeMessage(create(false));
        instance.onBridgeMessage({ type: 'CLUSTER_SERVING', data: { id: 1 } });

        const cluster = { id: 1, status: 'starting', setServing: vi.fn().mockResolvedValue(undefined) };
        instance.setClusterSpawned(cluster);
        instance.setClusterSpawned(cluster);

        expect(cluster.setServing).toHaveBeenCalledTimes(1);
    });

    it('forgets a hand-over for a process that never spawned when the cluster is created again', () => {
        const instance = make();
        instance.onBridgeMessage({ type: 'CLUSTER_SERVING', data: { id: 1 } });
        instance.onBridgeMessage(create(false));

        const cluster = { id: 1, status: 'starting', setServing: vi.fn().mockResolvedValue(undefined) };
        instance.setClusterSpawned(cluster);

        expect(cluster.setServing).not.toHaveBeenCalled();
    });

    it('lets every cluster the Bridge took over on resume serve', async () => {
        const instance = make(Promise.resolve({ keep: [1] }));
        const [kept, stopped] = [withCluster(instance, 1), withCluster(instance, 2)];

        instance.onConnectionStatus(READY);
        await new Promise(resolve => setImmediate(resolve));

        expect(kept.setServing).toHaveBeenCalledTimes(1);
        expect(stopped.setServing).not.toHaveBeenCalled();
    });
});
