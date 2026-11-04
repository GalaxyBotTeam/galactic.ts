import { EventPayload } from '../protocol/EventPayload';
import { Transport } from './Transport';

/**
 * Structural shape both the global `process` object (child side) and a Node `ChildProcess`
 * handle (parent side) satisfy - lets one Transport implementation cover both ends of the
 * process IPC channel.
 */
export interface ProcessLike {
    // Both `process.send` (4-arg: message, sendHandle, options, callback) and
    // `ChildProcess.send` (3-arg: message, sendHandle, callback) satisfy this loosely -
    // we only ever pass (message, undefined, undefined, callback), which both accept.
    send?: (...args: any[]) => boolean;
    on(event: 'message', listener: (message: unknown) => void): unknown;
}

export class ChildProcessTransport implements Transport {
    constructor(private readonly proc: ProcessLike) {}

    send(payload: EventPayload): Promise<void> {
        return new Promise((resolve, reject) => {
            if (typeof this.proc.send !== 'function') {
                reject(new Error('Process does not support sending messages'));
                return;
            }
            this.proc.send(payload, undefined, undefined, (error: Error | null) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    subscribe(onData: (raw: unknown) => void): void {
        this.proc.on('message', onData);
    }

    close(): void {
        // process/child_process IPC channels close themselves on exit; nothing to do here.
    }
}
