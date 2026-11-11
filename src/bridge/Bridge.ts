import { GatewayIntentsString, Snowflake } from "discord.js";
import { Server } from "net-ipc";
import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeInstanceConnectionStatus } from "../domain/BridgeInstanceState";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { ClusterCalculator } from "./ClusterCalculator";
import { BridgeClusterConnection } from "./BridgeClusterConnection";
import { HeartbeatResponse } from "../protocol/shared";
import { TypedEmitter } from "../general/TypedEmitter";
import { BridgeServer } from "./BridgeServer";
import { ClusterScheduler, HEARTBEAT_TIMEOUT_MS, MAX_MISSED_HEARTBEATS } from "./ClusterScheduler";
import { ClusterReclusterer } from "./ClusterReclusterer";
import { InstanceStopCoordinator } from "./InstanceStopCoordinator";
import { createBridgeMessageHandler, handOverCluster } from "./BridgeMessageRouter";
import { createBridgeRequestHandler } from "./BridgeRequestRouter";
import { RestartCoordinator, RestartOptions, RestartRoutine, type RestartStep } from "./RestartCoordinator";
import { sequentialRestart } from "./restartRoutines";
import { IdentifyGate } from "./IdentifyGate";
import { checkShardCount, fetchGatewayInfo, type GatewayInfo } from "./GatewayInfo";
import { ClusterResumer, type RejectedCluster } from "./ClusterResumer";
import { DisconnectPolicy } from "../protocol/bridge";

/** How long a Bridge that keeps clusters waits after its start before it starts clusters itself. */
export const DEFAULT_RESUME_WINDOW_MS = 20 * 1000;

export type BridgeOptions = {
    /** What instances do with their clusters when they lose the Bridge. Default `{ keepClusters: false }`. Change it later with {@link Bridge.setDisconnectPolicy}. */
    disconnectPolicy?: DisconnectPolicy;
    /**
     * Only while `disconnectPolicy` keeps clusters: how long after its start the Bridge waits before
     * it starts clusters, so instances that kept theirs during a Bridge restart can report them first.
     * Default {@link DEFAULT_RESUME_WINDOW_MS}.
     */
    resumeWindowMs?: number;
};

/** Composition root - wires transport (BridgeServer), business logic (ClusterReclusterer, InstanceStopCoordinator), and scheduling (ClusterScheduler) together. */
export class Bridge {
    public readonly port: number;
    private readonly token: string;
    private readonly intents: GatewayIntentsString[];
    private readonly shardsPerCluster: number = 1;
    private readonly clusterToStart: number = 1;
    private readonly reclusteringTimeoutInMs: number;
    private readonly ignoreHeartbeatMissed: boolean = false;

    private readonly events = new TypedEmitter<BridgeEvents>();
    private readonly clusterCalculator: ClusterCalculator;
    private readonly bridgeServer: BridgeServer;
    private readonly reclusterer: ClusterReclusterer;
    private readonly stopCoordinator: InstanceStopCoordinator;
    private readonly restartCoordinator: RestartCoordinator;
    private readonly scheduler: ClusterScheduler;
    private readonly gate = new IdentifyGate();
    private readonly resumer: ClusterResumer;
    private readonly resumeWindowMs: number;
    private _disconnectPolicy: DisconnectPolicy;
    private startedAt?: number;
    private shardCountRejected = false;

    constructor(port: number, token: string, intents: GatewayIntentsString[], shardsPerCluster: number, clusterToStart: number, reclusteringTimeoutInMs: number, ignoreHeartbeatMissed?: boolean, standbyInstances = 0, options: BridgeOptions = {}) {
        this.port = port;
        this.token = token;
        this.intents = intents;
        this.clusterToStart = clusterToStart;
        this.shardsPerCluster = shardsPerCluster;
        this.reclusteringTimeoutInMs = reclusteringTimeoutInMs;
        this.ignoreHeartbeatMissed = ignoreHeartbeatMissed || false;
        this._disconnectPolicy = validateDisconnectPolicy(options.disconnectPolicy ?? { keepClusters: false });
        this.resumeWindowMs = options.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;

        this.clusterCalculator = new ClusterCalculator(this.clusterToStart, this.shardsPerCluster);
        this.resumer = new ClusterResumer(this.clusterCalculator, () => this.getTotalShards(), this.events);
        this.reclusterer = new ClusterReclusterer(this.clusterCalculator, this.token, this.intents, () => this.getTotalShards(), this.events, this.gate);

        this.bridgeServer = new BridgeServer(this.port, {
            onInstanceConnected: (connection) => this.onInstanceConnected(connection),
            onInstanceDisconnected: (connection, reason) => this.onInstanceDisconnected(connection, reason),
        });
        this.stopCoordinator = new InstanceStopCoordinator(this.clusterCalculator, this.reclusterer, this.bridgeServer.connectedInstances, this.events, this.gate);
        this.restartCoordinator = new RestartCoordinator({
            connectedInstances: this.bridgeServer.connectedInstances,
            calculator: this.clusterCalculator,
            reclusterer: this.reclusterer,
            stopCoordinator: this.stopCoordinator,
            events: this.events,
            gate: this.gate,
            standbyInstances,
        });
        this.scheduler = new ClusterScheduler({
            checkCreate: () => this.checkCreate(),
            checkRecluster: () => {
                this.resumer.releaseExpired();
                // Rebalancing around an instance that may come back with its clusters would move them twice.
                if (this.restartCoordinator.running || this.clusterCalculator.clusterList.some(c => c.reserved)) return;
                this.reclusterer.checkRecluster(this.getEligibleInstancesForRecluster());
            },
            heartbeat: () => this.heartbeat(),
        });
    }

