import { describe, expect, it, vi } from 'vitest';
import { ManagedInstance, ManagedInstanceConnectionStatus } from '../../../src/instance/ManagedInstance';

// The constructor only builds a net-ipc Client, it does not connect - safe to instantiate here.
function make() {
    const instance = new ManagedInstance('entry.js', '127.0.0.1', 1, 1, {}) as any;
    instance.killProcess = vi.fn().mockResolvedValue(undefined);
    return instance;
}

describe('ManagedInstance bridge connection state', () => {
    it('disconnectAndKillAll survives net-ipc emitting status 4 and then close for one drop', () => {
        const instance = make();
        instance.markConnected();
        instance.clusters.set(1, { id: 1 });

        instance.disconnectAndKillAll();
        expect(() => instance.disconnectAndKillAll()).not.toThrow();

        expect(instance.killProcess).toHaveBeenCalledTimes(1);
        expect(instance.state.current).toBe(ManagedInstanceConnectionStatus.DISCONNECTED);
    });

    it('markConnected is idempotent', () => {
        const instance = make();
        instance.markConnected();

        expect(() => instance.markConnected()).not.toThrow();
        expect(instance.state.current).toBe(ManagedInstanceConnectionStatus.CONNECTED);
    });

    it('reconnect after a drop transitions back to CONNECTED', () => {
        const instance = make();
        instance.markConnected();
        instance.disconnectAndKillAll();

        instance.markConnected();
        expect(instance.state.current).toBe(ManagedInstanceConnectionStatus.CONNECTED);
    });
});
