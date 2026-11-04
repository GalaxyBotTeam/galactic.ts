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

    public spawnedAt?: number;

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
