import './harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A backslash inside a template literal is consumed by the TEMPLATE, not by the
 * page that receives it.
 *
 * Every browser script this CLI sends is built with a template literal, so an
 * escape written the way it would be written in ordinary code silently changes
 * meaning on the way out. Two shipped that way on 2026-08-31 and both produced
 * a *plausible* wrong answer rather than an error:
 *
 *   /\btr-click\b/       -> /<backspace>tr-click<backspace>/   matched nothing,
 *                           so a row the CLI had just selected was reported as
 *                           never selected and `sync` refused to create a task.
 *   /^Delete\(\d+\)$/    -> /^Delete(d+)$/                     matched nothing,
 *                           so an open, correct delete-confirmation dialog was
 *                           reported as having no confirm button.
 *
 * The first is catchable by scanning the emitted text for control characters
 * (`tests/scripts.test.js` does). The second is not: `\(` becomes `(`, which is
 * printable, valid, and wrong. The only place it is decidable is here, in the
 * source, before the template runs.
 *
 * Rule: inside template-literal TEXT, only escapes whose eaten form means the
 * SAME THING are allowed. `\n`, `\r`, `\t` survive being eaten (a regex `\n` and a
 * literal newline match identically, and most of these templates are ordinary
 * Node-side messages where a real newline is the point). `\\`, backtick and `$`
 * are the template's own escapes, and `\"` / `\'` land inside a quoted string in
 * the emitted script. Everything else — `\b`, `\d`, `\s`, `\w`, `\/`, `\(`, `\.`,
 * `\+` and friends — changes meaning when the template eats it and must be
 * written doubled. Text inside `${...}` is ordinary JavaScript and is not
 * scanned.
 */

const SRC_DIR = path.join(import.meta.dirname, '..', 'src');
// Escapes whose template-eaten form is equivalent, plus the template's own.
const ALLOWED_AFTER_BACKSLASH = new Set(['\\', '`', '$', 'n', 'r', 't', '"', "'", '\n']);

/**
 * Report every offending backslash inside template-literal text.
 *
 * Deliberately small: it tracks strings, comments and templates (including
 * `${}` nesting) and treats `/` as division. A regex literal containing a
 * backtick would confuse it; none exists in this codebase, and a false positive
 * here is a comment away from being fixed, while a false negative is a shipped
 * silent bug.
 */
export function scanTemplateEscapes(source) {
  const offenders = [];
  const stack = [];            // 'template' | 'expr'
  let i = 0;
  let line = 1;
  let mode = 'code';           // code | sq | dq | line-comment | block-comment

  const inTemplateText = () => stack.length > 0 && stack[stack.length - 1] === 'template';

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') line++;

    if (mode === 'line-comment') { if (ch === '\n') mode = 'code'; i++; continue; }
    if (mode === 'block-comment') { if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; } i++; continue; }
    if (mode === 'sq' || mode === 'dq') {
      if (ch === '\\') { i += 2; continue; }
      if ((mode === 'sq' && ch === "'") || (mode === 'dq' && ch === '"')) mode = 'code';
      i++;
      continue;
    }

    if (inTemplateText()) {
      if (ch === '\\') {
        if (!ALLOWED_AFTER_BACKSLASH.has(next)) {
          const from = Math.max(0, i - 55);
          offenders.push({ line, sequence: `\\${next}`, context: source.slice(from, i + 25).replace(/\n/g, ' ') });
        }
        i += 2;
        continue;
      }
      if (ch === '`') { stack.pop(); i++; continue; }
      if (ch === '$' && next === '{') { stack.push('expr'); i += 2; continue; }
      i++;
      continue;
    }

    // ordinary code (top level, or inside a ${} expression)
    if (ch === '/' && next === '/') { mode = 'line-comment'; i += 2; continue; }
    if (ch === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }
    if (ch === "'") { mode = 'sq'; i++; continue; }
    if (ch === '"') { mode = 'dq'; i++; continue; }
    if (ch === '`') { stack.push('template'); i++; continue; }
    if (ch === '}' && stack.length && stack[stack.length - 1] === 'expr') { stack.pop(); i++; continue; }
    if (ch === '{' && stack.length && stack[stack.length - 1] === 'expr') { stack.push('expr'); i++; continue; }
    i++;
  }
  return offenders;
}

