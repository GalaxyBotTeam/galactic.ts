import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../../src/bridge/Bridge';
import { IDENTIFY_SPACING_MS } from '../../../src/bridge/IdentifyGate';
import { BridgeInstanceConnection } from '../../../src/bridge/BridgeInstanceConnection';

function setup(clusters: number, shardsPerCluster: number, maxConcurrency: number) {
    const bridge = new Bridge(0, 'token', [], shardsPerCluster, clusters, 1000) as any;
    const instance = new BridgeInstanceConnection(1, { id: 'c', connection: { closed: false }, send: async () => {} } as any, undefined, false);
    bridge.bridgeServer.connectedInstances.set('c', instance);
    bridge.gate.setMaxConcurrency(maxConcurrency);
    return bridge;
}

const started = (bridge: any) => bridge.getClusters().filter((c: any) => c.connection).length;

describe('Bridge cluster starts', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('starts a whole bucket at once, then waits for the next window', () => {
        vi.useFakeTimers();
        const bridge = setup(8, 4, 16);

        bridge.checkCreate();
        expect(started(bridge)).toBe(4);

        vi.advanceTimersByTime(IDENTIFY_SPACING_MS - 1);
        bridge.checkCreate();
        expect(started(bridge)).toBe(4);

        vi.advanceTimersByTime(1);
        bridge.checkCreate();
        expect(started(bridge)).toBe(8);
    });

    it('stops starting clusters after Discord rejected the shard count', () => {
        const bridge = setup(2, 1, 16);
        const errors: string[] = [];
        bridge.on('ERROR', (e: string) => errors.push(e));

        bridge.onInvalidShardCount();
        bridge.onInvalidShardCount();
        bridge.checkCreate();

        expect(started(bridge)).toBe(0);
        expect(errors).toEqual([expect.stringContaining('4010')]);
    });

    it('takes max_concurrency from Discord and reports what it read', async () => {
        const info = { url: 'wss://x', shards: 16, session_start_limit: { total: 2000, remaining: 2000, reset_after: 1, max_concurrency: 16 } };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => info }));
        const bridge = setup(4, 4, 1);
        const seen: unknown[] = [];
        bridge.on('GATEWAY_INFO', (i: unknown) => seen.push(i));

        await bridge.refreshGatewayInfo();
        bridge.checkCreate();

        expect(seen).toEqual([info]);
        expect(started(bridge)).toBe(4);
    });

    it('keeps going with the safe pace if Discord does not answer', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const bridge = setup(2, 1, 1);
        const errors: string[] = [];
        bridge.on('ERROR', (e: string) => errors.push(e));

        await bridge.refreshGatewayInfo();
        bridge.checkCreate();

        expect(errors).toEqual([expect.stringContaining('offline')]);
        expect(started(bridge)).toBe(1);
    });
});
