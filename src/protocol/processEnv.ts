import { GatewayIntentsString } from 'discord.js';

/**
 * The parameters a parent process hands a forked cluster child. This is the single
 * source of truth for that hand-off - `encodeEnv` (parent side, ProcessSpawner) and
 * `decodeEnv` (child side, Cluster.initial()) must always agree on the shape, so they
 * live together here instead of being two independently hand-rolled implementations.
 */
export type SpawnParams = {
    instanceID: number,
    clusterID: number,
    shardList: number[],
    totalShards: number,
    token: string,
    intents: GatewayIntentsString[],
};

export function encodeEnv(params: SpawnParams): NodeJS.ProcessEnv {
    return {
        INSTANCE_ID: params.instanceID.toString(),
        CLUSTER_ID: params.clusterID.toString(),
        SHARD_LIST: params.shardList.join(','),
        TOTAL_SHARDS: params.totalShards.toString(),
        TOKEN: params.token,
        INTENTS: params.intents.join(','),
        FORCE_COLOR: 'true',
    };
}

export function decodeEnv(env: NodeJS.ProcessEnv): SpawnParams {
    if (env.SHARD_LIST == undefined || env.INSTANCE_ID == undefined || env.TOTAL_SHARDS == undefined
        || env.TOKEN == undefined || env.INTENTS == undefined || env.CLUSTER_ID == undefined) {
        throw new Error('Missing required environment variables');
    }

    return {
        instanceID: Number(env.INSTANCE_ID),
        clusterID: Number(env.CLUSTER_ID),
        shardList: env.SHARD_LIST.split(',').map(Number),
        totalShards: Number(env.TOTAL_SHARDS),
        token: env.TOKEN,
        intents: env.INTENTS.split(',').map(i => i.trim()) as GatewayIntentsString[],
    };
}
