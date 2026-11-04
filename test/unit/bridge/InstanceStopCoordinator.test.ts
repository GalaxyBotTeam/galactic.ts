import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAIN_POLL_INTERVAL_MS, InstanceStopCoordinator } from '../../../src/bridge/InstanceStopCoordinator';
import { TypedEmitter } from '../../../src/general/TypedEmitter';

const connection = { instanceID: 1 } as any;

function coordinatorWith(getOldClusterForConnection: ReturnType<typeof vi.fn>) {
    return new InstanceStopCoordinator({ getOldClusterForConnection } as any, {} as any, new Map(), new TypedEmitter());
}

describe('InstanceStopCoordinator.waitForDrain', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waitForDrain resolves once no cluster has the instance as oldConnection', async () => {
        const getOld = vi.fn().mockReturnValueOnce([{}]).mockReturnValue([]);
        const drained = coordinatorWith(getOld).waitForDrain(connection);

        await vi.advanceTimersByTimeAsync(2 * DRAIN_POLL_INTERVAL_MS);
        await expect(drained).resolves.toBeUndefined();
    });

    it('waitForDrain rejects after timeoutMs and stops polling', async () => {
        const getOld = vi.fn().mockReturnValue([{}]);
        const drained = coordinatorWith(getOld).waitForDrain(connection, 5000);
        const assertion = expect(drained).rejects.toThrow(/drain/i);

        await vi.advanceTimersByTimeAsync(5000);
        await assertion;

        const calls = getOld.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(getOld.mock.calls.length).toBe(calls);
    });

    it('waitForDrain without timeout keeps waiting', async () => {
        const getOld = vi.fn().mockReturnValue([{}]);
        let settled = false;
        coordinatorWith(getOld).waitForDrain(connection).finally(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
    });
});
