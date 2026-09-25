import { describe, expect, it, vi } from 'vitest';
import { BotInstance } from '../../../src/instance/BotInstance';
import { ClusterProcess } from '../../../src/cluster/ClusterProcess';

class TestInstance extends BotInstance {
    public constructor(entryPoint: string) {
        super(entryPoint);
    }

    public setClusterReady = vi.fn();
    setClusterStopped(): void {}
    setClusterSpawned(): void {}
    start(): void {}
    protected async forwardGuildRequestElsewhere(): Promise<unknown> { return undefined; }
    protected forwardGuildMessageElsewhere(): void {}
    protected async broadcastEvalAcrossClusters(): Promise<unknown[]> { return []; }

    public callOnMessage(clusterProcess: ClusterProcess, message: any) {
        return (this as any).onMessage(clusterProcess, message);
    }
}

/** A ClusterProcess over a fake child handle - enough for the state machine, no real fork. */
function realClusterProcess() {
    const fakeChild = { on: vi.fn(), send: vi.fn(), pid: 1, exitCode: null } as any;
    return new ClusterProcess(1, fakeChild, [0], 1);
}

describe('BotInstance.onMessage CLUSTER_READY', () => {
    it('marks a starting cluster running and notifies the subclass', () => {
        const instance = new TestInstance('entry.js');
        const cp = realClusterProcess();

        instance.callOnMessage(cp, { type: 'CLUSTER_READY', id: 1, guilds: 2, members: 3 });

        expect(cp.status).toBe('running');
        expect(instance.setClusterReady).toHaveBeenCalledWith(cp, 2, 3);
    });

    it('ignores CLUSTER_READY from a cluster that is already being torn down', () => {
        const instance = new TestInstance('entry.js');
        const cp = realClusterProcess();
        cp.markStopped();

        expect(() => instance.callOnMessage(cp, { type: 'CLUSTER_READY', id: 1, guilds: 0, members: 0 })).not.toThrow();

        expect(cp.status).toBe('stopped');
        expect(instance.setClusterReady).not.toHaveBeenCalled();
    });

    it('tolerates a duplicate CLUSTER_READY', () => {
        const instance = new TestInstance('entry.js');
        const cp = realClusterProcess();

        instance.callOnMessage(cp, { type: 'CLUSTER_READY', id: 1, guilds: 0, members: 0 });
        expect(() => instance.callOnMessage(cp, { type: 'CLUSTER_READY', id: 1, guilds: 0, members: 0 })).not.toThrow();

        expect(cp.status).toBe('running');
    });
});
