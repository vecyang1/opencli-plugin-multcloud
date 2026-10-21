import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';
import { createTransfer } from '../src/transfer.js';
import { createSync } from '../src/sync.js';
import { createBackup } from '../src/backup.js';
import { createRemoteUpload } from '../src/remote_upload.js';

/**
 * The creation commands used to report success unconditionally.
 * `createBackup` in particular clicked a selector that does not exist, never
 * chose a destination, never pressed a button, and returned
 * `{ok: true, action: 'Cloud Backup Configured'}` — so `multcloud backup a b`
 * printed a green tick every time and created nothing.
 */

/**
 * Identifies the builder submit script among the page chatter. Keyed on a
 * parameter name the script must carry, not on an internal helper name — the
 * previous marker was a function name, and renaming that helper turned four
 * assertions green-for-no-reason until the suite went red.
 */
const BUILDER_MARKER = 'submitLabel';

const task = (taskId, taskName) => ({
  taskId, taskName, typeRaw: 'cloudTransfer', typeNumeric: null, status: 'Success',
  isOneTime: true, cadence: 'One-time Task', sourcePath: 'a', destPath: 'b', lastRun: ''
});

/** A page where the builder flow succeeds and a new task appears afterwards. */
function successfulPage(existing = [], created = 'new-id') {
  let listCalls = 0;
  return installFakeBridge(pageRouter({
    handlers: [
      ['taskList', () => {
        listCalls++;
        return JSON.stringify(listCalls > 1 ? [...existing, task(created, 'Created Task')] : existing);
      }],
      [BUILDER_MARKER, { ok: true, step: 'submitted' }]
    ]
  }));
}

/** A page where the flow "succeeds" but no task is ever created. */
function silentlyIneffectivePage(existing = []) {
  return installFakeBridge(pageRouter({
    handlers: [
      ['taskList', JSON.stringify(existing)],
      [BUILDER_MARKER, { ok: true, step: 'submitted' }]
    ]
  }));
}

for (const [label, create] of Object.entries({
  transfer: (o) => createTransfer(o),
  sync: (o) => createSync(o),
  backup: (o) => createBackup(o)
})) {
  describe(`create ${label}`, () => {
    it('requires both a source and a destination', async () => {
      await assert.rejects(() => create({ from: 'a' }), /required/i);
      await assert.rejects(() => create({ to: 'b' }), /required/i);
    });

    it('returns ok and the new task id when a task really appeared', async () => {
      const bridge = successfulPage([task('old-1', 'Existing')]);
      try {
        const res = await create({ from: 'A/x', to: 'B/y', name: 'T' });
        assert.equal(res.ok, true);
        assert.equal(res.verified, true);
        assert.equal(res.taskId, 'new-id');
      } finally { bridge.restore(); }
    });

    it('reports FAILURE when the button was clicked but no task appeared', async () => {
      const bridge = silentlyIneffectivePage([task('old-1', 'Existing')]);
      try {
        const res = await create({ from: 'A/x', to: 'B/y' });
        assert.equal(res.ok, false, `${label} claimed success without creating a task`);
        assert.match(res.error, /no new task appeared/i);
      } finally { bridge.restore(); }
    });

    it('reports FAILURE when the page refuses a step', async () => {
      const bridge = installFakeBridge(pageRouter({
        handlers: [
          ['taskList', JSON.stringify([])],
          [BUILDER_MARKER, { ok: false, step: 'from_selection', error: 'Node not found: Nope', available: ['Real Folder'] }]
        ]
      }));
      try {
        const res = await create({ from: 'Nope', to: 'B' });
        assert.equal(res.ok, false);
        assert.match(res.error, /Node not found/);
      } finally { bridge.restore(); }
    });

    it('never retries the submit (a mutation that timed out may already have landed)', async () => {
      const bridge = successfulPage([]);
      try {
        await create({ from: 'A', to: 'B' });
        const submits = bridge.calls.filter(c => c.kind === 'eval' && String(c.payload).includes(BUILDER_MARKER));
        assert.equal(submits.length, 1);
        assert.equal(submits[0].opts.idempotent, false, 'the submit must be marked non-idempotent');
      } finally { bridge.restore(); }
    });
  });
}

