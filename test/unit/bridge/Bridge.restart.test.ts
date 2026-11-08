import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'net';
import { Bridge } from '../../../src/bridge/Bridge';
import { BridgeClusterConnectionStatus } from '../../../src/bridge/BridgeClusterConnection';
import { ManagedInstance, ManagedInstanceConnectionStatus } from '../../../src/instance/ManagedInstance';
import type { DisconnectPolicy } from '../../../src/protocol/bridge';

// Real net-ipc on localhost: a Bridge goes away and a fresh one takes over the clusters an instance kept.

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

async function startBridge(port: number, disconnectPolicy: DisconnectPolicy) {
    // 2 clusters with 1 shard each. Not `start()`: that would ask Discord for the gateway limits.
    const bridge = new Bridge(port, 'token', [], 1, 2, 60000, false, 0, { disconnectPolicy, resumeWindowMs: 0 }) as any;
    await bridge.bridgeServer.start();
    bridge.startedAt = Date.now();
    return bridge;
}

/** `allowReconnect` true behaves like a crash; false is net-ipc's clean shutdown, after which the client stops retrying on its own. */
async function stopBridge(bridge: any, allowReconnect = true) {
    bridge.scheduler.stop();
    await bridge.server.close(allowReconnect);
}

function startInstance(port: number) {
    const instance = new ManagedInstance('entry.js', '127.0.0.1', port, 1, {}) as any;
    instance.killProcess = vi.fn((cluster: { id: number }) => {
        instance.clusters.delete(cluster.id);
        return Promise.resolve();
    });
    // Stands in for two cluster processes the instance runs.
    instance.clusters.set(0, { id: 0, shardList: [0], totalShards: 2, status: 'running' });
    instance.clusters.set(1, { id: 1, shardList: [1], totalShards: 2, status: 'running' });
    instance.start();
    return instance;
}

async function until(check: () => boolean, timeoutMs = 8000) {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
});

describe('Bridge restart with kept clusters', () => {
    it.each([
        ['a crash', true],
        ['a clean shutdown', false],
    ])('a fresh Bridge takes over the clusters an instance kept through %s', { timeout: 30000 }, async (_, allowReconnect) => {
        const port = await freePort();
        let bridge = await startBridge(port, { keepClusters: true });
        const instance = startInstance(port);
        cleanup.push(() => { clearTimeout(instance.reconnectTimer); instance.instance.close?.(); });

        // The first Bridge adopts what the instance reports, then the policy is known.
        await until(() => bridge.getClusters().every((c: any) => c.connectionStatus === BridgeClusterConnectionStatus.CONNECTED));
        await until(() => instance.disconnectPolicy.keepClusters === true);

        await stopBridge(bridge, allowReconnect);
        await until(() => instance.state.current === ManagedInstanceConnectionStatus.DISCONNECTED);
        expect(instance.killProcess).not.toHaveBeenCalled();

        bridge = await startBridge(port, { keepClusters: true });
        cleanup.push(() => stopBridge(bridge));
        const resumed = vi.fn();
        bridge.on('INSTANCE_RESUMED', resumed);

        await until(() => resumed.mock.calls.length > 0, 15000);
        expect(resumed.mock.calls[0][1].map((c: any) => c.clusterID)).toEqual([0, 1]);
        expect(bridge.getClusters().map((c: any) => c.connectionStatus)).toEqual([
            BridgeClusterConnectionStatus.CONNECTED,
            BridgeClusterConnectionStatus.CONNECTED,
        ]);
        expect(bridge.getClusters()[0].servingConnection?.instanceID).toBe(1);
        expect(instance.killProcess).not.toHaveBeenCalled();
        expect(instance.clusters.size).toBe(2);
    });

    it('without the policy the instance stops its clusters when the Bridge goes away', { timeout: 20000 }, async () => {
        const port = await freePort();
        const bridge = await startBridge(port, { keepClusters: false });
        const instance = startInstance(port);
        cleanup.push(() => { clearTimeout(instance.reconnectTimer); instance.instance.close?.(); });

        await until(() => instance.state.current === ManagedInstanceConnectionStatus.CONNECTED && instance.resumed);
        await stopBridge(bridge);

        await until(() => instance.clusters.size === 0);
        expect(instance.killProcess).toHaveBeenCalledTimes(2);
    });
});
