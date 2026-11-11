import { BotInstance } from "./BotInstance";
import { ClusterProcess } from "../cluster/ClusterProcess";
import { Client } from "net-ipc";
import { EventManager } from "../transport/EventManager";
import { NetIpcClientTransport } from "../transport/NetIpcClientTransport";
import { GatewayIntentsString } from "discord.js";
import { ShardingUtil } from "../domain/ShardingUtil";
import { ManagedInstanceConnectionStatus, createManagedInstanceState } from "../domain/ManagedInstanceState";
import { BridgeMessage, BridgeRequest, DisconnectPolicy, ResumedCluster, ResumeResponse, SelfCheckResponse } from "../protocol/bridge";
import { ignoreUnknownMessage, rejectUnknownRequest } from "../protocol/shared";

export { ManagedInstanceConnectionStatus };

/**
 * @deprecated Renamed to {@link ManagedInstanceConnectionStatus}. Note that the members are
 * string-valued now ('connected' / 'disconnected'), no longer numeric.
 */
export const BridgeConnectionStatus = ManagedInstanceConnectionStatus;
/** @deprecated Renamed to {@link ManagedInstanceConnectionStatus}. */
export type BridgeConnectionStatus = ManagedInstanceConnectionStatus;

const SELF_CHECK_INTERVAL_MS = 2500;
const SELF_CHECK_TIMEOUT_MS = 60 * 1000;
const STARTING_CLUSTER_TIMEOUT_MS = 10 * 60 * 1000;
const RESUME_TIMEOUT_MS = 30 * 1000;
/** Pause before connecting again once net-ipc gave up its own retries; its longest retry delay. */
const RECONNECT_DELAY_MS = 10 * 1000;
/** net-ipc client status codes (`ClientStatus` in net-ipc). */
const NET_IPC_READY = 3;
const NET_IPC_DISCONNECTED = 4;

type ClusterCreateData = Extract<BridgeMessage, { type: 'CLUSTER_CREATE' }>['data'];

export class ManagedInstance extends BotInstance {

    private readonly host: string;

    private readonly port: number;

    private readonly instanceID: number;

    private readonly instance: Client;

    private readonly eventManager: EventManager<BridgeMessage, BridgeRequest>;

    private readonly state = createManagedInstanceState();

    private data: unknown;

    private dev: boolean = false;

    private _standby: boolean = false;

    /** Set by the Bridge on every connect; until then clusters stop with the connection, as before this option. */
    private _disconnectPolicy: DisconnectPolicy = { keepClusters: false };

    /** False from a connect until the Bridge answered `INSTANCE_RESUME`; the self check waits for it. */
    private resumed = false;

    /** The Bridge sent INSTANCE_STOP: this instance goes away, its clusters do not outlive the connection. */
    private stopRequested = false;

    private keepTimer?: ReturnType<typeof setTimeout>;

    /** Clusters the Bridge handed over before their process had spawned; they serve once it has. */
    private readonly serveOnSpawn = new Set<number>();

    private reconnectTimer?: ReturnType<typeof setTimeout>;

    constructor(entryPoint: string, host: string, port: number, instanceID: number, data: unknown, execArgv?: string[], dev?: boolean, env?: NodeJS.ProcessEnv) {
        super(entryPoint, execArgv, env);

        this.host = host;
        this.port = port;
        this.instanceID = instanceID;
        this.data = data;
        this.dev = dev || false;

        this.instance = new Client({
            host: this.host,
            port: this.port,
            reconnect: true,
            retries: 100
        });
        this.eventManager = new EventManager<BridgeMessage, BridgeRequest>(new NetIpcClientTransport(this.instance));
        this.eventManager.onMessage((message) => this.onBridgeMessage(message));
        this.eventManager.onRequest((message, timeout) => this.onBridgeRequest(message, timeout));
    }

    public start() {
        setInterval(() => {
            if (this.state.current == ManagedInstanceConnectionStatus.CONNECTED && this.resumed) {
                this.selfCheck();
            }
        }, SELF_CHECK_INTERVAL_MS);

        // Registered before the first connect, so every READY - the first one and each reconnect - goes through one path.
        this.instance.on("status", (status) => this.onConnectionStatus(status));
        this.instance.on("close", (reason) => this.onConnectionClosed(reason));
        this.connect();
    }

