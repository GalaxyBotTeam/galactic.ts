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
        // A cluster moving onto the lost instance is not kept: its old process still serves it.
        const reserved = this.calculator.getClusterForConnection(connection)
            .filter(c => c.connection === connection && RESERVABLE.includes(c.connectionStatus) && !c.oldConnection);
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
     * Answers `INSTANCE_RESUME`. A reported cluster is taken over if it is still assigned to this
     * instance (reserved, or left on its previous connection) or nobody holds it, and only if its
     * shards match the Bridge's layout.
     *
     * The report is the whole truth about the instance: it runs nothing else. So every cluster the
     * Bridge still has on a previous connection of this instance and that is not reported is freed.
     * That also cleans up clusters an instance stopped through `INSTANCE_STOP` left behind: the stop
     * removes the instance before its disconnect arrives, so they were never released.
     */
    resume(connection: BridgeInstanceConnection, reported: ResumedCluster[]): ResumeResponse {
        const kept: BridgeClusterConnection[] = [];
        const rejected: RejectedCluster[] = [];
        const onPreviousConnection = (c: BridgeClusterConnection) =>
            c.connection !== undefined && c.connection !== connection && c.connection.instanceID === connection.instanceID;

        for (const report of reported) {
            const cluster = this.calculator.clusterList.find(c => c.clusterID === report.id);
            const reason = this.mismatch(cluster, report);
            if (!cluster || reason) {
                rejected.push({ id: report.id, reason: reason ?? 'unknown cluster' });
                continue;
            }

            if (onPreviousConnection(cluster) && RESERVABLE.includes(cluster.connectionStatus) && !cluster.oldConnection) {
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

        for (const cluster of this.calculator.clusterList) {
            if (cluster.oldConnection && cluster.oldConnection !== connection && cluster.oldConnection.instanceID === connection.instanceID) {
                cluster.oldConnection = undefined;
            }
            if (!onPreviousConnection(cluster) || kept.includes(cluster)) continue;
            cluster.markDisconnected();
            this.events.emit('CLUSTER_STOPPED', cluster);
        }
        const keep = kept.map(c => c.clusterID);

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
