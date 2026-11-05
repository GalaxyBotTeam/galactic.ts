import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkShardCount, fetchGatewayInfo, type GatewayInfo } from '../../../src/bridge/GatewayInfo';

function info(shards: number, maxConcurrency: number, remaining = 1000): GatewayInfo {
    return {
        url: 'wss://gateway.discord.gg/',
        shards,
        session_start_limit: { total: 1000, remaining, reset_after: 90_000, max_concurrency: maxConcurrency },
    };
}

describe('checkShardCount', () => {
    it('accepts a fitting shard count', () => {
        expect(checkShardCount(info(16, 16), 32)).toEqual([]);
    });

    it('warns when fewer shards than recommended are configured', () => {
        expect(checkShardCount(info(9, 1), 8)).toEqual([expect.stringContaining('recommends 9')]);
    });

    it('warns about a count that large bot sharding would reject', () => {
        expect(checkShardCount(info(16, 16), 20)).toEqual([expect.stringContaining('multiple of max_concurrency 16')]);
    });

    it('does not ask small bots for a multiple', () => {
        expect(checkShardCount(info(3, 1), 3)).toEqual([]);
    });

    it('warns when the session starts do not cover all shards', () => {
        expect(checkShardCount(info(4, 1, 3), 4)).toEqual([expect.stringContaining('resets in 2 minutes')]);
    });
});

describe('fetchGatewayInfo', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('reads the limits with the bot token', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => info(16, 16) });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchGatewayInfo('abc')).resolves.toEqual(info(16, 16));
        expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bot abc' });
    });

    it('rejects on an error status', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

        await expect(fetchGatewayInfo('abc')).rejects.toThrow('401');
    });
});
