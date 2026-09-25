import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../../../src/general/TypedEmitter';

type Events = {
    greet: (name: string) => void;
};

describe('TypedEmitter', () => {
    it('emit with no listener is a no-op', () => {
        const emitter = new TypedEmitter<Events>();
        expect(() => emitter.emit('greet', 'world')).not.toThrow();
    });

    it('invokes the listener with the correct args', () => {
        const emitter = new TypedEmitter<Events>();
        const listener = vi.fn();
        emitter.on('greet', listener);

        emitter.emit('greet', 'world');

        expect(listener).toHaveBeenCalledWith('world');
    });

    it('invokes multiple listeners registered for the same event', () => {
        const emitter = new TypedEmitter<Events>();
        const a = vi.fn();
        const b = vi.fn();
        emitter.on('greet', a);
        emitter.on('greet', b);

        emitter.emit('greet', 'world');

        expect(a).toHaveBeenCalledWith('world');
        expect(b).toHaveBeenCalledWith('world');
    });

    it('off removes exactly the given listener', () => {
        const emitter = new TypedEmitter<Events>();
        const a = vi.fn();
        const b = vi.fn();
        emitter.on('greet', a);
        emitter.on('greet', b);

        emitter.off('greet', a);
        emitter.emit('greet', 'world');

        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledWith('world');
    });
});
