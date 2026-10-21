#!/usr/bin/env node
/**
 * Capture real bridge traffic into `tests/fixtures/`, so the offline suite is
 * graded against bytes the live page actually produced rather than against a
 * tidied-up idea of them.
 *
 * Read-only by design: it refuses any command that mutates remote state.
 *
 *   node tests/harness/record.js tasks clouds account shares
 *
 * Re-run it when MultCloud's markup changes and a fixture-backed test starts
 * disagreeing with reality.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTransport, resetTransport, runOpenCli } from '../../src/client.js';
import { scrub } from './scrub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'fixtures');

const READ_ONLY = {
  tasks:   async () => (await import('../../src/tasks.js')).listTasks(),
  clouds:  async () => (await import('../../src/clouds.js')).listClouds(),
  account: async () => (await import('../../src/account.js')).getAccountInfo(),
  shares:  async () => (await import('../../src/shares.js')).listShares(),
  drives:  async () => (await import('../../src/explorer.js')).listDrives()
};

async function main() {
  const wanted = process.argv.slice(2).filter(Boolean);
  const targets = wanted.length ? wanted : Object.keys(READ_ONLY);

  for (const name of targets) {
    if (!READ_ONLY[name]) {
      console.error(`refusing "${name}": only read-only captures are supported (${Object.keys(READ_ONLY).join(', ')})`);
      process.exit(2);
    }
  }

  fs.mkdirSync(OUT, { recursive: true });

  for (const name of targets) {
    const traffic = [];
    // Wrap, do not replace: we want the real answers AND a transcript of them.
    const recorder = async (args, opts) => {
      resetTransport();
      let res;
      try {
        res = await runOpenCli(args, opts);
      } finally {
        setTransport(recorder);
      }
      traffic.push({ kind: args[2], payload: args[3] ?? null, stdout: res.stdout });
      return res;
    };
    setTransport(recorder);

    try {
      const result = await READ_ONLY[name]();
      const file = path.join(OUT, `${name}.json`);

      // `rawItem` is the entire page model; keeping it would make the fixture
      // 100 KB of noise nobody reviews.
      const lean = JSON.parse(JSON.stringify(result, (k, v) => (k === 'rawItem' ? undefined : v)));
      const payload = { capturedFor: name, capturedBy: 'tests/harness/record.js', scrubbed: true, traffic, result: lean };
      fs.writeFileSync(file, scrub(JSON.stringify(payload, null, 2)));
      console.log(`captured ${name}: ${traffic.length} bridge call(s) -> ${path.relative(process.cwd(), file)}`);
    } catch (err) {
      console.error(`capture failed for ${name}: ${err.message}`);
    } finally {
      resetTransport();
    }
  }
}

/*
 * Only when RUN as a script.
 *
 * `tests/fixtures.test.js` imports `scrub` from this file, and an unguarded
 * `main()` turned that import into a full recording run: the "hermetic" offline
 * suite opened the live MultCloud session, issued real bridge calls, and
 * overwrote all five committed fixtures on every `npm test`. That also made
 * every fixture-backed assertion a tautology — the inputs were regenerated from
 * the code under test, during the run that graded it.
 */
const invokedAsScript = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) main();
