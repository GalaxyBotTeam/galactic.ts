import { ClusterProcess } from '../cluster/ClusterProcess';
import { TypedEmitter } from '../general/TypedEmitter';
import type { BotInstanceEvents } from './BotInstance';

export const SELF_DESTRUCT_TIMEOUT_MS = 5000;

/**
 * The soft-destruct -> SIGKILL -> wait-for-exit sequence, extracted out of
 * BotInstance.killProcess's previously tangled 4-stage promise chain.
 */
export class ChildProcessLifecycle {
    constructor(private readonly events: TypedEmitter<BotInstanceEvents>) {}

    async kill(clusterProcess: ClusterProcess, reason: string): Promise<void> {
        clusterProcess.markStopped();

        const selfDestructed = await this.requestSelfDestruct(clusterProcess, reason);
        if (!selfDestructed) {
            this.forceKill(clusterProcess, reason);
        }
        await this.waitForExit(clusterProcess);
    }

    private async requestSelfDestruct(clusterProcess: ClusterProcess, reason: string): Promise<boolean> {
        try {
            await clusterProcess.eventManager.request({ type: 'SELF_DESTRUCT', reason }, SELF_DESTRUCT_TIMEOUT_MS);
            return true;
        } catch {
            this.events.emit('PROCESS_SELF_DESTRUCT_ERROR', clusterProcess, reason, 'Cluster didnt respond to shot-call.');
            return false;
        }
    }

    private forceKill(clusterProcess: ClusterProcess, reason: string): void {
        if (clusterProcess.child && clusterProcess.child.pid) {
            if (clusterProcess.child.kill('SIGKILL')) {
                this.events.emit('PROCESS_KILLED', clusterProcess, reason, true);
            } else {
                this.events.emit('ERROR', `Failed to kill process for cluster ${clusterProcess.id}`);
                clusterProcess.child.kill('SIGKILL');
            }
            try {
                process.kill(-clusterProcess.child.pid);
            } catch {
                // process group may already be gone
            }
        } else {
            this.events.emit('PROCESS_KILLED', clusterProcess, reason, false);
        }
    }

    private waitForExit(clusterProcess: ClusterProcess): Promise<void> {
        return new Promise((resolve) => {
            if (!clusterProcess.child || clusterProcess.child.exitCode !== null) {
                resolve();
                return;
            }
            clusterProcess.child.once('exit', () => resolve());
        });
    }
}
