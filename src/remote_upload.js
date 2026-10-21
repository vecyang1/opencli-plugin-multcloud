import { createBuilderTask } from './task_builder.js';

/**
 * Submit an offline remote-upload download (HTTP, HTTPS or magnet link) to a
 * connected cloud drive, and VERIFY a task was actually created.
 *
 * This used to be an independent implementation of the whole page, and it was
 * the last create path in the CLI that reported success from a click rather
 * than from a read-back. Measured live 2026-08-31, it could not have worked:
 * it looked for the dialog's commit button with `.el-dialog button, .modal
 * button, .dialog-footer button` on a page whose dialog is `.popup` and whose
 * button is `button.saveCloud`, then -- guarded by `if (saveBtn)` -- skipped
 * the commit and returned `{ ok: true, action: 'submitted' }`.
 *
 * The Remote Upload page turns out to render the SAME two-`.task-box` layout
 * and the SAME hand-rolled destination tree as Cloud Transfer/Sync/Backup, so
 * it belongs on the shared engine rather than in a second copy of the picker.
 * Only the source differs: a dialog instead of a picker.
 */
export async function createRemoteUpload(options = {}) {
  // Accept both spellings. The CLI passed `cloud`/`path` while this function
  // read `targetCloud`/`targetPath`, so the documented `--cloud` flag was
  // silently dropped and every upload went to the page default.
  const { url, name } = options;
  const targetCloud = options.targetCloud ?? options.cloud;
  const targetPath = options.targetPath ?? options.path;

  if (!url) {
    throw new Error('A URL or magnet link is required for remote upload.');
  }
  if (!targetCloud) {
    throw new Error(
      'A destination cloud is required for remote upload. Pass --cloud "<drive>" ' +
      '(and optionally --path "<folder>"); run `multcloud drives` for the list.'
    );
  }

  const destination = targetPath
    ? `${targetCloud}/${String(targetPath).replace(/^[/\\]+/, '')}`
    : targetCloud;

  const res = await createBuilderTask('remote', { link: url, to: destination, name });

  return { ...res, url, targetCloud, targetPath: targetPath || null };
}
