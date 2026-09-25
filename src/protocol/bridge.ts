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
    | { type: 'INSTANCE_STOP_ACK' };

/**
 * Wire protocol between a ManagedInstance and the Bridge, request/response side.
 */
export type BridgeRequest =
    | { type: 'SELF_CHECK' }
    | { type: 'CLUSTER_HEARTBEAT', data: { clusterID: number } }
    | { type: 'REDIRECT_REQUEST_TO_GUILD', clusterID?: number, guildID: string, data: unknown }
    /** WARNING: see protocol/process.ts's BROADCAST_EVAL - same eval() risk, same trust boundary caveat. */
    | { type: 'BROADCAST_EVAL', data: string };

export type SelfCheckResponse = { clusterList: number[] };

export type { HeartbeatResponse };
