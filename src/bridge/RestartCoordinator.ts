import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeInstanceConnectionStatus } from "../domain/BridgeInstanceState";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { ClusterCalculator } from "./ClusterCalculator";
import { ClusterReclusterer } from "./ClusterReclusterer";
import { InstanceStopCoordinator } from "./InstanceStopCoordinator";
import { TypedEmitter } from "../general/TypedEmitter";
import type { BridgeEvents } from "./Bridge";
import { IdentifyGate } from "./IdentifyGate";

export const DEFAULT_RESTART_STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** Above the 60 second crash timeout of Pelican's Wings, which leaves a server offline if it exits again within it. */
export const DEFAULT_MIN_RESTART_INTERVAL_MS = 65 * 1000;

export type RestartRoutine = (ctx: RestartContext) => Promise<void>;

export type RestartOptions = {
    stepTimeoutMs?: number;
    /** Minimum time between two stops of the same instance; a restart waits for the rest of it. 0 turns this off. */
    minRestartIntervalMs?: number;
};

export type RestartStep =
    | { kind: 'move', from: number, to: number }
    | { kind: 'restart', instanceID: number }
    /** The instance stopped less than `minRestartIntervalMs` ago, its restart starts in `ms`. */
    | { kind: 'wait', instanceID: number, ms: number }
    /** Happens at once, so it is only reported as `done`. */
    | { kind: 'standby', from: number, to: number };

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
    /** Hands the standby role from one instance to another; it outlives their reconnects until the Bridge restarts. */
    transferStandby(fromID: number, toID: number): void;
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
    gate: IdentifyGate;
    /** How many instances the Bridge keeps empty as standby. */
    standbyInstances: number;
};

/** Runs one restart routine at a time against the connected instances. */
export class RestartCoordinator {
    private _running = false;
    /** The role of every instance seen so far, so it survives a reconnect. Lost on a Bridge restart. */
    private readonly standbyRoles = new Map<number, boolean>();
    private readonly lastStops = new Map<number, number>();

    constructor(private readonly deps: RestartCoordinatorDeps) {
        deps.events.on('INSTANCE_STOP', (connection) => this.lastStops.set(connection.instanceID, Date.now()));
    }

    /** True while a routine runs; the Bridge pauses rebalancing meanwhile. */
    get running(): boolean {
        return this._running;
    }

    /**
     * Decides the role of a connecting instance: it keeps the one it held, and a new instance becomes
     * standby while one is missing, unless it would be the only instance left to hold clusters.
     */
    syncStandbyRole(connection: BridgeInstanceConnection): void {
        const others = this.deps.connectedInstances.values()
            .filter(c => c !== connection && !c.dev)
            .toArray();
        const standbyMissing = others.filter(c => c.standby).length < this.deps.standbyInstances;
        const role = !connection.dev && standbyMissing
            && (this.standbyRoles.get(connection.instanceID) ?? others.some(c => !c.standby));

        this.standbyRoles.set(connection.instanceID, role);
        connection.setStandby(role);
        this.reportStandbyRole(connection);
    }

    /**
     * After a Bridge restart the roles are gone, and an instance may come back with clusters it kept.
     * Such an instance is no standby: it loses the role, and an empty instance takes it if one is missing.
     * Restart routines move roles themselves, so nothing changes while one runs.
     */
    syncStandbyAfterResume(connection: BridgeInstanceConnection): void {
        if (this._running) return;
        const holdsClusters = (c: BridgeInstanceConnection) => this.deps.calculator.getClusterForConnection(c).length > 0;

        if (connection.standby && holdsClusters(connection)) {
            this.standbyRoles.set(connection.instanceID, false);
            connection.setStandby(false);
            this.reportStandbyRole(connection);
        }

        // An instance on its way out cannot be the standby: once it is gone, none would be left.
        const instances = this.deps.connectedInstances.values()
            .filter(c => !c.dev && c.resumed && c.connectionStatus === BridgeInstanceConnectionStatus.READY)
            .toArray();
        const missing = this.deps.standbyInstances - instances.filter(c => c.standby).length;
        const candidates = instances.filter(c => !c.standby && !holdsClusters(c));
        // At least one instance has to stay available for clusters.
        const available = instances.filter(c => !c.standby).length;
        for (const candidate of candidates.slice(0, Math.max(0, Math.min(missing, available - 1)))) {
            this.standbyRoles.set(candidate.instanceID, true);
            candidate.setStandby(true);
            this.reportStandbyRole(candidate);
        }
    }

