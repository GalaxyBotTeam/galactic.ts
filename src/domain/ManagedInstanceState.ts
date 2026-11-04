import { StateMachine } from './StateMachine';

/** Renamed from the old `BridgeConnectionStatus` to disambiguate from BridgeInstanceConnectionStatus/BridgeClusterConnectionStatus. */
export enum ManagedInstanceConnectionStatus {
    CONNECTED = 'connected',
    DISCONNECTED = 'disconnected',
}

// net-ipc reconnects, so both directions are valid.
const TRANSITIONS: Record<ManagedInstanceConnectionStatus, readonly ManagedInstanceConnectionStatus[]> = {
    [ManagedInstanceConnectionStatus.CONNECTED]: [ManagedInstanceConnectionStatus.DISCONNECTED],
    [ManagedInstanceConnectionStatus.DISCONNECTED]: [ManagedInstanceConnectionStatus.CONNECTED],
};

export function createManagedInstanceState(): StateMachine<ManagedInstanceConnectionStatus> {
    return new StateMachine(ManagedInstanceConnectionStatus.DISCONNECTED, TRANSITIONS);
}
