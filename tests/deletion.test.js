import './harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';
import { deleteExplorerItem } from '../src/explorer.js';
import { deleteTask } from '../src/tasks.js';

/**
 * Deletion is the one operation this CLI cannot take back, and both delete
 * paths shipped as confident no-ops.
 *
 * `explorer delete` dispatched a `contextmenu` event, searched the whole
 * document for something reading "Delete" via `innerText`, clicked whatever it
 * found, and returned `{ok: true, deleted: <name>}` with NO read-back. Run live
 * against a real Google Drive on 2026-08-31 it removed nothing, three times,
 * and reported success every time. Nothing outside the browser could have
 * known.
 *
 * `tasks delete` had the mirror problem in the other direction: the
 * confirmation button was searched document-wide, and every task card on the
 * page carries its own button labelled "Delete" — so a mis-scoped click was an
 * irreversible delete of somebody else's task.
 */

const drive = { name: 'Drive One', id: 'drive-1', driveType: 'google_drive', rootId: '/' };
const file = (name) => ({ name, type: 'folder', size: '--', date: '--' });

/** An explorer page whose delete script "succeeds" but changes nothing. */
function explorerPage({ deletedForReal }) {
  let listCalls = 0;
  return installFakeBridge(pageRouter({
    handlers: [
      ['keys = ', { ok: true, source: 'clouds', drives: [drive] }],
      ['toolbarDelete', { ok: true, deleted: 'Victim', confirmed: 'Delete(1)' }],
      ['currentPath', () => {
        listCalls++;
        const gone = deletedForReal && listCalls > 1;
        return { ok: true, currentPath: 'Drive One', count: gone ? 1 : 2,
                 files: gone ? [file('Keeper')] : [file('Keeper'), file('Victim')] };
      }]
    ]
  }));
}

describe('explorer delete', () => {
  it('refuses without --yes', async () => {
    await assert.rejects(() => deleteExplorerItem('Drive One', '/', 'Victim', false),
      /requires explicit confirmation/);
  });

  it('reports FAILURE when the page claims success but the item is still listed', async () => {
    const bridge = explorerPage({ deletedForReal: false });
    try {
      const res = await deleteExplorerItem('Drive One', '/', 'Victim', true);
      assert.equal(res.ok, false, 'explorer delete claimed success without deleting anything');
      assert.equal(res.verifiedGone, false);
      assert.match(res.error, /still listed/i);
    } finally { bridge.restore(); }
  });

  it('confirms the item is gone before reporting success', async () => {
    const bridge = explorerPage({ deletedForReal: true });
    try {
      const res = await deleteExplorerItem('Drive One', '/', 'Victim', true);
      assert.equal(res.ok, true);
      assert.equal(res.verifiedGone, true);
    } finally { bridge.restore(); }
  });

  it('never retries a delete', async () => {
    const bridge = explorerPage({ deletedForReal: true });
    try {
      await deleteExplorerItem('Drive One', '/', 'Victim', true);
      const deletes = bridge.calls.filter(c => c.kind === 'eval' && String(c.payload).includes('toolbarDelete'));
      assert.equal(deletes.length, 1);
      assert.equal(deletes[0].opts.idempotent, false, 'the delete must be marked non-idempotent');
    } finally { bridge.restore(); }
  });
});

describe('deletion scripts are scoped to the thing being deleted', () => {
  const scriptFor = async (run, needle) => {
    const bridge = explorerPage({ deletedForReal: true });
    try {
      await run().catch(() => {});
      return bridge.scripts().find(s => s.includes(needle));
    } finally { bridge.restore(); }
  };

  it('explorer delete presses the toolbar, not a context menu, and refuses a multi-selection', async () => {
    const script = await scriptFor(() => deleteExplorerItem('Drive One', '/', 'Victim', true), 'toolbarDelete');
    assert.ok(script, 'no explorer delete script emitted');

    assert.doesNotMatch(script, /contextmenu/,
      'explorer delete is back on the context menu, which is not how this page deletes');
    assert.ok(script.includes('button.single-button'), 'does not press the toolbar Delete');
    assert.ok(script.includes("querySelector('#delete')"), 'does not scope the confirmation to #delete');
    assert.ok(script.includes("label !== 'Delete(1)'"),
      'does not check the confirmation count, so it can delete a selection it did not choose');
    assert.ok(script.includes('tr-back-ground'), 'does not read the row selection state');
    assert.doesNotMatch(script, /\.innerText/,
      'explorer delete matches on innerText, which is empty for these controls');
  });

  it('task delete scopes its confirmation to the delete dialog', async () => {
    const bridge = installFakeBridge(pageRouter({
      handlers: [
        ['taskList', JSON.stringify([{ taskId: 't-1', taskName: 'Victim', typeRaw: 'cloudTransfer',
          typeNumeric: null, status: 'Success', isOneTime: true, cadence: 'One-time Task',
          sourcePath: 'a', destPath: 'b', lastRun: '' }])],
        ['targetId', { ok: true, deleted: 't-1' }]
      ]
    }));
    try {
      await deleteTask('t-1', true).catch(() => {});
      const script = bridge.scripts().find(s => s.includes('targetId') && s.includes('operate-menu-item'));
      assert.ok(script, 'no task delete script emitted');

      assert.ok(script.includes("querySelector('#deleteTask')"),
        'the confirmation is not scoped to #deleteTask; every task card has its own Delete button');
      assert.ok(script.includes('.textContent'),
        'the menu is matched on innerText, which this menu reports as empty');
      assert.ok(script.includes('delete the task'),
        'the dialog is not identified by its prompt text');
    } finally { bridge.restore(); }
  });
});
