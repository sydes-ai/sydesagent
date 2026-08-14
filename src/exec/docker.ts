import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ExecResult, ExecutionEnvironment } from './types.js';

function runHost(command: string, args: string[], timeoutMs = 600_000): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + error.message, exitCode: 127, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut, ms: Date.now() - started });
    });
  });
}

/**
 * Runs commands inside a container while the agent and the graph work on a host copy of the
 * repository.
 *
 * Benchmark instance images carry the toolchain and the dependencies, but not Node; and the
 * indexer wants ordinary filesystem access. Copying the repo out, editing on the host, then
 * syncing changed files back before each command keeps both sides honest without requiring
 * anything to be installed into the image.
 */
export class DockerExec implements ExecutionEnvironment {
  readonly kind = 'docker';

  constructor(
    private readonly container: string,
    private readonly containerWorkdir: string,
    private readonly hostRoot: string,
  ) {}

  async run(command: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return runHost(
      'docker',
      ['exec', '-w', this.containerWorkdir, this.container, 'bash', '-lc', command],
      options.timeoutMs ?? 600_000,
    );
  }

  /** Copies host-side edits into the container before tests run. */
  async sync(changedFiles: string[]): Promise<void> {
    for (const rel of changedFiles) {
      const source = path.join(this.hostRoot, rel);
      const target = `${this.container}:${path.posix.join(this.containerWorkdir, rel)}`;
      await runHost('docker', ['cp', source, target], 60_000);
    }
  }

  async dispose(): Promise<void> {
    await runHost('docker', ['rm', '-f', this.container], 60_000);
  }
}

export interface ContainerHandle {
  exec: DockerExec;
  container: string;
}

/** Starts a detached container from an image and keeps it alive for the run. */
export async function startContainer(
  image: string,
  workdir: string,
  hostRoot: string,
  name?: string,
): Promise<ContainerHandle> {
  const container = name ?? `sydes-${Math.random().toString(36).slice(2, 10)}`;
  const result = await runHost('docker', [
    'run',
    '-d',
    '--name',
    container,
    '-w',
    workdir,
    image,
    'sleep',
    'infinity',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`failed to start container from ${image}: ${result.stderr.trim()}`);
  }
  return { exec: new DockerExec(container, workdir, hostRoot), container };
}

/** Copies the repository out of a container so the host can index and edit it. */
export async function copyOut(container: string, containerPath: string, hostPath: string): Promise<void> {
  const result = await runHost('docker', ['cp', `${container}:${containerPath}/.`, hostPath], 600_000);
  if (result.exitCode !== 0) {
    throw new Error(`docker cp out of ${container} failed: ${result.stderr.trim()}`);
  }
}
