import {BridgeClusterConnection} from "./BridgeClusterConnection";
import {BridgeClusterConnectionStatus} from "../domain/BridgeClusterState";
import {BridgeInstanceConnection} from "./BridgeInstanceConnection";
import {BridgeInstanceConnectionStatus} from "../domain/BridgeInstanceState";

/**
 * Manages the calculation and distribution of clusters for a Discord bot sharding system.
 * This class is responsible for creating clusters with their assigned shards,
 * tracking which clusters are in use, and providing methods to retrieve available clusters.
 */
export class ClusterCalculator {
    /** The total number of clusters to initialize */
    private readonly clusterToStart: number;

    /** The number of shards that each cluster will manage */
    private readonly shardsPerCluster: number;

    /** List of all clusters managed by this calculator */
    public readonly clusterList: BridgeClusterConnection[]= [];

    /**
     * Creates a new ClusterCalculator and initializes the clusters.
     * 
     * @param clusterToStart - The number of clusters to create
     * @param shardsPerCluster - The number of shards each cluster will manage
     */
    constructor(clusterToStart: number, shardsPerCluster: number) {
        this.shardsPerCluster = shardsPerCluster;
        this.clusterToStart = clusterToStart;

        this.calculateClusters();
    }

    /**
     * Calculates and initializes all clusters with their assigned shards.
     * Each cluster is assigned a sequential range of shard IDs based on its cluster index.
     */
    private calculateClusters(): void {
        const clusters: Map<number, number[]> = new Map();
        for (let i = 0; i < this.clusterToStart; i++) {
            clusters.set(i, []);
            for (let j = 0; j < this.shardsPerCluster; j++) {
                clusters.get(i)?.push(i * this.shardsPerCluster + j);
            }
        }

        for (let [clusterIndex, clusterShards] of clusters.entries()) {
            this.clusterList.push(new BridgeClusterConnection(clusterIndex, clusterShards));
        }
    }

    /**
     * Retrieves the next available (unused) cluster and marks it as used.
     * 
     * @returns The next available cluster, or undefined if all clusters are in use
     */
    public getNextCluster(): BridgeClusterConnection | undefined {
        for (const cluster of this.clusterList) {
            if (!cluster.isUsed()) {
                return cluster;
            }
        }
        return undefined; // No available clusters
    }

    /**
     * Retrieves multiple available clusters up to the specified count.
     * Each returned cluster is marked as used.
     * 
     * @param count - The maximum number of clusters to retrieve
     * @returns An array of available clusters (may be fewer than requested if not enough are available)
     */
    public getNextClusters(count: number): BridgeClusterConnection[] {
        const availableClusters: BridgeClusterConnection[] = [];
        for (const cluster of this.clusterList) {
            if (!cluster.isUsed() && availableClusters.length < count) {
                availableClusters.push(cluster);
            }
        }
        return availableClusters; // Returns the clusters that were found
    }

    /**
     * Sets the used status of a specific cluster by its ID.
     *
     * @param clusterID - The ID of the cluster to update
     * @param connection - The connection to associate with the cluster
     */
    public clearClusterConnection(clusterID: number): void {
        const cluster = this.clusterList.find(c => c.clusterID === clusterID);
        if (cluster) {
            cluster.setConnection(undefined);
        }
    }

    public getClusterForConnection(connection: BridgeInstanceConnection): BridgeClusterConnection[] {
        return this.clusterList.filter(cluster =>
            cluster.connection?.instanceID === connection.instanceID
        );
    }

    public getOldClusterForConnection(connection: BridgeInstanceConnection): BridgeClusterConnection[] {
        return this.clusterList.filter(cluster =>
            cluster.oldConnection?.instanceID === connection.instanceID
        );
    }

    public checkAllClustersConnected(): boolean {
        for (const cluster of this.clusterList) {
            if (cluster.connectionStatus != BridgeClusterConnectionStatus.CONNECTED){
                return false; // At least one cluster is not in use
            }
        }
        return true; // All clusters are in use
    }


    findMostAndLeastClustersForConnections(
        connectedClients: BridgeInstanceConnection[]
    ): {
        most: BridgeInstanceConnection | undefined,
        least: BridgeInstanceConnection | undefined
    } {

        const openClients = connectedClients.filter(x => !x.dev)

        const devClients = connectedClients.filter(x => x.dev)
        const summDevConnectedClusters = devClients.map(c => this.getClusterForConnection(c).length).reduce((a, b) => a + b, 0);

        let most: BridgeInstanceConnection | undefined;
        let least: BridgeInstanceConnection | undefined;
        let remainder = ((this.clusterToStart - summDevConnectedClusters) % openClients.length || 0);

        for (const client of openClients) {
            const clusters = this.getClusterForConnection(client);

            if (!most || clusters.length > this.getClusterForConnection(most).length) {
                most = client;
            }

            if (!least || clusters.length < this.getClusterForConnection(least).length) {
                least = client;
            }
        }

        if (most && least) {
            const mostCount = this.getClusterForConnection(most).length;
            const leastCount = this.getClusterForConnection(least).length;

            // Only recluster if the difference is greater than remainder
            if (mostCount - leastCount <= remainder) {
                return {most: undefined, least: undefined};
            }
        }

        return {most, least};
    }

    getClusterWithLowestLoad(connectedClients: Map<string, BridgeInstanceConnection>): BridgeInstanceConnection | undefined {
        let lowestLoadClient: BridgeInstanceConnection | undefined;
        let lowestLoad = Infinity;

        for (const client of connectedClients.values().filter(c =>
            c.connectionStatus === BridgeInstanceConnectionStatus.READY && !c.dev)) {
            const clusters = this.getClusterForConnection(client);

            const load = clusters.length; // Assuming load is determined by the number of clusters assigned
            if (load < lowestLoad) {
                lowestLoad = load;
                lowestLoadClient = client;
            }
        }

        return lowestLoadClient; // Returns the client with the lowest load, or undefined if no clients are connected
    }

    getClusterOfShard(shardID: number) {
        return this.clusterList.find(c => c.shardList.includes(shardID));
    }
}
