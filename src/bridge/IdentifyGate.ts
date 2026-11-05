/** Discord allows one identify per rate limit key in this window. */
export const IDENTIFY_WINDOW_MS = 5000;

/**
 * Paces cluster starts across all instances. discord.js throttles identifies inside one process only,
 * so two clusters starting at once can break `max_concurrency` unless the Bridge keeps them apart.
 * Timing is measured from the start of a cluster: it assumes clusters take about equally long to spawn.
 */
export class IdentifyGate {
    private maxConcurrency = 1;
    /** Per rate limit key (`shard_id % max_concurrency`): when its last reserved identify is over. */
    private readonly busyUntil = new Map<number, number>();

    /** The keys change with `max_concurrency`, so existing reservations no longer apply. */
    setMaxConcurrency(maxConcurrency: number): void {
        if (maxConcurrency === this.maxConcurrency) return;
        this.maxConcurrency = maxConcurrency;
        this.busyUntil.clear();
    }

    /** Reserves the slot if the shards can start right now. */
    tryAcquire(shardList: number[]): boolean {
        const now = Date.now();
        if (this.earliestStart(shardList, now) > now) return false;
        this.reserve(shardList, now);
        return true;
    }

    /** Reserves the next free slot at once, so callers start in the order they asked, and waits for it. */
    async acquire(shardList: number[]): Promise<void> {
        const now = Date.now();
        const start = this.earliestStart(shardList, now);
        this.reserve(shardList, start);
        if (start > now) await new Promise(resolve => setTimeout(resolve, start - now));
    }

    private earliestStart(shardList: number[], now: number): number {
        return Math.max(now, ...this.identifiesPerKey(shardList).keys().map(key => this.busyUntil.get(key) ?? 0));
    }

    private reserve(shardList: number[], start: number): void {
        for (const [key, identifies] of this.identifiesPerKey(shardList)) {
            this.busyUntil.set(key, start + identifies * IDENTIFY_WINDOW_MS);
        }
    }

    private identifiesPerKey(shardList: number[]): Map<number, number> {
        const identifies = new Map<number, number>();
        for (const shard of shardList) {
            const key = shard % this.maxConcurrency;
            identifies.set(key, (identifies.get(key) ?? 0) + 1);
        }
        return identifies;
    }
}
