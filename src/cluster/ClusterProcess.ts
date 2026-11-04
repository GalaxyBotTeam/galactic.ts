import { ChildProcess } from "child_process";
import { EventManager } from "../transport/EventManager";
import { ChildProcessTransport } from "../transport/ChildProcessTransport";
import { ProcessMessage, ProcessRequest } from "../protocol/process";
import { ClusterProcessState, createClusterProcessState } from "../domain/ClusterProcessState";

export type { ClusterProcessState };

export class ClusterProcess {
    public readonly child: ChildProcess;
    public readonly eventManager: EventManager<ProcessMessage, ProcessRequest>;
    public readonly id: number;
    public readonly shardList: number[];
    public readonly totalShards: number;
    public readonly createdAt: number = Date.now();

    private readonly state = createClusterProcessState();

    constructor(id: number, child: ChildProcess, shardList: number[], totalShards: number) {
        this.id = id;
        this.child = child;
        this.shardList = shardList;
        this.totalShards = totalShards;
        this.eventManager = new EventManager<ProcessMessage, ProcessRequest>(new ChildProcessTransport(child));

        // Ensure we do not retain pending requests if the child dies or errors
        this.child.on('exit', () => {
            this.eventManager.close('child process exited');
        });
        this.child.on('error', () => {
            this.eventManager.close('child process error');
        });
    }

    get status(): ClusterProcessState {
        return this.state.current;
    }

    markRunning(): void {
        if (this.state.current === 'running') return;
        this.state.transition('running');
    }

    markStopped(): void {
        if (this.state.current === 'stopped') return;
        this.state.transition('stopped');
    }

    /** Resolves once the message was handed to the IPC channel; rejects if the child is gone. */
    public sendMessage(data: unknown): Promise<void> {
        return this.eventManager.send({
            type: 'CUSTOM',
            data: data,
        });
    }

    public sendRequest(data: unknown, timeout = 5000): Promise<unknown> {
        return this.eventManager.request({
            type: 'CUSTOM',
            data: data,
        }, timeout);
    }
}
