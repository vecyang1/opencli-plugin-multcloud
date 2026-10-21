import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'vm';
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';

import { listTasks, inspectTask, runTask, deleteTask, renameTask, getTaskLogs } from '../src/tasks.js';
import { listClouds, renameCloud, getCloudProperties } from '../src/clouds.js';
import { getAccountInfo } from '../src/account.js';
import { listShares } from '../src/shares.js';
import { listDrives, listExplorerFiles, renameExplorerItem, deleteExplorerItem } from '../src/explorer.js';
import { createTransfer } from '../src/transfer.js';
import { createSync } from '../src/sync.js';
import { createBackup } from '../src/backup.js';
import { createRemoteUpload } from '../src/remote_upload.js';

/**
 * Every string this CLI sends to the browser must be valid JavaScript.
 *
 * This gate exists because the fake bridge does not EXECUTE the scripts — it
 * only answers them — so a browser-side syntax error sails through every other
 * offline test and only surfaces against a live session. Two shipped that way:
 * a stale identifier left behind when a predicate was replaced
 * (`ReferenceError: target is not defined`), and a regex whose `\/` collapsed to
 * a bare `/` because it lived inside a template literal
 * (`SyntaxError: missing ) after argument list`).
 *
 * Parsing is decidable and free. Executing them is not our business here.
 */
const task = (taskId, taskName) => ({
  taskId, taskName, typeRaw: 'cloudTransfer', typeNumeric: null, status: 'Success',
  isOneTime: true, cadence: 'One-time Task', sourcePath: 'a', destPath: 'b', lastRun: ''
});

const drive = { name: 'Drive One', id: 'drive-1', driveType: 'google_drive', rootId: '/' };

/** Answer anything, so we get as far as possible through every code path. */
function permissiveRouter() {
  return pageRouter({
    handlers: [
      ['taskList', JSON.stringify([task('t-1', 'Task One')])],
      ['cloudItems', [{ name: 'Drive One', type: 'Google Drive', email: '', capacity: '1 TB / 2 TB', status: 'Active', summary: 'x' }]],
      ['trafficMatch', { ok: true, plan: 'Lifetime Unlimited', trafficUsed: '1GB', trafficTotal: 'Unlimited', trafficSummary: '1GB / Unlimited', trafficKnown: true, user: 'u', url: 'x' }],
      ['keys = ', { ok: true, source: 'allDrivesArr', drives: [drive] }],
      ['submitLabel', { ok: true, step: 'submitted' }],
      ['downloadUrl', { ok: true, action: 'submitted', url: 'magnet:x', targetCloud: null }],
      ['wanted = ', { ok: true }],
      ['', { ok: true, count: 0, files: [], shares: [], versions: [] }]
    ]
  });
}

/**
 * Values chosen to break naive string building: quotes, a trailing backslash,
 * a newline, template syntax, and CJK.
 */
const NASTY = 'He said "hi" \\ ${x} \n 【全7集】';

