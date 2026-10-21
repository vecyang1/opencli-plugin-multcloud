import { createBuilderTask } from './task_builder.js';

/**
 * Create a Cloud Backup task.
 *
 * The previous implementation clicked a `.source-box` that does not exist,
 * never chose a destination, never pressed a submit button, and returned
 * `{ok: true, action: 'Cloud Backup Configured'}` regardless — so
 * `multcloud backup a b` reported a created task every time and created none.
 * It also navigated by URL, which lands on whatever route the SPA already held.
 */
export async function createBackup(options = {}) {
  const { from, to, name } = options;
  return createBuilderTask('backup', { from, to, name });
}
