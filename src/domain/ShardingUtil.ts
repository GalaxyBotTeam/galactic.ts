export class ShardingUtil {
    public static getShardIDForGuild(guildID: string, totalShards: number): number {
        if (!guildID || totalShards <= 0) {
            throw new Error("Invalid guild ID or total shards");
        }

        return  Number(BigInt(guildID) >> 22n) % totalShards;
    }
}