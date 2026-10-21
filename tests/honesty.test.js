import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';
import { getAccountInfo } from '../src/account.js';
import { listClouds } from '../src/clouds.js';
import { getStats } from '../src/stats.js';
import { classifyTimerLatency } from '../src/doctor.js';

/**
 * "Absent is not zero."
 *
 * These are the regressions for the defect that shipped: the CLI printed
 * `Used Quota: 1653.62GB` — a literal baked into the dispatcher — on every run,
 * while the real figure sat one line below it. And unreadable drive capacity
 * was summed as 0, so `stats` could report `Total Bound: 0.00 TB` as a fact.
 */

const TB = 1024 ** 4;

/** One entry of the page's own `clouds` array, as `listDrives` returns it. */
const rosterDrive = (name, usedBytes = null, totalBytes = null) => ({
  name, id: `id-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
  driveType: 'google_drive', rootId: '/', usedBytes, totalBytes
});

/**
 * A Manage Clouds page. `failed` lists the drives whose sidebar slot shows the
 * word "Failed" — MultCloud's QUOTA lookup, which this CLI must never report as
 * an authorization problem.
 */
function cloudsBridge(drives, { failed = [], extraHandlers = [] } = {}) {
  return installFakeBridge(pageRouter({
    handlers: [
      ...extraHandlers,
      ['const collect', { ok: true, source: 'clouds', sources: ['clouds'], drives }],
      ['capacities', {
        ok: true,
        capacities: drives
          .filter(d => Number.isFinite(d.usedBytes) && Number.isFinite(d.totalBytes))
          .map(d => ({ name: d.name, capacity: '1.5 TB/2 TB' })),
        sidebar: drives.map(d => ({
          name: d.name,
          full: `${d.name} ${failed.includes(d.name) ? 'Failed' : 'someone@example.invalid'}`,
          desc: failed.includes(d.name) ? 'Failed' : 'someone@example.invalid'
        }))
      }]
    ]
  }));
}

describe('account: unreadable is unknown, never a stored default', () => {
  it('reports null (not a plausible number) when the page shows no traffic', async () => {
    const bridge = installFakeBridge(pageRouter({
      handlers: [['trafficMatch', { ok: true, plan: 'Standard', planKnown: false, trafficUsed: null, trafficTotal: null, trafficSummary: null, trafficKnown: false, user: 'x', url: 'u' }]]
    }));
    try {
      const res = await getAccountInfo();
      assert.equal(res.trafficUsed, null);
      assert.equal(res.trafficKnown, false);
    } finally { bridge.restore(); }
  });

  it('exposes no field named like the dispatcher\'s old hardcoded fallbacks', async () => {
    const bridge = installFakeBridge(pageRouter({
      handlers: [['trafficMatch', { ok: true, plan: 'Lifetime Unlimited', trafficUsed: '10GB', trafficTotal: 'Unlimited', trafficSummary: '10GB / Unlimited', trafficKnown: true, user: 'x', url: 'u' }]]
    }));
    try {
      const res = await getAccountInfo();
      // The bug was a NAME mismatch: bin read `usedTraffic`, src returned
      // `trafficUsed`, so the `|| '1653.62GB'` fallback fired every single run.
      assert.equal(res.trafficUsed, '10GB');
      assert.equal('usedTraffic' in res, false);
      assert.equal('subscription' in res, false);
    } finally { bridge.restore(); }
  });
});

describe('clouds: the roster is complete and the quota label is not an auth claim', () => {
  it('formats used/total from the page model\'s exact byte counts', async () => {
    const bridge = cloudsBridge([rosterDrive('Drive A', 1.5 * TB, 2 * TB)]);
    try {
      const res = await listClouds();
      assert.equal(res.clouds[0].used, '1.50TB');
      assert.equal(res.clouds[0].total, '2.00TB');
      assert.equal(res.clouds[0].capacityKnown, true);
      assert.equal(res.clouds[0].quota, 'ok');
      assert.equal(res.warnings.length, 0, 'a healthy read must emit no warnings');
    } finally { bridge.restore(); }
  });

  it('warns when a drive has no readable capacity, and keeps it in the list', async () => {
    const bridge = cloudsBridge([rosterDrive('Drive A'), rosterDrive('Drive B', 1 * TB, 2 * TB)],
      { failed: ['Drive A'] });
    try {
      const res = await listClouds();
      assert.equal(res.totalCount, 2, 'a drive with no quota must still be listed');
      assert.equal(res.clouds[0].used, null);
      assert.equal(res.capacityUnreadableCount, 1);
      assert.match(res.warnings.join(' '), /Drive A/);
      assert.match(res.warnings.join(' '), /floor, not a total/);
    } finally { bridge.restore(); }
  });

  it('lists every drive on the roster, not only the ones the DOM happened to render', async () => {
    // The old scrape keyed on capacity text, so a drive whose quota had not
    // loaded vanished from the output entirely. Measured live 2026-08-31: the
    // account has 21 drives and `clouds` reported 12 — a different 12 per run.
    const drives = [
      rosterDrive('Rendered', 1 * TB, 2 * TB),
      rosterDrive('Not rendered yet'),
      rosterDrive('Also not rendered')
    ];
    const bridge = cloudsBridge(drives);
    try {
      const res = await listClouds();
      assert.equal(res.totalCount, 3);
      assert.deepEqual(res.clouds.map(c => c.name), ['Rendered', 'Not rendered yet', 'Also not rendered']);
    } finally { bridge.restore(); }
  });

  it('never calls a missing quota an expired token', async () => {
    // MultCloud writes "Failed" in the slot that otherwise holds the account
    // email when its QUOTA lookup does not return. This CLI read that as an
    // expired OAuth token and told the user to re-authorize. Measured
    // 2026-08-31: 13 of 21 drives were marked that way, two of which a transfer
    // had just read from and written to in the same minute.
    const bridge = cloudsBridge([rosterDrive('Working Drive')], { failed: ['Working Drive'] });
    try {
      const res = await listClouds();
      assert.equal(res.clouds[0].quota, 'unavailable');
      const everything = JSON.stringify(res).toLowerCase();
      for (const word of ['oauth', 'expired', 'token', 're-auth', 'reauthor']) {
        assert.ok(!everything.includes(word),
          `clouds output claims "${word}" from a quota label that says nothing about authorization`);
      }
    } finally { bridge.restore(); }
  });
});

describe('stats: totals say whether they are a measurement', () => {
  function statsBridge(drives, tasks) {
    return cloudsBridge(drives, { extraHandlers: [
      ['trafficMatch', { ok: true, plan: 'Lifetime Unlimited', trafficUsed: '1GB', trafficTotal: 'Unlimited', trafficSummary: '1GB / Unlimited', trafficKnown: true, user: 'x', url: 'u' }],
      ['taskList', tasks]
    ] });
  }

  it('refuses to report 0.00 TB as a total when nothing was readable', async () => {
    const bridge = statsBridge([rosterDrive('A'), rosterDrive('B')], []);
    try {
      const res = await getStats();
      assert.equal(res.storage.measured, false);
      // The old code returned the string '0.00' here, which reads as a fact.
      assert.equal(res.storage.totalCapacityTB, null);
      assert.match(res.warnings.join(' '), /not a measurement/);
    } finally { bridge.restore(); }
  });

  it('reports a partial total but names the drives it excluded', async () => {
    const bridge = statsBridge([rosterDrive('A', 1 * TB, 2 * TB), rosterDrive('B')], []);
    try {
      const res = await getStats();
      assert.equal(res.storage.measured, true);
      assert.equal(res.storage.drivesCounted, 1);
      assert.equal(res.storage.drivesUncounted, 1);
      assert.match(res.warnings.join(' '), /exclude 1 drive/);
    } finally { bridge.restore(); }
  });

  it('surfaces unclassified tasks instead of folding them into the success rate silently', async () => {
    const t = (id, status) => ({ taskId: id, taskName: id, typeRaw: 'cloudTransfer', typeNumeric: null, status, isOneTime: true, cadence: 'One-time Task', sourcePath: '', destPath: '', lastRun: '' });
    const bridge = statsBridge([rosterDrive('A', 1 * TB, 2 * TB)], [t('1', 'Success'), t('2', 'Unknown')]);
    try {
      const res = await getStats();
      assert.equal(res.tasks.unknown, 1);
      assert.ok(res.tasks.successRateNote.length > 0, 'a rate computed over unclassified rows must say so');
      assert.match(res.warnings.join(' '), /could not classify/i);
    } finally { bridge.restore(); }
  });
});

describe('a hidden browser tab is a diagnosable condition, not a mystery timeout', () => {
  // Chrome intensively throttles timers in a hidden tab. Measured 2026-08-31:
  // an in-page setTimeout(2000) took 116 SECONDS of wall clock. Every create
  // command sleeps in-page between steps, so a hidden tab turns them into a
  // bridge timeout at ~115s whose message says nothing about visibility --
  // three live magnet runs were spent on it before anyone timed a sleep.
  it('calls a normal round trip healthy', () => {
    assert.equal(classifyTimerLatency(400, 650), 'ok');
    assert.equal(classifyTimerLatency(400, 400), 'ok');
  });

  it('calls a wildly inflated round trip throttled', () => {
    assert.equal(classifyTimerLatency(400, 116673), 'throttled');
    assert.equal(classifyTimerLatency(2000, 60000), 'throttled');
  });

  it('treats a probe that never returned as throttled, not as healthy', () => {
    // Behind a client timeout the observation is missing, not fast. Defaulting
    // an absent measurement to "ok" is exactly the confident-zero this file
    // exists to prevent.
    assert.equal(classifyTimerLatency(400, null), 'throttled');
    assert.equal(classifyTimerLatency(400, undefined), 'throttled');
  });
});