describe('Every emitted browser script parses as JavaScript', () => {
  it('across every module, with hostile input', async () => {
    const bridge = installFakeBridge(permissiveRouter());
    const attempted = [];
    try {
      const calls = [
        ['listTasks', () => listTasks()],
        ['listClouds', () => listClouds()],
        ['getAccountInfo', () => getAccountInfo()],
        ['listShares', () => listShares()],
        ['listDrives', () => listDrives()],
        ['getCloudProperties', () => getCloudProperties('Drive One')],
        ['renameCloud', () => renameCloud(NASTY, NASTY + '2')],
        ['inspectTask', () => inspectTask('t-1')],
        ['getTaskLogs', () => getTaskLogs('t-1')],
        ['runTask', () => runTask('t-1')],
        ['renameTask', () => renameTask('t-1', NASTY)],
        ['deleteTask', () => deleteTask('t-1', true)],
        ['listExplorerFiles', () => listExplorerFiles('Drive One', NASTY)],
        ['renameExplorerItem', () => renameExplorerItem('Drive One', '', NASTY, NASTY + '2')],
        ['deleteExplorerItem', () => deleteExplorerItem('Drive One', '', NASTY, true)],
        ['createTransfer', () => createTransfer({ from: NASTY, to: NASTY, name: NASTY })],
        ['createSync', () => createSync({ from: NASTY, to: NASTY, realtime: true, twoway: true })],
        ['createBackup', () => createBackup({ from: NASTY, to: NASTY })],
        ['createRemoteUpload', () => createRemoteUpload({ url: 'magnet:' + NASTY, cloud: NASTY })]
      ];

      for (const [name, fn] of calls) {
        attempted.push(name);
        // Failures of intent are fine here; we only care about what was emitted.
        await fn().catch(() => {});
      }

      const scripts = bridge.scripts();
      assert.ok(scripts.length >= 20, `expected many emitted scripts, saw ${scripts.length}`);

      const broken = [];
      for (const script of scripts) {
        try {
          new vm.Script(`(function(){ return ${script}; })`);
        } catch (err) {
          broken.push(`${err.message}\n--- script head ---\n${String(script).slice(0, 260)}`);
        }
      }
      assert.deepEqual(broken, [], `browser scripts that do not parse:\n\n${broken.join('\n\n')}`);
      console.log(`      parsed ${scripts.length} emitted scripts from ${attempted.length} entry points`);
    } finally { bridge.restore(); }
  });

  it('no emitted script contains a raw control or zero-width character', async () => {
    // Escapes written inside a template literal are resolved by the TEMPLATE,
    // not by the page. A word boundary spelled with one backslash reaches the
    // browser as a raw backspace, so the emitted regex still parses, still
    // looks right in the editor and in a grep, and matches nothing.
    //
    // Measured 2026-08-31: the destination picker's "is this row selected"
    // predicate carried exactly that, so a row the CLI had just selected was
    // reported as never selected and `sync` refused to create anything. The
    // syntax gate above cannot see it — the script is valid JavaScript.
    const bridge = installFakeBridge(permissiveRouter());
    try {
      await createTransfer({ from: NASTY, to: NASTY, name: NASTY }).catch(() => {});
      await createSync({ from: NASTY, to: NASTY }).catch(() => {});
      await createBackup({ from: NASTY, to: NASTY }).catch(() => {});
      await listTasks().catch(() => {});
      await listClouds().catch(() => {});
      await listDrives().catch(() => {});
      await inspectTask('t-1').catch(() => {});

      const scripts = bridge.scripts();
      assert.ok(scripts.length >= 7, `expected several scripts, saw ${scripts.length}`);

      const offenders = [];
      for (const script of scripts) {
        const text = String(script);
        for (let i = 0; i < text.length; i++) {
          const code = text.codePointAt(i);
          const isAllowedWhitespace = code === 0x0a || code === 0x0d || code === 0x09;
          const isControl = (code < 0x20 && !isAllowedWhitespace) || code === 0x7f;
          const isZeroWidth = code === 0x200b || code === 0x200c || code === 0x200d ||
                              code === 0x2028 || code === 0x2029 || code === 0xfeff;
          if (isControl || isZeroWidth) {
            offenders.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')} near: ${JSON.stringify(text.slice(Math.max(0, i - 45), i + 25))}`);
          }
        }
      }
      assert.deepEqual(offenders, [],
        `emitted browser scripts contain characters that are invisible in source:\n${offenders.join('\n')}`);
      console.log(`      scanned ${scripts.length} emitted scripts for invisible characters`);
    } finally { bridge.restore(); }
  });

  it('no emitted script references an identifier it never declares', async () => {
    // The narrow, decidable slice of "undefined variable": a bare `target`,
    // which is what the removed fuzzy matcher left behind in inspectTask.
    const bridge = installFakeBridge(permissiveRouter());
    try {
      await inspectTask('t-1').catch(() => {});
      await runTask('t-1').catch(() => {});
      await deleteTask('t-1', true).catch(() => {});
      for (const script of bridge.scripts()) {
        if (/\btargetNorm\b|\bconst target\b/.test(script)) continue;
        assert.doesNotMatch(script, /[^.\w]target\b(?!Id)/,
          `script uses a bare "target" it never declares:\n${script.slice(0, 200)}`);
      }
    } finally { bridge.restore(); }
  });
});
