import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeInstanceConnectionStatus } from "../domain/BridgeInstanceState";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { ClusterCalculator } from "./ClusterCalculator";
import { ClusterReclusterer } from "./ClusterReclusterer";
import { InstanceStopCoordinator } from "./InstanceStopCoordinator";
import { TypedEmitter } from "../general/TypedEmitter";
import type { BridgeEvents } from "./Bridge";

export const DEFAULT_RESTART_STEP_TIMEOUT_MS = 10 * 60 * 1000;

export type RestartRoutine = (ctx: RestartContext) => Promise<void>;

export type RestartOptions = { stepTimeoutMs?: number };

export type RestartStep = { kind: 'move', from: number, to: number } | { kind: 'restart', instanceID: number };

/** Building blocks a restart routine works with; instances are addressed by ID because a restart replaces the connection object. */
export interface RestartContext {
    /** Snapshot at start: READY, non-dev, non-standby instance IDs, sorted ascending. */
    readonly instances: readonly number[];
    /** Snapshot at start: READY, non-dev standby instance IDs, sorted ascending. */
    readonly standby: readonly number[];
    /** Current connection for an ID (a restart replaces the object). */
    get(instanceID: number): BridgeInstanceConnection | undefined;
    /** Moves every CONNECTED cluster of `fromID` onto `toID`; resolves once none of them is still on `fromID`. */
    moveAllClusters(fromID: number, toID: number): Promise<void>;
    /** Stops the instance (draining onto other instances if it still has clusters), then waits for its reconnect. */
    restart(instanceID: number): Promise<void>;
}

/** A single routine step failed; the routine is aborted without rollback. */
export class RestartStepError extends Error {
    constructor(readonly step: 'move' | 'restart', readonly instanceID: number, cause: unknown) {
        super(`Restart step '${step}' failed for instance ${instanceID}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = 'RestartStepError';
    }
}

export type RestartCoordinatorDeps = {
    connectedInstances: Map<string, BridgeInstanceConnection>;
    calculator: ClusterCalculator;
    reclusterer: ClusterReclusterer;
    stopCoordinator: InstanceStopCoordinator;
    events: TypedEmitter<BridgeEvents>;
};

/** Runs one restart routine at a time against the connected instances. */
export class RestartCoordinator {
    private _running = false;

    constructor(private readonly deps: RestartCoordinatorDeps) {}

    /** True while a routine runs; the Bridge pauses rebalancing meanwhile. */
    get running(): boolean {
        return this._running;
    }

    async run(routine: RestartRoutine, options: RestartOptions = {}): Promise<void> {
        if (this._running) throw new Error('A restart routine is already running.');
        this._running = true;
        try {
            await routine(this.createContext(options.stepTimeoutMs ?? DEFAULT_RESTART_STEP_TIMEOUT_MS));
        } finally {
            this._running = false;
        }
    }

    private createContext(stepTimeoutMs: number): RestartContext {
        const snapshot = this.deps.connectedInstances.values()
            .filter(c => c.connectionStatus === BridgeInstanceConnectionStatus.READY && !c.dev)
            .toArray();
        const ids = (standby: boolean) => snapshot.filter(c => c.standby === standby).map(c => c.instanceID).sort((a, b) => a - b);

        return {
            instances: ids(false),
            standby: ids(true),
            get: (id) => this.find(id),
            moveAllClusters: (from, to) => this.moveAllClusters(from, to, stepTimeoutMs),
            restart: (id) => this.restart(id, stepTimeoutMs),
        };
    }

    private find(instanceID: number): BridgeInstanceConnection | undefined {
        return this.deps.connectedInstances.values().find(c => c.instanceID === instanceID);
    }

    private async moveAllClusters(fromID: number, toID: number, timeoutMs: number): Promise<void> {
        const from = this.find(fromID);
        const to = this.find(toID);
        if (fromID === toID) throw new RestartStepError('move', fromID, new Error('Source and target are the same instance.'));
        if (!from || !to) throw new RestartStepError('move', fromID, new Error(`Instance ${!from ? fromID : toID} is not connected.`));

        const step: RestartStep = { kind: 'move', from: fromID, to: toID };
        this.deps.events.emit('RESTART_STEP', step, 'started');

        let onDisconnect: BridgeEvents['INSTANCE_DISCONNECTED'] | undefined;
        const disconnected = new Promise<never>((_, reject) => {
            onDisconnect = (c) => {
                if (c.instanceID === fromID || c.instanceID === toID) reject(new Error(`Instance ${c.instanceID} disconnected during the move.`));
            };
            this.deps.events.on('INSTANCE_DISCONNECTED', onDisconnect);
        });

        try {
            for (const cluster of this.deps.calculator.getClusterForConnection(from)) {
                if (cluster.connectionStatus === BridgeClusterConnectionStatus.CONNECTED) this.deps.reclusterer.steal(cluster, to);
            }
            await Promise.race([this.deps.stopCoordinator.waitForDrain(from, timeoutMs), disconnected]);
        } catch (err) {
            throw new RestartStepError('move', fromID, err);
        } finally {
            this.deps.events.off('INSTANCE_DISCONNECTED', onDisconnect!);
        }

        this.deps.events.emit('RESTART_STEP', step, 'done');
    }

    private async restart(instanceID: number, timeoutMs: number): Promise<void> {
        const connection = this.find(instanceID);
        if (!connection) throw new RestartStepError('restart', instanceID, new Error(`Instance ${instanceID} is not connected.`));

        const step: RestartStep = { kind: 'restart', instanceID };
        this.deps.events.emit('RESTART_STEP', step, 'started');

        // Subscribe before stopping: the instance may reconnect before stop() resolves.
        let onReconnect!: () => void;
        const reconnected = new Promise<void>(resolve => { onReconnect = resolve; });
        const onConnected: BridgeEvents['INSTANCE_CONNECTED'] = (c) => {
            if (c.instanceID === instanceID) onReconnect();
        };
        this.deps.events.on('INSTANCE_CONNECTED', onConnected);

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await this.deps.stopCoordinator.stop(connection, true, timeoutMs);
            await Promise.race([reconnected, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Instance ${instanceID} did not reconnect within ${timeoutMs}ms.`)), timeoutMs);
            })]);
        } catch (err) {
            throw new RestartStepError('restart', instanceID, err);
        } finally {
            this.deps.events.off('INSTANCE_CONNECTED', onConnected);
            clearTimeout(timer);
        }

        this.deps.events.emit('RESTART_STEP', step, 'done');
    }
}
