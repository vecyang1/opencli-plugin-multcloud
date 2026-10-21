import '../harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listClouds } from '../../src/clouds.js';
import { listTasks, inspectTask, getTaskLogs, TASK_TYPES, normalizeTaskType } from '../../src/tasks.js';
import { getAccountInfo } from '../../src/account.js';
import { getStats } from '../../src/stats.js';
import { runDoctor } from '../../src/doctor.js';
import { listShares } from '../../src/shares.js';
import { listDrives, listExplorerFiles } from '../../src/explorer.js';
import { evaluate, navigateToOrThrow } from '../../src/client.js';

/**
 * LIVE suite. Read-only, and it needs an authenticated MultCloud session on the
 * OpenCLI bridge.
 *
 * It is opt-in (`MULTCLOUD_LIVE=1 npm run test:live`) so that `npm test` is
 * hermetic. The previous arrangement put 18 of 20 tests in here and called the
 * result "20/20 green", which described one machine at one moment and could
 * never run in CI.
 *
 * Nothing here mutates: no task is created, started, renamed or deleted.
 */
const LIVE = process.env.MULTCLOUD_LIVE === '1';
const live = (name, fn) => it(name, { skip: LIVE ? false : 'set MULTCLOUD_LIVE=1 to run against the real account' }, fn);

describe('Live: account', () => {
  live('reports a plan and traffic, or says plainly that it could not read them', async () => {
    const res = await getAccountInfo();
    assert.equal(res.ok, true);
    if (res.trafficKnown) {
      assert.match(res.trafficUsed, /\d/);
      assert.equal(res.trafficSummary, `${res.trafficUsed} / ${res.trafficTotal}`);
    } else {
      assert.equal(res.trafficUsed, null, 'unknown traffic must be null, never a stored default');
    }
  });
});

describe('Live: clouds', () => {
  live('lists every connected account and says whether its quota is readable', async () => {
    const res = await listClouds();
    assert.equal(res.ok, true);
    assert.ok(res.clouds.length >= 1);
    assert.equal(res.totalCount, res.quotaOkCount + res.quotaUnavailableCount + res.quotaUnknownCount,
      'the quota counters must partition the list exactly');
    for (const c of res.clouds) {
      assert.ok(['ok', 'unavailable', 'unknown'].includes(c.quota), `unexpected quota "${c.quota}" for ${c.name}`);
      assert.ok(c.id, `${c.name} has no id, so nothing can address it`);
      // Capacity is either a real split or an explicit null — never '0'.
      if (c.capacityKnown) assert.ok(c.used && c.total);
      else assert.equal(c.used, null);
    }
  });

  live('the roster matches what Cloud Explorer can address', async () => {
    // These came from two different page arrays and disagreed by six drives:
    // `clouds` listed 12 and Explorer could reach 15, out of 21 that exist.
    const [cloudsRes, drivesRes] = [await listClouds(), await listDrives()];
    const cloudIds = new Set(cloudsRes.clouds.map(c => c.id));
    const missing = drivesRes.drives.filter(d => !cloudIds.has(d.id)).map(d => d.name);
    assert.deepEqual(missing, [], 'drives Explorer can address that `clouds` does not list');
    assert.equal(cloudsRes.totalCount, drivesRes.drives.length);
  });

  live('never reports a missing quota as an authorization failure', async () => {
    // Measured 2026-08-31: MultCloud marked 13 of 21 drives "Failed" while a
    // transfer was reading from and writing to two of them.
    const res = await listClouds();
    const text = JSON.stringify(res).toLowerCase();
    for (const word of ['oauth', 'expired', 'token']) {
      assert.ok(!text.includes(word), `clouds output claims "${word}" about a quota label`);
    }
  });

  live('a filtered query returns only matching rows', async () => {
    const res = await listClouds({ status: 'ok' });
    assert.ok(res.clouds.every(c => c.quota === 'ok'));
  });
});

describe('Live: drives', () => {
  live('discovers drives dynamically, with the ids Explorer needs', async () => {
    const res = await listDrives();
    assert.equal(res.ok, true);
    assert.ok(res.drives.length >= 1);
    for (const d of res.drives) {
      assert.ok(d.name, 'every drive needs a name');
      assert.ok(d.id, 'every drive needs an id');
    }
  });

  live('refuses an unknown drive instead of falling back to another one', async () => {
    await assert.rejects(
      () => listExplorerFiles('definitely-not-a-connected-drive-xyz'),
      /No connected drive matches/
    );
  });
});

describe('Live: tasks', () => {
  live('lists tasks and accounts for every row in its own counters', async () => {
    const res = await listTasks();
    assert.equal(res.ok, true);
    assert.ok(res.totalCount >= 1);
    assert.equal(
      res.successCount + res.failureCount + res.syncingCount + res.pausedCount + res.unknownCount,
      res.totalCount,
      'status counters must account for every task'
    );
  });

  live('every task type the live account holds maps into the documented vocabulary', async () => {
    const res = await listTasks({ raw: true });
    const unmapped = res.tasks.filter(t => !TASK_TYPES.includes(t.type));
    assert.deepEqual(unmapped.map(t => t.typeRaw), [],
      'a live task type has no --type value; add it to normalizeTaskType');
  });

  live('--type filters partition the task list exactly', async () => {
    const all = await listTasks();
    let sum = 0;
    for (const type of TASK_TYPES) sum += (await listTasks({ type })).totalCount;
    assert.equal(sum, all.totalCount, 'the type filters must cover every task exactly once');
  });

  live('inspecting a real task returns its id and paths', async () => {
    const all = await listTasks();
    const target = all.tasks[0];
    const res = await inspectTask(target.taskId);
    assert.equal(res.ok, true);
    assert.equal(res.taskId, target.taskId);
  });

  live('an ambiguous name is refused rather than resolved to a guess', async () => {
    const all = await listTasks();
    const names = all.tasks.map(t => t.taskName);
    const prefix = names.find(n => names.filter(o => o.startsWith(n.slice(0, 12))).length > 1);
    if (!prefix) return; // no ambiguous pair on this account today
    await assert.rejects(() => inspectTask(prefix.slice(0, 12)).then(r => {
      if (!r.ok) throw new Error(r.error);
      return r;
    }), /matches \d+ tasks/);
  });

  live('logs come back, or say why they could not', async () => {
    const all = await listTasks();
    const res = await getTaskLogs(all.tasks[0].taskId);
    assert.equal(res.ok, true);
    if (res.runCount === null) assert.ok(res.logUnavailableReason);
  });
});

