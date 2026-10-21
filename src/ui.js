/**
 * Terminal UI formatting utilities (colors, tables, status badges).
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

export function colorize(text, color) {
  return `${colors[color] || ''}${text}${colors.reset}`;
}

export function formatStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return `${colors.green}● Success${colors.reset}`;
    case 'failure':
    case 'failed':
      return `${colors.red}✖ Failure${colors.reset}`;
    case 'syncing':
      return `${colors.cyan}↻ Syncing${colors.reset}`;
    case 'transferring':
      return `${colors.blue}➔ Transferring${colors.reset}`;
    case 'paused':
      return `${colors.yellow}⏸ Paused${colors.reset}`;
    case 'partial success':
      return `${colors.yellow}◐ Partial${colors.reset}`;
    case 'active':
      return `${colors.green}✔ Active${colors.reset}`;
    default:
      return `${colors.dim}○ ${status || 'Unknown'}${colors.reset}`;
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(text) {
  return String(text ?? '').replace(ANSI, '').length;
}

/**
 * Truncate to `limit` visible characters, preserving ANSI colour codes and
 * closing them so the rest of the row is not painted.
 */
export function truncateVisible(text, limit) {
  const str = String(text ?? '');
  if (visibleLength(str) <= limit) return str;
  if (limit <= 1) return '…';

  let out = '';
  let visible = 0;
  let hadAnsi = false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (match) { out += match[0]; hadAnsi = true; i += match[0].length - 1; continue; }
    }
    if (visible >= limit - 1) break;
    out += str[i];
    visible++;
  }
  return out + '…' + (hadAnsi ? '\x1b[0m' : '');
}

/**
 * Render a table that fits the terminal.
 *
 * Untruncated rows wrapped to 300+ characters on a real task list, which made
 * the output unreadable. Columns are capped proportionally to the widest ones.
 */
export function printTable(headers, rows, options = {}) {
  if (rows.length === 0) {
    console.log(colorize('  (No records found)', 'dim'));
    return;
  }

  const terminalWidth = options.maxWidth
    || (process.stdout.isTTY ? process.stdout.columns : 0)
    || 160;
  const budget = Math.max(40, terminalWidth - 2 - (headers.length - 1) * 2);

  let widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => visibleLength(r[i])))
  );

  // Shave the widest column repeatedly until the row fits. Narrow columns
  // (status, index) are never sacrificed for a wide free-text one.
  let total = widths.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (total > budget && guard++ < 10000) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 6) break;
    widths[widest] -= 1;
    total -= 1;
  }

  // Header
  const headerStr = headers.map((h, i) => truncateVisible(h, widths[i]).padEnd(widths[i])).join('  ');
  console.log(colorize(`  ${headerStr}`, 'bright'));
  console.log(colorize(`  ${widths.map(w => '─'.repeat(w)).join('  ')}`, 'dim'));

  // Rows
  for (const row of rows) {
    const rowStr = row.map((cell, i) => {
      const clipped = truncateVisible(cell, widths[i]);
      const pad = ' '.repeat(Math.max(0, widths[i] - visibleLength(clipped)));
      return `${clipped}${pad}`;
    }).join('  ');
    console.log(`  ${rowStr}`);
  }
}

/**
 * Print aggregate warnings to stderr, so `--json` and `--csv` pipes stay clean
 * while a human still learns the numbers above are a floor.
 */
export function printWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  for (const w of warnings) {
    process.stderr.write(`${colorize('▲ warning:', 'yellow')} ${w}\n`);
  }
}

export function printHeader(title) {
  console.log(`\n${colors.cyan}☁  MultCloud CLI${colors.reset} ─ ${colors.bright}${title}${colors.reset}\n`);
}
