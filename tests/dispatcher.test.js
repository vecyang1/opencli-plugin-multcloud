import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from '../bin/multcloud.js';

const execFileAsync = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'multcloud.js');

/**
 * These run the REAL binary. Every P0 defect in this CLI lived in the wiring
 * between `bin/` and `src/`, which is exactly the seam no unit test touched —
 * the original suite imported `src/` modules directly and never executed the
 * entry point at all.
 *
 * They need no browser: they exercise argument handling and the failure paths,
 * which is where the wiring bugs were.
 */
async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [BIN, ...args], {
      env: { ...process.env, MULTCLOUD_HOME: process.env.MULTCLOUD_HOME }
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('CLI entry point', () => {
  it('prints help and exits 0', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(plain(r.stdout), /USAGE:/);
  });

  it('rejects an unknown flag instead of silently ignoring it', async () => {
    // `--statuss Failure` used to list every task and exit 0.
    const r = await run(['tasks', '--statuss', 'Failure']);
    assert.equal(r.code, 2);
    assert.match(plain(r.stderr), /Unknown option "--statuss"/);
  });

  it('rejects a flag that is missing its value', async () => {
    const r = await run(['tasks', '--status']);
    assert.equal(r.code, 2);
    assert.match(plain(r.stderr), /requires a value/);
  });

  it('rejects a non-numeric value for a numeric flag', async () => {
    const r = await run(['tasks', 'watch', 'x', '--interval', 'soon']);
    assert.equal(r.code, 2);
    assert.match(plain(r.stderr), /expects a number/);
  });

  it('exits non-zero on an unknown command', async () => {
    const r = await run(['definitely-not-a-command']);
    assert.notEqual(r.code, 0);
  });

  it('refuses a task delete without --yes, before touching the network', async () => {
    // The refusal must be a usage error, not an auth or bridge error: a
    // confirmation gate that first opens a browser has already paid the cost
    // of the thing it is refusing to do.
    const r = await run(['tasks', 'delete', 'anything']);
    assert.notEqual(r.code, 0);
    assert.match(plain(r.stderr), /requires explicit confirmation/);
  });

  it('refuses an explorer delete without --yes', async () => {
    // This path had no confirmation gate at all, while deleting real cloud files.
    const r = await run(['explorer', 'delete', 'SomeCloud', '/', 'file.txt']);
    assert.notEqual(r.code, 0);
    assert.match(plain(r.stderr), /requires explicit confirmation/);
  });

  it('reports missing positional arguments as usage errors', async () => {
    for (const args of [['transfer', 'only-one'], ['sync', 'only-one'], ['backup', 'only-one'], ['remote-upload']]) {
      const r = await run(args);
      assert.notEqual(r.code, 0, `${args.join(' ')} should fail`);
      assert.match(plain(r.stderr), /Usage:/);
    }
  });
});

describe('parseArgs', () => {
  it('parses --interval, which the dispatcher read but the parser never set', () => {
    assert.equal(parseArgs(['tasks', 'watch', 'x', '--interval', '30']).flags.interval, 30);
    assert.equal(parseArgs(['tasks', 'watch', 'x', '--interval=45']).flags.interval, 45);
  });

  it('parses --twoway, which no CLI flag could previously reach', () => {
    assert.equal(parseArgs(['sync', 'a', 'b', '--twoway']).flags.twoway, true);
  });

  it('keeps -- passthrough intact for names that look like flags', () => {
    const { positional } = parseArgs(['tasks', 'run', '--', '--weird-name']);
    assert.deepEqual(positional, ['tasks', 'run', '--weird-name']);
  });

  it('does not leak a flag value into the positional list', () => {
    const { positional } = parseArgs(['tasks', 'watch', 'X', '--interval', '30']);
    assert.deepEqual(positional, ['tasks', 'watch', 'X']);
  });
});
