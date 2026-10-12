import { ClusterCalculator } from "./ClusterCalculator";
import { ClusterReclusterer } from "./ClusterReclusterer";
import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { TypedEmitter } from "../general/TypedEmitter";
import type { BridgeEvents } from "./Bridge";

export const DRAIN_POLL_INTERVAL_MS = 1000;

/** Ack-handshake + drain-wait poll for stopping one instance - was Bridge.stopInstance. */
export class InstanceStopCoordinator {
    constructor(
        private readonly calculator: ClusterCalculator,
        private readonly reclusterer: ClusterReclusterer,
        private readonly connectedInstances: Map<string, BridgeInstanceConnection>,
        private readonly events: TypedEmitter<BridgeEvents>,
    ) {}

    async stop(connection: BridgeInstanceConnection, recluster = true): Promise<void> {
        connection.markPendingStop();

        await connection.eventManager.send({ type: 'INSTANCE_STOP_ACK' });
        this.events.emit('INSTANCE_STOP_ACK', connection);

        if (recluster && this.connectedInstances.size > 1) {
            await this.drainViaRecluster(connection);
        } else {
            await this.stopImmediately(connection);
        }
    }

    private async drainViaRecluster(connection: BridgeInstanceConnection): Promise<void> {
        let clusterToSteal;
        while ((clusterToSteal = this.calculator.getClusterForConnection(connection).filter(c =>
            c.connectionStatus === BridgeClusterConnectionStatus.CONNECTED ||
            c.connectionStatus === BridgeClusterConnectionStatus.STARTING ||
            c.connectionStatus === BridgeClusterConnectionStatus.RECLUSTERING)[0]) !== undefined) {
            if (clusterToSteal.connectionStatus !== BridgeClusterConnectionStatus.CONNECTED) break;

            const least = this.calculator.getClusterWithLowestLoad(this.connectedInstances);
            if (!least) {
                this.events.emit('ERROR', 'Reclustering failed: No least cluster found.');
                await connection.eventManager.send({ type: 'CLUSTER_STOP', data: { id: clusterToSteal.clusterID } });
                clusterToSteal.markDisconnected();
                continue;
            }

            this.reclusterer.steal(clusterToSteal, least);
        }

        await this.waitForDrain(connection);

        await connection.eventManager.send({ type: 'INSTANCE_STOP' });
        this.events.emit('INSTANCE_STOP', connection);

        this.connectedInstances.delete(connection.connection.id);
        await connection.connection.close('Instance stopped.', false);
    }

    private waitForDrain(connection: BridgeInstanceConnection): Promise<void> {
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                const stillDraining = this.calculator.getOldClusterForConnection(connection)[0];
                if (!stillDraining) {
                    clearInterval(interval);
                    resolve();
                }
            }, DRAIN_POLL_INTERVAL_MS);
        });
    }

    private async stopImmediately(connection: BridgeInstanceConnection): Promise<void> {
        this.calculator.getClusterForConnection(connection).forEach(cluster => {
            cluster.markDisconnected();
            this.events.emit('CLUSTER_STOPPED', cluster);
        });

        await connection.eventManager.send({ type: 'INSTANCE_STOP' });
        this.events.emit('INSTANCE_STOP', connection);

        this.connectedInstances.delete(connection.connection.id);
        await connection.connection.close('Instance stopped.', true);
    }
}
