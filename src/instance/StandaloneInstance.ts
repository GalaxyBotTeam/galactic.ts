import { BotInstance } from "./BotInstance";
import { ClusterProcess } from "../cluster/ClusterProcess";
import { GatewayIntentsString } from "discord.js";

const STANDALONE_INSTANCE_ID = 1;
const RESTART_BACKOFF_BASE_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 60 * 1000;
/** Consecutive crashes after which every further restart also emits an ERROR event. */
const CRASH_LOOP_THRESHOLD = 5;

export class StandaloneInstance extends BotInstance {
    private readonly totalClusters: number;
    private readonly shardsPerCluster: number;

    public readonly token: string;
    public readonly intents: GatewayIntentsString[];

    /** Consecutive crash-restart attempts per cluster id - reset once a cluster reports ready. */
    private readonly restartAttempts: Map<number, number> = new Map();

    /** Pending backoff timers per cluster id - cleared on shutdown so nothing respawns afterwards. */
    private readonly restartTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

    constructor(entryPoint: string, shardsPerCluster: number, totalClusters: number, token: string, intents: GatewayIntentsString[], execArgv?: string[]) {
        super(entryPoint, execArgv);
        this.shardsPerCluster = shardsPerCluster;
        this.totalClusters = totalClusters;
        this.token = token;
        this.intents = intents;
    }

    get totalShards(): number {
        return this.shardsPerCluster * this.totalClusters;
    }

    private calculateClusters(): Record<number, number[]> {
        const clusters: Record<number, number[]> = {};
        for (let i = 0; i < this.totalClusters; i++) {
            clusters[i] = [];
            for (let j = 0; j < this.shardsPerCluster; j++) {
                clusters[i].push(i * this.shardsPerCluster + j);
            }
        }
        return clusters;
    }

    public start(): void {
        const clusters = this.calculateClusters();
        for (const [id, shardList] of Object.entries(clusters)) {
            this.startProcess(STANDALONE_INSTANCE_ID, Number(id), shardList, this.totalShards, this.token, this.intents);
        }
    }

    protected setClusterStopped(clusterProcess: ClusterProcess, reason: string): void {
        this.clusters.delete(clusterProcess.id);
        if (this._shuttingDown) return;

        const attempts = (this.restartAttempts.get(clusterProcess.id) ?? 0) + 1;
        this.restartAttempts.set(clusterProcess.id, attempts);

        // Never give up: a cluster that stays down means its shards are offline until someone
        // intervenes. Back off exponentially (capped) and flag the crash loop instead.
        const delay = Math.min(RESTART_BACKOFF_BASE_MS * Math.pow(2, attempts - 1), RESTART_BACKOFF_MAX_MS);
        if (attempts > CRASH_LOOP_THRESHOLD) {
            this.events.emit('ERROR', `Cluster ${clusterProcess.id} is crash-looping (${attempts} consecutive exits, last: ${reason}) - restarting in ${delay}ms.`);
        }

        const previous = this.restartTimers.get(clusterProcess.id);
        if (previous) clearTimeout(previous);

        const timer = setTimeout(() => {
            this.restartTimers.delete(clusterProcess.id);
            if (this._shuttingDown) return;
            this.restartProcess(clusterProcess);
        }, delay);
        this.restartTimers.set(clusterProcess.id, timer);
    }

    public async shutdown(): Promise<void> {
        this._shuttingDown = true;
        for (const timer of this.restartTimers.values()) clearTimeout(timer);
        this.restartTimers.clear();
        await Promise.all(Array.from(this.clusters.values()).map(c => this.killProcess(c, 'Graceful shutdown')));
    }

    protected setClusterReady(clusterProcess: ClusterProcess): void {
        this.restartAttempts.delete(clusterProcess.id);
    }

    protected setClusterSpawned(): void {
        // no-op: StandaloneInstance has no external coordinator to notify.
    }

    private restartProcess(clusterProcess: ClusterProcess): void {
        this.startProcess(STANDALONE_INSTANCE_ID, clusterProcess.id, clusterProcess.shardList, this.totalShards, this.token, this.intents);
    }

    protected async forwardGuildRequestElsewhere(guildID: string): Promise<unknown> {
        return Promise.reject(new Error(`No cluster owns guild ${guildID} and there is no bridge to escalate to.`));
    }

    protected forwardGuildMessageElsewhere(): void {
        // no bridge to forward to; matches pre-refactor behavior (this path silently dropped the message).
    }

    protected async broadcastEvalAcrossClusters(data: string, timeout: number): Promise<unknown[]> {
        return Promise.all(
            this.clusters.values().map(c => c.eventManager.request({ type: 'BROADCAST_EVAL', data }, timeout))
        );
    }
}
