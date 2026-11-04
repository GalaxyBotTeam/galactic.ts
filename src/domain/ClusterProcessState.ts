import { StateMachine } from './StateMachine';

export type ClusterProcessState = 'starting' | 'running' | 'stopped';

const TRANSITIONS: Record<ClusterProcessState, readonly ClusterProcessState[]> = {
    starting: ['running', 'stopped'],
    running: ['stopped'],
    stopped: [], // terminal
};

export function createClusterProcessState(): StateMachine<ClusterProcessState> {
    return new StateMachine<ClusterProcessState>('starting', TRANSITIONS);
}
