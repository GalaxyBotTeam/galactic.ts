import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Cluster } from '../../../src/cluster/Cluster';
import { INVALID_SHARD_COUNT_ERROR } from '../../../src/protocol/shared';

function setup() {
    const cluster = new Cluster<any>(1, 0, [0], 1, 'token', []);
    const triggerError = vi.spyOn(cluster, 'triggerError').mockResolvedValue();
    const client = new EventEmitter();
    cluster.client = client;
    return { cluster, client, triggerError };
}

describe('Cluster client', () => {
    it('keeps the client it was given', () => {
        const { cluster, client } = setup();
        expect(cluster.client).toBe(client);
    });

    it('reports close code 4010 as a cluster error', () => {
        const { client, triggerError } = setup();

        client.emit('shardDisconnect', { code: 4010 }, 0);

        expect(triggerError).toHaveBeenCalledWith(new Error(INVALID_SHARD_COUNT_ERROR));
    });

    it('ignores other close codes', () => {
        const { client, triggerError } = setup();

        client.emit('shardDisconnect', { code: 4004 }, 0);

        expect(triggerError).not.toHaveBeenCalled();
    });

    it('accepts a client without an event emitter', () => {
        const cluster = new Cluster<any>(1, 0, [0], 1, 'token', []);
        expect(() => { cluster.client = { ws: {} }; }).not.toThrow();
    });
});
