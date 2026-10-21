import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';
import { listTasks, resolveTask, deleteTask, retryFailedTasks, autoResumeTasks, normalizeTaskType, TASK_TYPES, saveAlias, getAliases, taskStatusFromItem } from '../src/tasks.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const taskFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'tasks.json'), 'utf8'));

/** The raw stdout the live page produced for the task-list query. */
const liveTaskListStdout = taskFixture.traffic.find(t => t.kind === 'eval' && String(t.payload).includes('taskList'))?.stdout;

/**
 * Build a row in the shape the in-page script returns. The fake bridge replaces
 * the browser, so it must speak the script's OUTPUT contract, not the Vue model.
 */
function row(taskId, taskName, typeRaw, status, extra = {}) {
  return {
    taskId, taskName, typeRaw, typeNumeric: null, status,
    isOneTime: true, cadence: 'One-time Task', schedule: 'Off',
    sourcePath: 'src', destPath: 'dst', progress: '100%', speed: '--', lastRun: '',
    ...extra
  };
}

function withTasks(rows) {
  return installFakeBridge(pageRouter({
    handlers: [['taskList', JSON.stringify(rows)]]
  }));
}

describe('Task type vocabulary (grounded in captured live data)', () => {
  it('every raw type the live page actually produced maps into the documented vocabulary', () => {
    assert.ok(liveTaskListStdout, 'fixture has no task-list capture');
    const rows = JSON.parse(liveTaskListStdout.slice(liveTaskListStdout.search(/[[{]/)));
    const rawTypes = [...new Set(rows.map(r => r.typeRaw || ''))].filter(Boolean);
    assert.ok(rawTypes.length >= 3, `expected several raw types in the capture, saw ${rawTypes.length}`);

    const unmapped = rawTypes.filter(t => !TASK_TYPES.includes(normalizeTaskType(t, null)));
    assert.deepEqual(unmapped, [],
      `raw page types with no documented --type value: ${unmapped.join(', ')}`);
    console.log(`      mapped ${rawTypes.length} live raw types: ${rawTypes.join(', ')}`);
  });

  it('linkTask is reachable as --type remote', () => {
    // This is the behaviour the old code got wrong: remote uploads carry
    // typeRaw "linkTask", the filter tested `includes('remote')`, and the
    // documented `--type remote` therefore reported "you own none".
    assert.equal(normalizeTaskType('linkTask', null), 'remote');
  });
});

describe('listTasks', () => {
  it('filters by the documented type vocabulary and finds remote uploads', async () => {
    const bridge = withTasks([
      row('a1', 'T1', 'cloudTransfer', 'Success'),
      row('b2', 'Magnet', 'linkTask', 'Unknown')
    ]);
    try {
      const remote = await listTasks({ type: 'remote' });
      assert.equal(remote.totalCount, 1);
      assert.equal(remote.tasks[0].taskId, 'b2');
    } finally { bridge.restore(); }
  });

  it('rejects an unknown --type rather than silently returning nothing', async () => {
    const bridge = withTasks([row('a1', 'T1', 'cloudTransfer', 'Success')]);
    try {
      await assert.rejects(() => listTasks({ type: 'remotee' }), /Unknown --type/);
    } finally { bridge.restore(); }
  });

  it('counts unclassified tasks and warns instead of hiding them', async () => {
    const bridge = withTasks([
      row('a1', 'ok', 'cloudTransfer', 'Success'),
      row('b2', 'mystery', 'cloudSync', 'Unknown')
    ]);
    try {
      const res = await listTasks();
      assert.equal(res.unknownCount, 1);
      assert.match(res.warnings.join(' '), /could not classify/i);
      // Success + failure + syncing + paused + unknown must account for every row.
      assert.equal(res.successCount + res.failureCount + res.syncingCount + res.pausedCount + res.unknownCount, res.totalCount);
    } finally { bridge.restore(); }
  });

  it('does not label a running real-time sync as a one-time task', async () => {
    const bridge = withTasks([row('s1', 'RT', 'cloudSync', 'Syncing')]);
    try {
      const res = await listTasks();
      assert.equal(res.tasks[0].isOneTime, false);
      assert.equal(res.oneTimeCount, 0);
    } finally { bridge.restore(); }
  });

  it('omits the raw page model unless --raw is asked for', async () => {
    const bridge = withTasks([{ ...row('a1', 'T', 'cloudTransfer', 'Success'), rawItem: { secret: 'internal' } }]);
    try {
      const plain = await listTasks();
      assert.equal('rawItem' in plain.tasks[0], false);
      const raw = await listTasks({ raw: true });
      assert.equal(raw.tasks[0].rawItem.secret, 'internal');
    } finally { bridge.restore(); }
  });
});

describe('resolveTask — ambiguity is refused, never guessed', () => {
  const rows = [
    row('id-aaa', 'Photos Sync', 'cloudSync', 'Success'),
    row('id-bbb', 'Photos Sync v2', 'cloudSync', 'Success')
  ];

  it('an exact id wins even when another row shares the text', async () => {
    const bridge = withTasks(rows);
    try {
      assert.equal((await resolveTask('id-bbb')).taskId, 'id-bbb');
    } finally { bridge.restore(); }
  });

  it('an exact name beats a longer name that contains it', async () => {
    const bridge = withTasks(rows);
    try {
      // The old code did `innerText.includes(target)` and took the first DOM
      // hit, so "Photos Sync" could resolve to "Photos Sync v2".
      assert.equal((await resolveTask('Photos Sync')).taskId, 'id-aaa');
    } finally { bridge.restore(); }
  });

  it('a genuinely ambiguous query throws and lists the candidates', async () => {
    const bridge = withTasks(rows);
    try {
      await assert.rejects(() => resolveTask('Photos'), (err) => {
        assert.match(err.message, /matches 2 tasks/);
        assert.match(err.message, /id-aaa/);
        assert.match(err.message, /id-bbb/);
        return true;
      });
    } finally { bridge.restore(); }
  });

  it('a query matching nothing throws rather than returning a wrong task', async () => {
    const bridge = withTasks(rows);
    try {
      await assert.rejects(() => resolveTask('nothing-like-this'), /No task matches/);
    } finally { bridge.restore(); }
  });
});

describe('deleteTask', () => {
  it('refuses without explicit confirmation', async () => {
    await assert.rejects(() => deleteTask('anything', false), /requires explicit confirmation/);
  });

  it('targets the card by id, never by rendered text', async () => {
    const rows = [
      row('id-aaa', 'Photos Sync', 'cloudSync', 'Success'),
      row('id-bbb', 'Photos Sync v2', 'cloudSync', 'Success')
    ];
    let deleteScript = null;
    let listCalls = 0;
    const bridge = installFakeBridge(pageRouter({
      handlers: [
        ['taskList', () => {
          listCalls++;
          // After the delete, the task is gone — this is the read-back.
          return JSON.stringify(listCalls > 1 ? rows.filter(r => r.taskId !== 'id-aaa') : rows);
        }],
        ['dotBtn', (script) => { deleteScript = script; return { ok: true, deleted: 'id-aaa' }; }]
      ]
    }));
    try {
      const res = await deleteTask('Photos Sync', true);
      assert.equal(res.ok, true);
      assert.equal(res.taskId, 'id-aaa');
      assert.equal(res.verifiedGone, true);
      // The emitted script must carry the id and must not select by innerText.
      assert.match(deleteScript, /const targetId = "id-aaa"/);
      assert.doesNotMatch(deleteScript, /innerText\.includes\(target/);
    } finally { bridge.restore(); }
  });

  it('reports failure when the task is still present after a "successful" delete', async () => {
    const rows = [row('id-aaa', 'Stubborn', 'cloudSync', 'Success')];
    const bridge = installFakeBridge(pageRouter({
      handlers: [
        ['taskList', JSON.stringify(rows)],          // never disappears
        ['dotBtn', { ok: true, deleted: 'id-aaa' }]  // UI claims success
      ]
    }));
    try {
      const res = await deleteTask('Stubborn', true);
      assert.equal(res.ok, false);
      assert.match(res.error, /still in the list/);
    } finally { bridge.restore(); }
  });
});

describe('alias registry', () => {
  it('writes into the sandbox, never the real home directory', async () => {
    saveAlias('sandbox-task', 'Sandbox Alias');
    assert.equal(getAliases()['sandbox-task'], 'Sandbox Alias');
    const written = path.join(process.env.MULTCLOUD_HOME, 'aliases.json');
    assert.ok(fs.existsSync(written), 'alias file was not created inside the sandbox');
  });
});

describe('retryFailedTasks', () => {
  /**
   * A bulk mutation with no hermetic test until the coverage-shape gate found
   * it. The hazard is blast radius: this walks a list and presses play on each
   * row, so a wrong filter re-runs healthy tasks, and a wrong identifier starts
   * somebody else's. Both are silent -- the page reports success either way.
   */
  const mixed = () => [
    row('id-fail-1', 'Nightly Backup', 'cloudBackup', 'Failure'),
    row('id-ok-1', 'Photos Sync', 'cloudSync', 'Success'),
    row('id-fail-2', 'Second Failing Fixture', 'cloudTransfer', 'Failure'),
    row('id-live-1', 'Realtime Mirror', 'cloudSync', 'Syncing')
  ];

  function withRetry(rows, onRun) {
    const runScripts = [];
    const bridge = installFakeBridge(pageRouter({
      handlers: [
        ['taskList', () => JSON.stringify(rows)],
        ['task-operate-play', (script) => {
          runScripts.push(script);
          const id = (/const targetId = "([^"]+)"/.exec(script) || [])[1];
          return onRun ? onRun(id) : { ok: true, action: 'started', taskId: id };
        }]
      ]
    }));
    return { bridge, runScripts };
  }

  it('retries ONLY the failed tasks, and addresses each by id', async () => {
    const { bridge, runScripts } = withRetry(mixed());
    try {
      const res = await retryFailedTasks();
      assert.equal(res.totalFailed, 2, 'only the two Failure rows are in scope');
      assert.equal(res.retriedCount, 2);
      assert.equal(res.ok, true);

      const started = runScripts.map(s => (/const targetId = "([^"]+)"/.exec(s) || [])[1]);
      assert.deepEqual(started.sort(), ['id-fail-1', 'id-fail-2'],
        'a healthy task was re-run: this is the blast-radius failure');
      // Never by rendered text -- two tasks can share a substring.
      for (const s of runScripts) assert.doesNotMatch(s, /innerText\.includes\(target/);
    } finally { bridge.restore(); }
  });

  it('reports ok:false when a retry fails, rather than a green tick', async () => {
    const { bridge } = withRetry(mixed(), (id) =>
      id === 'id-fail-2' ? { ok: false, error: 'Play button not found' } : { ok: true, taskId: id });
    try {
      const res = await retryFailedTasks();
      assert.equal(res.ok, false, 'a partial retry must not report success');
      assert.equal(res.totalFailed, 2);
      assert.equal(res.retriedCount, 1);
      const bad = res.results.find(r => r.taskId === 'id-fail-2');
      assert.equal(bad.success, false);
      assert.match(bad.error, /Play button not found/);
    } finally { bridge.restore(); }
  });

  it('retries the task that failed, not another one that shares its name', async () => {
    // The property under test is "the already-resolved task is passed through,
    // never re-resolved by name". With unique names that is UNOBSERVABLE -- both
    // implementations emit the same script, and a mutation swapping them escaped
    // this suite until this fixture existed. Two tasks sharing a name is the
    // case the source comment was written about. The name is INVENTED at the
    // right shape: a realistic-looking one is how a real account string ends up
    // committed, and the publish scanner caught exactly that here.
    const twins = [
      row('id-twin-ok', 'Duplicate Name Fixture', 'cloudTransfer', 'Success'),
      row('id-twin-bad', 'Duplicate Name Fixture', 'cloudTransfer', 'Failure')
    ];
    const { bridge, runScripts } = withRetry(twins);
    try {
      const res = await retryFailedTasks();
      const started = runScripts.map(s => (/const targetId = "([^"]+)"/.exec(s) || [])[1]);
      assert.deepEqual(started, ['id-twin-bad'],
        'the failed twin must be the one restarted');
      assert.equal(res.ok, true);
      assert.equal(res.retriedCount, 1);
    } finally { bridge.restore(); }
  });

  it('touches nothing when there is nothing to retry', async () => {
    const healthy = mixed().filter(r => r.status !== 'Failure');
    // A trap, not a recorded value: "this must never be called" is not
    // observable from a stub that returns something plausible.
    const bridge = installFakeBridge(pageRouter({
      handlers: [
        ['taskList', () => JSON.stringify(healthy)],
        ['task-operate-play', () => { throw new Error('retried a task when none had failed'); }]
      ]
    }));
    try {
      const res = await retryFailedTasks();
      assert.equal(res.ok, true);
      assert.equal(res.totalFailed, 0);
      assert.equal(res.retriedCount, 0);
      assert.deepEqual(res.results, []);
    } finally { bridge.restore(); }
  });
});

describe('a status nobody could read is not a reassuring one', () => {
  // `inspect` ended its status expression with `|| 'Normal'`. For a payload
  // carrying no status at all that invents a calm, specific, wrong answer --
  // and it is the benign end of the scale, so nobody questions it. Measured
  // 2026-08-31: two magnet tasks that `tasks list` honestly showed as Unknown
  // inspected as `Normal`, and I spent several steps of a live investigation
  // treating "Normal" as something MultCloud had actually said.
  it('reports Unknown when the payload states no status', () => {
    assert.equal(taskStatusFromItem({ id: 'x' }), 'Unknown');
    assert.equal(taskStatusFromItem({}), 'Unknown');
    assert.equal(taskStatusFromItem(), 'Unknown');
  });

  it('still reports what the payload does state', () => {
    assert.equal(taskStatusFromItem({ result: 1 }), 'Success');
    assert.equal(taskStatusFromItem({ statusTxt: 'Success' }), 'Success');
    assert.equal(taskStatusFromItem({ statusTxt: 'Failure' }), 'Failure');
    assert.equal(taskStatusFromItem({ statusTxt: 'Syncing' }), 'Syncing');
  });

  it('is the same source the page runs, not a copy of it', () => {
    // A second implementation inside the browser script is how the tested
    // behaviour and the shipped behaviour quietly diverge. Note this scan must
    // not spell the banned literal in its own prose -- the first version of
    // this test failed on the docstring that explained it.
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tasks.js'), 'utf8');
    assert.ok(!/\|\| 'Normal'/.test(src),
      "the invented 'Normal' default is still somewhere in tasks.js");
    // ...and the page really is running THIS function, not a lookalike. Without
    // this line the test above passes for a browser script that quietly kept a
    // second copy of the old logic.
    assert.ok(/const statusOf = \$\{taskStatusFromItem\.toString\(\)\}/.test(src),
      'the inspect script no longer injects taskStatusFromItem; the page may hold a second implementation');
  });

  it('detects Failure and Paused from result or statusTxt', () => {
    assert.equal(taskStatusFromItem({ result: -1 }), 'Failure');
    assert.equal(taskStatusFromItem({ result: 0 }), 'Failure');
    assert.equal(taskStatusFromItem({ result: 2 }), 'Failure');
    assert.equal(taskStatusFromItem({ statusTxt: 'Failed' }), 'Failure');
    assert.equal(taskStatusFromItem({ statusTxt: 'Paused' }), 'Paused');
  });
});

describe('autoResumeTasks supervisor', () => {
  const mixed = () => [
    row('id-fail-1', 'Avatar Transfer', 'cloudTransfer', 'Failure'),
    row('id-ok-1', 'Photos Sync', 'cloudSync', 'Success'),
    row('id-paused-1', 'Course Backup', 'cloudBackup', 'Paused'),
    row('id-live-1', 'Realtime Mirror', 'cloudSync', 'Syncing')
  ];

  function withSupervisor(rows, onRun) {
    const runScripts = [];
    const bridge = installFakeBridge(pageRouter({
      handlers: [
        ['taskList', () => JSON.stringify(rows)],
        ['task-operate-play', (script) => {
          runScripts.push(script);
          const id = (/const targetId = "([^"]+)"/.exec(script) || [])[1];
          return onRun ? onRun(id) : { ok: true, action: 'started', taskId: id };
        }]
      ]
    }));
    return { bridge, runScripts };
  }

  it('resumes failed and paused tasks in a single pass (--once)', async () => {
    const { bridge, runScripts } = withSupervisor(mixed());
    try {
      const res = await autoResumeTasks({ once: true });
      assert.equal(res.ok, true);
      assert.equal(res.inspectedCount, 4);
      assert.equal(res.resumedCount, 2);
      const resumedIds = runScripts.map(s => (/const targetId = "([^"]+)"/.exec(s) || [])[1]);
      assert.deepEqual(resumedIds.sort(), ['id-fail-1', 'id-paused-1']);
    } finally { bridge.restore(); }
  });

  it('filters tasks by query', async () => {
    const { bridge, runScripts } = withSupervisor(mixed());
    try {
      const res = await autoResumeTasks({ once: true, query: 'Avatar' });
      assert.equal(res.ok, true);
      assert.equal(res.resumedCount, 1);
      const resumedIds = runScripts.map(s => (/const targetId = "([^"]+)"/.exec(s) || [])[1]);
      assert.deepEqual(resumedIds, ['id-fail-1']);
    } finally { bridge.restore(); }
  });

  it('respects maxRetries limit', async () => {
    const { bridge } = withSupervisor(mixed());
    try {
      const res = await autoResumeTasks({ once: true, maxRetries: 0 });
      assert.equal(res.ok, true);
      assert.equal(res.resumedCount, 0);
    } finally { bridge.restore(); }
  });

  it('logs supervisor actions to auto_resume.log', async () => {
    const logPath = path.join(process.env.MULTCLOUD_HOME, 'auto_resume.log');
    const { bridge } = withSupervisor(mixed());
    try {
      await autoResumeTasks({ once: true, query: 'Avatar', logFile: logPath });
      assert.ok(fs.existsSync(logPath), 'log file was not created');
      const content = fs.readFileSync(logPath, 'utf8');
      assert.match(content, /RESUME_TRIGGERED.*id-fail-1/);
    } finally { bridge.restore(); }
  });
});

