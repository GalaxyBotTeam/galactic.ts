import { describe, expect, it, vi } from 'vitest';
import { ChildProcessTransport } from '../../../src/transport/ChildProcessTransport';

describe('ChildProcessTransport', () => {
    it('send() resolves when the underlying process.send succeeds', async () => {
        const proc = {
            send: vi.fn((..._args: any[]) => { (_args[3] as any)?.(null); return true; }),
            on: vi.fn(),
        };
        const transport = new ChildProcessTransport(proc);

        await expect(transport.send({ id: '1', type: 'message', data: {} })).resolves.toBeUndefined();
        expect(proc.send).toHaveBeenCalledOnce();
    });

    it('send() rejects when the underlying send reports an error', async () => {
        const proc = {
            send: vi.fn((..._args: any[]) => { (_args[3] as any)?.(new Error('broken pipe')); return true; }),
            on: vi.fn(),
        };
        const transport = new ChildProcessTransport(proc);

        await expect(transport.send({ id: '1', type: 'message', data: {} })).rejects.toThrow('broken pipe');
    });

    it('send() rejects immediately when the process cannot send at all', async () => {
        const proc = { on: vi.fn() };
        const transport = new ChildProcessTransport(proc);

        await expect(transport.send({ id: '1', type: 'message', data: {} })).rejects.toThrow();
    });

    it('subscribe() wires the raw callback through to the process "message" event', () => {
        const proc = { send: vi.fn(), on: vi.fn() };
        const transport = new ChildProcessTransport(proc);
        const handler = vi.fn();

        transport.subscribe(handler);

        expect(proc.on).toHaveBeenCalledWith('message', handler);
    });
});
