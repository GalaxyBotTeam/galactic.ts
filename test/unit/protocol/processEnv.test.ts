import { describe, expect, it } from 'vitest';
import { decodeEnv, encodeEnv, SpawnParams } from '../../../src/protocol/processEnv';

describe('processEnv', () => {
    const params: SpawnParams = {
        instanceID: 1,
        clusterID: 2,
        shardList: [4, 5, 6],
        totalShards: 12,
        token: 'a-token',
        intents: ['Guilds', 'GuildMessages'] as any,
        serving: true,
    };

    it('round-trips through encode/decode', () => {
        const decoded = decodeEnv(encodeEnv(params) as NodeJS.ProcessEnv);
        expect(decoded).toEqual(params);
    });

    it('decodeEnv throws when a required variable is missing', () => {
        const env = encodeEnv(params) as NodeJS.ProcessEnv;
        delete env.TOKEN;
        expect(() => decodeEnv(env)).toThrow();
    });
});

describe('processEnv serving', () => {
    const base: SpawnParams = { instanceID: 1, clusterID: 2, shardList: [0], totalShards: 1, token: 't', intents: [], serving: false };

    it('round-trips a cluster started without serving', () => {
        expect(decodeEnv(encodeEnv(base) as NodeJS.ProcessEnv).serving).toBe(false);
    });

    it('serves when the parent of an older version did not set it', () => {
        const env = encodeEnv(base) as NodeJS.ProcessEnv;
        delete env.SERVING;
        expect(decodeEnv(env).serving).toBe(true);
    });
});
