import { describe, expect, it, vi } from 'vitest';
import { createClusterRequestHandler, sampleHeartbeat, SELF_DESTRUCT_EXIT_GRACE_MS } from '../../../src/cluster/ClusterRequestHandler';

function fakeClient(overrides: Partial<any> = {}) {
    return {
        ws: { ping: 42, shards: new Map() },
        guilds: { cache: { filter: () => ({ size: 0, reduce: () => 0 }) } },
        shard: undefined,
        ...overrides,
    } as any;
}

describe('sampleHeartbeat', () => {
    it('resolves with cpu/memory/ping data after the sampling window', async () => {
        vi.useFakeTimers();
        try {
            const client = fakeClient();
            const promise = sampleHeartbeat(client);
            await vi.advanceTimersByTimeAsync(500);
            const result = await promise;

            expect(result.ping).toBe(42);
            expect(result.cpu.cpuPercent).toBeTypeOf('string');
            expect(result.memory.usage).toMatch(/MB$/);
            expect(result.shardPings).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('createClusterRequestHandler', () => {
    it('CUSTOM delegates to the registered custom handler', async () => {
        const client = fakeClient();
        const handler = createClusterRequestHandler({
            getClient: () => client,
            getCustomHandler: () => (data, resolve) => resolve(`echo:${data}`),
            selfDestruct: vi.fn(),
        });

        const result = await handler({ type: 'CUSTOM', data: 'hi' }, 5000);
        expect(result).toBe('echo:hi');
    });

    it('CUSTOM with no registered handler returns undefined', async () => {
        const handler = createClusterRequestHandler({
            getClient: () => fakeClient(),
            getCustomHandler: () => undefined,
            selfDestruct: vi.fn(),
        });

        const result = await handler({ type: 'CUSTOM', data: 'hi' }, 5000);
        expect(result).toBeUndefined();
    });

    it('BROADCAST_EVAL evaluates the function against the client and returns its result', async () => {
        const client = fakeClient();
        const handler = createClusterRequestHandler({
            getClient: () => client,
            getCustomHandler: () => undefined,
            selfDestruct: vi.fn(),
        });

        const result = await handler({ type: 'BROADCAST_EVAL', data: '(client) => client.ws.ping' }, 5000);
        expect(result).toBe(42);
    });

    it('SELF_DESTRUCT shuts down, resolves first (so the response can be flushed) and exits after the grace period', async () => {
        vi.useFakeTimers();
        try {
            const selfDestruct = vi.fn().mockResolvedValue(undefined);
            const exit = vi.fn();
            const handler = createClusterRequestHandler({
                getClient: () => fakeClient(),
                getCustomHandler: () => undefined,
                selfDestruct,
                exit,
            });

            await handler({ type: 'SELF_DESTRUCT', reason: 'test' }, 5000);

            expect(selfDestruct).toHaveBeenCalledWith('test');
            expect(exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(SELF_DESTRUCT_EXIT_GRACE_MS);
            expect(exit).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('REDIRECT_REQUEST_TO_GUILD is rejected (child never receives this, only sends it)', async () => {
        const handler = createClusterRequestHandler({
            getClient: () => fakeClient(),
            getCustomHandler: () => undefined,
            selfDestruct: vi.fn(),
        });

        await expect(handler({ type: 'REDIRECT_REQUEST_TO_GUILD', guildID: '1', data: {} }, 5000)).rejects.toThrow();
    });
});
