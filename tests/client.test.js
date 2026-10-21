import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonFromOutput, runOpenCli, setTransport, resetTransport, navigateTo, evaluate, formatOpenCliArgs, isHeadlessBackendEnabled } from '../src/client.js';
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';

const NOISE = '⚠  Ignoring 1 YAML adapter for plugin github-trending: repos.yaml.\n⚠  Plugin chaport/cmd.js: cli is not defined\n';

describe('extractJsonFromOutput', () => {
  it('parses an object behind the bridge\'s own warning lines', () => {
    assert.deepEqual(extractJsonFromOutput(NOISE + '{"a":1}'), { a: 1 });
  });

  it('parses an array', () => {
    assert.deepEqual(extractJsonFromOutput(NOISE + '[1,2]'), [1, 2]);
  });

  it('survives a warning line that itself contains braces', () => {
    // The previous implementation seized on the first `{` in the stream and
    // threw when it was not the payload.
    assert.deepEqual(extractJsonFromOutput('⚠ bad {not json} here\n[{"b":2}]'), [{ b: 2 }]);
  });

  it('returns a bare unquoted scalar as a string', () => {
    // opencli prints objects as JSON but scalars raw. `location.href` arrives
    // like this, and returning null for it silently disabled the navigation
    // verification.
    assert.equal(
      extractJsonFromOutput(NOISE + 'https://app.multcloud.com/mc_project/task_list'),
      'https://app.multcloud.com/mc_project/task_list'
    );
  });

  it('returns null for empty output', () => {
    assert.equal(extractJsonFromOutput(''), null);
    assert.equal(extractJsonFromOutput(null), null);
  });

  it('throws on genuinely malformed JSON rather than inventing a value', () => {
    assert.throws(() => extractJsonFromOutput(NOISE + '{"a":'), /Failed to parse JSON/);
  });
});

describe('runOpenCli retry policy', () => {
  it('retries a read up to three times', async () => {
    let attempts = 0;
    setTransport(async () => { attempts++; throw new Error('boom'); });
    try {
      await assert.rejects(() => runOpenCli(['browser', 'mc', 'eval', 'x'], { idempotent: true, timeout: 10 }));
      assert.equal(attempts, 3);
    } finally { resetTransport(); }
  });

  it('never retries a mutating call', async () => {
    // A create/run/delete that timed out client-side may already have landed
    // server-side; retrying it submits the mutation twice.
    let attempts = 0;
    setTransport(async () => { attempts++; throw new Error('timeout'); });
    try {
      await assert.rejects(
        () => runOpenCli(['browser', 'mc', 'eval', 'x'], { idempotent: false, timeout: 10 }),
        /not retried: this call mutates remote state/
      );
      assert.equal(attempts, 1);
    } finally { resetTransport(); }
  });

  it('succeeds on a later attempt for a read', async () => {
    let attempts = 0;
    setTransport(async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return { stdout: '{"ok":true}', stderr: '' };
    });
    try {
      const res = await runOpenCli(['browser', 'mc', 'eval', 'x'], { idempotent: true, timeout: 10 });
      assert.deepEqual(extractJsonFromOutput(res.stdout), { ok: true });
    } finally { resetTransport(); }
  });
});

describe('navigateTo', () => {
  it('reaches a route by sidebar click and confirms arrival', async () => {
    const bridge = installFakeBridge(pageRouter({ url: 'https://app.multcloud.com/mc_project/task_list' }));
    try {
      const res = await navigateTo('Cloud Backup', 'https://app.multcloud.com/mc_project/cloud_backup');
      assert.equal(res.ok, true);
      assert.equal(res.method, 'sidebar');
      assert.equal(res.slug, 'cloud_backup');
    } finally { bridge.restore(); }
  });

  it('reports failure when the app does not actually arrive', async () => {
    // Measured live: opening one of these URLs directly leaves the SPA on the
    // route it already held. Silently continuing is how `backup` ended up
    // filling in a form on the task list.
    const bridge = installFakeBridge((record) => {
      if (record.kind === 'open') return { isOpen: true, isLoggedIn: true };
      const s = String(record.payload || '');
      if (s.includes('isLoggedIn')) return { isOpen: true, url: 'https://app.multcloud.com/mc_project/remote_task', isLoggedIn: true };
      if (s.includes('() => location.href')) return 'https://app.multcloud.com/mc_project/remote_task';
      if (s.includes('const wantedSection =')) return { clicked: false };
      return undefined;
    });
    try {
      const res = await navigateTo('Cloud Backup', 'https://app.multcloud.com/mc_project/cloud_backup');
      assert.equal(res.ok, false);
      assert.match(res.error, /expected \/mc_project\/cloud_backup/);
    } finally { bridge.restore(); }
  });

  it('does nothing when already on the target route', async () => {
    const bridge = installFakeBridge(pageRouter({ url: 'https://app.multcloud.com/mc_project/task_list' }));
    try {
      const res = await navigateTo('Task List', 'https://app.multcloud.com/mc_project/task_list');
      assert.equal(res.method, 'already-there');
      assert.equal(bridge.opens().length, 0, 'must not re-open a page it is already on');
    } finally { bridge.restore(); }
  });
});

