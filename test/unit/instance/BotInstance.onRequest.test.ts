import { describe, expect, it, vi } from 'vitest';
import { BotInstance } from '../../../src/instance/BotInstance';
import { ClusterProcess } from '../../../src/cluster/ClusterProcess';

/** Minimal concrete BotInstance exposing the two abstract hooks as spies for assertions. */
class TestInstance extends BotInstance {
    public constructor(entryPoint: string) {
        super(entryPoint);
    }

    public forwardGuildRequestElsewhere = vi.fn(async (_guildID: string, _data: unknown, _timeout: number) => 'forwarded');
    public forwardGuildMessageElsewhere = vi.fn();
    public broadcastEvalAcrossClusters = vi.fn(async (_data: string, _timeout: number) => ['broadcast-result']);

    setClusterStopped(): void {}
    setClusterReady(): void {}
    setClusterSpawned(): void {}
    start(): void {}

    public callOnRequest(clusterProcess: ClusterProcess, message: any, timeout: number) {
        return (this as any).onRequest(clusterProcess, message, timeout);
    }
}

function fakeClusterProcess(shardList: number[], totalShards: number, requestResult: unknown = 'local-result') {
    return {
        shardList,
        totalShards,
        eventManager: { request: vi.fn().mockResolvedValue(requestResult) },
    } as unknown as ClusterProcess;
}

describe('BotInstance.onRequest template method', () => {
    it('routes REDIRECT_REQUEST_TO_GUILD to the local cluster when the shard is owned locally', async () => {
        const instance = new TestInstance('entry.js');
        // guild "175928847299117063" with totalShards=1 always maps to shard 0
        const clusterProcess = fakeClusterProcess([0], 1);

        const result = await instance.callOnRequest(clusterProcess, {
            type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '175928847299117063', data: { x: 1 },
        }, 5000);

        expect(result).toBe('local-result');
        expect(clusterProcess.eventManager.request).toHaveBeenCalledWith({ type: 'CUSTOM', data: { x: 1 } }, 5000);
        expect(instance.forwardGuildRequestElsewhere).not.toHaveBeenCalled();
    });

    it('calls forwardGuildRequestElsewhere when the shard is not owned locally', async () => {
        const instance = new TestInstance('entry.js');
        const clusterProcess = fakeClusterProcess([99], 1); // shard 0 never in [99]

        const result = await instance.callOnRequest(clusterProcess, {
            type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '175928847299117063', data: { x: 1 },
        }, 5000);

        expect(result).toBe('forwarded');
        expect(instance.forwardGuildRequestElsewhere).toHaveBeenCalledWith('175928847299117063', { x: 1 }, 5000);
    });

    it('routes BROADCAST_EVAL to broadcastEvalAcrossClusters', async () => {
        const instance = new TestInstance('entry.js');
        const clusterProcess = fakeClusterProcess([0], 1);

        const result = await instance.callOnRequest(clusterProcess, { type: 'BROADCAST_EVAL', data: '() => 1' }, 5000);

        expect(result).toEqual(['broadcast-result']);
        expect(instance.broadcastEvalAcrossClusters).toHaveBeenCalledWith('() => 1', 5000);
    });

    it('rejects CUSTOM when no request listener is registered', async () => {
        const instance = new TestInstance('entry.js');
        const clusterProcess = fakeClusterProcess([0], 1);

        await expect(instance.callOnRequest(clusterProcess, { type: 'CUSTOM', data: {} }, 5000)).rejects.toThrow();
    });

    it('invokes the registered CUSTOM request listener with resolve/reject', async () => {
        const instance = new TestInstance('entry.js');
        const clusterProcess = fakeClusterProcess([0], 1);
        instance.on('request', (_cp: ClusterProcess, data: unknown, resolve: (data: unknown) => void) => resolve(`handled:${JSON.stringify(data)}`));

        const result = await instance.callOnRequest(clusterProcess, { type: 'CUSTOM', data: { a: 1 } }, 5000);

        expect(result).toBe('handled:{"a":1}');
    });

    it('rejects incoming CLUSTER_HEARTBEAT/SELF_DESTRUCT requests (parent never legitimately receives these)', async () => {
        const instance = new TestInstance('entry.js');
        const clusterProcess = fakeClusterProcess([0], 1);

        await expect(instance.callOnRequest(clusterProcess, { type: 'CLUSTER_HEARTBEAT' }, 5000)).rejects.toThrow();
        await expect(instance.callOnRequest(clusterProcess, { type: 'SELF_DESTRUCT', reason: 'x' }, 5000)).rejects.toThrow();
    });
});
