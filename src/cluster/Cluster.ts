import { Client, GatewayIntentsString } from "discord.js";
import { EventManager } from "../transport/EventManager";
import { ChildProcessTransport } from "../transport/ChildProcessTransport";
import { ProcessMessage, ProcessRequest } from "../protocol/process";
import { serializeError } from "../protocol/shared";
import { createClusterRequestHandler, CustomRequestHandler } from "./ClusterRequestHandler";

export class Cluster<T extends Client> {

    public readonly instanceID: number;

    public readonly clusterID: number;

    public readonly shardList: number[] = [];

    public readonly totalShards: number;

    public readonly token: string;

    public readonly intents: GatewayIntentsString[];

    public eventManager: EventManager<ProcessMessage, ProcessRequest>;

    public client!: T;

    public onSelfDestruct?: () => void | Promise<void>;

    private _shuttingDown = false;

    private readonly eventMap: {
        'message': ((message: unknown) => void) | undefined,
        'request': CustomRequestHandler | undefined,
        'CLUSTER_READY': (() => void) | undefined,
    } = {
        message: undefined, request: undefined, CLUSTER_READY: undefined,
    }

    constructor(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]) {
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

    static initial<T extends Client>(): Cluster<T> {
        const args = process.env;

        if (args.SHARD_LIST == undefined || args.INSTANCE_ID == undefined || args.TOTAL_SHARDS == undefined || args.TOKEN == undefined || args.INTENTS == undefined || args.CLUSTER_ID == undefined) {
            throw new Error("Missing required environment variables");
        }

        const shardList = args.SHARD_LIST.split(',').map(Number);

        const totalShards = Number(args.TOTAL_SHARDS);

        const instanceID = Number(args.INSTANCE_ID);
        const clusterID = Number(args.CLUSTER_ID);

        const token = args.TOKEN;

        const intents = args.INTENTS.split(',').map(i => i.trim()) as GatewayIntentsString[];

        return new Cluster<T>(instanceID, clusterID, shardList, totalShards, token, intents);
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
        if (this.onSelfDestruct) {
            await Promise.resolve(this.onSelfDestruct());
        }
        if (this.client) {
            try { this.client.destroy(); } catch {}
        }
    }

    private onMessage(message: ProcessMessage): void {
        if (message.type === 'CUSTOM' && this.eventMap.message) {
            this.eventMap.message(message.data);
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
};
