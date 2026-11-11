import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeClusterConnectionStatus, createBridgeClusterState } from "../domain/BridgeClusterState";
import { HeartbeatResponse } from "../protocol/shared";

export { BridgeClusterConnectionStatus };

export class BridgeClusterConnection {
    public readonly clusterID: number;
    public readonly shardList: number[];

    private readonly state = createBridgeClusterState();

    public connection?: BridgeInstanceConnection;

    public oldConnection?: BridgeInstanceConnection;

    public missedHeartbeats: number = 0;

    public heartbeatResponse?: HeartbeatResponse;

    public heartbeatPending = false;

    public readyAt?: number;

    /** The process on `connection` was started for a move and does not serve yet; the Bridge sends `CLUSTER_SERVING`. */
    public handoverPending = false;

    public spawnedAt?: number;

    /**
     * Set while the instance holding this cluster is gone but may still run it (`DisconnectPolicy`):
     * the time the Bridge gives up on it, `Infinity` for never. The cluster stays assigned meanwhile,
     * so it is not started anywhere else, but it gets no heartbeats and serves no requests.
     */
    public reservedUntil?: number;

    constructor(clusterID: number, shardList: number[]) {
        this.clusterID = clusterID;
        this.shardList = shardList;
    }

    get connectionStatus(): BridgeClusterConnectionStatus {
        return this.state.current;
    }

    setConnection(connection?: BridgeInstanceConnection): void {
        if (connection == undefined) {
            this.state.transition(BridgeClusterConnectionStatus.DISCONNECTED);
            this.connection = undefined;
            this.reservedUntil = undefined;
            return;
        }

        if (this.connection) {
            throw new Error(`Connection already set for cluster ${this.clusterID}`);
        }

        this.state.transition(BridgeClusterConnectionStatus.REQUESTING);
        this.connection = connection;
    }

    markStarting(): void {
        this.state.transition(BridgeClusterConnectionStatus.STARTING);
    }

    markConnected(): void {
        this.state.transition(BridgeClusterConnectionStatus.CONNECTED);
    }

    markDisconnected(): void {
        this.state.transition(BridgeClusterConnectionStatus.DISCONNECTED);
        this.connection = undefined;
        this.reservedUntil = undefined;
    }

    get reserved(): boolean {
        return this.reservedUntil !== undefined;
    }

    /** Keeps the cluster assigned to its instance, which lost the Bridge, until `until`. */
    reserve(until: number): void {
        this.reservedUntil = until;
        this.heartbeatResponse = undefined;
        this.resetMissedHeartbeats();
    }

    /**
     * The instance is back and still runs the cluster: `connection` replaces the closed one.
     * A cluster that became ready meanwhile is marked connected.
     */
    resume(connection: BridgeInstanceConnection, running: boolean): void {
        this.connection = connection;
        this.reservedUntil = undefined;
        if (this.connectionStatus === BridgeClusterConnectionStatus.REQUESTING) {
            this.markStarting();
            this.spawnedAt ??= Date.now();
        }
        if (running && this.connectionStatus === BridgeClusterConnectionStatus.STARTING) {
            this.markConnected();
            this.readyAt = Date.now();
            this.spawnedAt = undefined;
        }
    }

    /** Takes over a cluster nobody holds, which `connection` reported as still running or starting. */
    adopt(connection: BridgeInstanceConnection, running: boolean): void {
        this.setConnection(connection);
        this.markStarting();
        this.spawnedAt = Date.now();
        this.resetMissedHeartbeats();
        if (running) {
            this.markConnected();
            this.readyAt = Date.now();
            this.spawnedAt = undefined;
        }
    }

    /** The instance that answers for this cluster: during a move the old one, until the new one is ready. */
    get servingConnection(): BridgeInstanceConnection | undefined {
        if (this.reserved) return undefined;
        if (this.oldConnection) return this.oldConnection;
        return this.connectionStatus === BridgeClusterConnectionStatus.CONNECTED ? this.connection : undefined;
    }

    isUsed(): boolean {
        return this.connection != undefined && this.connectionStatus !== BridgeClusterConnectionStatus.DISCONNECTED;
    }

    reclustering(connection: BridgeInstanceConnection): void {
        this.state.transition(BridgeClusterConnectionStatus.RECLUSTERING);
        this.oldConnection = this.connection;
        this.connection = connection;
    }

    addMissedHeartbeat(): void {
        this.missedHeartbeats++;
    }

    removeMissedHeartbeat(): void {
        if (this.missedHeartbeats > 0) {
            this.missedHeartbeats--;
        }
    }

    resetMissedHeartbeats(): void {
        this.missedHeartbeats = 0;
    }
}

export type { HeartbeatResponse };
