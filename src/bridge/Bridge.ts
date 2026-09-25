import { GatewayIntentsString, Snowflake } from "discord.js";
import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeInstanceConnectionStatus } from "../domain/BridgeInstanceState";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { ClusterCalculator } from "../domain/ClusterCalculator";
import { BridgeClusterConnection } from "./BridgeClusterConnection";
import { HeartbeatResponse } from "../protocol/shared";
import { TypedEmitter } from "../general/TypedEmitter";
import { BridgeServer } from "./BridgeServer";
import { ClusterScheduler, HEARTBEAT_TIMEOUT_MS, MAX_MISSED_HEARTBEATS } from "./ClusterScheduler";
import { ClusterReclusterer } from "./ClusterReclusterer";
import { InstanceStopCoordinator } from "./InstanceStopCoordinator";
import { createBridgeMessageHandler } from "./BridgeMessageRouter";
import { createBridgeRequestHandler } from "./BridgeRequestRouter";

const RESTART_STOP_DELAY_MS = 1000 * 10;

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
    private readonly server: BridgeServer;
    private readonly reclusterer: ClusterReclusterer;
    private readonly stopCoordinator: InstanceStopCoordinator;
    private readonly scheduler: ClusterScheduler;

    constructor(port: number, token: string, intents: GatewayIntentsString[], shardsPerCluster: number, clusterToStart: number, reclusteringTimeoutInMs: number, ignoreHeartbeatMissed?: boolean) {
        this.port = port;
        this.token = token;
        this.intents = intents;
        this.clusterToStart = clusterToStart;
        this.shardsPerCluster = shardsPerCluster;
        this.reclusteringTimeoutInMs = reclusteringTimeoutInMs;
        this.ignoreHeartbeatMissed = ignoreHeartbeatMissed || false;

        this.clusterCalculator = new ClusterCalculator(this.clusterToStart, this.shardsPerCluster);
        this.reclusterer = new ClusterReclusterer(this.clusterCalculator, this.token, this.intents, () => this.getTotalShards(), this.events);

        this.server = new BridgeServer(this.port, {
            onInstanceConnected: (connection) => this.onInstanceConnected(connection),
            onInstanceDisconnected: (connection, reason) => this.onInstanceDisconnected(connection, reason),
        });
        this.stopCoordinator = new InstanceStopCoordinator(this.clusterCalculator, this.reclusterer, this.server.connectedInstances, this.events);
        this.scheduler = new ClusterScheduler({
            checkCreate: () => this.checkCreate(),
            checkRecluster: () => this.reclusterer.checkRecluster(this.getEligibleInstancesForRecluster()),
            heartbeat: () => this.heartbeat(),
        });
    }

    public start(): void {
        this.server.start();
        this.scheduler.start();
    }

    private onInstanceConnected(connection: BridgeInstanceConnection): void {
        connection.eventManager.onMessage(createBridgeMessageHandler(connection, {
            calculator: this.clusterCalculator,
            events: this.events,
            onInstanceStop: (c) => { this.stopInstance(c); },
        }));
        connection.eventManager.onRequest(createBridgeRequestHandler(connection, {
            calculator: this.clusterCalculator,
            connectedInstances: this.server.connectedInstances,
            totalShards: () => this.getTotalShards(),
        }));
        this.events.emit('INSTANCE_CONNECTED', connection);
    }

    private onInstanceDisconnected(connection: BridgeInstanceConnection, reason: string): void {
        for (const cluster of this.clusterCalculator.getClusterForConnection(connection)) {
            this.clusterCalculator.clearClusterConnection(cluster.clusterID);
        }
        this.events.emit('INSTANCE_DISCONNECTED', connection, reason);
    }

    private getEligibleInstancesForRecluster(): BridgeInstanceConnection[] {
        return this.server.connectedInstances.values()
            .filter(c => c.connectionStatus === BridgeInstanceConnectionStatus.READY)
            .filter(c => !c.dev)
            .filter(c => c.establishedAt + this.reclusteringTimeoutInMs < Date.now())
            .toArray();
    }

    private checkCreate(): void {
        const optionalCluster = this.clusterCalculator.getNextCluster();
        if (!optionalCluster) return;

        const lowestLoadClient = this.clusterCalculator.getClusterWithLowestLoad(this.server.connectedInstances);
        if (!lowestLoadClient) return;

        this.reclusterer.createCluster(lowestLoadClient, optionalCluster);
    }

    private heartbeat(): void {
        this.clusterCalculator.clusterList.forEach((cluster) => {
            if (!cluster.connection || cluster.connectionStatus !== BridgeClusterConnectionStatus.CONNECTED || cluster.heartbeatPending) return;

            cluster.heartbeatPending = true;
            cluster.connection.eventManager.request<HeartbeatResponse>({
                type: 'CLUSTER_HEARTBEAT',
                data: { clusterID: cluster.clusterID },
            }, HEARTBEAT_TIMEOUT_MS).then((r) => {
                cluster.removeMissedHeartbeat();
                cluster.heartbeatResponse = r;
            }).catch((err) => {
                this.events.emit('CLUSTER_HEARTBEAT_FAILED', cluster, err);
                cluster.addMissedHeartbeat();

                if (cluster.missedHeartbeats > MAX_MISSED_HEARTBEATS && !cluster.connection?.dev && !this.ignoreHeartbeatMissed) {
                    cluster.connection?.eventManager.send({ type: 'CLUSTER_STOP', data: { id: cluster.clusterID } });
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

    public get connectedInstances(): Map<string, BridgeInstanceConnection> {
        return this.server.connectedInstances;
    }

    async stopAllInstances(): Promise<void> {
        const instances = Array.from(this.server.connectedInstances.values());
        for (const instance of instances) {
            await this.stopCoordinator.stop(instance, false);
        }
    }

    async stopAllInstancesWithRestart(): Promise<void> {
        const instances = Array.from(this.server.connectedInstances.values());

        for (const instance of instances) {
            await this.stopCoordinator.stop(instance);
            await new Promise<void>((resolve) => setTimeout(resolve, RESTART_STOP_DELAY_MS));
        }
    }

    async moveCluster(bridgeInstanceConnection: BridgeInstanceConnection, bridgeClusterConnection: BridgeClusterConnection): Promise<void> {
        this.reclusterer.moveCluster(bridgeInstanceConnection, bridgeClusterConnection);
    }

    async stopInstance(bridgeInstanceConnection: BridgeInstanceConnection, recluster = true): Promise<void> {
        return this.stopCoordinator.stop(bridgeInstanceConnection, recluster);
    }

    sendRequestToGuild(cluster: BridgeClusterConnection, guildID: Snowflake, data: unknown, timeout = 5000): Promise<unknown> {
        if (!cluster.connection) {
            return Promise.reject(new Error("No connection defined for cluster " + cluster.clusterID));
        }

        return cluster.connection.eventManager.request({
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
    'ERROR': (error: string) => void,
};
