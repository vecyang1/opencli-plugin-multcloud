import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { parseArgs } from '../bin/multcloud.js';
import { TASK_TYPES } from '../src/tasks.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every `multcloud ...` command printed ANYWHERE a human or agent can read it
 * must survive the argument parser.
 *
 * The set this ranges over is the point. A gate named "the docs" that greps one
 * file is a gate that goes green while a second file rots — so this walks every
 * Markdown file in the repo plus the CLI's own `--help` text, and reports how
 * many command strings it graded. A number that drops is a selector that
 * silently narrowed.
 */
function markdownFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * Pull invocations out of text.
 *
 * The character class deliberately accepts capitals, digits, quotes and CJK:
 * a lowercase-only class stops at the first real argument and silently grades a
 * truncated stub, which passes while testing none of the flags.
 */
/**
 * Flags that belong to the OpenCLI host, not to this CLI. A command documented
 * as `opencli multcloud clouds -f json` is correct, and feeding `-f json` to
 * this parser is a category error — the gate was grading the wrong subject.
 */
const HOST_FLAGS = new Set(['-f', '--format', '--trace', '-v', '--verbose']);

function stripHostFlags(raw) {
  const parts = raw.split(/\s+/);
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    if (HOST_FLAGS.has(parts[i])) { i++; continue; }          // flag and its value
    if (/^(?:--format|--trace)=/.test(parts[i])) continue;
    kept.push(parts[i]);
  }
  return kept.join(' ');
}

function extractCommands(text) {
  const found = [];
  const re = /(?:^|\s)(?:\$\s*)?(opencli\s+)?(?:multcloud|mc-cli)\s+([^\n`|;>]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let raw = m[2].trim().replace(/\s+$/, '');
    if (m[1]) raw = stripHostFlags(raw);      // invoked through the OpenCLI host
    if (raw) found.push(raw);
  }
  return found;
}

/** Split a command line into argv, honouring quotes. */
function toArgv(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

const PLACEHOLDER = /^[<[].*[>\]]$/;

describe('Documented-command contract', () => {
  const sources = [];

  for (const file of markdownFiles(ROOT)) {
    sources.push({ label: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') });
  }

  // The skill is the agent-facing copy of this contract and drifts the same way.
  const skill = path.join(process.env.HOME || '', '.agents/skills/multcloud-ops/SKILL.md');
  if (fs.existsSync(skill)) {
    sources.push({ label: 'multcloud-ops/SKILL.md', text: fs.readFileSync(skill, 'utf8') });
  }

  // Grade the RENDERED help, not its source: the source contains template
  // expressions that are not what a user ever sees.
  const renderedHelp = execFileSync('node', [path.join(ROOT, 'bin/multcloud.js'), '--help'], { encoding: 'utf8' });
  sources.push({ label: 'multcloud --help (rendered)', text: renderedHelp });

  const commands = [];
  for (const src of sources) {
    for (const cmd of extractCommands(src.text)) {
      commands.push({ src: src.label, cmd });
    }
  }

  it('finds command strings to grade (guards against a selector that narrowed)', () => {
    assert.ok(commands.length >= 30, `only ${commands.length} documented commands found; the extractor probably stopped matching`);
    console.log(`      graded ${commands.length} documented command strings from ${sources.length} sources`);
  });

  it('every documented command parses', () => {
    const failures = [];
    for (const { src, cmd } of commands) {
      const argv = toArgv(cmd)
        .filter(a => !PLACEHOLDER.test(a))
        .map(a => a.replace(/^--(\w[\w-]*)=<.*>$/, '--$1=1'));
      try {
        parseArgs(argv);
      } catch (err) {
        failures.push(`${src}: "${cmd}" -> ${err.message.split('\n')[0]}`);
      }
    }
    assert.deepEqual(failures, [], `documented commands the parser rejects:\n${failures.join('\n')}`);
  });

  it('every --type value the rendered help advertises is a real filter value', () => {
    const help = execFileSync('node', [path.join(ROOT, 'bin/multcloud.js'), '--help'], { encoding: 'utf8' })
      .replace(/\x1b\[[0-9;]*m/g, '');
    const m = /--type <([^>]+)>/.exec(help);
    assert.ok(m, 'rendered help no longer documents --type');
    const advertised = m[1].split('|').map(v => v.trim()).filter(Boolean);
    assert.ok(advertised.length > 0, 'no --type values advertised');
    for (const value of advertised) {
      assert.ok(TASK_TYPES.includes(value),
        `help advertises --type ${value}, which is not one of ${TASK_TYPES.join(', ')}`);
    }
    console.log(`      --type advertises: ${advertised.join(', ')}`);
  });

  it('every flag the dispatcher reads is a flag the parser can set', () => {
    const bin = fs.readFileSync(path.join(ROOT, 'bin/multcloud.js'), 'utf8');
    const body = bin.slice(bin.indexOf('async function main('));
    const read = new Set([...body.matchAll(/flags\.([A-Za-z][A-Za-z0-9]*)/g)].map(m => m[1]));

    const settable = new Set();
    for (const argv of [
      ['--json'], ['--raw'], ['--realtime'], ['--twoway'], ['--one-time'], ['--recurring'],
      ['--yes'], ['--help'], ['--status', 'x'], ['--type', 'transfer'], ['--query', 'x'],
      ['--cloud', 'x'], ['--path', 'x'], ['--name', 'x'], ['--interval', '1'],
      ['--max-wait', '1'], ['--limit', '1'], ['--once'], ['--vps'], ['--max-retries', '1'],
      ['--stalled-timeout', '1']
    ]) {
      Object.keys(parseArgs(argv).flags).forEach(k => settable.add(k));
    }

    const unreachable = [...read].filter(k => !settable.has(k));
    assert.deepEqual(unreachable, [], `dispatcher reads flags the parser never sets: ${unreachable.join(', ')}`);
  });
});