describe('sync mode flags reach the page', () => {
  it('clicks Real Time Sync when --realtime is given', async () => {
    const bridge = successfulPage([]);
    try {
      const res = await createSync({ from: 'A', to: 'B', realtime: true });
      const script = bridge.scripts().find(s => s.includes('modeClicks'));
      assert.match(script, /Real Time Sync/);
      assert.equal(res.mode, 'Real-Time');
    } finally { bridge.restore(); }
  });

  it('honours --twoway, which the CLI previously could not reach at all', async () => {
    const bridge = successfulPage([]);
    try {
      const res = await createSync({ from: 'A', to: 'B', twoway: true });
      assert.equal(res.twoway, true);
      assert.match(bridge.scripts().find(s => s.includes('modeClicks')), /two-way sync/);
    } finally { bridge.restore(); }
  });
});

/**
 * Remote Upload was the last create path whose success came from a click.
 *
 * It kept its own copy of the page logic and returned
 * `{ok: true, action: 'submitted'}` after pressing "Upload Now", with no
 * read-back. Measured live 2026-08-31 it could not have worked: it hunted the
 * dialog commit button with `.el-dialog button, .modal button, .dialog-footer
 * button` on a page whose dialog is `.popup` and whose button is
 * `button.saveCloud`, and the search was guarded by `if (saveBtn)` — so the
 * link was typed, never committed, and the command reported success anyway.
 *
 * It now runs on the shared builder engine, which verifies by read-back.
 */
