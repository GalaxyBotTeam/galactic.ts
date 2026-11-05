export const SCHEDULER_INTERVAL_MS = 5000;
/** Short enough for `IdentifyGate` to decide the pace of cluster starts, not this tick. */
export const CREATE_INTERVAL_MS = 1000;
export const HEARTBEAT_TIMEOUT_MS = 20000;
export const MAX_MISSED_HEARTBEATS = 7;

export type SchedulerTasks = {
    checkCreate(): void;
    checkRecluster(): void;
    heartbeat(): void;
};

/** Owns the periodic tick - the business logic for each task lives with whoever owns that task's state. */
export class ClusterScheduler {
    private timer?: ReturnType<typeof setInterval>;
    private createTimer?: ReturnType<typeof setInterval>;

    constructor(private readonly tasks: SchedulerTasks) {}

    start(): void {
        this.createTimer = setInterval(() => this.tasks.checkCreate(), CREATE_INTERVAL_MS);
        this.timer = setInterval(() => {
            this.tasks.checkRecluster();
            this.tasks.heartbeat();
        }, SCHEDULER_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        if (this.createTimer) clearInterval(this.createTimer);
    }
}
