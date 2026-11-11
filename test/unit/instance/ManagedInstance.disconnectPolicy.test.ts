import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedInstance, ManagedInstanceConnectionStatus } from '../../../src/instance/ManagedInstance';

const READY = 3;
const DISCONNECTED = 4;

// The constructor only builds a net-ipc Client, it does not connect - safe to instantiate here.
function make(resumeResponse: Promise<unknown> = Promise.resolve({ keep: [] })) {
    const instance = new ManagedInstance('entry.js', '127.0.0.1', 1, 1, {}) as any;
    instance.killProcess = vi.fn((cluster: { id: number }) => {
        instance.clusters.delete(cluster.id);
        return Promise.resolve();
    });
    instance.eventManager = { request: vi.fn(() => resumeResponse), send: vi.fn().mockResolvedValue(undefined) };
    return instance;
}

function withClusters(instance: any, ...ids: number[]) {
    for (const id of ids) {
        instance.clusters.set(id, { id, shardList: [id], totalShards: 4, status: 'running', setServing: vi.fn().mockResolvedValue(undefined) });
    }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => vi.useRealTimers());

describe('ManagedInstance disconnect policy', () => {
    it('stops its clusters on a drop until the Bridge says otherwise', () => {
        const instance = make();
        instance.markConnected();
        withClusters(instance, 1);

        instance.onConnectionStatus(DISCONNECTED);

        expect(instance.killProcess).toHaveBeenCalledTimes(1);
    });

    it('keeps its clusters running when the Bridge allows it', () => {
        const instance = make();
        const kept = vi.fn();
        instance.on('BRIDGE_CLUSTERS_KEPT', kept);
        instance.onBridgeMessage({ type: 'INSTANCE_DISCONNECT_POLICY', data: { keepClusters: true } });
        instance.markConnected();
        withClusters(instance, 1, 2);

        instance.onConnectionStatus(DISCONNECTED);
        instance.onConnectionClosed('retries exhausted');
        clearTimeout(instance.reconnectTimer);

        expect(instance.killProcess).not.toHaveBeenCalled();
        expect(instance.state.current).toBe(ManagedInstanceConnectionStatus.DISCONNECTED);
        expect(kept).toHaveBeenCalledWith([1, 2], undefined);
        expect(instance.disconnectPolicy).toEqual({ keepClusters: true });
    });

    it('stops them once the timeout passes without the Bridge', () => {
        vi.useFakeTimers();
        const instance = make();
        instance.onBridgeMessage({ type: 'INSTANCE_DISCONNECT_POLICY', data: { keepClusters: true, timeoutMs: 30000 } });
        instance.markConnected();
        withClusters(instance, 1);

        instance.onConnectionStatus(DISCONNECTED);
        vi.advanceTimersByTime(29999);
        expect(instance.killProcess).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(instance.killProcess).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'Bridge not back within 30000ms');
    });

    it('keeps them when the Bridge is back before the timeout', async () => {
        vi.useFakeTimers();
        const instance = make(Promise.resolve({ keep: [1] }));
        instance.onBridgeMessage({ type: 'INSTANCE_DISCONNECT_POLICY', data: { keepClusters: true, timeoutMs: 30000 } });
        instance.markConnected();
        withClusters(instance, 1);

        instance.onConnectionStatus(DISCONNECTED);
        vi.advanceTimersByTime(10000);
        instance.onConnectionStatus(READY);
        await vi.runAllTimersAsync();

        expect(instance.killProcess).not.toHaveBeenCalled();
        expect(instance.state.current).toBe(ManagedInstanceConnectionStatus.CONNECTED);
    });

    it('stops its clusters on a drop after the Bridge asked it to stop', () => {
        const instance = make();
        instance.onBridgeMessage({ type: 'INSTANCE_DISCONNECT_POLICY', data: { keepClusters: true } });
        instance.markConnected();
        withClusters(instance, 1);

        instance.onBridgeMessage({ type: 'INSTANCE_STOP' });
        instance.onConnectionClosed('Instance stopped.');

        expect(instance.killProcess).toHaveBeenCalledTimes(1);
        expect(instance.reconnectTimer).toBeUndefined();
    });
});

describe('ManagedInstance resume', () => {
    it('reports its clusters after a connect and stops the ones the Bridge does not take over', async () => {
        const instance = make(Promise.resolve({ keep: [1] }));
        const resumed = vi.fn();
        instance.on('INSTANCE_RESUMED', resumed);
        withClusters(instance, 1, 2);
        instance.clusters.get(2).status = 'starting';

        instance.onConnectionStatus(READY);
        await settle();

        expect(instance.eventManager.request).toHaveBeenCalledWith({
            type: 'INSTANCE_RESUME',
            data: { clusters: [
                { id: 1, shardList: [1], totalShards: 4, running: true },
                { id: 2, shardList: [2], totalShards: 4, running: false },
            ] },
        }, expect.any(Number));
        expect(instance.killProcess).toHaveBeenCalledTimes(1);
        expect(instance.killProcess).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), expect.any(String));
        expect(resumed).toHaveBeenCalledWith([1], [2]);
        expect(instance.resumed).toBe(true);
    });

    it('stops every cluster when the Bridge does not know INSTANCE_RESUME', async () => {
        const instance = make(Promise.reject(new Error("unknown request type 'INSTANCE_RESUME'")));
        withClusters(instance, 1);

        instance.onConnectionStatus(READY);
        await settle();

        expect(instance.killProcess).toHaveBeenCalledTimes(1);
        expect(instance.resumed).toBe(true);
    });

    it('runs no self check before the Bridge answered the resume', () => {
        const instance = make(new Promise(() => {}));
        instance.onConnectionStatus(READY);

        expect(instance.resumed).toBe(false);
    });

    it('announces that it can resume when it connects', () => {
        const instance = make();
        const connect = vi.spyOn(instance.instance, 'connect').mockResolvedValue(undefined);

        instance.connect();

        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 1, resume: true }));
    });
});
