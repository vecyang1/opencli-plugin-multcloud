import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { globSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const files = (pat) => globSync(pat, { cwd: ROOT });

/**
 * The denominator gate: which half of this product does the suite execute?
 *
 * The defect this exists to prevent is not a bug in any one function; it is the
 * SHAPE of a suite. The handover build shipped 20 tests that called 9 read
 * functions 34 times and write functions ZERO times, and never executed the CLI
 * as a process. Every one of the 6 untested write paths turned out to be broken
 * (all four creates, both deletes); every exercised read path worked. That is
 * not luck -- an unexecuted path has no feedback signal, so selectors written
 * against a page nobody loaded are guesses that nothing corrects.
 *
 * Reads are cheap and safe to exercise; writes are expensive and destructive,
 * so effort drifts to reads unless something counts. Nothing about a green run
 * distinguishes "covers everything" from "covers only the half that cannot
 * lie". This counts, and prints what it counted, so a selector that silently
 * narrows later shows up as a number that dropped.
 */

// A function whose NAME looks like a mutation but which only reads. Each entry
// must carry the reason, and `the allowlist has not gone stale` proves every
// name here still exists -- otherwise a rename quietly shrinks the denominator.
const READ_ONLY_DESPITE_THE_NAME = {
  runDoctor: 'diagnostics only: probes the bridge and reads the page, writes nothing',
  runOpenCli: 'the transport itself; idempotency is its argument, not its behaviour',
  setTransport: 'test seam, in-process only; never reaches the network',
  createBuilderTask:
    'the shared engine, reached only through its four wrappers (createTransfer, ' +
    'createSync, createBackup, createRemoteUpload) -- each of which this gate ' +
    'requires a hermetic test for'
};

const MUTATION_SHAPED = /^(create|delete|rename|run|retry|submit|update|set|write|purge)/;

function exportedFunctions() {
  const found = {};
  for (const f of [...files('src/*.js'), 'bin/multcloud.js']) {
    const src = read(f);
    // Both shapes, or the extractor silently reads half the file: a lossy
    // subject list is invisible from the assertion's side.
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) found[m[1]] = f;
    for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g)) found[m[1]] = f;
  }
  return found;
}

const hermeticSources = files('tests/*.test.js').map(read).join('\n');

describe('suite shape: the half that can lie', () => {
  test('every mutating export is exercised by a hermetic test', () => {
    const exports = exportedFunctions();
    const mutating = Object.entries(exports).filter(([n]) => MUTATION_SHAPED.test(n));

    // An extractor that finds nothing passes every assertion below it.
    assert.ok(
      Object.keys(exports).length >= 30,
      `inconclusive: found only ${Object.keys(exports).length} exports; the extractor is broken`
    );
    assert.ok(
      mutating.length >= 10,
      `inconclusive: found only ${mutating.length} mutation-shaped exports`
    );

    const unexercised = mutating.filter(([n]) =>
      !READ_ONLY_DESPITE_THE_NAME[n] &&
      !new RegExp(`\\b${n}\\s*\\(`).test(hermeticSources)
    );

    assert.deepEqual(
      unexercised.map(([n, f]) => `${n} (${f})`),
      [],
      'These mutate remote state and no hermetic test calls them. Add a test, or ' +
      'add the name to READ_ONLY_DESPITE_THE_NAME with the reason it only reads.'
    );

    const graded = mutating.length - Object.keys(READ_ONLY_DESPITE_THE_NAME).length;
    console.log(
      `      graded ${graded} mutating exports across ${Object.keys(exports).length} exports ` +
      `in ${files('src/*.js').length + 1} modules`
    );
  });

  test('the allowlist has not gone stale', () => {
    const exports = exportedFunctions();
    const vanished = Object.keys(READ_ONLY_DESPITE_THE_NAME).filter(n => !exports[n]);
    assert.deepEqual(vanished, [],
      'Allowlisted names no longer exported. A rename must not silently drop a ' +
      'function out of the denominator.');
  });

  test('the suite executes the real CLI as a process, not only its modules', () => {
    // A mock at the boundary erases the property under test: argument parsing,
    // exit codes and unknown-flag rejection are only observable from outside.
    // Exclude this file: it names those APIs in order to search for them, so
    // counting itself would make the check unable to say no.
    //
    // Match an IMPORT of the spawn API and a reference to the binary, not a
    // mention of either. Measured 2026-08-31: a comment in client.test.js
    // reading "this is what execFile sets on a timeout" was counted as a third
    // spawner. Nothing broke -- the two real ones still passed the assertion --
    // but the printed count is the evidence this gate offers, and a count that
    // includes prose can stay green after the last real spawner is deleted.
    const spawners = files('tests/*.test.js')
      .filter(f => !f.endsWith('coverage-shape.test.js'))
      .filter(f => {
        const src = read(f);
        const importsSpawn = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(src);
        // ...and actually launches something as `node <args>`. Written this way
        // because the two real spawners disagree on spelling: contract.test.js
        // calls execFileSync('node', ...) and dispatcher.test.js calls a
        // promisified execFileAsync('node', ...), so keying on the function
        // name found neither.
        const launchesNode = /\(\s*['"]node['"]\s*,/.test(src);
        return importsSpawn && launchesNode;
      });
    assert.ok(spawners.length >= 1,
      'No hermetic test runs bin/multcloud.js as a process. Module-level tests ' +
      'cannot see wiring, argv parsing, or exit codes.');
    console.log(`      ${spawners.length} test file(s) execute the real binary: ${spawners.join(', ')}`);
  });
});
