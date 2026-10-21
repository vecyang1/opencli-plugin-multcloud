import { createBuilderTask } from './task_builder.js';

/**
 * Create a Cloud Transfer task.
 *
 * This module previously also exported `createSync` and `createBackup` stubs
 * that navigated and returned `{ok: true}` without touching the page. Nothing
 * imported them, and they are gone: `sync.js` and `backup.js` are the owners.
 */
export async function createTransfer(options = {}) {
  const { from, to, name } = options;
  return createBuilderTask('transfer', { from, to, name });
}