describe('browser script time budget', () => {
  it('forwards an explicit timeout to the transport', async () => {
    // `evaluate()` accepted an options object and read only `idempotent`, so a
    // caller asking for a longer budget silently got the 30s default. Measured
    // live 2026-08-31: a magnet remote-upload needs longer, because MultCloud
    // resolves torrent metadata after the link is committed. The create died at
    // 32.6s -- and reported no cause at all, so it read as a page defect.
    const bridge = installFakeBridge(pageRouter({
      handlers: [['LONG_RUNNING_MARKER', { ok: true }]]
    }));
    try {
      await evaluate('/* LONG_RUNNING_MARKER */ (() => ({ok:true}))()', { timeout: 120000 });
      const evalCall = bridge.calls.filter(c => c.kind === 'eval').pop();
      assert.equal(evalCall.opts.timeout, 120000);
    } finally { bridge.restore(); }
  });

  it('still defaults to 30s when no budget is asked for', async () => {
    const bridge = installFakeBridge(pageRouter({
      handlers: [['DEFAULT_MARKER', { ok: true }]]
    }));
    try {
      await evaluate('/* DEFAULT_MARKER */ (() => ({ok:true}))()');
      const evalCall = bridge.calls.filter(c => c.kind === 'eval').pop();
      assert.equal(evalCall.opts.timeout, 30000);
    } finally { bridge.restore(); }
  });

  it('says it timed out, and does not dump the whole script as the reason', async () => {
    // What this replaces: "OpenCLI execution failed (not retried: this call
    // mutates remote state): Command failed: opencli browser mc eval (async
    // () => {" followed by 300 lines of the script and NO stated cause. The
    // reader cannot tell a timeout from a rejected page from a crash.
    const hugeScript = '(async () => {\n' + '  // filler\n'.repeat(400) + '})()';
    setTransport(async () => {
      const err = new Error(`Command failed: opencli browser mc eval ${hugeScript}`);
      err.killed = true;          // this is what execFile sets on a timeout
      err.signal = 'SIGTERM';
      throw err;
    });
    try {
      await assert.rejects(
        () => runOpenCli(['browser', 'mc', 'eval', hugeScript], { idempotent: false, timeout: 45000 }),
        (err) => {
          assert.match(err.message, /timed out after 45s/i, 'names the budget it actually used');
          assert.match(err.message, /not retried: this call mutates remote state/);
          assert.ok(err.message.length < 500,
            `the reason must stay readable; got ${err.message.length} chars`);
          return true;
        }
      );
    } finally { resetTransport(); }
  });
});

describe('OpenCLI 2.0 & Cloud VPS transport routing', () => {
  it('rewrites positional session to --session for OpenCLI 2.0', () => {
    assert.deepEqual(
      formatOpenCliArgs(['browser', 'mc', 'eval', '1+1']),
      ['browser', '--session', 'mc', 'eval', '1+1']
    );
    assert.deepEqual(
      formatOpenCliArgs(['browser', 'mc', 'open', 'https://app.multcloud.com']),
      ['browser', '--session', 'mc', 'open', 'https://app.multcloud.com']
    );
  });

  it('honours MULTCLOUD_BACKEND env override', () => {
    const prev = process.env.MULTCLOUD_BACKEND;
    try {
      process.env.MULTCLOUD_BACKEND = 'headless';
      assert.equal(isHeadlessBackendEnabled(), true);
      process.env.MULTCLOUD_BACKEND = 'opencli';
      assert.equal(isHeadlessBackendEnabled(), false);
    } finally {
      if (prev === undefined) delete process.env.MULTCLOUD_BACKEND;
      else process.env.MULTCLOUD_BACKEND = prev;
    }
  });

  it('emits an actionable --vps remedy hint when local OpenCLI bridge is disconnected', async () => {
    setTransport(async () => {
      const err = new Error('Command failed: opencli browser --session mc eval');
      err.stderr = 'Extension is not connected';
      throw err;
    });
    try {
      await assert.rejects(
        () => runOpenCli(['browser', 'mc', 'eval', '1'], { idempotent: false }),
        /Pass --vps \(or set MULTCLOUD_BACKEND=cloud\)/
      );
    } finally { resetTransport(); }
  });
});
