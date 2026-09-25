import { fork } from 'child_process';
import { ClusterProcess } from '../cluster/ClusterProcess';
import { encodeEnv, SpawnParams } from '../protocol/processEnv';

export type SpawnEvents = {
    onSpawned(clusterProcess: ClusterProcess): void;
    onError(clusterProcess: ClusterProcess, error: unknown): void;
    onExit(clusterProcess: ClusterProcess, reason: string): void;
};

/** Owns child_process.fork() + env marshaling - the process-mechanics half of what was BotInstance.startProcess. */
export class ProcessSpawner {
    constructor(private readonly entryPoint: string, private readonly execArgv: string[] = []) {}

    spawn(params: SpawnParams, events: SpawnEvents): ClusterProcess {
        try {
            const childProcess = fork(this.entryPoint, {
                env: encodeEnv(params),
                stdio: 'inherit',
                execArgv: this.execArgv,
                silent: false,
                detached: true,
            });

            const clusterProcess = new ClusterProcess(params.clusterID, childProcess, params.shardList, params.totalShards);

            childProcess.stdout?.on('data', (data) => process.stdout.write(data));
            childProcess.stderr?.on('data', (data) => process.stderr.write(data));

            childProcess.on('spawn', () => events.onSpawned(clusterProcess));
            childProcess.on('error', (err) => events.onError(clusterProcess, err));
            childProcess.on('exit', (code, signal) => events.onExit(clusterProcess, `Process exited: ${code} ${signal}`));

            return clusterProcess;
        } catch (error) {
            throw new Error(`Failed to start process for cluster ${params.clusterID}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
