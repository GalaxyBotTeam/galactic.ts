export const SCHEDULER_INTERVAL_MS = 5000;
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

    constructor(private readonly tasks: SchedulerTasks) {}

    start(): void {
        this.timer = setInterval(() => {
            this.tasks.checkCreate();
            this.tasks.checkRecluster();
            this.tasks.heartbeat();
        }, SCHEDULER_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }
}
