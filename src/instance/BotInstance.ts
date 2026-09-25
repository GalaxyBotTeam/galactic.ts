import { ClusterProcess } from "../cluster/ClusterProcess";
import { GatewayIntentsString } from "discord.js";
import { ShardingUtil } from "../domain/ShardingUtil";
import { TypedEmitter } from "../general/TypedEmitter";
import { ProcessSpawner } from "./ProcessSpawner";
import { ChildProcessLifecycle } from "./ChildProcessLifecycle";
import { SpawnParams } from "../protocol/processEnv";
import { ProcessMessage, ProcessRequest } from "../protocol/process";
import { ignoreUnknownMessage, rejectUnknownRequest, SerializedError } from "../protocol/shared";

export abstract class BotInstance {

    public readonly clusters: Map<number, ClusterProcess> = new Map();

    protected _shuttingDown = false;

    protected readonly events = new TypedEmitter<BotInstanceEvents>();

    private readonly spawner: ProcessSpawner;
    private readonly lifecycle: ChildProcessLifecycle;

    private messageListener?: BotInstanceMessageListener;
    private requestListener?: BotInstanceRequestListener;

    protected constructor(entryPoint: string, execArgv?: string[]) {
        this.spawner = new ProcessSpawner(entryPoint, execArgv ?? []);
        this.lifecycle = new ChildProcessLifecycle(this.events);
    }

    protected startProcess(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]): void {
        const params: SpawnParams = { instanceID, clusterID, shardList, totalShards, token, intents };

        this.spawner.spawn(params, {
            onSpawned: (cp) => {
                this.events.emit('PROCESS_SPAWNED', cp);
                this.setClusterSpawned(cp);
                this.clusters.set(cp.id, cp);
                cp.eventManager.onMessage((message) => this.onMessage(cp, message));
                cp.eventManager.onRequest((message, timeout) => this.onRequest(cp, message, timeout));
            },
            onError: (cp, err) => this.events.emit('PROCESS_ERROR', cp, err),
            onExit: (cp, reason) => { this.killProcess(cp, reason); },
        });
    }

    /**
     * In-flight kills keyed by cluster. killProcess() is reached twice for one teardown: once
     * explicitly (CLUSTER_ERROR, CLUSTER_STOP, self-check, shutdown) and again from the child's
     * 'exit' event that the first kill causes. Coalescing them keeps setClusterStopped() - and
     * therefore CLUSTER_STOPPED to the bridge / the restart in StandaloneInstance - to one call.
     */
    private readonly pendingKills = new Map<ClusterProcess, Promise<void>>();

    protected killProcess(clusterProcess: ClusterProcess, reason: string): Promise<void> {
        const inFlight = this.pendingKills.get(clusterProcess);
        if (inFlight) return inFlight;

        const kill = this.lifecycle.kill(clusterProcess, reason).then(() => {
            this.clusters.delete(clusterProcess.id);
            this.setClusterStopped(clusterProcess, reason);
        }).finally(() => {
            this.pendingKills.delete(clusterProcess);
        });
        this.pendingKills.set(clusterProcess, kill);
        return kill;
    }

    protected abstract setClusterStopped(clusterProcess: ClusterProcess, reason: string): void;

    protected abstract setClusterReady(clusterProcess: ClusterProcess, guilds: number, members: number): void;

    protected abstract setClusterSpawned(clusterProcess: ClusterProcess): void;

    public abstract start(): void;

    private onMessage(clusterProcess: ClusterProcess, message: ProcessMessage): void {
        switch (message.type) {
            case 'CLUSTER_READY':
                // A child can report ready while we are already tearing it down (killProcess
                // marks it stopped, then waits up to SELF_DESTRUCT_TIMEOUT_MS). Ignore it -
                // the cluster is going away and must not be advertised as running.
                if (clusterProcess.status === 'stopped') return;
                clusterProcess.markRunning();
                this.events.emit('CLUSTER_READY', clusterProcess);
                this.setClusterReady(clusterProcess, message.guilds || 0, message.members || 0);
                return;
            case 'CLUSTER_ERROR':
                clusterProcess.markStopped();
                this.events.emit('CLUSTER_ERROR', clusterProcess, message.error);
                this.killProcess(clusterProcess, 'Cluster error: ' + message.error.message);
                return;
            case 'CUSTOM':
                this.messageListener?.(clusterProcess, message.data);
                return;
            case 'REDIRECT_MESSAGE_TO_GUILD': {
                const shardID = ShardingUtil.getShardIDForGuild(message.guildID, clusterProcess.totalShards);
                if (clusterProcess.shardList.includes(shardID)) {
                    clusterProcess.eventManager.send({ type: 'CUSTOM', data: message.data });
                } else {
                    this.forwardGuildMessageElsewhere(message.guildID, message.data);
                }
                return;
            }
            default:
                ignoreUnknownMessage(message, 'BotInstance.onMessage');
        }
    }

    protected async onRequest(clusterProcess: ClusterProcess, message: ProcessRequest, timeout: number): Promise<unknown> {
        switch (message.type) {
            case 'REDIRECT_REQUEST_TO_GUILD': {
                const shardID = ShardingUtil.getShardIDForGuild(message.guildID, clusterProcess.totalShards);
                if (clusterProcess.shardList.includes(shardID)) {
                    return clusterProcess.eventManager.request({ type: 'CUSTOM', data: message.data }, timeout);
                }
                return this.forwardGuildRequestElsewhere(message.guildID, message.data, timeout);
            }
            case 'BROADCAST_EVAL':
                return this.broadcastEvalAcrossClusters(message.data, timeout);
            case 'CUSTOM':
                if (!this.requestListener) return Promise.reject(new Error('No CUSTOM request handler registered'));
                return new Promise((resolve, reject) => this.requestListener!(clusterProcess, message.data, resolve, reject));
            case 'CLUSTER_HEARTBEAT':
            case 'SELF_DESTRUCT':
                // These are requests a parent SENDS to a child, never receives from one.
                return Promise.reject(new Error(`BotInstance does not receive incoming ${message.type} requests`));
            default:
                return rejectUnknownRequest(message, 'BotInstance.onRequest');
        }
    }

    /** Hook: guild's shard lives on another instance/cluster this BotInstance doesn't own directly. */
    protected abstract forwardGuildRequestElsewhere(guildID: string, data: unknown, timeout: number): Promise<unknown>;

    /** Hook: same as above, fire-and-forget. */
    protected abstract forwardGuildMessageElsewhere(guildID: string, data: unknown): void;

    /** Hook: fan a BROADCAST_EVAL out across every cluster this BotInstance knows about (locally or via a bridge). */
    protected abstract broadcastEvalAcrossClusters(data: string, timeout: number): Promise<unknown[]>;

    public on<K extends keyof AllBotInstanceListeners>(event: K, listener: AllBotInstanceListeners[K]): void {
        if (event === 'message') {
            this.messageListener = listener as BotInstanceMessageListener;
            return;
        }
        if (event === 'request') {
            this.requestListener = listener as BotInstanceRequestListener;
            return;
        }
        this.events.on(event as keyof BotInstanceEvents, listener as BotInstanceEvents[keyof BotInstanceEvents]);
    }

    public off<K extends keyof AllBotInstanceListeners>(event: K, listener: AllBotInstanceListeners[K]): void {
        if (event === 'message') {
            if (this.messageListener === listener) this.messageListener = undefined;
            return;
        }
        if (event === 'request') {
            if (this.requestListener === listener) this.requestListener = undefined;
            return;
        }
        this.events.off(event as keyof BotInstanceEvents, listener as BotInstanceEvents[keyof BotInstanceEvents]);
    }

    public sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout = 5000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            for (const client of this.clusters.values()) {
                const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
                if (client.shardList.includes(shardID)) {
                    client.eventManager.request({
                        type: 'CUSTOM',
                        data: message
                    }, timeout).then(resolve).catch(reject);
                    return;
                }
            }
            reject(new Error(`No cluster found for guild ${guildID}`));
        });
    }

    public sendRequestToCluster(cluster: ClusterProcess, message: unknown, timeout = 5000): Promise<unknown> {
        return cluster.eventManager.request({
            type: 'CUSTOM',
            data: message
        }, timeout);
    }
}

