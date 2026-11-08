import { GatewayIntentsString } from 'discord.js';
import { HeartbeatResponse } from './shared';

/**
 * Wire protocol between a ManagedInstance and the Bridge it connects to (net-ipc).
 * Fire-and-forget messages - no reply expected.
 */
export type BridgeMessage =
    | { type: 'CLUSTER_CREATE', data: { clusterID: number, instanceID: number, totalShards: number, shardList: number[], token: string, intents: GatewayIntentsString[] } }
    | { type: 'CLUSTER_STOP', data: { id: number } }
    | { type: 'CLUSTER_RECLUSTER', data: { clusterID: number } }
    | { type: 'CLUSTER_SPAWNED', data: { id: number } }
    | { type: 'CLUSTER_READY', data: { id: number, guilds?: number, members?: number } }
    | { type: 'CLUSTER_STOPPED', data: { id: number, reason?: string } }
    | { type: 'INSTANCE_STOP' }
    | { type: 'INSTANCE_STOP_ACK' }
    /** The instance's current standby role: on every connect and whenever a restart routine moves it. */
    | { type: 'INSTANCE_STANDBY', data: { standby: boolean } }
    /** What the instance does with its clusters when it loses the Bridge: on every connect and whenever it changes. */
    | { type: 'INSTANCE_DISCONNECT_POLICY', data: DisconnectPolicy };

/**
 * What an instance does with its running clusters when the connection to the Bridge drops.
 * The Bridge decides and tells every instance on connect.
 *
 * - `{ keepClusters: false }`: stop them at once (the default, and the only behaviour before this option).
 * - `{ keepClusters: true, timeoutMs }`: keep them running, stop them if the Bridge is not back within `timeoutMs`.
 * - `{ keepClusters: true }`: keep them running until the Bridge is back, however long that takes.
 *
 * When the instance reconnects it reports the clusters it still runs (`INSTANCE_RESUME`) and the
 * Bridge takes them over instead of starting them again.
 */
export type DisconnectPolicy =
    | { keepClusters: false }
    | { keepClusters: true, timeoutMs?: number };

/** One cluster process an instance still runs, as reported in `INSTANCE_RESUME`. */
export type ResumedCluster = { id: number, shardList: number[], totalShards: number, running: boolean };

/** The clusters the Bridge took over; the instance stops every other one it reported. */
export type ResumeResponse = { keep: number[] };

/**
 * Wire protocol between a ManagedInstance and the Bridge, request/response side.
 */
export type BridgeRequest =
    | { type: 'SELF_CHECK' }
    /** The first request after every connect: the clusters the instance still runs. Answered with a {@link ResumeResponse}. */
    | { type: 'INSTANCE_RESUME', data: { clusters: ResumedCluster[] } }
    | { type: 'CLUSTER_HEARTBEAT', data: { clusterID: number } }
    | { type: 'REDIRECT_REQUEST_TO_GUILD', clusterID?: number, guildID: string, data: unknown }
    /** WARNING: see protocol/process.ts's BROADCAST_EVAL - same eval() risk, same trust boundary caveat. */
    | { type: 'BROADCAST_EVAL', data: string };

export type SelfCheckResponse = { clusterList: number[] };

export type { HeartbeatResponse };
