import path from 'path';
import os from 'os';

/**
 * Single owner for every on-disk location this CLI reads or writes.
 *
 * `MULTCLOUD_HOME` exists so tests can point the whole process at a disposable
 * directory. It is a *location* variable, not a credential: absence means "use
 * the real home", so tests must SET it rather than unset it. See
 * `tests/harness/sandbox.js`, which is the only place that is allowed to.
 */
export function multcloudHome() {
  return process.env.MULTCLOUD_HOME || path.join(os.homedir(), '.multcloud');
}

export function aliasFile() {
  return path.join(multcloudHome(), 'aliases.json');
}
