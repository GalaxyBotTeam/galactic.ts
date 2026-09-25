import { BridgeInstanceConnection } from "./BridgeInstanceConnection";
import { ClusterCalculator } from "../domain/ClusterCalculator";
import { ShardingUtil } from "../domain/ShardingUtil";
import { BridgeClusterConnectionStatus } from "../domain/BridgeClusterState";
import { BridgeRequest, SelfCheckResponse } from "../protocol/bridge";
import { rejectUnknownRequest } from "../protocol/shared";

export type BridgeRequestRouterDeps = {
    calculator: ClusterCalculator;
    connectedInstances: Map<string, BridgeInstanceConnection>;
    totalShards(): number;
};

/** Typed dispatch table replacing the old `if (m.type == 'X')` chain in Bridge.onRequest. */
export function createBridgeRequestHandler(connection: BridgeInstanceConnection, deps: BridgeRequestRouterDeps) {
    return (message: BridgeRequest, timeout: number): unknown => {
        switch (message.type) {
            case 'REDIRECT_REQUEST_TO_GUILD': {
                const shardID = ShardingUtil.getShardIDForGuild(message.guildID, deps.totalShards());
                const cluster = deps.calculator.getClusterOfShard(shardID);
                if (!cluster) {
                    return Promise.reject(new Error('cluster not found'));
                }
                if (cluster.connectionStatus != BridgeClusterConnectionStatus.CONNECTED) {
                    return Promise.reject(new Error('cluster not connected.'));
                }
                if (!cluster.connection?.eventManager) {
                    return Promise.reject(new Error('no connection defined.'));
                }
                return cluster.connection.eventManager.request({
                    type: 'REDIRECT_REQUEST_TO_GUILD',
                    clusterID: cluster.clusterID,
                    guildID: message.guildID,
                    data: message.data,
                }, timeout);
            }
            case 'BROADCAST_EVAL': {
                return Promise.all(
                    deps.connectedInstances.values().map(c =>
                        c.eventManager.request<unknown[]>({ type: 'BROADCAST_EVAL', data: message.data }, timeout))
                ).then(r => r.flatMap(f => f));
            }
            case 'SELF_CHECK': {
                const response: SelfCheckResponse = {
                    clusterList: [
                        ...deps.calculator.getClusterForConnection(connection).map(c => c.clusterID),
                        ...deps.calculator.getOldClusterForConnection(connection).map(c => c.clusterID),
                    ],
                };
                return response;
            }
            case 'CLUSTER_HEARTBEAT':
                // Bridge only ever SENDS this to instances, never receives it as a request.
                return Promise.reject(new Error('Bridge does not handle incoming CLUSTER_HEARTBEAT requests'));
            default:
                return rejectUnknownRequest(message, 'BridgeRequestRouter');
        }
    };
}
