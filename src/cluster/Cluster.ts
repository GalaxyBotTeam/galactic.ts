import { Client, GatewayIntentsString } from "discord.js";
import { EventManager } from "../transport/EventManager";
import { ChildProcessTransport } from "../transport/ChildProcessTransport";
import { ProcessMessage, ProcessRequest } from "../protocol/process";
import { INVALID_SHARD_CLOSE_CODE, INVALID_SHARD_COUNT_ERROR, serializeError } from "../protocol/shared";
import { decodeEnv } from "../protocol/processEnv";
import { createClusterRequestHandler, CustomRequestHandler } from "./ClusterRequestHandler";

export class Cluster<T extends Client> {

    public readonly instanceID: number;

    public readonly clusterID: number;

    public readonly shardList: number[] = [];

    public readonly totalShards: number;

    public readonly token: string;

    public readonly intents: GatewayIntentsString[];

    public eventManager: EventManager<ProcessMessage, ProcessRequest>;

    private _client!: T;

    public onSelfDestruct?: () => void | Promise<void>;

    private _shuttingDown = false;

    private _serving: boolean;

    private readonly eventMap: {
        'message': ((message: unknown) => void) | undefined,
        'request': CustomRequestHandler | undefined,
        'CLUSTER_READY': (() => void) | undefined,
        'SERVING': ((serving: boolean) => void) | undefined,
    } = {
        message: undefined, request: undefined, CLUSTER_READY: undefined, SERVING: undefined,
    }

    constructor(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[], serving = true) {
        this._serving = serving;
        this.instanceID = instanceID;
        this.clusterID = clusterID;
        this.shardList = shardList;
        this.totalShards = totalShards;
        this.token = token;
        this.intents = intents;

        this.eventManager = new EventManager<ProcessMessage, ProcessRequest>(new ChildProcessTransport(process));
        this.eventManager.onMessage((message) => this.onMessage(message));
        this.eventManager.onRequest(createClusterRequestHandler<T>({
            getClient: () => this.client,
            getCustomHandler: () => this.eventMap.request,
            selfDestruct: (reason) => this.shutdown(reason),
        }));

        const gracefulExit = async () => {
            await this.shutdown('signal');
            process.exit(0);
        };
        process.once('SIGTERM', gracefulExit);
        process.once('SIGINT', gracefulExit);
    }

    get client(): T {
        return this._client;
    }

    /**
     * Whether this cluster handles Discord events. While galactic moves a cluster, the old and the
     * new process are connected to the same shards and Discord sends every event to both. Only one
     * of them is serving: the old one until the new one is ready, then the new one. The old one
     * stops serving as soon as it is asked to stop.
     *
     * Return early from your event handlers while this is `false`. The events a new process
     * receives before the hand-over, including the ones discord.js holds back until `clientReady`
     * and replays then, have already been handled by the old process.
     */
    get serving(): boolean {
        return this._serving;
    }

    set client(client: T) {
        this._client = client;
        // discord.js gives up on this close code without an error, the cluster would just never become ready.
        client.on?.('shardDisconnect', ({ code }) => {
            if (code === INVALID_SHARD_CLOSE_CODE) this.triggerError(new Error(INVALID_SHARD_COUNT_ERROR)).catch(() => {});
        });
    }

    /** Builds the Cluster for this child process from the env ProcessSpawner set (see protocol/processEnv.ts). */
    static initial<T extends Client>(): Cluster<T> {
        const params = decodeEnv(process.env);
        return new Cluster<T>(params.instanceID, params.clusterID, params.shardList, params.totalShards, params.token, params.intents, params.serving);
    }

    /** Resolves once the message was handed to the parent; rejects if the IPC channel is gone. */
    triggerReady(guilds: number, members: number): Promise<void> {
        const sent = this.eventManager.send({
            type: 'CLUSTER_READY',
            id: this.clusterID,
            guilds: guilds,
            members: members,
        });

        if(this.eventMap?.CLUSTER_READY) {
            this.eventMap?.CLUSTER_READY();
        }
        return sent;
    }

    triggerError(e: unknown): Promise<void> {
        return this.eventManager.send({
            type: 'CLUSTER_ERROR',
            id: this.clusterID,
            error: serializeError(e),
        });
    }

    /** Shared by SIGTERM/SIGINT and the SELF_DESTRUCT request handler - idempotent. */
    private async shutdown(_reason: string): Promise<void> {
        if (this._shuttingDown) return;
        this._shuttingDown = true;
        // Before onSelfDestruct: during a move the new process takes over right now.
        this.setServing(false);
        if (this.onSelfDestruct) {
            await Promise.resolve(this.onSelfDestruct());
        }
        if (this.client) {
            try { this.client.destroy(); } catch {}
        }
    }

    private setServing(serving: boolean): void {
        if (this._serving === serving) return;
        this._serving = serving;
        this.eventMap.SERVING?.(serving);
    }

    private onMessage(message: ProcessMessage): void {
        if (message.type === 'CUSTOM' && this.eventMap.message) {
            this.eventMap.message(message.data);
        }
        // A cluster that is shutting down never serves again.
        if (message.type === 'CLUSTER_SERVING' && !this._shuttingDown) {
            this.setServing(message.serving);
        }
    }

    public on<K extends keyof ClusterEventListeners>(event: K, listener: ClusterEventListeners[K]): void {
        this.eventMap[event] = listener as any;
    }

    public sendMessage(data: unknown): Promise<void> {
        return this.eventManager.send({
            type: 'CUSTOM',
            data: data,
        });
    }

    public sendRequest(data: unknown, timeout = 5000): Promise<unknown> {
        return this.eventManager.request({
            type: 'CUSTOM',
            data: data,
        }, timeout);
    }

    /**
     * WARNING: `fn` is serialized via `.toString()`, sent over IPC, and `eval()`'d in every
     * cluster. Only safe because every cluster is spawned by the same trusted parent process -
     * never pass a function derived from untrusted/external input.
     */
    public broadcastEval<Result>(fn: (cluster: T) => Result, timeout = 20000): Promise<Result[]> {
        return this.eventManager.request({
            type: 'BROADCAST_EVAL',
            data: fn.toString(),
        }, timeout);
    }


    public sendMessageToClusterOfGuild(guildID: string, message: unknown): Promise<void> {
        return this.eventManager.send({
            type: 'REDIRECT_MESSAGE_TO_GUILD',
            guildID: guildID,
            data: message
        });
    }

    public sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout = 5000): Promise<unknown> {
        return this.eventManager.request({
            type: 'REDIRECT_REQUEST_TO_GUILD',
            guildID: guildID,
            data: message
        }, timeout);
    }
}

export type ClusterEventListeners = {
    message: (message: unknown) => void;
    request: CustomRequestHandler;

    CLUSTER_READY: () => void;
    /** `serving` changed, see {@link Cluster.serving}. */
    SERVING: (serving: boolean) => void;
};
