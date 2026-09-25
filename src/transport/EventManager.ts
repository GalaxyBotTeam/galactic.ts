import { EventPayload } from '../protocol/EventPayload';
import { Transport } from './Transport';

/**
 * Generic request/response + fire-and-forget messaging protocol over an injected Transport,
 * correlating requests/responses by UUID with timeout handling. `TMessage`/`TRequest` are the
 * only place a caller's protocol types are named - this class puts them into an EventPayload's
 * `data` on the way out and casts back on the way in, so the transport itself never needs to
 * know about them.
 */
export class EventManager<TMessage = unknown, TRequest = unknown> {

    private pendingPayloads = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
    }>();

    // Track per-request timeout handles so we can clear them on resolve/reject
    private pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

    private _onMessage?: (message: TMessage) => void;
    private _onRequest?: (message: TRequest, timeout: number) => unknown;

    constructor(private readonly transport: Transport) {
        transport.subscribe((raw) => this.receive(raw));
    }

    onMessage(handler: (message: TMessage) => void): void {
        this._onMessage = handler;
    }

    onRequest(handler: (message: TRequest, timeout: number) => unknown): void {
        this._onRequest = handler;
    }

    async send(data: TMessage) {
        return this.transport.send({
            id: crypto.randomUUID(),
            type: 'message',
            data: data,
        });
    }

    async request<TResponse = unknown>(payload: TRequest, timeout: number): Promise<TResponse> {
        const id = crypto.randomUUID();

        return new Promise<TResponse>((resolve, reject) => {
            this.pendingPayloads.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject
            });

            const t = setTimeout(() => {
                if (this.pendingPayloads.has(id)) {
                    this.pendingPayloads.delete(id);
                    this.pendingTimeouts.delete(id);
                    reject({
                        error: `Request with id ${id} timed out`,
                    });
                }
            }, timeout);
            this.pendingTimeouts.set(id, t);

            this.transport.send({
                id: id,
                type: 'request',
                data: payload,
                timeout: timeout
            }).catch((err) => {
                if (this.pendingPayloads.has(id)) {
                    const to = this.pendingTimeouts.get(id);
                    if (to) clearTimeout(to);
                    this.pendingTimeouts.delete(id);
                    this.pendingPayloads.delete(id);
                    reject(err);
                }
            });
        })
    }

    receive(possiblePayload: unknown) {
        if (typeof possiblePayload !== 'object' || possiblePayload === null) {
            return;
        }

        const payload = possiblePayload as EventPayload;

        if (!payload.id || !payload.type) {
            return;
        }

        if (payload.type === 'message') {
            this._onMessage?.(payload.data as TMessage);
            return;
        }

        if (payload.type === 'response') {
            const resolve = this.pendingPayloads.get(payload.id)?.resolve;
            if (resolve) {
                resolve(payload.data);
                this.pendingPayloads.delete(payload.id);
                const to = this.pendingTimeouts.get(payload.id);
                if (to) clearTimeout(to);
                this.pendingTimeouts.delete(payload.id);
            }
            return;
        }

        if (payload.type === 'response_error') {
            const reject = this.pendingPayloads.get(payload.id)?.reject;
            if (reject) {
                reject(payload.data);
                this.pendingPayloads.delete(payload.id);
                const to = this.pendingTimeouts.get(payload.id);
                if (to) clearTimeout(to);
                this.pendingTimeouts.delete(payload.id);
            }
            return;
        }

        if (payload.type === 'request') {
            if (!this._onRequest) return;
            const data = this._onRequest(payload.data as TRequest, payload.timeout || 5000);
            if (data instanceof Promise) {
                data.then((result) => {
                    this.transport.send({
                        id: payload.id,
                        type: 'response',
                        data: result
                    }).catch(() => {});
                }).catch((error) => {
                    this.transport.send({
                        id: payload.id,
                        type: 'response_error',
                        data: error
                    }).catch(() => {});
                });
            } else {
                this.transport.send({
                    id: payload.id,
                    type: 'response',
                    data: data
                }).catch(() => {});
            }
            return;
        }
    }

    // Reject and clear all pending requests to avoid memory leaks when a connection/process closes
    close(reason?: string) {
        const err = { error: reason || 'EventManager closed' };
        for (const [id, handlers] of this.pendingPayloads.entries()) {
            try { handlers.reject(err); } catch (_) { /* ignore */ }
            this.pendingPayloads.delete(id);
            const to = this.pendingTimeouts.get(id);
            if (to) clearTimeout(to);
            this.pendingTimeouts.delete(id);
        }
        // In case there are any stray timeouts with no pending payload
        for (const to of this.pendingTimeouts.values()) {
            clearTimeout(to);
        }
        this.pendingTimeouts.clear();
        this.transport.close(reason);
    }
}
