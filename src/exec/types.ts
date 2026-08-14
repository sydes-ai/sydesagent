export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  ms: number;
}

/**
 * Where shell commands run. The agent edits files on the host and may need to run tests
 * somewhere else entirely (a benchmark instance image), so command execution is a seam.
 */
export interface ExecutionEnvironment {
  readonly kind: string;
  run(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Called before running commands, e.g. to sync host edits into a container. */
  sync?(changedFiles: string[]): Promise<void>;
  dispose?(): Promise<void>;
}
