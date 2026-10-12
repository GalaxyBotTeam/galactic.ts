import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { BridgeClusterConnection } from "./BridgeClusterConnection";
import { ClusterCalculator } from "./ClusterCalculator";
import { TypedEmitter } from "../general/TypedEmitter";
import { BridgeMessage } from "../protocol/bridge";
import { ignoreUnknownMessage } from "../protocol/shared";
import type { BridgeEvents } from "./Bridge";

export type BridgeMessageRouterDeps = {
    calculator: ClusterCalculator;
    events: TypedEmitter<BridgeEvents>;
    onInstanceStop(connection: BridgeInstanceConnection): void;
};

/** Typed dispatch table replacing the old `if (m.type == 'X')` chain in Bridge.onMessage. */
export function createBridgeMessageHandler(connection: BridgeInstanceConnection, deps: BridgeMessageRouterDeps) {
    return (message: BridgeMessage): void => {
        switch (message.type) {
            case 'CLUSTER_SPAWNED': {
                const cluster = findCluster(deps.calculator, connection, message.data.id);
                if (cluster) {
                    cluster.markStarting();
                    cluster.spawnedAt = Date.now();
                }
                return;
            }
            case 'CLUSTER_READY': {
                const cluster = findCluster(deps.calculator, connection, message.data.id);
                if (cluster) {
                    cluster.readyAt = Date.now();
                    const readyDuration = cluster.readyAt - cluster.spawnedAt!;
                    cluster.spawnedAt = undefined;

                    deps.events.emit('CLUSTER_READY', cluster, message.data.guilds || 0, message.data.members || 0, readyDuration);
                    cluster.markConnected();
                    if (cluster.oldConnection) {
                        const oldConnection = cluster.oldConnection;
                        oldConnection.eventManager.send({ type: 'CLUSTER_STOP', data: { id: cluster.clusterID } }).catch((err) => {
                            deps.events.emit('ERROR', `Failed to send CLUSTER_STOP for reclustered cluster ${cluster.clusterID} to instance ${oldConnection.instanceID}: ${err}`);
                        });
                        cluster.oldConnection = undefined;
                    }
                }
                return;
            }
            case 'CLUSTER_STOPPED': {
                const cluster = findCluster(deps.calculator, connection, message.data.id);
                if (cluster) {
                    cluster.readyAt = undefined;
                    deps.events.emit('CLUSTER_STOPPED', cluster);
                    cluster.setConnection(undefined);
                }
                return;
            }
            case 'INSTANCE_STOP':
                deps.onInstanceStop(connection);
                return;
            case 'CLUSTER_CREATE':
            case 'CLUSTER_STOP':
            case 'CLUSTER_RECLUSTER':
            case 'INSTANCE_STOP_ACK':
                // Bridge only ever SENDS these to instances, never receives them back.
                return;
            default:
                ignoreUnknownMessage(message, 'BridgeMessageRouter');
        }
    };
}

function findCluster(calculator: ClusterCalculator, connection: BridgeInstanceConnection, clusterID: number): BridgeClusterConnection | undefined {
    return calculator.getClusterForConnection(connection).find(c => c.clusterID === clusterID);
}
