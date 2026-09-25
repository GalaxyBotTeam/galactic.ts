import { BotInstance } from "./BotInstance";
import { ClusterProcess } from "../cluster/ClusterProcess";
import { Client } from "net-ipc";
import { EventManager } from "../transport/EventManager";
import { NetIpcClientTransport } from "../transport/NetIpcClientTransport";
import { GatewayIntentsString } from "discord.js";
import { ShardingUtil } from "../domain/ShardingUtil";
import { ManagedInstanceConnectionStatus, createManagedInstanceState } from "../domain/ManagedInstanceState";
import { BridgeMessage, BridgeRequest, SelfCheckResponse } from "../protocol/bridge";
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

    constructor(entryPoint: string, host: string, port: number, instanceID: number, data: unknown, execArgv?: string[], dev?: boolean) {
        super(entryPoint, execArgv);

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
            if (this.state.current == ManagedInstanceConnectionStatus.CONNECTED) {
                this.selfCheck();
            }
        }, SELF_CHECK_INTERVAL_MS);

        this.instance.connect({
            id: this.instanceID,
            dev: this.dev,
            data: this.data,
        }).then(_ => {
            this.events.emit('BRIDGE_CONNECTION_ESTABLISHED');
            this.markConnected();

            this.instance.on("close", (reason) => {
                this.events.emit('BRIDGE_CONNECTION_CLOSED', reason);
                this.disconnectAndKillAll();
            });

            this.instance.on("status", (status) => {
                this.events.emit('BRIDGE_CONNECTION_STATUS_CHANGE', status);

                if (status == 4) {
                    this.disconnectAndKillAll();
                } else if (status == 3) {
                    this.markConnected();
                    this.events.emit('BRIDGE_CONNECTION_ESTABLISHED');
                }
            });
        })
    }

    private markConnected(): void {
        if (this.state.current === ManagedInstanceConnectionStatus.CONNECTED) return;
        this.state.transition(ManagedInstanceConnectionStatus.CONNECTED);
    }

    /**
     * Idempotent: net-ipc emits `status` 4 (DISCONNECTED) and afterwards `close` for the same
     * drop (retries exhausted / explicit close), so this runs twice per disconnect. The second
     * call must be a no-op - DISCONNECTED -> DISCONNECTED is not a valid transition.
     */
    private disconnectAndKillAll(): void {
        if (this.state.current === ManagedInstanceConnectionStatus.DISCONNECTED) return;
        this.clusters.forEach((client) => {
            this.killProcess(client, 'Bridge connection closed');
        });
        this.state.transition(ManagedInstanceConnectionStatus.DISCONNECTED);
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
    }

    private onBridgeMessage(message: BridgeMessage): void {
        switch (message.type) {
            case 'CLUSTER_CREATE':
                this.onClusterCreate(message.data);
                return;
            case 'CLUSTER_STOP':
                this.onClusterStop(message.data);
                return;
            case 'CLUSTER_RECLUSTER':
                this.onClusterRecluster(message.data);
                return;
            case 'INSTANCE_STOP_ACK':
                this.events.emit('INSTANCE_STOP_ACK');
                return;
            case 'INSTANCE_STOP':
                this.events.emit('INSTANCE_STOP');
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

        this.startProcess(this.instanceID, data.clusterID, data.shardList, data.totalShards, data.token, data.intents as GatewayIntentsString[]);
    }

    private onClusterStop(data: { id: number }) {
        const cluster = this.clusters.get(data.id)
        if (cluster) {
            this.killProcess(cluster, `Request to stop cluster ${data.id}`);
        }
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
                // ManagedInstance only ever SENDS SELF_CHECK to the bridge, never receives it.
                return Promise.reject(new Error('ManagedInstance does not handle incoming SELF_CHECK requests'));
            default:
                return rejectUnknownRequest(message, 'ManagedInstance.onBridgeRequest');
        }
    }

    stopInstance(): void {
        this.eventManager.send({ type: 'INSTANCE_STOP' }).catch(() => {});
    }
}
