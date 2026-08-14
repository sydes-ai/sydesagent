import { spawn } from 'node:child_process';
import type { ExecResult, ExecutionEnvironment } from './types.js';

const MAX_CAPTURE = 200_000;

export class LocalExec implements ExecutionEnvironment {
  readonly kind = 'local';

  constructor(
    private readonly root: string,
    private readonly defaultTimeoutMs = 120_000,
  ) {}

  run(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: options.cwd ?? this.root,
        shell: true,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_CAPTURE) stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_CAPTURE) stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: `${stderr}${error.message}`,
          exitCode: 127,
          timedOut,
          ms: Date.now() - started,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, MAX_CAPTURE),
          stderr: stderr.slice(0, MAX_CAPTURE),
          exitCode: code ?? (timedOut ? 124 : 1),
          timedOut,
          ms: Date.now() - started,
        });
      });
    });
  }
}
