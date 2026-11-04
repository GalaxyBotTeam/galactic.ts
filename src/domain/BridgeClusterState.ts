import { StateMachine } from './StateMachine';

export enum BridgeClusterConnectionStatus {
    REQUESTING = 'requesting',
    STARTING = 'starting',
    CONNECTED = 'connected',
    RECLUSTERING = 'reclustering',
    DISCONNECTED = 'disconnected',
}

// Derived from every mutation site in the pre-refactor Bridge.ts/BridgeClusterConnection.ts.
const TRANSITIONS: Record<BridgeClusterConnectionStatus, readonly BridgeClusterConnectionStatus[]> = {
    [BridgeClusterConnectionStatus.DISCONNECTED]: [BridgeClusterConnectionStatus.REQUESTING],
    [BridgeClusterConnectionStatus.REQUESTING]: [BridgeClusterConnectionStatus.STARTING, BridgeClusterConnectionStatus.DISCONNECTED],
    [BridgeClusterConnectionStatus.STARTING]: [BridgeClusterConnectionStatus.CONNECTED, BridgeClusterConnectionStatus.DISCONNECTED],
    [BridgeClusterConnectionStatus.CONNECTED]: [BridgeClusterConnectionStatus.RECLUSTERING, BridgeClusterConnectionStatus.DISCONNECTED],
    [BridgeClusterConnectionStatus.RECLUSTERING]: [BridgeClusterConnectionStatus.STARTING, BridgeClusterConnectionStatus.DISCONNECTED],
};

export function createBridgeClusterState(): StateMachine<BridgeClusterConnectionStatus> {
    return new StateMachine(BridgeClusterConnectionStatus.DISCONNECTED, TRANSITIONS);
}
