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

    /**
     * The instance reports the clusters it still runs after every connect (`INSTANCE_RESUME`) and
     * honours a `DisconnectPolicy`. Older versions do neither.
     */
    public readonly supportsResume: boolean;

    private readonly state = createBridgeInstanceState();
    private _standby: boolean;
    private _resumed: boolean;

    constructor(instanceID: number, connection: Connection, data: unknown, dev: boolean, standby?: boolean, supportsResume = false) {
        this.instanceID = instanceID;
        this.connection = connection;
        this.data = data;
        this.dev = dev || false;
        this._standby = standby || false;
        this.supportsResume = supportsResume;
        this._resumed = !supportsResume;
        this.transport = new NetIpcConnectionTransport(connection);
        this.eventManager = new EventManager<BridgeMessage, BridgeRequest>(this.transport);
    }

    get connectionStatus(): BridgeInstanceConnectionStatus {
        return this.state.current;
    }

    /** Kept empty by the balancer; filled only by explicit moves or restart routines. */
    get standby(): boolean {
        return this._standby;
    }

    setStandby(standby: boolean): void {
        this._standby = standby;
    }

    /**
     * False until the instance has reported the clusters it still runs. The Bridge gives it no new
     * clusters before that, or it could start one the instance already runs.
     */
    get resumed(): boolean {
        return this._resumed;
    }

    markResumed(): void {
        this._resumed = true;
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
