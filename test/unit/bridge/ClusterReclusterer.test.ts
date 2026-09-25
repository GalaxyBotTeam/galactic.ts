import { describe, expect, it, vi } from 'vitest';
import { ClusterCalculator } from '../../../src/bridge/ClusterCalculator';
import { ClusterReclusterer } from '../../../src/bridge/ClusterReclusterer';
import { TypedEmitter } from '../../../src/general/TypedEmitter';
import type { BridgeEvents } from '../../../src/bridge/Bridge';

function fakeInstance(id: number) {
    return { instanceID: id, dev: false, eventManager: { send: vi.fn().mockResolvedValue(undefined) } } as any;
}

function setup(clusterCount: number, shardsPerCluster: number) {
    const calculator = new ClusterCalculator(clusterCount, shardsPerCluster);
    const events = new TypedEmitter<BridgeEvents>();
    const reclusterer = new ClusterReclusterer(calculator, 'token', [], () => clusterCount * shardsPerCluster, events);
    return { calculator, events, reclusterer };
}

describe('ClusterReclusterer', () => {
    it('createCluster assigns the connection and sends CLUSTER_CREATE', () => {
        const { calculator, reclusterer } = setup(1, 1);
        const instance = fakeInstance(1);

        reclusterer.createCluster(instance, calculator.clusterList[0]);

        expect(calculator.clusterList[0].connection).toBe(instance);
        expect(instance.eventManager.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLUSTER_CREATE' }));
    });

    it('createCluster emits CLUSTER_SPAWNED', () => {
        const { calculator, reclusterer, events } = setup(1, 1);
        const instance = fakeInstance(1);
        const listener = vi.fn();
        events.on('CLUSTER_SPAWNED', listener);

        reclusterer.createCluster(instance, calculator.clusterList[0]);

        expect(listener).toHaveBeenCalledWith(calculator.clusterList[0], instance);
    });

    it('createCluster reports a failed CLUSTER_CREATE send as ERROR instead of an unhandled rejection', async () => {
        const { calculator, reclusterer, events } = setup(1, 1);
        const instance = fakeInstance(1);
        instance.eventManager.send.mockRejectedValue(new Error('Connection is closed'));
        const errors: string[] = [];
        events.on('ERROR', (e) => errors.push(e));

        reclusterer.createCluster(instance, calculator.clusterList[0]);
        await Promise.resolve();
        await Promise.resolve();

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/CLUSTER_CREATE.*cluster 0.*instance 1/);
    });

    it('checkRecluster steals a cluster from the busiest instance onto the least busy one when imbalanced', () => {
        const { calculator, reclusterer } = setup(4, 1);
        const heavy = fakeInstance(1);
        const light = fakeInstance(2);

        calculator.clusterList.forEach((c, i) => {
            const owner = i < 3 ? heavy : light;
            c.setConnection(owner);
            c.markStarting();
            c.markConnected();
        });

        reclusterer.checkRecluster([heavy, light]);

        // one of heavy's clusters should now be reclustering onto light
        const reclustering = calculator.clusterList.filter(c => c.oldConnection === heavy);
        expect(reclustering).toHaveLength(1);
        expect(reclustering[0].connection).toBe(light);
    });

    it('checkRecluster does nothing when not all clusters are connected yet', () => {
        const { calculator, reclusterer } = setup(2, 1);
        const instance = fakeInstance(1);
        calculator.clusterList[0].setConnection(instance); // only one connected, other untouched

        expect(() => reclusterer.checkRecluster([instance])).not.toThrow();
        expect(calculator.clusterList[1].connection).toBeUndefined();
    });

    it('moveCluster reclusters the given cluster onto the given instance', () => {
        const { calculator, reclusterer } = setup(1, 1);
        const from = fakeInstance(1);
        const to = fakeInstance(2);
        calculator.clusterList[0].setConnection(from);
        calculator.clusterList[0].markStarting();
        calculator.clusterList[0].markConnected();

        reclusterer.moveCluster(to, calculator.clusterList[0]);

        expect(calculator.clusterList[0].connection).toBe(to);
        expect(calculator.clusterList[0].oldConnection).toBe(from);
    });

    it('moveCluster rejects a cluster that is not CONNECTED with a descriptive error', () => {
        const { calculator, reclusterer } = setup(1, 1);
        const from = fakeInstance(1);
        const to = fakeInstance(2);
        calculator.clusterList[0].setConnection(from);
        calculator.clusterList[0].markStarting();

        expect(() => reclusterer.moveCluster(to, calculator.clusterList[0])).toThrow(/cannot be moved while starting/);
        expect(calculator.clusterList[0].connection).toBe(from);
    });

    it('moveCluster rejects moving a cluster onto the instance it already runs on', () => {
        const { calculator, reclusterer } = setup(1, 1);
        const from = fakeInstance(1);
        calculator.clusterList[0].setConnection(from);
        calculator.clusterList[0].markStarting();
        calculator.clusterList[0].markConnected();

        expect(() => reclusterer.moveCluster(from, calculator.clusterList[0])).toThrow(/already runs on instance 1/);
        expect(calculator.clusterList[0].oldConnection).toBeUndefined();
    });
});
