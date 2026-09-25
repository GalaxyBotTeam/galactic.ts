/** A plain-object, JSON-safe representation of a thrown error - survives process/socket boundaries. */
export type SerializedError = {
    message: string,
    stack?: string,
    name?: string,
};

export function serializeError(e: unknown): SerializedError {
    if (e instanceof Error) {
        return { message: e.message, stack: e.stack, name: e.name };
    }
    return { message: String(e) };
}

export type ShardPing = {
    id: number,
    ping: number,
    status: number,
    guilds: number,
    members: number,
    uptime?: unknown,
};

export type HeartbeatResponse = {
    cpu: {
        raw: {
            user: number,
            system: number,
        },
        cpuPercent: string,
    },
    memory: {
        raw: {
            rss: number,
            heapTotal: number,
            heapUsed: number,
            external: number,
            arrayBuffers: number,
        },
        memoryPercent: string,
        usage: string,
    },
    ping: number,
    shardPings: ShardPing[],
};

/**
 * Exhaustiveness helper for discriminated-union switches. Call in the `default` case:
 * if a union member is ever added without a matching `case`, this line fails to compile
 * because `x` is no longer typed `never`.
 */
export function assertNever(x: never, context: string): never {
    throw new Error(`Unhandled protocol case in ${context}: ${JSON.stringify(x)}`);
}

/**
 * Runtime-safe exhaustiveness pins for the message/request routers. They give the same
 * compile-time guarantee as `assertNever` (the `default` branch only type-checks while every
 * union member has a `case`), but a type that only exists at runtime - a peer running another
 * version of this package during a rolling deploy - is logged and dropped (messages) or
 * answered with a rejection (requests) instead of throwing inside a transport's event
 * emitter and crashing the whole process.
 */
export function ignoreUnknownMessage(x: never, context: string): void {
    console.warn(`[galactic] ${context}: ignoring unknown message type ${describeUnknown(x)}`);
}

export function rejectUnknownRequest(x: never, context: string): Promise<never> {
    return Promise.reject(new Error(`${context}: unknown request type ${describeUnknown(x)}`));
}

function describeUnknown(x: unknown): string {
    const type = (x as { type?: unknown } | null)?.type;
    return typeof type === 'string' ? `'${type}'` : JSON.stringify(x);
}