    public get disconnectPolicy(): DisconnectPolicy {
        return this._disconnectPolicy;
    }

    /**
     * Changes what instances do with their clusters when they lose the Bridge, and tells every
     * connected instance. An instance that is disconnected right now keeps the policy it had.
     * Switching keeping off frees every cluster the Bridge still holds for a missing instance.
     */
    public setDisconnectPolicy(policy: DisconnectPolicy): void {
        this._disconnectPolicy = validateDisconnectPolicy(policy);
        for (const connection of this.bridgeServer.connectedInstances.values()) {
            this.sendDisconnectPolicy(connection);
        }
        if (!policy.keepClusters) this.resumer.releaseAll();
    }

    private sendDisconnectPolicy(connection: BridgeInstanceConnection): void {
        if (!connection.supportsResume) return;
        connection.eventManager.send({ type: 'INSTANCE_DISCONNECT_POLICY', data: this._disconnectPolicy }).catch((err) => {
            this.events.emit('ERROR', `Reporting the disconnect policy to instance ${connection.instanceID} failed: ${err}`);
        });
    }

    public start(): void {
        this.startedAt = Date.now();
        this.bridgeServer.start().catch((err) => {
            this.events.emit('ERROR', `Bridge server failed to start on port ${this.port}: ${err}`);
        });
        this.scheduler.start();
        void this.refreshGatewayInfo();
    }

    /** Until this answers, the gate assumes `max_concurrency` 1, which is safe for every bot. */
    private async refreshGatewayInfo(): Promise<void> {
        let info: GatewayInfo;
        try {
            info = await fetchGatewayInfo(this.token);
        } catch (err) {
            this.events.emit('ERROR', `Could not read the gateway limits, keeping the last known max_concurrency: ${err}`);
            return;
        }
        this.gate.setMaxConcurrency(info.session_start_limit.max_concurrency);
        this.events.emit('GATEWAY_INFO', info);
        checkShardCount(info, this.getTotalShards()).forEach(warning => this.events.emit('ERROR', warning));
    }

    private onInstanceConnected(connection: BridgeInstanceConnection): void {
        this.restartCoordinator.syncStandbyRole(connection);
        this.sendDisconnectPolicy(connection);
        connection.eventManager.onMessage(createBridgeMessageHandler(connection, {
            calculator: this.clusterCalculator,
            events: this.events,
            onInstanceStop: (c) => {
                this.stopInstance(c).catch((err) => {
                    this.events.emit('ERROR', `Stopping instance ${c.instanceID} failed: ${err}`);
                });
            },
            onInvalidShardCount: () => this.onInvalidShardCount(),
        }));
        connection.eventManager.onRequest(createBridgeRequestHandler(connection, {
            calculator: this.clusterCalculator,
            connectedInstances: this.bridgeServer.connectedInstances,
            totalShards: () => this.getTotalShards(),
            onResume: (c, clusters) => {
                const response = this.resumer.resume(c, clusters);
                this.restartCoordinator.syncStandbyAfterResume(c);
                return response;
            },
        }));
        this.events.emit('INSTANCE_CONNECTED', connection);
    }