    private connect(): void {
        this.instance.connect({
            id: this.instanceID,
            dev: this.dev,
            data: this.data,
            resume: true,
        }).catch((err) => {
            this.events.emit('ERROR', `Could not connect to bridge ${this.host}:${this.port}: ${err}`);
            this.scheduleReconnect();
        });
    }

    /** net-ipc stops reconnecting after its retries; a kept cluster needs the Bridge back, so keep trying. */
    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.stopRequested) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, RECONNECT_DELAY_MS);
    }

    private onConnectionStatus(status: number): void {
        this.events.emit('BRIDGE_CONNECTION_STATUS_CHANGE', status);

        if (status == NET_IPC_DISCONNECTED) {
            this.onBridgeLost();
        } else if (status == NET_IPC_READY) {
            // A stop the Bridge asked for belongs to the last connection; this one starts fresh.
            this.stopRequested = false;
            this.markConnected();
            this.events.emit('BRIDGE_CONNECTION_ESTABLISHED');
            this.resume();
        }
    }

    private onConnectionClosed(reason: string): void {
        this.events.emit('BRIDGE_CONNECTION_CLOSED', reason);
        this.onBridgeLost();
        this.scheduleReconnect();
    }

    /** The configured flag until the bridge reports the role, then whatever the bridge says. */
    get standby(): boolean {
        return this._standby;
    }

    /** What happens to this instance's clusters when it loses the Bridge, as the Bridge last said. */
    get disconnectPolicy(): DisconnectPolicy {
        return this._disconnectPolicy;
    }

    private markConnected(): void {
        this.clearKeepTimer();
        if (this.state.current === ManagedInstanceConnectionStatus.CONNECTED) return;
        this.state.transition(ManagedInstanceConnectionStatus.CONNECTED);
    }

    /**
     * Idempotent like {@link disconnectAndKillAll}. Keeps the clusters running if the Bridge's
     * policy says so, stops them otherwise.
     */
    private onBridgeLost(): void {
        if (this.state.current === ManagedInstanceConnectionStatus.DISCONNECTED) return;
        this.resumed = false;

        const policy = this._disconnectPolicy;
        if (!policy.keepClusters || this.stopRequested || this.clusters.size === 0) {
            this.disconnectAndKillAll();
            return;
        }

        this.state.transition(ManagedInstanceConnectionStatus.DISCONNECTED);
        this.events.emit('BRIDGE_CLUSTERS_KEPT', [...this.clusters.keys()], policy.timeoutMs);
        if (policy.timeoutMs !== undefined) {
            this.keepTimer = setTimeout(() => {
                this.keepTimer = undefined;
                this.killAll(`Bridge not back within ${policy.timeoutMs}ms`);
            }, policy.timeoutMs);
        }
    }

    /**
     * Idempotent: net-ipc emits `status` 4 (DISCONNECTED) and afterwards `close` for the same
     * drop (retries exhausted / explicit close), so this runs twice per disconnect. The second
     * call must be a no-op - DISCONNECTED -> DISCONNECTED is not a valid transition.
     */
    private disconnectAndKillAll(): void {
        if (this.state.current === ManagedInstanceConnectionStatus.DISCONNECTED) return;
        this.killAll('Bridge connection closed');
        this.state.transition(ManagedInstanceConnectionStatus.DISCONNECTED);
    }

    private killAll(reason: string): void {
        this.clearKeepTimer();
        this.clusters.forEach((client) => {
            this.killProcess(client, reason);
        });
    }

    private clearKeepTimer(): void {
        if (!this.keepTimer) return;
        clearTimeout(this.keepTimer);
        this.keepTimer = undefined;
    }

    /**
     * First thing after every connect: tell the Bridge which clusters still run here, and stop the
     * ones it does not take over. A Bridge without `INSTANCE_RESUME` rejects the request; it knows
     * none of them, so they all stop.
     */
    private resume(): void {
        this.resumed = false;
        const clusters: ResumedCluster[] = this.clusters.values()
            .filter(c => c.status !== 'stopped')
            .map(c => ({ id: c.id, shardList: c.shardList, totalShards: c.totalShards, running: c.status === 'running' }))
            .toArray();

        this.eventManager.request<ResumeResponse>({ type: 'INSTANCE_RESUME', data: { clusters } }, RESUME_TIMEOUT_MS).then((response) => {
            const stopped = clusters.filter(c => !response.keep.includes(c.id)).map(c => c.id);
            this.stopReported(stopped, 'Bridge did not take the cluster over');
            // The Bridge only takes over a cluster nothing else serves, e.g. the new process of a move whose old one is gone.
            response.keep.forEach((id) => this.serve(id));
            this.resumed = true;
            this.events.emit('INSTANCE_RESUMED', response.keep, stopped);
        }).catch((err) => {
            if (this.state.current !== ManagedInstanceConnectionStatus.CONNECTED) return;
            this.events.emit('ERROR', `Resuming at the bridge failed, stopping the clusters it does not know: ${err}`);
            this.stopReported(clusters.map(c => c.id), 'Bridge could not take the cluster over');
            this.resumed = true;
        });
    }

    private stopReported(ids: number[], reason: string): void {
        for (const id of ids) {
            const cluster = this.clusters.get(id);
            if (cluster) this.killProcess(cluster, reason);
        }
    }

    private selfCheck() {
        this.eventManager.request<SelfCheckResponse>({ type: 'SELF_CHECK' }, SELF_CHECK_TIMEOUT_MS).then((response) => {
            this.events.emit('SELF_CHECK_RECEIVED', response);

            const startingClusters = this.clusters.values().filter(c => c.status == 'starting').toArray();
            startingClusters.forEach((c: ClusterProcess) => {
                if (Date.now() - c.createdAt > STARTING_CLUSTER_TIMEOUT_MS) {
                    this.killProcess(c, 'Cluster took too long to start');
                }
            })

            // check if there is an wrong cluster on this host
            const wrongClusters = this.clusters.values().filter(c => !response.clusterList.includes(c.id)).toArray();
            if (wrongClusters.length > 0) {
                this.events.emit('SELF_CHECK_ERROR', `Self check found wrong clusters: ${wrongClusters.map(c => c.id).join(', ')}`);
                wrongClusters.forEach(c => {
                    this.killProcess(c, 'Self check found wrong cluster');
                });
            } else {
                this.events.emit('SELF_CHECK_SUCCESS');
            }
        }).catch((err) => {
            this.events.emit('SELF_CHECK_ERROR', `Self check failed: ${err}`);
        });
    }

    protected setClusterStopped(client: ClusterProcess, reason: string): void {
        this.eventManager.send({
            type: 'CLUSTER_STOPPED',
            data: { id: client.id, reason: reason }
        }).catch(() => {});
    }

    protected setClusterReady(client: ClusterProcess, guilds: number, members: number): void {
        this.eventManager.send({
            type: 'CLUSTER_READY',
            data: { id: client.id, guilds: guilds, members: members }
        }).catch(() => {});
    }

    protected setClusterSpawned(client: ClusterProcess): void {
        this.eventManager.send({
            type: 'CLUSTER_SPAWNED',
            data: { id: client.id }
        }).catch(() => {});
        if (this.serveOnSpawn.delete(client.id)) this.handOver(client);
    }

    private onBridgeMessage(message: BridgeMessage): void {
        switch (message.type) {
            case 'CLUSTER_CREATE':
                this.onClusterCreate(message.data);
                return;
            case 'CLUSTER_STOP':
                this.onClusterStop(message.data);
                return;
            case 'CLUSTER_SERVING':
                this.serve(message.data.id);
                return;
            case 'CLUSTER_RECLUSTER':
                this.onClusterRecluster(message.data);
                return;
            case 'INSTANCE_STOP_ACK':
                this.events.emit('INSTANCE_STOP_ACK');
                return;
            case 'INSTANCE_STOP':
                this.stopRequested = true;
                this.events.emit('INSTANCE_STOP');
                return;
            case 'INSTANCE_STANDBY':
                this._standby = message.data.standby;
                this.events.emit('INSTANCE_STANDBY', message.data.standby);
                return;
            case 'INSTANCE_DISCONNECT_POLICY':
                this._disconnectPolicy = message.data;
                this.events.emit('INSTANCE_DISCONNECT_POLICY', message.data);
                return;
            case 'CLUSTER_SPAWNED':
            case 'CLUSTER_READY':
            case 'CLUSTER_STOPPED':
                // ManagedInstance only ever SENDS these to the bridge, never receives them back.
                return;
            default:
                ignoreUnknownMessage(message, 'ManagedInstance.onBridgeMessage');
        }
    }

    private onClusterCreate(data: ClusterCreateData) {
        if (this.clusters.has(data.clusterID)) {
            this.eventManager.send({
                type: 'CLUSTER_STOPPED',
                data: { id: data.clusterID, reason: 'Cluster already exists' }
            }).catch(() => {});
            return;
        }

        this.serveOnSpawn.delete(data.clusterID);
        this.startProcess(this.instanceID, data.clusterID, data.shardList, data.totalShards, data.token, data.intents as GatewayIntentsString[], data.serving ?? true);
    }

    private onClusterStop(data: { id: number }) {
        const cluster = this.clusters.get(data.id)
        if (cluster) {
            this.killProcess(cluster, `Request to stop cluster ${data.id}`);
        }
    }

    private serve(id: number): void {
        const cluster = this.clusters.get(id);
        if (!cluster) {
            // The old process of a move died before the new one spawned.
            this.serveOnSpawn.add(id);
            return;
        }
        this.handOver(cluster);
    }

    private handOver(cluster: ClusterProcess): void {
        if (cluster.status === 'stopped') return;
        cluster.setServing().catch((err) => {
            this.events.emit('ERROR', `Failed to hand cluster ${cluster.id} over: ${err}`);
        });
    }

    private onClusterRecluster(data: { clusterID: number }) {
        const cluster = this.clusters.get(data.clusterID);
        if (cluster) {
            this.events.emit('CLUSTER_RECLUSTER', cluster);
        }
    }

    protected async forwardGuildRequestElsewhere(guildID: string, data: unknown, timeout: number): Promise<unknown> {
        return this.eventManager.request({ type: 'REDIRECT_REQUEST_TO_GUILD', guildID, data }, timeout);
    }

    protected forwardGuildMessageElsewhere(): void {
        // The bridge protocol has no fire-and-forget guild-redirect message today - matches
        // pre-refactor behavior, where ManagedInstance never implemented this path either.
    }

    protected async broadcastEvalAcrossClusters(data: string, timeout: number): Promise<unknown[]> {
        return this.eventManager.request<unknown[]>({ type: 'BROADCAST_EVAL', data }, timeout);
    }

    private async onBridgeRequest(message: BridgeRequest, timeout: number): Promise<unknown> {
        switch (message.type) {
            case 'REDIRECT_REQUEST_TO_GUILD': {
                const cluster = this.clusters.get(message.clusterID!);
                if (!cluster) {
                    return Promise.reject(new Error(`Cluster is not here. Cluster ID: ${message.clusterID}`));
                }
                return cluster.eventManager.request({ type: 'CUSTOM', data: message.data }, timeout);
            }
            case 'CLUSTER_HEARTBEAT': {
                const cluster = this.clusters.get(message.data.clusterID);
                if (!cluster) {
                    return Promise.reject(new Error(`Cluster is not here. Cluster ID: ${message.data.clusterID}`));
                }
                return cluster.eventManager.request({ type: 'CLUSTER_HEARTBEAT' }, timeout);
            }
            case 'BROADCAST_EVAL':
                return Promise.all(this.clusters.values().filter(c => c.status == 'running').map(c =>
                    c.eventManager.request({ type: 'BROADCAST_EVAL', data: message.data }, timeout)
                ));
            case 'SELF_CHECK':
            case 'INSTANCE_RESUME':
                // ManagedInstance only ever SENDS these to the bridge, never receives them.
                return Promise.reject(new Error(`ManagedInstance does not handle incoming ${message.type} requests`));
            default:
                return rejectUnknownRequest(message, 'ManagedInstance.onBridgeRequest');
        }
    }

    stopInstance(): void {
        this.eventManager.send({ type: 'INSTANCE_STOP' }).catch(() => {});
    }
}
