import { describe, expect, it } from 'vitest';
import { ShardingUtil } from '../../../src/domain/ShardingUtil';

describe('ShardingUtil.getShardIDForGuild', () => {
    it('computes the discord shard id from a snowflake', () => {
        // (guildID >> 22) % totalShards, per Discord's sharding formula
        expect(ShardingUtil.getShardIDForGuild('41771983423143937', 8)).toBe(6);
    });

    it('wraps around totalShards', () => {
        const shardID = ShardingUtil.getShardIDForGuild('175928847299117063', 2);
        expect(shardID).toBeGreaterThanOrEqual(0);
        expect(shardID).toBeLessThan(2);
    });

    it('throws on empty guildID', () => {
        expect(() => ShardingUtil.getShardIDForGuild('', 4)).toThrow();
    });

    it('throws on non-positive totalShards', () => {
        expect(() => ShardingUtil.getShardIDForGuild('123', 0)).toThrow();
        expect(() => ShardingUtil.getShardIDForGuild('123', -1)).toThrow();
    });
});
