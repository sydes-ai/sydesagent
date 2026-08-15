import { spawnSync } from 'node:child_process';

/**
 * Some tests need a real language toolchain. On a machine without one they cannot pass, and a
 * suite that goes red over an absent optional dependency teaches people to ignore red — so
 * they are skipped, visibly, instead.
 */
function available(command: string, args: string[]): boolean {
  try {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export const HAS_GO = available('go', ['version']);
