import { StateMachine } from './StateMachine';

export enum BridgeInstanceConnectionStatus {
    READY = 'ready',
    PENDING_STOP = 'pending_stop',
}

const TRANSITIONS: Record<BridgeInstanceConnectionStatus, readonly BridgeInstanceConnectionStatus[]> = {
    [BridgeInstanceConnectionStatus.READY]: [BridgeInstanceConnectionStatus.PENDING_STOP],
    [BridgeInstanceConnectionStatus.PENDING_STOP]: [], // terminal
};

export function createBridgeInstanceState(): StateMachine<BridgeInstanceConnectionStatus> {
    return new StateMachine(BridgeInstanceConnectionStatus.READY, TRANSITIONS);
}
