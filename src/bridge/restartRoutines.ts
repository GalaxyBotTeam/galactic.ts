import type { RestartContext, RestartRoutine } from "./RestartCoordinator";

/** Picks which instances a routine handles and in which order; may return a subset of `ids`. */
export type InstanceOrder = (ids: readonly number[], ctx: RestartContext) => number[];

export const byId: InstanceOrder = (ids) => [...ids].sort((a, b) => a - b);

function ordered(order: InstanceOrder, ctx: RestartContext): number[] {
    const ids = order(ctx.instances, ctx);
    if (new Set(ids).size !== ids.length || ids.some(id => !ctx.instances.includes(id))) {
        throw new Error(`InstanceOrder returned unknown or duplicate instance IDs: ${ids.join(', ')}`);
    }
    return ids;
}

/** Restarts the instances one after another. */
export function sequentialRestart(order: InstanceOrder = byId): RestartRoutine {
    return async (ctx) => {
        for (const id of ordered(order, ctx)) await ctx.restart(id);
    };
}

/** Rolls every instance's clusters onto the previously restarted one, starting with the empty standby. */
export function rollingReload(order: InstanceOrder = byId): RestartRoutine {
    return async (ctx) => {
        if (ctx.standby.length !== 1) throw new Error(`rollingReload needs exactly one standby instance, found ${ctx.standby.length}.`);
        const ids = ordered(order, ctx);
        const standby = ctx.standby[0];

        // The standby runs new code before it takes any clusters.
        await ctx.restart(standby);
        let prev = standby;
        for (const id of ids) {
            await ctx.moveAllClusters(id, prev);
            await ctx.restart(id);
            prev = id;
        }
        // Leave the standby empty again.
        if (prev !== standby) await ctx.moveAllClusters(standby, prev);
    };
}
