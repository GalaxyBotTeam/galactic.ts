import { GatewayIntentsString } from "discord.js";
import { ClusterCalculator } from "../domain/ClusterCalculator";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { BridgeClusterConnection } from "./BridgeClusterConnection";
import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { TypedEmitter } from "../general/TypedEmitter";
import type { BridgeEvents } from "./Bridge";

/** Steal-selection + cluster assign/recluster business logic - was Bridge.createCluster/checkRecluster/moveCluster. */
export class ClusterReclusterer {
    constructor(
        private readonly calculator: ClusterCalculator,
        private readonly token: string,
        private readonly intents: GatewayIntentsString[],
        private readonly totalShards: () => number,
        private readonly events: TypedEmitter<BridgeEvents>,
    ) {}

    createCluster(connection: BridgeInstanceConnection, cluster: BridgeClusterConnection, recluster = false): void {
        cluster.resetMissedHeartbeats();
        cluster.heartbeatResponse = undefined;

        if (!recluster) {
            cluster.setConnection(connection);
        } else {
            cluster.oldConnection?.eventManager.send({
                type: 'CLUSTER_RECLUSTER',
                data: { clusterID: cluster.clusterID },
            }).catch((err) => {
                this.events.emit('ERROR', `Failed to notify old instance about reclustering of cluster ${cluster.clusterID}: ${err}`);
            });
        }

        this.events.emit('CLUSTER_SPAWNED', cluster, connection);
        connection.eventManager.send({
            type: 'CLUSTER_CREATE',
            data: {
                clusterID: cluster.clusterID,
                instanceID: connection.instanceID,
                totalShards: this.totalShards(),
                shardList: cluster.shardList,
                token: this.token,
                intents: this.intents,
            },
        }).catch((err) => {
            // The connection will drop and its disconnect handler frees the cluster again.
            this.events.emit('ERROR', `Failed to send CLUSTER_CREATE for cluster ${cluster.clusterID} to instance ${connection.instanceID}: ${err}`);
        });
    }

    /** Steals one cluster from the busiest connected instance onto the least busy one, if imbalanced. */
    checkRecluster(connectedInstances: BridgeInstanceConnection[]): void {
        if (!this.calculator.checkAllClustersConnected()) return;

        const { most, least } = this.calculator.findMostAndLeastClustersForConnections(connectedInstances);
        if (!most || !least) return;

        const clusterToSteal = this.calculator.getClusterForConnection(most)[0];
        if (!clusterToSteal) return;

        this.steal(clusterToSteal, least);
    }

    steal(cluster: BridgeClusterConnection, to: BridgeInstanceConnection): void {
        cluster.reclustering(to);
        this.events.emit('CLUSTER_RECLUSTER', cluster, to, cluster.oldConnection!);
        this.createCluster(to, cluster, true);
    }

    /** Public entry point (Bridge.moveCluster) - validates up front so callers get a descriptive error instead of an InvalidTransitionError. */
    moveCluster(bridgeInstanceConnection: BridgeInstanceConnection, bridgeClusterConnection: BridgeClusterConnection): void {
        if (bridgeClusterConnection.connectionStatus !== BridgeClusterConnectionStatus.CONNECTED) {
            throw new Error(`Cluster ${bridgeClusterConnection.clusterID} cannot be moved while ${bridgeClusterConnection.connectionStatus} - only CONNECTED clusters can be reclustered.`);
        }
        if (bridgeClusterConnection.connection?.instanceID === bridgeInstanceConnection.instanceID) {
            throw new Error(`Cluster ${bridgeClusterConnection.clusterID} already runs on instance ${bridgeInstanceConnection.instanceID}.`);
        }
        this.steal(bridgeClusterConnection, bridgeInstanceConnection);
    }
}