    private onInstanceDisconnected(connection: BridgeInstanceConnection, reason: string): void {
        const reserved = this.resumer.reserve(connection, this._disconnectPolicy);
        for (const cluster of this.clusterCalculator.getClusterForConnection(connection)) {
            if (reserved.includes(cluster)) continue;
            this.clusterCalculator.clearClusterConnection(cluster.clusterID);
        }
        // The old process of a move keeps serving only if its instance keeps its clusters; otherwise the new one takes over now.
        const oldProcessesStop = !this._disconnectPolicy.keepClusters || !connection.supportsResume;
        for (const cluster of this.clusterCalculator.getOldClusterForConnection(connection)) {
            cluster.oldConnection = undefined;
            if (oldProcessesStop && cluster.connection) handOverCluster(cluster, cluster.connection, this.events);
        }
        this.events.emit('INSTANCE_DISCONNECTED', connection, reason);
    }

    /** Retrying cannot help and costs session starts: every cluster would fail the same way. */
    private onInvalidShardCount(): void {
        if (this.shardCountRejected) return;
        this.shardCountRejected = true;
        this.events.emit('ERROR', `Discord rejected ${this.getTotalShards()} shards (close code 4010). No more clusters start until the shard count is fixed and the Bridge restarted.`);
    }

    private getEligibleInstancesForRecluster(): BridgeInstanceConnection[] {
        return this.bridgeServer.connectedInstances.values()
            .filter(c => c.connectionStatus === BridgeInstanceConnectionStatus.READY)
            .filter(c => !c.dev)
            .filter(c => !c.standby)
            .filter(c => c.resumed)
            .filter(c => c.establishedAt + this.reclusteringTimeoutInMs < Date.now())
            .toArray();
    }

    /** True while a Bridge that keeps clusters gives instances time to report the clusters they kept through its restart. */
    private get inResumeWindow(): boolean {
        return this._disconnectPolicy.keepClusters
            && this.startedAt !== undefined
            && Date.now() < this.startedAt + this.resumeWindowMs;
    }

    private checkCreate(): void {
        if (this.shardCountRejected || this.inResumeWindow) return;

        let cluster;
        while ((cluster = this.clusterCalculator.getNextCluster()) !== undefined) {
            const lowestLoadClient = this.clusterCalculator.getClusterWithLowestLoad(this.bridgeServer.connectedInstances);
            if (!lowestLoadClient || !this.gate.tryAcquire(cluster.shardList)) return;

            this.reclusterer.createCluster(lowestLoadClient, cluster);
        }
    }

    private heartbeat(): void {
        this.clusterCalculator.clusterList.forEach((cluster) => {
            const { connection, connectionStatus } = cluster;
            const starting = connectionStatus === BridgeClusterConnectionStatus.STARTING;
            if (!connection || cluster.reserved || cluster.heartbeatPending || (!starting && connectionStatus !== BridgeClusterConnectionStatus.CONNECTED)) return;

            cluster.heartbeatPending = true;
            connection.eventManager.request<HeartbeatResponse>({
                type: 'CLUSTER_HEARTBEAT',
                data: { clusterID: cluster.clusterID },
            }, HEARTBEAT_TIMEOUT_MS).then((r) => {
                cluster.removeMissedHeartbeat();
                // The cluster may have moved while this answer was on its way.
                if (cluster.connection === connection) cluster.heartbeatResponse = r;
            }).catch((err) => {
                // A process that is still booting may not answer yet, that is no failure.
                if (starting) return;

                this.events.emit('CLUSTER_HEARTBEAT_FAILED', cluster, err);
                cluster.addMissedHeartbeat();

                if (cluster.missedHeartbeats > MAX_MISSED_HEARTBEATS && !cluster.connection?.dev && !this.ignoreHeartbeatMissed) {
                    cluster.connection?.eventManager.send({ type: 'CLUSTER_STOP', data: { id: cluster.clusterID } }).catch((sendErr) => {
                        this.events.emit('ERROR', `Failed to send CLUSTER_STOP for cluster ${cluster.clusterID} after missed heartbeats: ${sendErr}`);
                    });
                    cluster.markDisconnected();
                    cluster.resetMissedHeartbeats();
                }
            }).finally(() => {
                cluster.heartbeatPending = false;
            });
        });
    }

    private getTotalShards(): number {
        return this.shardsPerCluster * this.clusterToStart;
    }

    public on<K extends keyof BridgeEvents>(event: K, listener: BridgeEvents[K]): void {
        this.events.on(event, listener);
    }

    public off<K extends keyof BridgeEvents>(event: K, listener: BridgeEvents[K]): void {
        this.events.off(event, listener);
    }

    public getClusters(): BridgeClusterConnection[] {
        return this.clusterCalculator.clusterList;
    }

