import { EventManager } from "../transport/EventManager";
import { NetIpcConnectionTransport } from "../transport/NetIpcConnectionTransport";
import { Connection } from "net-ipc";
import { BridgeInstanceConnectionStatus, createBridgeInstanceState } from "../domain/BridgeInstanceState";
import { BridgeMessage, BridgeRequest } from "../protocol/bridge";

export { BridgeInstanceConnectionStatus };

export class BridgeInstanceConnection {
    public readonly instanceID: number;
    public readonly eventManager: EventManager<BridgeMessage, BridgeRequest>;
    public readonly connection: Connection;
    public readonly transport: NetIpcConnectionTransport;
    public readonly data: unknown;
    public readonly dev: boolean = false;
    public readonly establishedAt: number = Date.now();

    private readonly state = createBridgeInstanceState();

    constructor(instanceID: number, connection: Connection, data: unknown, dev: boolean) {
        this.instanceID = instanceID;
        this.connection = connection;
        this.data = data;
        this.dev = dev || false;
        this.transport = new NetIpcConnectionTransport(connection);
        this.eventManager = new EventManager<BridgeMessage, BridgeRequest>(this.transport);
    }

    get connectionStatus(): BridgeInstanceConnectionStatus {
        return this.state.current;
    }

    markPendingStop(): void {
        if (this.state.current === BridgeInstanceConnectionStatus.PENDING_STOP) return;
        this.state.transition(BridgeInstanceConnectionStatus.PENDING_STOP);
    }

    /** Server-side demux: BridgeServer routes an incoming net-ipc `message` event here. */
    dispatch(message: unknown): void {
        this.transport.dispatch(message);
    }

    /** @deprecated Use `eventManager.onMessage()`. Replaces the Bridge's own handler, as it always did. */
    onMessage(callback: (message: unknown) => void): void {
        this.eventManager.onMessage(callback);
    }

    /** @deprecated Use `eventManager.onRequest()`. Replaces the Bridge's own handler, as it always did. */
    onRequest(callback: (message: unknown, timeout: number) => unknown): void {
        this.eventManager.onRequest(callback);
    }

    /** @deprecated Use {@link dispatch}. */
    messageReceive(message: unknown): void {
        this.dispatch(message);
    }
}
