import { describe, expect, it, vi } from 'vitest';
import { Cluster } from '../../../src/cluster/Cluster';
import { ClusterProcess } from '../../../src/cluster/ClusterProcess';

function cluster(serving?: boolean) {
    const c = new Cluster<any>(1, 0, [0], 1, 'token', [], serving) as any;
    const listener = vi.fn();
    c.on('SERVING', listener);
    return { c, listener };
}

describe('Cluster.serving', () => {
    it('serves from the start unless it was started for a move', () => {
        expect(cluster().c.serving).toBe(true);
        expect(cluster(false).c.serving).toBe(false);
    });

    it('starts serving on CLUSTER_SERVING and reports it once', () => {
        const { c, listener } = cluster(false);

        c.onMessage({ type: 'CLUSTER_SERVING', serving: true });
        c.onMessage({ type: 'CLUSTER_SERVING', serving: true });

        expect(c.serving).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(true);
    });

    it('stops serving when asked to stop, before onSelfDestruct runs', async () => {
        const { c, listener } = cluster();
        let servingDuringCleanup: boolean | undefined;
        c.onSelfDestruct = () => { servingDuringCleanup = c.serving; };

        await c.shutdown('test');

        expect(servingDuringCleanup).toBe(false);
        expect(listener).toHaveBeenCalledWith(false);
    });

    it('never serves again once it is stopping', async () => {
        const { c } = cluster(false);
        await c.shutdown('test');

        c.onMessage({ type: 'CLUSTER_SERVING', serving: true });

        expect(c.serving).toBe(false);
    });
});

describe('ClusterProcess.setServing', () => {
    function process(serving: boolean) {
        const child = { on: vi.fn(), send: vi.fn((_m, _h, _o, cb) => cb(null)), pid: 1, exitCode: null } as any;
        return { cp: new ClusterProcess(1, child, [0], 1, serving), child };
    }

    it('tells the child once', async () => {
        const { cp, child } = process(false);

        await cp.setServing();
        await cp.setServing();

        expect(cp.serving).toBe(true);
        expect(child.send).toHaveBeenCalledTimes(1);
        expect(child.send.mock.calls[0][0]).toMatchObject({ type: 'message', data: { type: 'CLUSTER_SERVING', serving: true } });
    });

    it('sends nothing to a cluster that already serves', async () => {
        const { cp, child } = process(true);

        await cp.setServing();

        expect(child.send).not.toHaveBeenCalled();
    });
});
