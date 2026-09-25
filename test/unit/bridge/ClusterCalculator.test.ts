import { describe, expect, it } from 'vitest';
import { ClusterCalculator } from '../../../src/bridge/ClusterCalculator';
import { BridgeInstanceConnection } from '../../../src/bridge/BridgeInstanceConnection';
import { BridgeClusterConnectionStatus } from '../../../src/bridge/BridgeClusterConnection';

// Fake net-ipc Connection - only shape BridgeInstanceConnection/EventManager touch in these tests.
function fakeConnection(id: string) {
    return { id, connection: { closed: false }, send: async () => {} } as any;
}

function fakeInstance(instanceID: number, dev = false) {
    return new BridgeInstanceConnection(instanceID, fakeConnection(`conn-${instanceID}`), undefined, dev);
}

describe('ClusterCalculator', () => {
    it('creates the requested number of clusters with sequential shard ranges', () => {
        const calc = new ClusterCalculator(3, 2);
        expect(calc.clusterList).toHaveLength(3);
        expect(calc.clusterList[0].shardList).toEqual([0, 1]);
        expect(calc.clusterList[1].shardList).toEqual([2, 3]);
        expect(calc.clusterList[2].shardList).toEqual([4, 5]);
    });

    it('getNextCluster returns clusters in order and skips used ones', () => {
        const calc = new ClusterCalculator(2, 1);
        const instance = fakeInstance(1);

        const first = calc.getNextCluster();
        expect(first).toBe(calc.clusterList[0]);
        first!.setConnection(instance);

        const second = calc.getNextCluster();
        expect(second).toBe(calc.clusterList[1]);
    });

    it('getNextCluster returns undefined once all clusters are used', () => {
        const calc = new ClusterCalculator(1, 1);
        calc.clusterList[0].setConnection(fakeInstance(1));
        expect(calc.getNextCluster()).toBeUndefined();
    });

    it('getClusterForConnection / getOldClusterForConnection filter by instanceID', () => {
        const calc = new ClusterCalculator(2, 1);
        const instanceA = fakeInstance(1);
        const instanceB = fakeInstance(2);

        calc.clusterList[0].setConnection(instanceA);
        calc.clusterList[0].markStarting();
        calc.clusterList[0].markConnected();
        calc.clusterList[1].setConnection(instanceB);

        expect(calc.getClusterForConnection(instanceA)).toEqual([calc.clusterList[0]]);
        expect(calc.getClusterForConnection(instanceB)).toEqual([calc.clusterList[1]]);

        calc.clusterList[0].reclustering(instanceB);
        expect(calc.getOldClusterForConnection(instanceA)).toEqual([calc.clusterList[0]]);
    });

    it('checkAllClustersConnected is true only when every cluster is CONNECTED', () => {
        const calc = new ClusterCalculator(2, 1);
        expect(calc.checkAllClustersConnected()).toBe(false);

        calc.clusterList.forEach((c) => {
            c.setConnection(fakeInstance(1));
            c.markStarting();
            c.markConnected();
        });
        expect(calc.checkAllClustersConnected()).toBe(true);
    });

    it('clearClusterConnection disconnects the given cluster by id', () => {
        const calc = new ClusterCalculator(1, 1);
        calc.clusterList[0].setConnection(fakeInstance(1));
        calc.clearClusterConnection(calc.clusterList[0].clusterID);
        expect(calc.clusterList[0].connection).toBeUndefined();
        expect(calc.clusterList[0].connectionStatus).toBe(BridgeClusterConnectionStatus.DISCONNECTED);
    });

    it('getClusterOfShard finds the cluster owning a shard id', () => {
        const calc = new ClusterCalculator(2, 2); // shards [0,1] and [2,3]
        expect(calc.getClusterOfShard(0)).toBe(calc.clusterList[0]);
        expect(calc.getClusterOfShard(3)).toBe(calc.clusterList[1]);
        expect(calc.getClusterOfShard(99)).toBeUndefined();
    });

    it('getClusterWithLowestLoad picks the READY, non-dev instance with fewest assigned clusters', () => {
        const calc = new ClusterCalculator(3, 1);
        const light = fakeInstance(1);
        const heavy = fakeInstance(2);

        calc.clusterList[0].setConnection(heavy);
        calc.clusterList[1].setConnection(heavy);
        calc.clusterList[2].setConnection(light);

        const connections = new Map([
            ['a', light],
            ['b', heavy],
        ]);

        expect(calc.getClusterWithLowestLoad(connections)).toBe(light);
    });

    it('getClusterWithLowestLoad ignores dev instances', () => {
        const calc = new ClusterCalculator(1, 1);
        const devInstance = fakeInstance(1, true);
        const connections = new Map([['a', devInstance]]);

        expect(calc.getClusterWithLowestLoad(connections)).toBeUndefined();
    });

    it('findMostAndLeastClustersForConnections finds an imbalance beyond the remainder', () => {
        const calc = new ClusterCalculator(4, 1);
        const heavy = fakeInstance(1);
        const light = fakeInstance(2);

        // heavy owns 3 clusters, light owns 1 -> remainder for 4 clusters / 2 clients = 0
        calc.clusterList[0].setConnection(heavy);
        calc.clusterList[1].setConnection(heavy);
        calc.clusterList[2].setConnection(heavy);
        calc.clusterList[3].setConnection(light);

        const { most, least } = calc.findMostAndLeastClustersForConnections([heavy, light]);
        expect(most).toBe(heavy);
        expect(least).toBe(light);
    });

    it('findMostAndLeastClustersForConnections returns undefined/undefined when within remainder', () => {
        const calc = new ClusterCalculator(2, 1);
        const a = fakeInstance(1);
        const b = fakeInstance(2);

        calc.clusterList[0].setConnection(a);
        calc.clusterList[1].setConnection(b);

        const { most, least } = calc.findMostAndLeastClustersForConnections([a, b]);
        expect(most).toBeUndefined();
        expect(least).toBeUndefined();
    });
});
