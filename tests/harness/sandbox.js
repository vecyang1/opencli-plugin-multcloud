/**
 * The ONE owner of test isolation. Every test file must import this FIRST,
 * before importing anything from `src/`.
 *
 * Why one owner and not a per-file `mkdtemp`: `src/paths.js` reads
 * `MULTCLOUD_HOME` when it is called, but a module that captured it at import
 * time would bind whichever value the first-loaded test file happened to set.
 * Node's module cache makes this file run exactly once per process, so every
 * test sees the same sandbox.
 *
 * Note the direction: `MULTCLOUD_HOME` is a LOCATION, not a credential. Unsetting
 * it does not mean "use nothing", it means "use ~/.multcloud" — i.e. the
 * developer's real alias registry, which currently holds 17 live entries. So it
 * is SET to a disposable directory, never deleted.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multcloud-test-'));

process.env.MULTCLOUD_HOME = root;

export const SANDBOX_HOME = root;

export function realHomeAliasFile() {
  return path.join(os.homedir(), '.multcloud', 'aliases.json');
}

/** Snapshot of the real alias file, so a test can prove it was never touched. */
export function realAliasFingerprint() {
  const f = realHomeAliasFile();
  if (!fs.existsSync(f)) return 'absent';
  const stat = fs.statSync(f);
  return `${stat.size}:${stat.mtimeMs}`;
}

process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

/**
 * Fingerprint of the committed fixture directory, taken at import.
 *
 * The offline suite must not write here. It did: `tests/fixtures.test.js`
 * imports `scrub` from `record.js`, whose `main()` ran on import, so every
 * `npm test` opened the live browser and rewrote all five fixtures — making the
 * fixture-backed gates grade the code against output the same run had just
 * produced. Same shape as the alias guard above: assert the cause and the
 * symptom, because they become visible at different moments.
 */
export function fixtureFingerprint() {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
  if (!fs.existsSync(dir)) return 'absent';
  return fs.readdirSync(dir).sort().map(f => {
    const st = fs.statSync(path.join(dir, f));
    return `${f}:${st.size}:${st.mtimeMs}`;
  }).join('|');
}

export const FIXTURE_FINGERPRINT = fixtureFingerprint();
