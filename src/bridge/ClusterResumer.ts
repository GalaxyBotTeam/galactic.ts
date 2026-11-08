import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeClusterConnection } from "./BridgeClusterConnection";
import { ClusterCalculator } from "./ClusterCalculator";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { TypedEmitter } from "../general/TypedEmitter";
import { DisconnectPolicy, ResumedCluster, ResumeResponse } from "../protocol/bridge";
import type { BridgeEvents } from "./Bridge";

/**
 * The Bridge waits this much longer than the instance before it gives up on a reserved cluster,
 * so the instance has stopped it before another instance starts it.
 */
export const RESERVATION_MARGIN_MS = 5000;

/** A cluster an instance reported but the Bridge did not take over; the instance stops it. */
export type RejectedCluster = { id: number, reason: string };

const RESERVABLE = [
    BridgeClusterConnectionStatus.REQUESTING,
    BridgeClusterConnectionStatus.STARTING,
    BridgeClusterConnectionStatus.CONNECTED,
];

/**
 * Keeps the clusters of an instance that lost the Bridge, and takes over the clusters an instance
 * still runs when it connects again - after a network drop or a restart of the Bridge.
 */
export class ClusterResumer {
    constructor(
        private readonly calculator: ClusterCalculator,
        private readonly totalShards: () => number,
        private readonly events: TypedEmitter<BridgeEvents>,
    ) {}

    /** On disconnect: keeps the clusters the instance may still run, as `policy` allows. */
    reserve(connection: BridgeInstanceConnection, policy: DisconnectPolicy): BridgeClusterConnection[] {
        if (!policy.keepClusters || !connection.supportsResume) return [];

        const until = policy.timeoutMs === undefined ? Infinity : Date.now() + policy.timeoutMs + RESERVATION_MARGIN_MS;
        const reserved = this.calculator.getClusterForConnection(connection)
            .filter(c => c.connection === connection && RESERVABLE.includes(c.connectionStatus));
        for (const cluster of reserved) {
            cluster.reserve(until);
            this.events.emit('CLUSTER_RESERVED', cluster, until);
        }
        return reserved;
    }

    /** Frees every reservation whose time is up; the scheduler calls this on every tick. */
    releaseExpired(now = Date.now()): void {
        for (const cluster of this.calculator.clusterList) {
            if (cluster.reservedUntil === undefined || cluster.reservedUntil > now) continue;
            cluster.markDisconnected();
            this.events.emit('CLUSTER_RESERVATION_EXPIRED', cluster);
        }
    }

    /** Frees every reservation at once, e.g. when the policy no longer keeps clusters. */
    releaseAll(): void {
        this.releaseExpired(Infinity);
    }

    /**
     * Answers `INSTANCE_RESUME`. A reported cluster is taken over if it is reserved for this
     * instance or nobody holds it, and only if its shards match the Bridge's layout. Reserved
     * clusters the instance no longer runs are freed.
     */
    resume(connection: BridgeInstanceConnection, reported: ResumedCluster[]): ResumeResponse {
        const kept: BridgeClusterConnection[] = [];
        const rejected: RejectedCluster[] = [];

        for (const report of reported) {
            const cluster = this.calculator.clusterList.find(c => c.clusterID === report.id);
            const reason = this.mismatch(cluster, report);
            if (!cluster || reason) {
                rejected.push({ id: report.id, reason: reason ?? 'unknown cluster' });
                continue;
            }

            if (cluster.reserved && cluster.connection?.instanceID === connection.instanceID) {
                cluster.resume(connection, report.running);
            } else if (!cluster.isUsed() && !cluster.oldConnection) {
                cluster.adopt(connection, report.running);
            } else if (cluster.connection !== connection) {
                const holder = cluster.connection?.instanceID ?? cluster.oldConnection?.instanceID;
                rejected.push({ id: report.id, reason: `held by instance ${holder}` });
                continue;
            }
            kept.push(cluster);
        }

        const keep = kept.map(c => c.clusterID);
        for (const cluster of this.calculator.clusterList) {
            if (!cluster.reserved || cluster.connection?.instanceID !== connection.instanceID || keep.includes(cluster.clusterID)) continue;
            cluster.markDisconnected();
            this.events.emit('CLUSTER_STOPPED', cluster);
        }

        connection.markResumed();
        this.events.emit('INSTANCE_RESUMED', connection, kept, rejected);
        return { keep };
    }

    private mismatch(cluster: BridgeClusterConnection | undefined, report: ResumedCluster): string | undefined {
        if (!cluster) return 'unknown cluster';
        if (report.totalShards !== this.totalShards()) return `runs ${report.totalShards} total shards, the Bridge ${this.totalShards()}`;
        const sameShards = report.shardList.length === cluster.shardList.length
            && report.shardList.every((shard, i) => shard === cluster.shardList[i]);
        if (!sameShards) return `runs shards ${report.shardList.join(',')}, the Bridge expects ${cluster.shardList.join(',')}`;
        return undefined;
    }
}
