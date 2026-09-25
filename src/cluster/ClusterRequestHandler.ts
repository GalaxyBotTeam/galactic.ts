import { Client } from 'discord.js';
import os from 'node:os';
import { ProcessRequest } from '../protocol/process';
import { HeartbeatResponse, rejectUnknownRequest, ShardPing } from '../protocol/shared';

export type CustomRequestHandler = (data: unknown, resolve: (data: unknown) => void, reject: (error: unknown) => void, timeout: number) => void;

/**
 * Delay between resolving a SELF_DESTRUCT request and exiting. The response is written by
 * EventManager only after the handler resolves, and process.send() is asynchronous - exiting
 * synchronously dropped the response every time, so the parent always waited out its
 * SELF_DESTRUCT timeout and SIGKILLed a process that had already shut down cleanly.
 */
export const SELF_DESTRUCT_EXIT_GRACE_MS = 250;

export type ClusterRequestHandlerDeps<T extends Client> = {
    getClient(): T;
    getCustomHandler(): CustomRequestHandler | undefined;
    selfDestruct(reason: string): Promise<void>;
    /** Terminates the process after SELF_DESTRUCT; defaults to process.exit(0). Injected for tests. */
    exit?(): void;
};

/**
 * WARNING: evaluates a stringified function received from the parent process via IPC.
 * Only safe because the parent and this child are the same trust boundary (both spawned
 * by the same BotInstance) - kept per explicit decision, not removed.
 */
function runBroadcastEval<T extends Client>(client: T, source: string): unknown {
    const fn = eval(`(${source})`);
    return fn(client);
}

/** Samples CPU/memory/shard-ping data over a real 500ms window (fixes the previous fire-and-forget bug). */
export function sampleHeartbeat<T extends Client>(client: T): Promise<HeartbeatResponse> {
    return new Promise((resolve) => {
        const startTime = process.hrtime.bigint();
        const startUsage = process.cpuUsage();

        setTimeout(() => {
            const endTime = process.hrtime.bigint();
            const usageDiff = process.cpuUsage(startUsage);

            const elapsedTimeUs = Number((endTime - startTime) / 1000n);
            const totalCPUTime = usageDiff.user + usageDiff.system;
            const cpuCount = os.cpus().length;
            const cpuPercent = (totalCPUTime / (elapsedTimeUs * cpuCount)) * 100;

            const shardPings: ShardPing[] = [];
            try {
                const shards = client.ws.shards;
                if (shards) {
                    shards.forEach((shard) => {
                        const entry: ShardPing = {
                            id: shard.id,
                            ping: shard.ping,
                            status: shard.status,
                            guilds: client.guilds.cache.filter(g => g.shardId === shard.id).size,
                            members: client.guilds.cache.filter(g => g.shardId === shard.id).reduce((acc, g) => acc + g.memberCount, 0),
                        };
                        shardPings.push(entry);
                        client.shard?.fetchClientValues('uptime', shard.id).then(values => {
                            entry.uptime = values;
                        }).catch(() => {});
                    });
                }
            } catch (_) {
                // ignore and keep empty shardPings on failure
            }

            resolve({
                cpu: { raw: process.cpuUsage(), cpuPercent: cpuPercent.toFixed(2) },
                memory: {
                    raw: process.memoryUsage(),
                    memoryPercent: ((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100).toFixed(2) + '%',
                    usage: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + 'MB',
                },
                ping: client.ws.ping,
                shardPings,
            });
        }, 500);
    });
}

/**
 * Child-side (Cluster.ts) dispatch table for requests sent DOWN from the parent.
 * REDIRECT_REQUEST_TO_GUILD is a request the child only ever SENDS (via
 * sendRequestToClusterOfGuild), never receives - it's rejected here for completeness.
 */
export function createClusterRequestHandler<T extends Client>(deps: ClusterRequestHandlerDeps<T>) {
    return function handleRequest(message: ProcessRequest, _timeout: number): unknown {
        switch (message.type) {
            case 'CUSTOM': {
                const handler = deps.getCustomHandler();
                if (!handler) return undefined;
                return new Promise((resolve, reject) => handler(message.data, resolve, reject, _timeout));
            }
            case 'CLUSTER_HEARTBEAT':
                return sampleHeartbeat(deps.getClient());
            case 'BROADCAST_EVAL':
                return runBroadcastEval(deps.getClient(), message.data);
            case 'SELF_DESTRUCT':
                return deps.selfDestruct(message.reason).then(() => {
                    const exit = deps.exit ?? (() => process.exit(0));
                    setTimeout(exit, SELF_DESTRUCT_EXIT_GRACE_MS);
                });
            case 'REDIRECT_REQUEST_TO_GUILD':
                return Promise.reject(new Error('Cluster does not handle incoming REDIRECT_REQUEST_TO_GUILD requests'));
            default:
                return rejectUnknownRequest(message, 'ClusterRequestHandler');
        }
    };
}
