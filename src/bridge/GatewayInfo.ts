const GATEWAY_BOT_URL = 'https://discord.com/api/v10/gateway/bot';
const GATEWAY_BOT_TIMEOUT_MS = 10_000;

/** Response of Discord's `GET /gateway/bot`. */
export type GatewayInfo = {
    url: string,
    /** The shard count Discord recommends. */
    shards: number,
    session_start_limit: {
        total: number,
        remaining: number,
        reset_after: number,
        /** Above 1 for bots on large bot sharding. */
        max_concurrency: number,
    },
};

export async function fetchGatewayInfo(token: string): Promise<GatewayInfo> {
    const response = await fetch(GATEWAY_BOT_URL, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(GATEWAY_BOT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET /gateway/bot answered ${response.status}`);
    return await response.json() as GatewayInfo;
}

/**
 * Problems Discord would only report at runtime. The multiple Discord assigns for large bot sharding is not
 * part of the API, so `max_concurrency` stands in for it and the result is a warning: close code 4010 is final.
 */
export function checkShardCount(info: GatewayInfo, totalShards: number): string[] {
    const { remaining, reset_after, max_concurrency } = info.session_start_limit;
    const warnings: string[] = [];

    if (totalShards < info.shards) {
        warnings.push(`Discord recommends ${info.shards} shards, but ${totalShards} are configured.`);
    }
    if (max_concurrency > 1 && totalShards % max_concurrency !== 0) {
        warnings.push(`${totalShards} shards is not a multiple of max_concurrency ${max_concurrency}. On large bot sharding Discord closes the connection with 4010 if the count is not a multiple of the assigned shard number.`);
    }
    if (remaining < totalShards) {
        warnings.push(`Only ${remaining} session starts are left for ${totalShards} shards. The limit resets in ${Math.ceil(reset_after / 60_000)} minutes.`);
    }
    return warnings;
}
