import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fork, ForkOptions } from 'child_process';
import { ProcessSpawner } from '../../../src/instance/ProcessSpawner';
import { ManagedInstance } from '../../../src/instance/ManagedInstance';
import { StandaloneInstance } from '../../../src/instance/StandaloneInstance';
import { SpawnParams } from '../../../src/protocol/processEnv';

vi.mock('child_process', () => ({ fork: vi.fn() }));

const params: SpawnParams = {
    instanceID: 1,
    clusterID: 2,
    shardList: [4, 5],
    totalShards: 12,
    token: 'real-token',
    intents: ['Guilds'],
    serving: true,
};

const events = { onSpawned: vi.fn(), onError: vi.fn(), onExit: vi.fn() };

function forkedEnv(): NodeJS.ProcessEnv {
    return (vi.mocked(fork).mock.calls[0][1] as ForkOptions).env!;
}

describe('child process env', () => {
    beforeEach(() => {
        vi.mocked(fork).mockReset();
        vi.mocked(fork).mockImplementation(() => new EventEmitter() as any);
    });

    it('merges custom variables into the forked environment', () => {
        new ProcessSpawner('entry.js', [], { DATABASE_URL: 'postgres://db' }).spawn(params, events);

        expect(forkedEnv()).toMatchObject({ DATABASE_URL: 'postgres://db', CLUSTER_ID: '2', TOKEN: 'real-token' });
    });

    it('does not let custom variables override the cluster hand-off', () => {
        new ProcessSpawner('entry.js', [], { TOKEN: 'wrong', CLUSTER_ID: '99' }).spawn(params, events);

        expect(forkedEnv()).toMatchObject({ TOKEN: 'real-token', CLUSTER_ID: '2' });
    });

    it('forwards only the hand-off variables by default', () => {
        new ProcessSpawner('entry.js').spawn(params, events);

        expect(Object.keys(forkedEnv()).sort()).toEqual(
            ['CLUSTER_ID', 'FORCE_COLOR', 'INSTANCE_ID', 'INTENTS', 'SERVING', 'SHARD_LIST', 'TOKEN', 'TOTAL_SHARDS'],
        );
    });

    it('StandaloneInstance passes env through to its clusters', () => {
        const instance = new StandaloneInstance('entry.js', 1, 1, 'token', [], [], { FOO: 'bar' });
        instance.start();

        expect(forkedEnv().FOO).toBe('bar');
    });

    it('ManagedInstance passes env through and keeps dev at its existing position', () => {
        const instance = new ManagedInstance('entry.js', '127.0.0.1', 1, 1, {}, [], true, { FOO: 'bar' }) as any;
        instance.startProcess(1, 2, [4], 12, 'token', []);

        expect(instance.dev).toBe(true);
        expect(forkedEnv().FOO).toBe('bar');
    });
});