/**
 * The Remote Upload page contract, re-checked against the live DOM.
 *
 * Read-only: it navigates and probes, and creates nothing. Every selector
 * asserted here is one `createRemoteUpload` depends on, and each was wrong in
 * the shipped implementation (measured 2026-08-31).
 */
describe('Live: remote upload page contract', () => {
  live('the page renders the two-box layout the builder engine expects', async () => {
    await navigateToOrThrow('Remote Upload', 'https://app.multcloud.com/mc_project/remote_task');
    const probe = await evaluate(`(() => {
      const vis = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0;
      return {
        url: location.href,
        boxes: document.querySelectorAll('.task-box').length,
        addLink: Array.from(document.querySelectorAll('div, button, span, a'))
          .some(e => (e.textContent || '').trim() === 'Add Link' && vis(e)),
        submit: Array.from(document.querySelectorAll('button'))
          .some(b => (b.innerText || '').trim() === 'Upload Now' && vis(b)),
        nameEditor: !!document.querySelector('.edit-task-icon'),
        hiddenFeedbackTextarea: Array.from(document.querySelectorAll('textarea'))
          .some(t => /reason why you leave/i.test(String(t.placeholder || '')))
      };
    })()`);

    assert.match(probe.url, /remote_task/, 'the sidebar click did not reach Remote Upload');
    assert.equal(probe.boxes, 2, 'Remote Upload no longer renders exactly two .task-box selectors');
    assert.equal(probe.addLink, true, 'the "Add Link" control is gone');
    assert.equal(probe.submit, true, 'the "Upload Now" button is gone');

    // --name is REFUSED for remote upload on the strength of this. If the page
    // ever grows a name editor, that refusal becomes wrong and must be revisited.
    assert.equal(probe.nameEditor, false,
      'Remote Upload now has a task-name editor; createBuilderTask still refuses --name for it');

    // The reason the link input is taken from inside the visible popup rather
    // than by a bare `textarea` selector. If this box ever disappears the guard
    // is merely redundant, not wrong -- but while it is here, it is a live hazard.
    assert.equal(probe.hiddenFeedbackTextarea, true,
      'the hidden cancellation-feedback textarea is gone; re-check the link-input guard');
  });

  live('remote-upload task cards carry a direct Delete, not the "..." menu', async () => {
    const all = await listTasks({ type: 'remote' });
    if (!all.tasks.length) return; // the account holds no remote task today

    await navigateToOrThrow('Task List', 'https://app.multcloud.com/mc_project/task_list');
    const id = all.tasks[0].taskId;
    const probe = await evaluate(`(() => {
      const targetId = ${JSON.stringify(all.tasks[0].taskId)};
      const card = Array.from(document.querySelectorAll('.el-card.grid-card, .grid-card, .el-card'))
        .find(c => { const i = c.querySelector('input'); return i && i.value === targetId; });
      if (!card) return { found: false };
      return {
        found: true,
        hasMenu: !!card.querySelector('.task-operate-menu, .icon-more, [class*="more"]'),
        directDeletes: Array.from(card.querySelectorAll('button'))
          .filter(b => (b.textContent || '').trim() === 'Delete' && b.offsetWidth > 0).length
      };
    })()`);

    assert.equal(probe.found, true, `no card rendered for remote task ${id}`);
    // Requiring the menu is what made `tasks delete` fail on every remote task.
    if (!probe.hasMenu) {
      assert.equal(probe.directDeletes, 1,
        'a menu-less remote card must expose exactly one direct Delete button, or deleteTask refuses');
    }
  });
});

describe('Live: aggregates', () => {
  live('stats never presents an unmeasured total as a number', async () => {
    const res = await getStats();
    assert.equal(res.ok, true);
    if (!res.storage.measured) {
      assert.equal(res.storage.totalCapacityTB, null);
      assert.ok(res.warnings.some(w => /not a measurement/.test(w)));
    } else {
      assert.ok(Number(res.storage.totalCapacityTB) > 0);
      assert.ok(Number(res.storage.usedCapacityTB) <= Number(res.storage.totalCapacityTB));
    }
  });

  live('doctor returns a full check list', async () => {
    const res = await runDoctor();
    assert.ok(res.checks.length >= 4);
    assert.ok(res.checks.some(c => c.name.includes('Bridge')));
    assert.ok(res.checks.every(c => ['PASS', 'WARN', 'FAIL'].includes(c.status)));
  });

  live('shares returns an array even when empty', async () => {
    const res = await listShares();
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.shares));
  });
});
