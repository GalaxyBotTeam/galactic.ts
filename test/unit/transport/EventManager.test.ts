import { describe, expect, it, vi } from 'vitest';
import { EventManager } from '../../../src/transport/EventManager';
import { FakeTransport } from './FakeTransport';

describe('EventManager', () => {
    it('send() wraps data in a message envelope', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);

        await em.send({ hello: 'world' });

        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]).toMatchObject({ type: 'message', data: { hello: 'world' } });
        expect(transport.sent[0].id).toBeTypeOf('string');
    });

    it('request() resolves when a matching response envelope arrives', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);

        const pending = em.request({ ping: true }, 1000);
        const sentRequest = transport.sent[0];
        expect(sentRequest.type).toBe('request');

        transport.receiveFromPeer({ id: sentRequest.id, type: 'response', data: 'pong' });

        await expect(pending).resolves.toBe('pong');
    });

    it('request() rejects when a response_error envelope arrives', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);

        const pending = em.request({ ping: true }, 1000);
        const sentRequest = transport.sent[0];

        transport.receiveFromPeer({ id: sentRequest.id, type: 'response_error', data: 'boom' });

        await expect(pending).rejects.toBe('boom');
    });

    it('request() rejects on timeout and a late response is a no-op', async () => {
        vi.useFakeTimers();
        try {
            const transport = new FakeTransport();
            const em = new EventManager(transport);

            const pending = em.request({ ping: true }, 10);
            const sentRequest = transport.sent[0];

            const assertion = expect(pending).rejects.toBeTruthy();
            await vi.advanceTimersByTimeAsync(20);
            await assertion;

            // late response after timeout must not throw / must not resolve anything
            expect(() => transport.receiveFromPeer({ id: sentRequest.id, type: 'response', data: 'late' })).not.toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it('receive() on an incoming request invokes onRequest and sends back a response', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);
        em.onRequest((message: any) => `handled:${message.value}`);

        transport.receiveFromPeer({ id: 'req-1', type: 'request', data: { value: 42 }, timeout: 1000 });

        // handler is sync, response should already be sent
        const response = transport.sent.find(p => p.id === 'req-1');
        expect(response).toMatchObject({ type: 'response', data: 'handled:42' });
    });

    it('receive() on an incoming request supports an async onRequest handler', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);
        em.onRequest(async (message: any) => `async:${message.value}`);

        transport.receiveFromPeer({ id: 'req-2', type: 'request', data: { value: 7 }, timeout: 1000 });

        await vi.waitFor(() => {
            const response = transport.sent.find(p => p.id === 'req-2');
            expect(response).toMatchObject({ type: 'response', data: 'async:7' });
        });
    });

    it('receive() sends a response_error when an async onRequest handler rejects', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);
        em.onRequest(async () => { throw new Error('nope'); });

        transport.receiveFromPeer({ id: 'req-3', type: 'request', data: {}, timeout: 1000 });

        await vi.waitFor(() => {
            const response = transport.sent.find(p => p.id === 'req-3');
            expect(response?.type).toBe('response_error');
        });
    });

    it('receive() invokes onMessage for message envelopes', () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);
        const onMessage = vi.fn();
        em.onMessage(onMessage);

        transport.receiveFromPeer({ id: 'm-1', type: 'message', data: { foo: 'bar' } });

        expect(onMessage).toHaveBeenCalledWith({ foo: 'bar' });
    });

    it('receive() ignores malformed payloads without throwing', () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);

        expect(() => transport.receiveFromPeer(null)).not.toThrow();
        expect(() => transport.receiveFromPeer('a string')).not.toThrow();
        expect(() => transport.receiveFromPeer({})).not.toThrow();
        expect(() => transport.receiveFromPeer({ id: 'x' })).not.toThrow();
    });

    it('close(reason) rejects all pending requests, clears them, and closes the transport', async () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);

        const pending1 = em.request({}, 5000);
        const pending2 = em.request({}, 5000);

        em.close('shutting down');

        await expect(pending1).rejects.toMatchObject({ error: 'shutting down' });
        await expect(pending2).rejects.toMatchObject({ error: 'shutting down' });
        expect(transport.closedReason).toBe('shutting down');
    });

    it('close() closes the transport even when no request is pending', () => {
        const transport = new FakeTransport();
        const em = new EventManager(transport);

        em.close('idle close');

        expect(transport.closedReason).toBe('idle close');
    });
});
