import { SerializedError } from './shared';

/**
 * Wire protocol between a parent process (BotInstance/ClusterProcess) and the forked
 * child process running a Cluster. Fire-and-forget messages - no reply expected.
 */
export type ProcessMessage =
    | { type: 'CUSTOM', data: unknown }
    | { type: 'CLUSTER_READY', id: number, guilds: number, members: number }
    | { type: 'CLUSTER_ERROR', id: number, error: SerializedError }
    | { type: 'REDIRECT_MESSAGE_TO_GUILD', guildID: string, data: unknown };

/**
 * Wire protocol between a parent process and the forked child, request/response side.
 */
export type ProcessRequest =
    | { type: 'CUSTOM', data: unknown }
    | { type: 'CLUSTER_HEARTBEAT' }
    | { type: 'SELF_DESTRUCT', reason: string }
    | { type: 'REDIRECT_REQUEST_TO_GUILD', guildID: string, data: unknown }
    /**
     * WARNING: the child evaluates `data` (a stringified function) via `eval()`.
     * This is only safe because the parent and child are the same trust boundary
     * (both spawned by the same BotInstance) - never route untrusted input onto this
     * channel, and never expose CUSTOM/BROADCAST_EVAL handling to external input either.
     */
    | { type: 'BROADCAST_EVAL', data: string };
