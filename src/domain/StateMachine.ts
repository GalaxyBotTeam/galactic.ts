export class InvalidTransitionError extends Error {
    constructor(from: string, to: string) {
        super(`Invalid transition: ${from} -> ${to}`);
    }
}

/** Generic guarded-transition primitive - reused by every *ConnectionStatus/ProcessState enum in this codebase. */
export class StateMachine<S extends string> {
    private state: S;

    constructor(initial: S, private readonly transitions: Record<S, readonly S[]>) {
        this.state = initial;
    }

    get current(): S {
        return this.state;
    }

    can(next: S): boolean {
        return this.transitions[this.state].includes(next);
    }

    transition(next: S): void {
        if (!this.can(next)) {
            throw new InvalidTransitionError(this.state, next);
        }
        this.state = next;
    }
}
