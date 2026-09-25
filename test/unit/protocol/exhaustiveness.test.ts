import { describe, expect, it } from 'vitest';
import { assertNever } from '../../../src/protocol/shared';
import { ProcessMessage, ProcessRequest } from '../../../src/protocol/process';
import { BridgeMessage, BridgeRequest } from '../../../src/protocol/bridge';

// Type-level pin: a switch over each protocol union with `assertNever` in `default` only
// compiles if every member is handled. Adding a union member without updating one of these
// switches is a `tsc` build error, not a silent runtime drop - that's the whole point of the
// typed protocol layer. If this file fails to compile, a switch below is missing a case.

function handleProcessMessage(m: ProcessMessage): string {
    switch (m.type) {
        case 'CUSTOM': return 'custom';
        case 'CLUSTER_READY': return 'ready';
        case 'CLUSTER_ERROR': return 'error';
        case 'REDIRECT_MESSAGE_TO_GUILD': return 'redirect';
        default: return assertNever(m, 'handleProcessMessage');
    }
}

function handleProcessRequest(m: ProcessRequest): string {
    switch (m.type) {
        case 'CUSTOM': return 'custom';
        case 'CLUSTER_HEARTBEAT': return 'heartbeat';
        case 'SELF_DESTRUCT': return 'destruct';
        case 'REDIRECT_REQUEST_TO_GUILD': return 'redirect';
        case 'BROADCAST_EVAL': return 'eval';
        default: return assertNever(m, 'handleProcessRequest');
    }
}

function handleBridgeMessage(m: BridgeMessage): string {
    switch (m.type) {
        case 'CLUSTER_CREATE': return 'create';
        case 'CLUSTER_STOP': return 'stop';
        case 'CLUSTER_RECLUSTER': return 'recluster';
        case 'CLUSTER_SPAWNED': return 'spawned';
        case 'CLUSTER_READY': return 'ready';
        case 'CLUSTER_STOPPED': return 'stopped';
        case 'INSTANCE_STOP': return 'instance_stop';
        case 'INSTANCE_STOP_ACK': return 'instance_stop_ack';
        default: return assertNever(m, 'handleBridgeMessage');
    }
}

function handleBridgeRequest(m: BridgeRequest): string {
    switch (m.type) {
        case 'SELF_CHECK': return 'self_check';
        case 'CLUSTER_HEARTBEAT': return 'heartbeat';
        case 'REDIRECT_REQUEST_TO_GUILD': return 'redirect';
        case 'BROADCAST_EVAL': return 'eval';
        default: return assertNever(m, 'handleBridgeRequest');
    }
}

describe('protocol exhaustiveness', () => {
    it('handles a representative message from each union (compile-time exhaustiveness is the real test)', () => {
        expect(handleProcessMessage({ type: 'CUSTOM', data: null })).toBe('custom');
        expect(handleProcessRequest({ type: 'SELF_DESTRUCT', reason: 'test' })).toBe('destruct');
        expect(handleBridgeMessage({ type: 'INSTANCE_STOP' })).toBe('instance_stop');
        expect(handleBridgeRequest({ type: 'SELF_CHECK' })).toBe('self_check');
    });

    it('assertNever throws with the offending value and context', () => {
        // @ts-expect-error - intentionally passing an invalid variant to exercise the runtime guard
        expect(() => assertNever({ type: 'NOT_REAL' }, 'test')).toThrow(/NOT_REAL/);
    });
});
