import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'vm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jsv } from '../src/client.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The escaping the code used before: single quotes only. */
const legacyEscape = (v) => "'" + String(v).replace(/'/g, "\\'") + "'";

/**
 * Byte-faithful to how these scripts are actually built: the value is assigned
 * on its own line, so a trailing `//` comments out only that line's remainder
 * and every following line still executes.
 */
function emit(encoded) {
  return [
    '(async () => {',
    '    const target = ' + encoded + ';',
    '    return { seen: target };',
    '  })()'
  ].join('\n');
}

const BREAKOUT = String.raw`\'; g.PWNED = 1; //`;

describe('Browser-script value encoding', () => {
  it('the legacy escaping really did execute injected code (guards the fix)', () => {
    // If this ever stops being true the exploit fixture has gone stale and the
    // test below is no longer evidence of anything.
    const ctx = vm.createContext({ g: {} });
    vm.runInContext(emit(legacyEscape(BREAKOUT)), ctx);
    assert.equal(ctx.g.PWNED, 1, 'the legacy pattern should demonstrate the vulnerability');
  });

  it('jsv renders the breakout payload inert', async () => {
    const ctx = vm.createContext({ g: {} });
    // The emitted IIFE is async, so its value arrives as a cross-realm promise.
    const out = await vm.runInContext(emit(jsv(BREAKOUT)), ctx);
    assert.equal(ctx.g.PWNED, undefined, 'injected code executed');
    assert.equal(out.seen, BREAKOUT, 'payload must survive as plain data');
  });

  for (const [label, payload] of Object.entries({
    'lone backslash': '\\',
    'trailing backslash': 'name\\',
    'raw newline': 'a\nb',
    'carriage return': 'a\rb',
    'double quote': 'say "hi"',
    'template interpolation': 'x${g.PWNED=1}y',
    'closing script tag': '</script><script>g.PWNED=1</script>',
    'CJK and brackets': '【高清剧集网】鱿鱼游戏[全7集] "Squid"',
    'line separator U+2028': 'a b',
    'null-ish': ''
  })) {
    it(`round-trips exactly: ${label}`, async () => {
      const ctx = vm.createContext({ g: {} });
      const out = await vm.runInContext(emit(jsv(payload)), ctx);
      assert.equal(out.seen, payload);
      assert.equal(ctx.g.PWNED, undefined);
    });
  }

  it('undefined becomes null rather than the identifier `undefined`', () => {
    assert.equal(jsv(undefined), 'null');
  });
});

describe('No module still uses the legacy escaping', () => {
  it('src/ contains no single-quote-only escape of an interpolated value', () => {
    const offenders = [];
    for (const file of fs.readdirSync(SRC)) {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      // Ignore the explanatory comment in client.js that quotes the old idiom.
      const code = text.split('\n').filter(l => !/^\s*\*/.test(l)).join('\n');
      if (/\.replace\(\/'\/g,\s*"\\\\'"\)/.test(code)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `these modules still build JS with the unsafe escape: ${offenders.join(', ')}`);
  });

  it('grades every module in src/ (guards against an empty denominator)', () => {
    const count = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).length;
    assert.ok(count >= 10, `expected the full module set, saw ${count}`);
    console.log(`      scanned ${count} modules in src/`);
  });
});