    /** The underlying net-ipc Server (kept public for backwards compatibility). */
    public get server(): Server {
        return this.bridgeServer.server;
    }

    public get connectedInstances(): Map<string, BridgeInstanceConnection> {
        return this.bridgeServer.connectedInstances;
    }

    async stopAllInstances(): Promise<void> {
        const instances = Array.from(this.bridgeServer.connectedInstances.values());
        for (const instance of instances) {
            await this.stopCoordinator.stop(instance, false);
        }
    }

    /** Restarts every connected instance through `routine`; rebalancing is paused while it runs. */
    async restartAll(routine: RestartRoutine = sequentialRestart(), options?: RestartOptions): Promise<void> {
        await this.refreshGatewayInfo();
        return this.restartCoordinator.run(routine, options);
    }

    /** @deprecated Use restartAll(). */
    async stopAllInstancesWithRestart(): Promise<void> {
        return this.restartAll();
    }

    async moveCluster(bridgeInstanceConnection: BridgeInstanceConnection, bridgeClusterConnection: BridgeClusterConnection): Promise<void> {
        await this.gate.acquire(bridgeClusterConnection.shardList);
        this.reclusterer.moveCluster(bridgeInstanceConnection, bridgeClusterConnection);
    }

    async stopInstance(bridgeInstanceConnection: BridgeInstanceConnection, recluster = true): Promise<void> {
        return this.stopCoordinator.stop(bridgeInstanceConnection, recluster);
    }

    sendRequestToGuild(cluster: BridgeClusterConnection, guildID: Snowflake, data: unknown, timeout = 5000): Promise<unknown> {
        const serving = cluster.servingConnection;
        if (!serving) {
            return Promise.reject(new Error("No connection defined for cluster " + cluster.clusterID));
        }

        return serving.eventManager.request({
            type: 'REDIRECT_REQUEST_TO_GUILD',
            clusterID: cluster.clusterID,
            guildID: guildID,
            data: data,
        }, timeout);
    }
}

export type BridgeEvents = {
    'CLUSTER_READY': (cluster: BridgeClusterConnection, guilds: number, members: number, readyDuration: number) => void,
    'CLUSTER_STOPPED': (cluster: BridgeClusterConnection) => void,
    'CLUSTER_SPAWNED': (cluster: BridgeClusterConnection, connection: BridgeInstanceConnection) => void,
    'CLUSTER_RECLUSTER': (cluster: BridgeClusterConnection, newConnection: BridgeInstanceConnection, oldConnection: BridgeInstanceConnection) => void,
    'CLUSTER_HEARTBEAT_FAILED': (cluster: BridgeClusterConnection, error: unknown) => void,
    'INSTANCE_CONNECTED': (client: BridgeInstanceConnection) => void,
    'INSTANCE_DISCONNECTED': (client: BridgeInstanceConnection, reason: string) => void,
    'INSTANCE_STOP_ACK': (cluster: BridgeInstanceConnection) => void,
    'INSTANCE_STOP': (cluster: BridgeInstanceConnection) => void,
    'RESTART_STEP': (step: RestartStep, status: 'started' | 'done') => void,
    'ERROR': (error: string) => void,
    /** Discord's `GET /gateway/bot`, read on start and before every restart routine. */
    'GATEWAY_INFO': (info: GatewayInfo) => void,
    /** The instance holding the cluster lost the Bridge and may still run it; it stays assigned until `until` (`Infinity`: until the instance is back). */
    'CLUSTER_RESERVED': (cluster: BridgeClusterConnection, until: number) => void,
    /** The instance did not come back in time; the cluster is free and starts elsewhere. */
    'CLUSTER_RESERVATION_EXPIRED': (cluster: BridgeClusterConnection) => void,
    /** An instance reported the clusters it still runs: `kept` are taken over, `rejected` it stops. */
    'INSTANCE_RESUMED': (client: BridgeInstanceConnection, kept: BridgeClusterConnection[], rejected: RejectedCluster[]) => void,
};

export type { RejectedCluster };

function validateDisconnectPolicy(policy: DisconnectPolicy): DisconnectPolicy {
    if (policy.keepClusters && policy.timeoutMs !== undefined && !(Number.isFinite(policy.timeoutMs) && policy.timeoutMs >= 0)) {
        throw new Error(`disconnectPolicy.timeoutMs must be a finite number >= 0, got ${policy.timeoutMs}. Leave it out to keep clusters until the Bridge is back.`);
    }
    return policy;
}

/** @deprecated Renamed to {@link BridgeEvents}. */
export type BridgeEventListeners = BridgeEvents;
