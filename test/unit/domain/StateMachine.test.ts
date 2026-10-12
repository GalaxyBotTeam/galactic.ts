import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, StateMachine } from '../../../src/domain/StateMachine';

type Light = 'red' | 'green' | 'yellow';
const TRANSITIONS: Record<Light, readonly Light[]> = {
    red: ['green'],
    green: ['yellow'],
    yellow: ['red'],
};

describe('StateMachine', () => {
    it('starts at the given initial state', () => {
        const sm = new StateMachine<Light>('red', TRANSITIONS);
        expect(sm.current).toBe('red');
    });

    it('can() reflects the transition table', () => {
        const sm = new StateMachine<Light>('red', TRANSITIONS);
        expect(sm.can('green')).toBe(true);
        expect(sm.can('yellow')).toBe(false);
    });

    it('transition() to an allowed state updates current', () => {
        const sm = new StateMachine<Light>('red', TRANSITIONS);
        sm.transition('green');
        expect(sm.current).toBe('green');
    });

    it('transition() to a disallowed state throws InvalidTransitionError and does not change state', () => {
        const sm = new StateMachine<Light>('red', TRANSITIONS);
        expect(() => sm.transition('yellow')).toThrow(InvalidTransitionError);
        expect(sm.current).toBe('red');
    });
});
