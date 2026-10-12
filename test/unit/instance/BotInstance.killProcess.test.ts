import { describe, expect, it, vi } from 'vitest';
import { BotInstance } from '../../../src/instance/BotInstance';
import { ClusterProcess } from '../../../src/cluster/ClusterProcess';

class TestInstance extends BotInstance {
    public constructor() {
        super('entry.js');
    }

    public setClusterStopped = vi.fn();
    setClusterReady(): void {}
    setClusterSpawned(): void {}
    start(): void {}
    protected async forwardGuildRequestElsewhere(): Promise<unknown> { return undefined; }
    protected forwardGuildMessageElsewhere(): void {}
    protected async broadcastEvalAcrossClusters(): Promise<unknown[]> { return []; }

    public kill(clusterProcess: ClusterProcess, reason: string) {
        return this.killProcess(clusterProcess, reason);
    }
}

function setup() {
    const instance = new TestInstance();
    let finishKill!: () => void;
    const lifecycleKill = vi.fn(() => new Promise<void>((resolve) => { finishKill = resolve; }));
    (instance as any).lifecycle = { kill: lifecycleKill };
    const cp = { id: 1 } as unknown as ClusterProcess;
    instance.clusters.set(1, cp);
    return { instance, cp, lifecycleKill, finish: () => finishKill() };
}

describe('BotInstance.killProcess', () => {
    it('coalesces a second kill for the same cluster while the first is still in flight', async () => {
        const { instance, cp, lifecycleKill, finish } = setup();

        const first = instance.kill(cp, 'explicit');
        const second = instance.kill(cp, 'Process exited: 0 null'); // what the exit event triggers

        expect(second).toBe(first);
        finish();
        await Promise.all([first, second]);

        expect(lifecycleKill).toHaveBeenCalledTimes(1);
        expect(instance.setClusterStopped).toHaveBeenCalledTimes(1);
        expect(instance.setClusterStopped).toHaveBeenCalledWith(cp, 'explicit');
        expect(instance.clusters.has(1)).toBe(false);
    });

    it('allows a new kill once the previous one has completed', async () => {
        const { instance, cp, lifecycleKill, finish } = setup();

        const first = instance.kill(cp, 'a');
        finish();
        await first;

        const second = instance.kill(cp, 'b');
        finish();
        await second;

        expect(lifecycleKill).toHaveBeenCalledTimes(2);
        expect(instance.setClusterStopped).toHaveBeenCalledTimes(2);
    });
});
