import { Server } from "net-ipc";
import { BridgeInstanceConnection } from "./BridgeInstanceConnection";

export type BridgeServerEvents = {
    onInstanceConnected(connection: BridgeInstanceConnection): void;
    onInstanceDisconnected(connection: BridgeInstanceConnection, reason: string): void;
};

/** Owns the net-ipc Server lifecycle and connect/disconnect/message wiring - no cluster business logic. */
export class BridgeServer {
    public readonly server: Server;
    public readonly connectedInstances: Map<string, BridgeInstanceConnection> = new Map();

    constructor(port: number, private readonly events: BridgeServerEvents) {
        this.server = new Server({ port });
    }

    start(): Promise<void> {
        return this.server.start().then(() => {
            this.listen();
        });
    }

    private listen(): void {
        this.server.on('connect', (connection, payload) => {
            const id = payload?.id;
            const data = payload?.data as unknown;
            const dev = payload?.dev || false;

            if (!id) {
                connection.close('Invalid payload', false);
                return;
            }
            if (this.connectedInstances.values().some(client => client.instanceID === id)) {
                connection.close('Already connected', false);
                return;
            }

            const bridgeInstanceConnection = new BridgeInstanceConnection(id, connection, data, dev);
            this.connectedInstances.set(connection.id, bridgeInstanceConnection);
            this.events.onInstanceConnected(bridgeInstanceConnection);
        });

        this.server.on('disconnect', (connection, reason) => {
            const closedConnection = this.connectedInstances.get(connection.id);
            if (!closedConnection) return;

            this.connectedInstances.delete(connection.id);
            this.events.onInstanceDisconnected(closedConnection, reason);
        });

        this.server.on('message', (message, connection) => {
            this.connectedInstances.get(connection.id)?.dispatch(message);
        });
    }
}
