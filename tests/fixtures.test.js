import { SANDBOX_HOME, realHomeAliasFile, realAliasFingerprint, FIXTURE_FINGERPRINT, fixtureFingerprint } from './harness/sandbox.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { aliasFile } from '../src/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

/**
 * Two guarantees, asserted in both directions because they fail at different
 * times: that the sandbox is actually in effect (the cause), and that the real
 * files were never touched (the symptom, which is only visible after damage).
 */
describe('Test isolation', () => {
  const before_ = realAliasFingerprint();

  it('MULTCLOUD_HOME points at a disposable directory, not the real one', () => {
    assert.equal(process.env.MULTCLOUD_HOME, SANDBOX_HOME);
    assert.ok(SANDBOX_HOME.startsWith(os.tmpdir()), `sandbox is not under the temp dir: ${SANDBOX_HOME}`);
  });

  it('the alias path resolver follows the sandbox', () => {
    assert.equal(aliasFile(), path.join(SANDBOX_HOME, 'aliases.json'));
    assert.notEqual(aliasFile(), realHomeAliasFile());
  });

  it('no test file imports a harness script that runs on import', () => {
    // The cause, checked statically, because the symptom is a race: the write
    // lands after the assertion that would have seen it. `record.js` calls
    // `main()` at module scope, so importing it for one helper made every
    // `npm test` open the live browser and rewrite all five fixtures — and the
    // fixture-backed gates then graded the code against output produced by the
    // same run. `scrub()` now lives in a side-effect-free module.
    const RUNS_ON_IMPORT = ['harness/record.js'];
    const offenders = [];
    let graded = 0;
    const files = [
      ...fs.readdirSync(HERE).filter(f => f.endsWith('.test.js')).map(f => path.join(HERE, f)),
      ...(fs.existsSync(path.join(HERE, 'live'))
        ? fs.readdirSync(path.join(HERE, 'live')).filter(f => f.endsWith('.test.js')).map(f => path.join(HERE, 'live', f))
        : [])
    ];
    for (const full of files) {
      graded++;
      const text = fs.readFileSync(full, 'utf8');
      for (const script of RUNS_ON_IMPORT) {
        // Import statements only. Matching any mention makes this file flag
        // itself for naming the script in a comment, and the obvious fix —
        // excluding this file — carves out the one file guaranteed to talk
        // about it.
        const imported = new RegExp(`(?:from|import\\()\\s*['"][^'"]*${script.replace('/', '\\/').replace('.', '\\.')}['"]`);
        if (imported.test(text)) offenders.push(`${path.relative(HERE, full)} -> ${script}`);
      }
    }
    assert.deepEqual(offenders, [], `test files importing a script with a top-level entry point:\n${offenders.join('\n')}`);
    console.log(`      graded ${graded} test files for imports of run-on-import scripts`);
  });

  it('the real alias registry is untouched by the suite', () => {
    // ~/.multcloud/aliases.json holds live task labels. A test that writes
    // there corrupts the user's own data, and nothing would report it.
    assert.equal(realAliasFingerprint(), before_);
  });

  after(() => {
    // Belt and braces for any OTHER writer: checked last, so a write that
    // lands mid-suite is still visible. `node --test` runs each file in its own
    // process, so this only sees writes caused by this file.
    assert.equal(fixtureFingerprint(), FIXTURE_FINGERPRINT,
      'the offline suite wrote to tests/fixtures/ — fixtures are inputs, not output');
  });

  it('every test file imports the sandbox before anything from src/', () => {
    // Ordering, not presence: a file that imports src/ first is not sandboxed,
    // and under an alphabetical runner it passes anyway because some earlier
    // file did the scrub for everyone.
    const offenders = [];
    let graded = 0;
    const candidates = [
      ...fs.readdirSync(HERE).filter(f => f.endsWith('.test.js')).map(f => path.join(HERE, f)),
      ...(fs.existsSync(path.join(HERE, 'live')) ? fs.readdirSync(path.join(HERE, 'live')).filter(f => f.endsWith('.test.js')).map(f => path.join(HERE, 'live', f)) : [])
    ];
    for (const full of candidates) {
      const file = path.relative(HERE, full);
      graded++;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      const sandboxAt = lines.findIndex(l => /from '\.\.?\/(tests\/)?harness\/sandbox\.js'|harness\/sandbox\.js'/.test(l));
      const srcAt = lines.findIndex(l => /from '\.\.\/src\//.test(l));
      if (srcAt !== -1 && (sandboxAt === -1 || sandboxAt > srcAt)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `test files that import src/ before the sandbox: ${offenders.join(', ')}`);
    console.log(`      graded ${graded} test files for sandbox-import ordering`);
  });
});

describe('Committed fixtures carry no account data', () => {
  const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')) : [];

  it('there are fixtures to grade', () => {
    assert.ok(files.length >= 3, `expected captured fixtures, found ${files.length}`);
    console.log(`      graded ${files.length} fixture files`);
  });

  it('no identifier-length hex run survives that is not synthetic', () => {
    // Runs of >= 32 hex, NOT `\\b[0-9a-f]{32}\\b`. The word-boundary version
    // could not see a 40-character BitTorrent infohash inside
    // `magnet:?xt=urn:btih:...`, and one sat in the committed `tasks.json`
    // naming a torrent this account had fetched. A gate whose selector is
    // narrower than the claim it makes is the failure this whole file exists
    // to prevent.
    const leaks = [];
    let graded = 0;
    for (const f of fs.readdirSync(FIXTURES).filter(n => n.endsWith('.json'))) {
      graded++;
      const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
      for (const id of text.match(/[0-9a-f]{32,}/gi) || []) {
        if (!id.toLowerCase().startsWith('fake')) leaks.push(`${f}: ${id.length} hex chars starting ${id.slice(0, 6)}…`);
      }
    }
    assert.deepEqual(leaks, [], `unscrubbed identifiers in committed fixtures:\n${leaks.join('\n')}`);
    console.log(`      graded ${graded} fixture files for identifier-length hex runs`);
  });

  it('no real email address survives', () => {
    const leaks = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
      for (const addr of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
        if (!addr.endsWith('example.invalid')) leaks.push(`${f}: ${addr}`);
      }
    }
    assert.deepEqual([...new Set(leaks)], [], `unredacted addresses in fixtures:\n${leaks.join('\n')}`);
  });

  it('the scrubber actually replaces identifiers (guards against a no-op scrub)', async () => {
    const { scrub } = await import('./harness/scrub.js');
    // A synthetic sample, never a real identifier: a scanner that spells a live
    // credential literally puts one in the repo to prove it removes them.
    const synthetic = '0123456789abcdef'.repeat(2);            // 32 hex
    const infohash = 'abcdef0123456789'.repeat(2) + '0123456789';  // 40 hex, as a magnet carries
    const out = scrub(`{"id":"${synthetic}","src":"magnet:?xt=urn:btih:${infohash}","mail":"a.b@somewhere.example.com"}`);

    assert.doesNotMatch(out, new RegExp(synthetic));
    assert.doesNotMatch(out, new RegExp(infohash, 'i'),
      'a 40-hex infohash survived — this is exactly what shipped in tasks.json');
    assert.match(out, /fakex+1/);
    assert.match(out, /redacted@example\.invalid/);

    // Replacements preserve length and are not themselves identifier-shaped.
    assert.equal((out.match(/[0-9a-f]{32,}/gi) || []).length, 0,
      'the scrubber\'s own output contains an identifier-length hex run');
  });
});