export type BotInstanceEvents = {
    'PROCESS_KILLED': (clusterProcess: ClusterProcess, reason: string, processKilled: boolean) => void,
    'PROCESS_SELF_DESTRUCT_ERROR': (clusterProcess: ClusterProcess, reason: string, error: unknown) => void,
    'PROCESS_SPAWNED': (clusterProcess: ClusterProcess) => void,
    'PROCESS_ERROR': (clusterProcess: ClusterProcess, error: unknown) => void,
    'CLUSTER_READY': (clusterProcess: ClusterProcess) => void,
    'CLUSTER_ERROR': (clusterProcess: ClusterProcess, error: SerializedError) => void,
    'CLUSTER_RECLUSTER': (clusterProcess: ClusterProcess) => void,
    'ERROR': (error: string) => void,

    'BRIDGE_CONNECTION_ESTABLISHED': () => void,
    'BRIDGE_CONNECTION_CLOSED': (reason: string) => void,
    'BRIDGE_CONNECTION_STATUS_CHANGE': (status: number) => void,
    'INSTANCE_STOP_ACK': () => void,
    'INSTANCE_STOP': () => void,

    'SELF_CHECK_SUCCESS': () => void,
    'SELF_CHECK_ERROR': (error: string) => void,
    'SELF_CHECK_RECEIVED': (data: { clusterList: number[] }) => void,
};

export type BotInstanceMessageListener = (clusterProcess: ClusterProcess, message: unknown) => void;
export type BotInstanceRequestListener = (clusterProcess: ClusterProcess, message: unknown, resolve: (data: unknown) => void, reject: (error: unknown) => void) => void;

type AllBotInstanceListeners = BotInstanceEvents & {
    'message': BotInstanceMessageListener,
    'request': BotInstanceRequestListener,
};