/**
 * A backtick inside a COMMENT that sits inside a template literal closes the
 * template.
 *
 * This is the sibling of the escape bug above and it has now bitten this repo
 * three times, always the same way: an explanatory comment is written inside a
 * browser script and names a selector or a command in backticks, exactly as it
 * would be written anywhere else in the file.
 *
 *     const js = `(() => {
 *       // the commit button is `button.saveCloud`      <- template ends HERE
 *     })()`;
 *
 * Usually that is a SyntaxError, which is loud. It does not have to be: an even
 * number of backticks on the line can close and reopen the template and leave a
 * file that parses and emits a script with the comment's content spliced into
 * it as code. The scanner above cannot see this — a backtick in template text
 * is exactly how a template legitimately ends — so this is a separate check.
 *
 * Only comment-shaped lines are considered (a line whose first non-space
 * characters are `//`, `/*` or a continuation `*`). A bare `//` inside template
 * text is ordinarily a URL, and those are left alone.
 */
export function scanTemplateCommentBackticks(source) {
  const offenders = [];
  const lines = source.split('\n');
  let depth = 0;              // template nesting, counted crudely
  let inBlockComment = false;

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const trimmed = raw.trim();
    const looksLikeComment = trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');

    if (depth > 0 && looksLikeComment && raw.includes('`')) {
      offenders.push({ line: n + 1, context: trimmed.slice(0, 90) });
    }

    // Track template depth on non-comment lines only; a comment line's own
    // backticks are the bug being reported, not a real delimiter.
    if (!looksLikeComment && !inBlockComment) {
      for (const ch of raw) {
        if (ch === '`') depth = depth > 0 ? depth - 1 : 1;
      }
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) inBlockComment = true;
    if (inBlockComment && trimmed.includes('*/')) inBlockComment = false;
  }
  return offenders;
}

describe('template-literal escaping', () => {
  it('no source file lets a template eat an escape meant for the browser', () => {
    const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js')).sort();
    assert.ok(files.length >= 10, `expected the whole src/ tree, saw ${files.length} file(s)`);

    const report = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      for (const o of scanTemplateEscapes(source)) {
        report.push(`src/${file}:${o.line}  "${o.sequence}"  …${o.context}…`);
      }
    }
    assert.deepEqual(report, [],
      `backslashes inside template literals that the template will consume:\n\n${report.join('\n')}\n\n` +
      'Double them (\\\\d, \\\\s, \\\\b) or rewrite without an escape.');
    console.log(`      scanned ${files.length} source files for template-eaten escapes`);
  });

  it('no comment inside a browser script closes its template with a backtick', () => {
    const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js')).sort();
    assert.ok(files.length >= 10, `expected the whole src/ tree, saw ${files.length} file(s)`);

    const report = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      for (const o of scanTemplateCommentBackticks(source)) {
        report.push(`src/${file}:${o.line}  ${o.context}`);
      }
    }
    assert.deepEqual(report, [],
      `backticks in comments inside template literals (these END the template):\n\n${report.join('\n')}\n\n` +
      'Quote the selector with " instead, or move the explanation to module scope.');
    console.log(`      scanned ${files.length} source files for template-closing comment backticks`);
  });

  it('the scanner itself catches both shipped instances', () => {
    const backspace = 'const js = `(() => /\\btr-click\\b/.test(x))`;';
    const paren = 'const js = `(() => /^Delete\\(\\d+\\)$/.test(t))`;';
    const safe = 'const js = `(() => /\\\\s+/.test(x) + `never`)`;';

    assert.equal(scanTemplateEscapes(backspace).length, 2, 'missed the \\b pair');
    assert.equal(scanTemplateEscapes(paren).length, 3, 'missed the \\( \\d \\) escapes');
    assert.deepEqual(scanTemplateEscapes(safe), [], 'flagged a correctly doubled escape');
  });

  it('ignores ordinary code, comments and quoted strings', () => {
    const sample = [
      'const re = /\\d+/;',                       // plain code: fine
      '// a comment with \\d in it',
      "const s = 'a \\d string';",
      'const t = `text ${ /\\d/.test(x) } more`;' // inside ${}: ordinary code
    ].join('\n');
    assert.deepEqual(scanTemplateEscapes(sample), []);
  });
});
