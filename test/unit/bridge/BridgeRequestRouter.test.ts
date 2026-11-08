import { describe, expect, it, vi } from 'vitest';
import { createBridgeRequestHandler } from '../../../src/bridge/BridgeRequestRouter';
import { BridgeClusterConnection } from '../../../src/bridge/BridgeClusterConnection';

const fakeInstance = (response = 'guild-response') => ({ eventManager: { request: vi.fn().mockResolvedValue(response) } }) as any;

function fakeConnectedCluster(clusterID: number) {
    const cluster = new BridgeClusterConnection(clusterID, [0]);
    cluster.setConnection(fakeInstance());
    cluster.markStarting();
    cluster.markConnected();
    return cluster;
}

function setup(overrides: Partial<{ calculator: any; connectedInstances: Map<string, any> }> = {}) {
    const calculator = overrides.calculator ?? {
        getClusterOfShard: vi.fn(),
        getClusterForConnection: vi.fn().mockReturnValue([]),
        getOldClusterForConnection: vi.fn().mockReturnValue([]),
    };
    const connectedInstances = overrides.connectedInstances ?? new Map();
    const connection = {} as any;
    const onResume = vi.fn().mockReturnValue({ keep: [1] });
    const handler = createBridgeRequestHandler(connection, { calculator, connectedInstances, totalShards: () => 1, onResume });
    return { handler, calculator, connectedInstances, connection, onResume };
}

describe('BridgeRequestRouter', () => {
    it('REDIRECT_REQUEST_TO_GUILD forwards to the connected owning cluster', async () => {
        const cluster = fakeConnectedCluster(1);
        const { handler } = setup({ calculator: { getClusterOfShard: vi.fn().mockReturnValue(cluster) } });

        const result = await handler({ type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '123', data: { x: 1 } }, 5000);

        expect(result).toBe('guild-response');
        expect(cluster.connection!.eventManager.request).toHaveBeenCalledWith(
            { type: 'REDIRECT_REQUEST_TO_GUILD', clusterID: 1, guildID: '123', data: { x: 1 } }, 5000);
    });

    it('REDIRECT_REQUEST_TO_GUILD rejects when no cluster owns the shard', async () => {
        const { handler } = setup({ calculator: { getClusterOfShard: vi.fn().mockReturnValue(undefined) } });

        await expect(handler({ type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '123', data: {} }, 5000)).rejects.toThrow('cluster not found');
    });

    it('REDIRECT_REQUEST_TO_GUILD rejects while a cluster starts for the first time', async () => {
        const cluster = new BridgeClusterConnection(1, [0]);
        cluster.setConnection(fakeInstance());
        cluster.markStarting();
        const { handler } = setup({ calculator: { getClusterOfShard: vi.fn().mockReturnValue(cluster) } });

        await expect(handler({ type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '123', data: {} }, 5000)).rejects.toThrow('not connected');
    });

    it('REDIRECT_REQUEST_TO_GUILD stays on the old instance while the cluster moves', async () => {
        const cluster = fakeConnectedCluster(1);
        const newInstance = fakeInstance('new');
        cluster.reclustering(newInstance);
        cluster.markStarting();
        const { handler } = setup({ calculator: { getClusterOfShard: vi.fn().mockReturnValue(cluster) } });

        await expect(handler({ type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '123', data: {} }, 5000)).resolves.toBe('guild-response');
        expect(newInstance.eventManager.request).not.toHaveBeenCalled();
    });

    it('BROADCAST_EVAL fans out to every connected instance and flattens the results', async () => {
        const instanceA = { eventManager: { request: vi.fn().mockResolvedValue([1, 2]) } };
        const instanceB = { eventManager: { request: vi.fn().mockResolvedValue([3]) } };
        const connectedInstances = new Map([['a', instanceA], ['b', instanceB]]);
        const { handler } = setup({ connectedInstances });

        const result = await handler({ type: 'BROADCAST_EVAL', data: 'fn' }, 5000);

        expect(result).toEqual([1, 2, 3]);
    });

    it('SELF_CHECK returns the cluster ids owned (current + old) by this connection', () => {
        const calculator = {
            getClusterForConnection: vi.fn().mockReturnValue([{ clusterID: 1 }, { clusterID: 2 }]),
            getOldClusterForConnection: vi.fn().mockReturnValue([{ clusterID: 3 }]),
        };
        const { handler } = setup({ calculator });

        const result = handler({ type: 'SELF_CHECK' }, 5000);

        expect(result).toEqual({ clusterList: [1, 2, 3] });
    });

    it('INSTANCE_RESUME is answered by the resumer for this connection', () => {
        const { handler, onResume, connection } = setup();
        const clusters = [{ id: 1, shardList: [0], totalShards: 1, running: true }];

        expect(handler({ type: 'INSTANCE_RESUME', data: { clusters } }, 5000)).toEqual({ keep: [1] });
        expect(onResume).toHaveBeenCalledWith(connection, clusters);
    });

    it('CLUSTER_HEARTBEAT as an incoming request is rejected (Bridge only ever sends this)', async () => {
        const { handler } = setup();
        await expect(handler({ type: 'CLUSTER_HEARTBEAT', data: { clusterID: 1 } }, 5000)).rejects.toThrow();
    });

    it('a request type this version does not know is answered with a rejection, not thrown', async () => {
        const { handler } = setup();

        let result: unknown;
        expect(() => { result = handler({ type: 'NOT_REAL' } as any, 5000); }).not.toThrow();
        await expect(result).rejects.toThrow(/NOT_REAL/);
    });
});