    private reportStandbyRole(connection: BridgeInstanceConnection): void {
        connection.eventManager.send({ type: 'INSTANCE_STANDBY', data: { standby: connection.standby } }).catch((err) => {
            this.deps.events.emit('ERROR', `Reporting the standby role to instance ${connection.instanceID} failed: ${err}`);
        });
    }

    async run(routine: RestartRoutine, options: RestartOptions = {}): Promise<void> {
        if (this._running) throw new Error('A restart routine is already running.');
        this._running = true;
        try {
            const ctx = this.createContext(
                options.stepTimeoutMs ?? DEFAULT_RESTART_STEP_TIMEOUT_MS,
                options.minRestartIntervalMs ?? DEFAULT_MIN_RESTART_INTERVAL_MS,
            );
            await routine(ctx);

            const missing = [...ctx.instances, ...ctx.standby].filter(id => !this.find(id));
            if (missing.length > 0) throw new Error(`Restart routine finished, but instance(s) ${missing.join(', ')} are not connected.`);
        } finally {
            this._running = false;
        }
    }

    private createContext(stepTimeoutMs: number, minRestartIntervalMs: number): RestartContext {
        const snapshot = this.deps.connectedInstances.values()
            .filter(c => c.connectionStatus === BridgeInstanceConnectionStatus.READY && !c.dev)
            .toArray();
        const ids = (standby: boolean) => snapshot.filter(c => c.standby === standby).map(c => c.instanceID).sort((a, b) => a - b);

        return {
            instances: ids(false),
            standby: ids(true),
            get: (id) => this.find(id),
            moveAllClusters: (from, to) => this.moveAllClusters(from, to, stepTimeoutMs),
            restart: (id) => this.restart(id, stepTimeoutMs, minRestartIntervalMs),
            transferStandby: (from, to) => {
                this.setStandbyRole(from, false);
                this.setStandbyRole(to, true);
                this.deps.events.emit('RESTART_STEP', { kind: 'standby', from, to }, 'done');
            },
        };
    }

    private setStandbyRole(instanceID: number, standby: boolean): void {
        this.standbyRoles.set(instanceID, standby);
        const connection = this.find(instanceID);
        if (!connection) return;
        connection.setStandby(standby);
        this.reportStandbyRole(connection);
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

        let aborted = false;
        const moveAndDrain = async () => {
            for (const cluster of this.deps.calculator.getClusterForConnection(from)) {
                if (cluster.connectionStatus !== BridgeClusterConnectionStatus.CONNECTED) continue;
                await this.deps.gate.acquire(cluster.shardList);
                if (aborted) return;
                this.deps.reclusterer.steal(cluster, to);
            }
            await this.deps.stopCoordinator.waitForDrain(from, timeoutMs);
        };

        try {
            await Promise.race([moveAndDrain(), disconnected]);
        } catch (err) {
            throw new RestartStepError('move', fromID, err);
        } finally {
            aborted = true;
            this.deps.events.off('INSTANCE_DISCONNECTED', onDisconnect!);
        }

        this.deps.events.emit('RESTART_STEP', step, 'done');
    }

    private connected(instanceID: number): BridgeInstanceConnection {
        const connection = this.find(instanceID);
        if (!connection) throw new RestartStepError('restart', instanceID, new Error(`Instance ${instanceID} is not connected.`));
        return connection;
    }

    private async waitForRestartInterval(instanceID: number, minIntervalMs: number): Promise<void> {
        const lastStop = this.lastStops.get(instanceID);
        const ms = lastStop === undefined ? 0 : lastStop + minIntervalMs - Date.now();
        if (ms <= 0) return;

        const step: RestartStep = { kind: 'wait', instanceID, ms };
        this.deps.events.emit('RESTART_STEP', step, 'started');
        await new Promise(resolve => setTimeout(resolve, ms));
        this.deps.events.emit('RESTART_STEP', step, 'done');
    }

    private async restart(instanceID: number, timeoutMs: number, minIntervalMs: number): Promise<void> {
        this.connected(instanceID);
        await this.waitForRestartInterval(instanceID, minIntervalMs);
        const connection = this.connected(instanceID);

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
