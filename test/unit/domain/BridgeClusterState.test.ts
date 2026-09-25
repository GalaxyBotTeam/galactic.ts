import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../../src/domain/StateMachine';
import { BridgeClusterConnectionStatus } from '../../../src/domain/BridgeClusterState';
import { BridgeClusterConnection } from '../../../src/bridge/BridgeClusterConnection';

function fakeInstanceConnection() {
    return {} as any;
}

describe('BridgeClusterConnection state machine', () => {
    it('starts DISCONNECTED', () => {
        const cluster = new BridgeClusterConnection(0, [0]);
        expect(cluster.connectionStatus).toBe(BridgeClusterConnectionStatus.DISCONNECTED);
    });

    it('setConnection(x) moves DISCONNECTED -> REQUESTING', () => {
        const cluster = new BridgeClusterConnection(0, [0]);
        cluster.setConnection(fakeInstanceConnection());
        expect(cluster.connectionStatus).toBe(BridgeClusterConnectionStatus.REQUESTING);
    });

    it('rejects an invalid jump straight to STARTING from DISCONNECTED', () => {
        const cluster = new BridgeClusterConnection(0, [0]);
        expect(() => cluster.markStarting()).toThrow(InvalidTransitionError);
    });

    it('allows the full REQUESTING -> STARTING -> CONNECTED -> RECLUSTERING -> STARTING cycle', () => {
        const cluster = new BridgeClusterConnection(0, [0]);
        cluster.setConnection(fakeInstanceConnection());
        cluster.markStarting();
        cluster.markConnected();
        cluster.reclustering(fakeInstanceConnection());
        expect(cluster.connectionStatus).toBe(BridgeClusterConnectionStatus.RECLUSTERING);
        cluster.markStarting();
        expect(cluster.connectionStatus).toBe(BridgeClusterConnectionStatus.STARTING);
    });

    it('setConnection(undefined) always moves to DISCONNECTED', () => {
        const cluster = new BridgeClusterConnection(0, [0]);
        cluster.setConnection(fakeInstanceConnection());
        cluster.markStarting();
        cluster.setConnection(undefined);
        expect(cluster.connectionStatus).toBe(BridgeClusterConnectionStatus.DISCONNECTED);
        expect(cluster.connection).toBeUndefined();
    });
});
