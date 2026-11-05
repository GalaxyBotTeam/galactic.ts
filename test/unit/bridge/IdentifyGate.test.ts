import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDENTIFY_WINDOW_MS, IdentifyGate } from '../../../src/bridge/IdentifyGate';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('IdentifyGate', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('without max_concurrency every shard waits for the one before', () => {
        const gate = new IdentifyGate();

        expect(gate.tryAcquire([0])).toBe(true);
        expect(gate.tryAcquire([1])).toBe(false);

        vi.advanceTimersByTime(IDENTIFY_WINDOW_MS);
        expect(gate.tryAcquire([1])).toBe(true);
    });

    it('a cluster with several shards in one key holds it for all of their identifies', () => {
        const gate = new IdentifyGate();
        expect(gate.tryAcquire([0, 1])).toBe(true);

        vi.advanceTimersByTime(IDENTIFY_WINDOW_MS);
        expect(gate.tryAcquire([2])).toBe(false);

        vi.advanceTimersByTime(IDENTIFY_WINDOW_MS);
        expect(gate.tryAcquire([2])).toBe(true);
    });

    it('clusters in different keys start together', () => {
        const gate = new IdentifyGate();
        gate.setMaxConcurrency(16);

        expect(gate.tryAcquire(range(0, 7))).toBe(true);
        expect(gate.tryAcquire(range(8, 15))).toBe(true);
    });

    it('the next bucket waits for the window of the one before', () => {
        const gate = new IdentifyGate();
        gate.setMaxConcurrency(16);
        expect(gate.tryAcquire(range(0, 15))).toBe(true);

        expect(gate.tryAcquire(range(16, 31))).toBe(false);

        vi.advanceTimersByTime(IDENTIFY_WINDOW_MS);
        expect(gate.tryAcquire(range(16, 31))).toBe(true);
    });

    it('acquire queues callers in the order they asked', async () => {
        const gate = new IdentifyGate();
        const order: number[] = [];

        const first = gate.acquire([0]).then(() => order.push(1));
        const second = gate.acquire([1]).then(() => order.push(2));

        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual([1]);

        await vi.advanceTimersByTimeAsync(IDENTIFY_WINDOW_MS);
        await Promise.all([first, second]);
        expect(order).toEqual([1, 2]);
    });

    it('a changed max_concurrency drops the reservations of the old keys', () => {
        const gate = new IdentifyGate();
        gate.tryAcquire([0]);

        gate.setMaxConcurrency(16);

        expect(gate.tryAcquire([1])).toBe(true);
    });
});
