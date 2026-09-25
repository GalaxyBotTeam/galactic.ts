import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneInstance } from '../../../src/instance/StandaloneInstance';
import { ClusterProcess } from '../../../src/cluster/ClusterProcess';

function setup() {
    const instance = new StandaloneInstance('entry.js', 1, 1, 'token', []) as any;
    instance.startProcess = vi.fn();
    const errors: string[] = [];
    instance.on('ERROR', (e: string) => errors.push(e));
    const cp = { id: 0, shardList: [0] } as unknown as ClusterProcess;
    return { instance, cp, errors };
}

describe('StandaloneInstance crash restarts', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('restarts with exponential backoff and never gives up', () => {
        const { instance, cp, errors } = setup();

        instance.setClusterStopped(cp, 'crash');
        vi.advanceTimersByTime(999);
        expect(instance.startProcess).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(instance.startProcess).toHaveBeenCalledTimes(1);

        for (let i = 2; i <= 8; i++) {
            instance.setClusterStopped(cp, 'crash');
            vi.advanceTimersByTime(60 * 1000); // >= the capped max backoff
            expect(instance.startProcess).toHaveBeenCalledTimes(i);
        }

        // attempts 6..8 exceed the crash-loop threshold and are flagged, but still restarted
        expect(errors).toHaveLength(3);
        expect(errors[0]).toMatch(/crash-looping/);
    });

    it('caps the backoff at 60s', () => {
        const { instance, cp } = setup();

        for (let i = 0; i < 7; i++) {
            instance.setClusterStopped(cp, 'crash');
            vi.advanceTimersByTime(60 * 1000);
        }
        expect(instance.startProcess).toHaveBeenCalledTimes(7);

        // 8th attempt would be 128s uncapped - must fire at exactly 60s
        instance.setClusterStopped(cp, 'crash');
        vi.advanceTimersByTime(60 * 1000 - 1);
        expect(instance.startProcess).toHaveBeenCalledTimes(7);
        vi.advanceTimersByTime(1);
        expect(instance.startProcess).toHaveBeenCalledTimes(8);
    });

    it('a ready cluster resets the attempt counter', () => {
        const { instance, cp, errors } = setup();

        for (let i = 0; i < 6; i++) {
            instance.setClusterStopped(cp, 'crash');
            vi.advanceTimersByTime(60 * 1000);
        }
        expect(errors).toHaveLength(1);

        instance.setClusterReady(cp);
        instance.setClusterStopped(cp, 'crash');
        vi.advanceTimersByTime(1000);

        expect(errors).toHaveLength(1);
        expect(instance.startProcess).toHaveBeenCalledTimes(7);
    });

    it('shutdown cancels a pending restart', async () => {
        const { instance, cp } = setup();

        instance.setClusterStopped(cp, 'crash');
        await instance.shutdown();
        vi.advanceTimersByTime(60 * 1000);

        expect(instance.startProcess).not.toHaveBeenCalled();
    });
});