describe('remote upload', () => {
  const args = { url: 'https://example.com/f.txt', cloud: 'Google Drive 5' };

  it('requires a url', async () => {
    await assert.rejects(() => createRemoteUpload({ cloud: 'Google Drive 5' }), /url or magnet/i);
  });

  it('requires a destination cloud', async () => {
    // The old implementation treated the destination as optional and fell
    // through to whatever the page happened to have selected.
    await assert.rejects(() => createRemoteUpload({ url: 'magnet:x' }), /destination cloud is required/i);
  });

  it('refuses --name instead of silently dropping it', async () => {
    // The Remote Upload page carries no `.edit-task-icon`, so there is nowhere
    // to put a name. The error must name the layer that CAN carry one.
    await assert.rejects(
      () => createRemoteUpload({ ...args, name: 'My Download' }),
      /tasks rename/i
    );
  });

  it('returns ok and the new task id when a task really appeared', async () => {
    const bridge = successfulPage([task('old-1', 'Existing')]);
    try {
      const res = await createRemoteUpload(args);
      assert.equal(res.ok, true);
      assert.equal(res.verified, true);
      assert.equal(res.taskId, 'new-id');
      assert.equal(res.url, args.url);
    } finally { bridge.restore(); }
  });

  it('reports FAILURE when Upload Now was clicked but no task appeared', async () => {
    const bridge = silentlyIneffectivePage([task('old-1', 'Existing')]);
    try {
      const res = await createRemoteUpload(args);
      assert.equal(res.ok, false, 'remote upload claimed success without creating a task');
      assert.match(res.error, /no new task appeared/i);
    } finally { bridge.restore(); }
  });

  it('commits the Add Link dialog through the controls the page actually has', async () => {
    const bridge = successfulPage([]);
    try {
      await createRemoteUpload(args);
      const script = bridge.scripts().find(s => s.includes(BUILDER_MARKER));
      assert.ok(script, 'no builder script was emitted for remote upload');
      assert.ok(script.includes(".popup"), 'the script does not look for the .popup dialog');
      assert.ok(script.includes('HTMLTextAreaElement.prototype'),
        'the link is assigned to .value directly; Vue listens on the native setter');
      assert.doesNotMatch(script, /dialog-footer/,
        'the script still hunts the Element-UI dialog footer, which this page has none of');
    } finally { bridge.restore(); }
  });

  it('never falls back to a bare textarea (the page hides a cancellation feedback box)', async () => {
    const bridge = successfulPage([]);
    try {
      await createRemoteUpload(args);
      const script = bridge.scripts().find(s => s.includes(BUILDER_MARKER));
      // `document.querySelector('textarea')` as a last resort can select the
      // hidden "reason why you leave" subscription-cancellation textarea, which
      // would type the download URL into an account-cancellation form.
      assert.doesNotMatch(script, /querySelector\((['"])textarea\1\)/,
        'a bare textarea fallback can select the hidden cancellation feedback box');
      assert.ok(script.includes('reason why you leave'),
        'the script does not refuse the subscription-feedback textarea by name');
    } finally { bridge.restore(); }
  });

  it('composes --cloud and --path into one destination', async () => {
    const bridge = successfulPage([]);
    try {
      const res = await createRemoteUpload({ ...args, path: '/Offline' });
      const script = bridge.scripts().find(s => s.includes(BUILDER_MARKER));
      // Build the expected string from the argument rather than repeating the
      // drive name in a regex: a name embedded in a pattern is not a quoted
      // value, so the publish sanitiser cannot rewrite it and the public tree
      // fails this test alone.
      assert.ok(script.includes(JSON.stringify(`${args.cloud}/Offline`)),
        'the destination path never reached the page');
      assert.equal(res.targetPath, '/Offline');
    } finally { bridge.restore(); }
  });

  it('still accepts the legacy targetCloud spelling', async () => {
    const bridge = successfulPage([]);
    try {
      await createRemoteUpload({ url: args.url, targetCloud: 'Google Drive 5' });
      assert.match(bridge.scripts().find(s => s.includes(BUILDER_MARKER)), /"Google Drive 5"/);
    } finally { bridge.restore(); }
  });

  it('never retries the submit (a mutation that timed out may already have landed)', async () => {
    const bridge = successfulPage([]);
    try {
      await createRemoteUpload(args);
      const submits = bridge.calls.filter(c => c.kind === 'eval' && String(c.payload).includes(BUILDER_MARKER));
      // The link path runs in two phases, so the property is not "there is one
      // call" -- it is that NO builder call is retryable. A staged link and a
      // submit are both mutations of page state that may already have landed.
      assert.ok(submits.length >= 1, 'no builder script was sent');
      for (const call of submits) {
        assert.equal(call.opts.idempotent, false,
          'every builder phase must be marked non-idempotent, not just the last');
      }
    } finally { bridge.restore(); }
  });
});

/**
 * The picker contract, asserted on the script the CLI actually emits.
 *
 * Measured live on 2026-08-31: the Cloud Transfer / Sync / Backup pages carry
 * TWO trees in the DOM at once and show one at a time. The source picker is an
 * Element-UI tree with checkboxes; the destination picker is a hand-rolled tree
 * (`.tree-node-div` + `.tr-tree-name-span`) with no checkbox and no radio.
 *
 * The shipped code selected the destination with `.el-radio__inner`, which
 * exists nowhere on the page, then submitted with an empty TO box. MultCloud
 * refuses that, so no task was ever created by any of the three commands. These
 * assertions are the cheap regression guard; the DOM claim itself is re-checked
 * against the live page in `tests/live/live.test.js`.
 */
describe('builder page selector contract', () => {
  const builderScript = async (kind, create) => {
    const bridge = installFakeBridge(pageRouter({
      handlers: [['taskList', JSON.stringify([])], [BUILDER_MARKER, { ok: false, step: 'layout', error: 'stub' }]]
    }));
    try {
      await create({ from: 'A/x', to: 'B/y', name: 'T' });
      return bridge.scripts().find(s => s.includes(BUILDER_MARKER));
    } finally { bridge.restore(); }
  };

  for (const [kind, create] of Object.entries({
    transfer: (o) => createTransfer(o),
    sync: (o) => createSync(o),
    backup: (o) => createBackup(o)
  })) {
    it(`${kind}: drives the destination tree that actually exists`, async () => {
      const script = await builderScript(kind, create);
      assert.ok(script, `no builder script was emitted for ${kind}`);

      assert.doesNotMatch(script, /el-radio/,
        `${kind} still selects the destination with a radio; the page has none`);

      for (const selector of ['.tree-node-div', '.tr-tree-name-span', 'i.pull-triangle', 'tr-click']) {
        assert.ok(script.includes(selector),
          `${kind} builder script does not use ${selector} for the destination tree`);
      }
      for (const selector of ['.el-tree-node__content', '.el-checkbox__inner']) {
        assert.ok(script.includes(selector),
          `${kind} builder script does not use ${selector} for the source tree`);
      }
    });

    it(`${kind}: refuses to submit while a selection box is still empty`, async () => {
      const script = await builderScript(kind, create);
      assert.match(script, /click here to select/i,
        `${kind} never checks the placeholder text, so an empty box reaches submit`);
      // Assert the PROPERTY (both boxes are checked before submit), not a
      // count of occurrences. The count was 2 until the Remote Upload branch
      // added a third check to the same shared script, at which point a
      // correct engine failed a gate that was only ever a proxy.
      const submitAt = script.indexOf('submitBtn.click()');
      assert.ok(submitAt > 0, `${kind}: no submit call found in the emitted script`);
      for (const box of ['boxText(0)', 'boxText(1)']) {
        const at = script.indexOf(`EMPTY.test(${box})`);
        assert.ok(at > -1, `${kind} never checks whether ${box} is still the empty placeholder`);
        assert.ok(at < submitAt, `${kind} checks ${box} only after clicking submit, which is too late`);
      }
    });

    it(`${kind}: edits the task name through the control that exists`, async () => {
      const script = await builderScript(kind, create);
      assert.ok(script.includes('.edit-task-icon'), `${kind} does not open the task-name editor`);
      assert.ok(script.includes('input.edit-input'), `${kind} does not target the task-name input`);
      assert.ok(script.includes('i.name-sure'), `${kind} never commits the task name`);
      assert.doesNotMatch(script, /input\.tree-name-edit/,
        `${kind} types the task name into a tree-rename input instead`);
    });
  }
});

/**
 * A torrent source for the link-path tests.
 *
 * Deliberately a `.torrent` URL rather than a magnet literal: `publish/
 * verify-clean.py` forbids the BitTorrent infohash URN prefix anywhere in the
 * public tree, because the account's own remote tasks carry real infohashes.
 * (This comment must not spell that prefix either.) Exempting test files would
 * hollow out the gate at the one place a fixture is most likely to paste a real
 * one. The tests below assert on the emitted script, which does not depend on
 * which torrent spelling was used.
 */
const TORRENT_SOURCE = 'https://example.invalid/fixture.torrent';

describe('the builder asks for a budget its own flow can fit in', () => {
  // The builder script is an interactive multi-step flow: it opens a picker,
  // waits for a tree, expands it, confirms two modals, then submits. Under the
  // 30s default that fits only when nothing on the page is slow. Measured live
  // 2026-08-31, a magnet remote-upload does not fit -- MultCloud resolves
  // torrent metadata after the link is committed -- and the create was killed
  // mid-flow, which on a MUTATING call is the worst place to be cut off.
  for (const [label, create] of Object.entries({
    transfer: () => createTransfer({ from: 'A/x', to: 'B/y' }),
    sync: () => createSync({ from: 'A/x', to: 'B/y' }),
    backup: () => createBackup({ from: 'A/x', to: 'B/y' }),
    'remote-upload': () => createRemoteUpload({ url: TORRENT_SOURCE, cloud: 'B', path: 'y' })
  })) {
    it(`${label} sends the submit script with more than the 30s default`, async () => {
      const bridge = successfulPage();
      try {
        await create();
        const submit = bridge.calls.filter(
          c => c.kind === 'eval' && String(c.payload).includes(BUILDER_MARKER)).pop();
        assert.ok(submit, 'the builder submit script was never sent');
        assert.ok(submit.opts.timeout > 30000,
          `${label} ran under ${submit.opts.timeout}ms; the default is what killed the magnet create`);
      } finally { bridge.restore(); }
    });
  }
});

describe('the Add Link dialog gets a budget a torrent can finish in', () => {
  // Measured live 2026-08-31. The dialog wait was 10s. A magnet does not
  // resolve that fast: polled with a 60s budget the SAME link that the product
  // called invalid was accepted and the dialog closed. So the product was
  // reporting a rejection it had never observed -- it quoted the dialog's own
  // text as proof, and that text is present whether or not anything is wrong.
  //
  // The ceiling is not ours to choose: the OpenCLI bridge kills a single
  // `Runtime.evaluate` at ~115s. A wait longer than that is a promise the
  // transport cannot keep, so the two numbers are asserted against each other.
  it('waits far longer than 10s, but still inside what the bridge can deliver', async () => {
    const bridge = successfulPage();
    try {
      await createRemoteUpload({ url: TORRENT_SOURCE, cloud: 'B', path: 'y' });
      const script = bridge.scripts().find(s => s.includes('LINK_DIALOG_CLOSE_MS'));
      assert.ok(script, 'the builder script does not declare its link-dialog budget');

      const wait = Number(/const LINK_DIALOG_CLOSE_MS = (\d+)/.exec(script)[1]);
      const ceiling = Number(/const BRIDGE_EVAL_CEILING_MS = (\d+)/.exec(script)[1]);

      assert.ok(wait > 10000, `10s was measured too short for a magnet; got ${wait}ms`);
      assert.ok(wait < ceiling,
        `a ${wait}ms wait cannot be delivered: the bridge kills one eval at ${ceiling}ms`);
    } finally { bridge.restore(); }
  });
});

describe('a magnet has a step an HTTP link does not', () => {
  // Measured live 2026-08-31. Once MultCloud resolves a torrent it does not
  // close the Add Link dialog -- it REPLACES it with "Select Content to
  // Upload", listing the files inside (for Sintel: "Name(11/11)", Sintel.mp4,
  // 123.25 MB), whose commit is `button.foot-download`.
  //
  // The old code's success condition was "the popup count reached zero". For a
  // torrent that never happens, so a magnet that had been accepted and fully
  // resolved was reported as `Please enter valid link`. T-037 never saw this
  // because an HTTPS URL has no content-selection step at all.
  const scriptFor = async () => {
    const bridge = successfulPage();
    try {
      await createRemoteUpload({ url: TORRENT_SOURCE, cloud: 'B', path: 'y' });
      return bridge.scripts().find(s => s.includes(BUILDER_MARKER));
    } finally { bridge.restore(); }
  };

  it('confirms the content-selection dialog a torrent opens', async () => {
    const script = await scriptFor();
    assert.ok(script, 'no builder script was emitted');
    assert.ok(script.includes('foot-download'),
      'the script never commits the "Select Content to Upload" dialog a torrent opens');
  });

  it('does not report an unobserved rejection', async () => {
    const script = await scriptFor();
    assert.doesNotMatch(script, /most likely rejected/,
      'the script still asserts a cause it never observed; a still-open popup is not proof of rejection');
  });

  it('keeps the whole link stage inside what the bridge can deliver', async () => {
    const script = await scriptFor();
    const ceiling = Number(/const BRIDGE_EVAL_CEILING_MS = (\d+)/.exec(script)[1]);
    const resolve = Number(/const LINK_DIALOG_CLOSE_MS = (\d+)/.exec(script)[1]);
    const content = Number(/const TORRENT_CONTENT_MS = (\d+)/.exec(script)[1]);
    // Both waits can run back to back on the torrent path, and the destination
    // picker and submit still have to happen after them inside the same eval.
    assert.ok(resolve + content < ceiling * 0.75,
      `link stage may burn ${resolve + content}ms of a ${ceiling}ms eval, leaving too little for the picker and submit`);
  });
});

describe('the link flow is split into phases the transport can actually deliver', () => {
  // The single-eval flow does not fit. Measured live 2026-08-31, three times:
  // resolving a torrent, committing its content dialog, expanding the
  // destination tree and submitting exceeded the bridge's ~115s ceiling for one
  // `Runtime.evaluate`, and the create was killed mid-flow.
  //
  // A bigger client timeout cannot fix that -- the ceiling is the transport's.
  // So the link path stages the source in one eval and finishes in a second,
  // with the page's state carrying between them.
  it('sends two scripts for a link source, each inside the ceiling', async () => {
    const bridge = successfulPage();
    try {
      await createRemoteUpload({ url: TORRENT_SOURCE, cloud: 'B', path: 'y' });
      const builderScripts = bridge.calls
        .filter(c => c.kind === 'eval' && String(c.payload).includes(BUILDER_MARKER));
      assert.equal(builderScripts.length, 2,
        `the link flow should stage and finish in separate evals; got ${builderScripts.length}`);

      const ceiling = Number(/const BRIDGE_EVAL_CEILING_MS = (\d+)/.exec(builderScripts[0].payload)[1]);
      for (const call of builderScripts) {
        assert.ok(call.opts.timeout < ceiling * 1.5,
          `an eval asking for ${call.opts.timeout}ms cannot be delivered under a ${ceiling}ms ceiling`);
      }
      assert.match(String(builderScripts[0].payload), /const phase = "link"/);
      assert.match(String(builderScripts[1].payload), /const phase = "finish"/);
    } finally { bridge.restore(); }
  });

  it('still sends exactly one script when the source is a folder', async () => {
    const bridge = successfulPage();
    try {
      await createTransfer({ from: 'A/x', to: 'B/y' });
      const builderScripts = bridge.calls
        .filter(c => c.kind === 'eval' && String(c.payload).includes(BUILDER_MARKER));
      assert.equal(builderScripts.length, 1,
        'a picker-source create has no slow stage and must not pay for two round trips');
    } finally { bridge.restore(); }
  });
});
