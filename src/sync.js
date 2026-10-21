import { createBuilderTask } from './task_builder.js';

/**
 * Create a Cloud Sync task.
 *
 * `Normal Sync` / `Real Time Sync` are buttons on the page (confirmed live
 * 2026-08-31), so the mode is selected before the source/destination pickers.
 */
export async function createSync(options = {}) {
  const { from, to, name, realtime, twoway } = options;

  const modeClicks = [];
  if (realtime) modeClicks.push('Real Time Sync');
  if (twoway) modeClicks.push('Switch to two-way sync');

  const res = await createBuilderTask('sync', { from, to, name, modeClicks });
  return { ...res, mode: realtime ? 'Real-Time' : 'Normal', twoway: !!twoway };
}
