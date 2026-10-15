import { describe, expect, it } from 'vitest';
import { rollingReload, sequentialRestart } from '../../../src/bridge/restartRoutines';
import type { RestartContext } from '../../../src/bridge/RestartCoordinator';

function fakeCtx(instances: number[], standby: number[] = []) {
    const calls: string[] = [];
    const ctx: RestartContext = {
        instances,
        standby,
        get: () => undefined,
        moveAllClusters: async (from, to) => { calls.push(`move:${from}>${to}`); },
        restart: async (id) => { calls.push(`restart:${id}`); },
    };
    return { ctx, calls };
}

describe('restart routines', () => {
    it('sequentialRestart restarts in ascending order by default', async () => {
        const { ctx, calls } = fakeCtx([1, 2]);
        await sequentialRestart()(ctx);
        expect(calls).toEqual(['restart:1', 'restart:2']);
    });

    it('sequentialRestart honours a custom order', async () => {
        const { ctx, calls } = fakeCtx([1, 2]);
        await sequentialRestart(ids => [...ids].reverse())(ctx);
        expect(calls).toEqual(['restart:2', 'restart:1']);
    });

    it('rollingReload rolls through the standby', async () => {
        const { ctx, calls } = fakeCtx([1, 2, 3], [9]);
        await rollingReload()(ctx);
        expect(calls).toEqual(['restart:9', 'move:1>9', 'restart:1', 'move:2>1', 'restart:2', 'move:3>2', 'restart:3', 'move:9>3']);
    });

    it('rollingReload with only the standby restarts just the standby', async () => {
        const { ctx, calls } = fakeCtx([], [9]);
        await rollingReload()(ctx);
        expect(calls).toEqual(['restart:9']);
    });

    it('rollingReload throws without exactly one standby', async () => {
        for (const standby of [[], [8, 9]]) {
            const { ctx, calls } = fakeCtx([1], standby);
            await expect(rollingReload()(ctx)).rejects.toThrow(/exactly one standby/);
            expect(calls).toEqual([]);
        }
    });

    it('order returning unknown or duplicate IDs throws before any step', async () => {
        for (const order of [() => [1, 1], () => [99]]) {
            for (const routine of [sequentialRestart(order), rollingReload(order)]) {
                const { ctx, calls } = fakeCtx([1, 2], [9]);
                await expect(routine(ctx)).rejects.toThrow(/unknown or duplicate/);
                expect(calls).toEqual([]);
            }
        }
    });
});
