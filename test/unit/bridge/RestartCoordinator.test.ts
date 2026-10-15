import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestartContext, RestartCoordinator, RestartStepError } from '../../../src/bridge/RestartCoordinator';
import { ClusterCalculator } from '../../../src/bridge/ClusterCalculator';
import { BridgeInstanceConnection } from '../../../src/bridge/BridgeInstanceConnection';
import { TypedEmitter } from '../../../src/general/TypedEmitter';
import type { BridgeEvents } from '../../../src/bridge/Bridge';

// Fake net-ipc Connection - only shape BridgeInstanceConnection/EventManager touch in these tests.
function fakeConnection(id: string) {
    return { id, connection: { closed: false }, send: async () => {} } as any;
}

function fakeInstance(instanceID: number, dev = false, standby = false) {
    return new BridgeInstanceConnection(instanceID, fakeConnection(`conn-${instanceID}`), undefined, dev, standby);
}

function setup(instances: BridgeInstanceConnection[], clusters = 3) {
    const connectedInstances = new Map(instances.map(i => [i.connection.id, i]));
    const calculator = new ClusterCalculator(clusters, 1);
    const events = new TypedEmitter<BridgeEvents>();
    const reclusterer = { steal: vi.fn() };
    const stopCoordinator = { stop: vi.fn().mockResolvedValue(undefined), waitForDrain: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new RestartCoordinator({ connectedInstances, calculator, reclusterer: reclusterer as any, stopCoordinator: stopCoordinator as any, events });
    return { coordinator, connectedInstances, calculator, events, reclusterer, stopCoordinator };
}

/** Runs `body` as a routine and returns the routine's outcome. */
function runWith(coordinator: RestartCoordinator, body: (ctx: RestartContext) => Promise<void>, stepTimeoutMs?: number) {
    return coordinator.run(body, { stepTimeoutMs });
}

describe('RestartCoordinator', () => {
    afterEach(() => vi.useRealTimers());

    it('exposes non-standby and standby IDs sorted, excluding dev', async () => {
        const { coordinator } = setup([fakeInstance(3), fakeInstance(1), fakeInstance(9, false, true), fakeInstance(5, true)]);
        let seen: { instances: readonly number[], standby: readonly number[] } | undefined;

        await runWith(coordinator, async (ctx) => { seen = { instances: ctx.instances, standby: ctx.standby }; });

        expect(seen).toEqual({ instances: [1, 3], standby: [9] });
    });

    it('restart resolves when the same instanceID reconnects', async () => {
        const { coordinator, events, stopCoordinator, connectedInstances } = setup([fakeInstance(1), fakeInstance(2)]);
        const steps: string[] = [];
        events.on('RESTART_STEP', (step, status) => steps.push(`${step.kind}:${status}`));
        stopCoordinator.stop.mockImplementation(async (conn: BridgeInstanceConnection) => {
            connectedInstances.delete(conn.connection.id);
            // Reconnect before stop() resolves - restart() must already be listening.
            const fresh = fakeInstance(conn.instanceID);
            connectedInstances.set(fresh.connection.id, fresh);
            events.emit('INSTANCE_CONNECTED', fresh);
        });

        await runWith(coordinator, ctx => ctx.restart(1));

        expect(stopCoordinator.stop).toHaveBeenCalledWith(expect.objectContaining({ instanceID: 1 }), true, 10 * 60 * 1000);
        expect(steps).toEqual(['restart:started', 'restart:done']);
    });

    it('restart rejects with RestartStepError after stepTimeoutMs', async () => {
        vi.useFakeTimers();
        const { coordinator } = setup([fakeInstance(1)]);

        const result = runWith(coordinator, ctx => ctx.restart(1), 1000);
        const assertion = expect(result).rejects.toSatisfy((e: unknown) =>
            e instanceof RestartStepError && e.step === 'restart' && e.instanceID === 1);

        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it('restart of an instance that is no longer connected rejects at once', async () => {
        const { coordinator, stopCoordinator } = setup([fakeInstance(1)]);

        await expect(runWith(coordinator, ctx => ctx.restart(42))).rejects.toBeInstanceOf(RestartStepError);
        expect(stopCoordinator.stop).not.toHaveBeenCalled();
    });

    it('moveAllClusters steals every CONNECTED cluster and waits for the drain', async () => {
        const a = fakeInstance(1);
        const b = fakeInstance(2);
        const { coordinator, calculator, reclusterer, stopCoordinator } = setup([a, b]);
        calculator.clusterList.forEach(c => c.setConnection(a));
        calculator.clusterList[0].markStarting();
        calculator.clusterList[0].markConnected();
        calculator.clusterList[1].markStarting();
        calculator.clusterList[1].markConnected();
        calculator.clusterList[2].markStarting();

        await runWith(coordinator, ctx => ctx.moveAllClusters(1, 2), 5000);

        expect(reclusterer.steal).toHaveBeenCalledTimes(2);
        expect(reclusterer.steal).toHaveBeenCalledWith(calculator.clusterList[0], b);
        expect(reclusterer.steal).toHaveBeenCalledWith(calculator.clusterList[1], b);
        expect(stopCoordinator.waitForDrain).toHaveBeenCalledWith(a, 5000);
    });

    it('moveAllClusters aborts immediately when the target disconnects', async () => {
        const b = fakeInstance(2);
        const { coordinator, events, stopCoordinator } = setup([fakeInstance(1), b]);
        stopCoordinator.waitForDrain.mockReturnValue(new Promise(() => {}));

        const result = runWith(coordinator, ctx => ctx.moveAllClusters(1, 2));
        await Promise.resolve();
        events.emit('INSTANCE_DISCONNECTED', b, 'gone');

        await expect(result).rejects.toSatisfy((e: unknown) => e instanceof RestartStepError && e.step === 'move');
    });

    it('moveAllClusters(x, x) rejects without stealing', async () => {
        const { coordinator, reclusterer } = setup([fakeInstance(1)]);

        await expect(runWith(coordinator, ctx => ctx.moveAllClusters(1, 1))).rejects.toBeInstanceOf(RestartStepError);
        expect(reclusterer.steal).not.toHaveBeenCalled();
    });

    it('rejects a second run while one is running', async () => {
        const { coordinator } = setup([fakeInstance(1)]);
        let release!: () => void;
        const first = runWith(coordinator, () => new Promise<void>(r => { release = r; }));

        await expect(runWith(coordinator, async () => {})).rejects.toThrow(/already running/);
        release();
        await first;
    });

    it('running is true during the routine and false after success and after failure', async () => {
        const { coordinator } = setup([fakeInstance(1)]);
        let during: boolean | undefined;

        await runWith(coordinator, async () => { during = coordinator.running; });
        expect(during).toBe(true);
        expect(coordinator.running).toBe(false);

        await expect(runWith(coordinator, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(coordinator.running).toBe(false);
        await expect(runWith(coordinator, async () => {})).resolves.toBeUndefined();
    });
});
