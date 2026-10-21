#!/usr/bin/env node

import { getAccountInfo } from '../src/account.js';
import { listClouds, renameCloud, getCloudProperties } from '../src/clouds.js';
import { listExplorerFiles, renameExplorerItem, deleteExplorerItem, listDrives } from '../src/explorer.js';
import { listTasks, runTask, retryFailedTasks, autoResumeTasks, inspectTask, deleteTask, getTaskLogs, getTaskVersions, getTaskOptions, watchTask, renameTask, TASK_TYPES } from '../src/tasks.js';
import { installSupervisorDaemon, uninstallSupervisorDaemon, getSupervisorStatus, readSupervisorLogs, SUPERVISOR_LABEL } from '../src/supervisor.js';
import { createTransfer } from '../src/transfer.js';
import { createSync } from '../src/sync.js';
import { createBackup } from '../src/backup.js';
import { createRemoteUpload } from '../src/remote_upload.js';
import { listShares } from '../src/shares.js';
import { getAggregatedStats } from '../src/stats.js';
import { runDoctor } from '../src/doctor.js';
import { runFlow } from '../src/flow.js';
import { closeHeadlessSession } from '../src/client.js';
import { colorize, formatStatus, printHeader, printTable, printWarnings } from '../src/ui.js';
import fs from 'fs';

/**
 * Flag specification.
 *
 * Declaring flags in one table is what makes an unknown flag an error. The
 * previous hand-rolled parser silently dropped anything it did not recognise
 * and pushed the value into the positional list, so `--statuss Failure` listed
 * every task and exited 0, and `--interval 30` — documented in the README and
 * in this file's own help — was read at the watch call site but never parsed.
 */
const FLAGS = {
  json:      { type: 'bool' },
  raw:       { type: 'bool' },
  realtime:  { type: 'bool' },
  twoway:    { type: 'bool' },
  'one-time': { type: 'bool', key: 'oneTime', value: true },
  recurring: { type: 'bool', key: 'oneTime', value: false },
  once:      { type: 'bool' },
  vps:       { type: 'bool' },
  yes:       { type: 'bool', aliases: ['y'] },
  help:      { type: 'bool', aliases: ['h'] },
  status:    { type: 'string' },
  type:      { type: 'string' },
  query:     { type: 'string', aliases: ['q'] },
  cloud:     { type: 'string' },
  path:      { type: 'string' },
  name:      { type: 'string' },
  interval:  { type: 'number' },
  'max-wait': { type: 'number', key: 'maxWait' },
  'max-retries': { type: 'number', key: 'maxRetries' },
  'stalled-timeout': { type: 'number', key: 'stalledTimeout' },
  limit:     { type: 'number' }
};

const FLAG_LOOKUP = (() => {
  const map = new Map();
  for (const [name, spec] of Object.entries(FLAGS)) {
    map.set(name, { name, ...spec });
    for (const alias of spec.aliases || []) map.set(alias, { name, ...spec });
  }
  return map;
})();

export function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }

    let token = arg.replace(/^--?/, '');
    let inlineValue = null;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    const spec = FLAG_LOOKUP.get(token);
    if (!spec) {
      const known = Object.keys(FLAGS).map(f => `--${f}`).join(', ');
      throw new Error(`Unknown option "${arg}".\nValid options: ${known}`);
    }

    const key = spec.key || spec.name;

    if (spec.type === 'bool') {
      flags[key] = 'value' in spec ? spec.value : true;
      continue;
    }

    const raw = inlineValue !== null ? inlineValue : args[++i];
    if (raw === undefined) {
      throw new Error(`Option "${arg}" requires a value.`);
    }
    if (spec.type === 'number') {
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`Option "${arg}" expects a number, got "${raw}".`);
      flags[key] = num;
    } else {
      flags[key] = raw;
    }
  }

  return { positional, flags };
}

/**
 * Every mutating command routes its result through here. Printing a green tick
 * without reading `ok` is how rename/run/delete/transfer/remote-upload all
 * reported success for actions the page had refused.
 */
function assertOk(res, whatFailed) {
  if (res && res.ok === false) {
    const detail = res.error || 'the page did not confirm the action';
    const extra = res.available ? `\nVisible options were: ${res.available.join(', ')}` : '';
    throw new Error(`${whatFailed}: ${detail}${extra}`);
  }
  return res;
}

function emit(res, flags, renderer) {
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    renderer();
  }
  printWarnings(res && res.warnings);
}

function unknownOr(value, fallback = colorize('unknown', 'dim')) {
  return (value === null || value === undefined || value === '') ? fallback : value;
}

function printHelp() {
  console.log(`
${colorize('MultCloud CLI', 'bright')} - Unified Multi-Cloud Transfer, Sync, Backup & Explorer

${colorize('USAGE:', 'bright')}
  multcloud <command> [subcommand] [options]

${colorize('CORE COMMANDS:', 'bright')}
  ${colorize('account', 'cyan')}                          Show account plan and traffic usage
  ${colorize('stats', 'cyan')}                            Aggregate metrics (storage, success rates, token health)
  ${colorize('doctor', 'cyan')}                           Full system health check & diagnostics
  ${colorize('clouds [list]', 'cyan')}                    List connected cloud storage & email accounts
  ${colorize('clouds rename <old> <new>', 'cyan')}        Rename a connected cloud drive
  ${colorize('clouds properties <name>', 'cyan')}         Show one drive's status and quota
  ${colorize('drives', 'cyan')}                           List drives with the ids Cloud Explorer addresses
  ${colorize('explorer list <cloud> [path]', 'cyan')}     Browse files/folders (alias: ls)
  ${colorize('explorer rename <cloud> <path> <old> <new>', 'cyan')}  Rename a file/folder
  ${colorize('explorer delete <cloud> <path> <name> --yes', 'cyan')} Delete a file/folder
  ${colorize('tasks [list]', 'cyan')}                     List transfer/sync/backup tasks
  ${colorize('tasks inspect <id|name>', 'cyan')}          Deep inspect a task
  ${colorize('tasks logs <id|name>', 'cyan')}             Execution logs & run metrics
  ${colorize('tasks versions <id|name>', 'cyan')}         Backup snapshot versions
  ${colorize('tasks options <id|name>', 'cyan')}          Task transfer/sync/backup policies
  ${colorize('tasks run <id|name>', 'cyan')}              Trigger immediate execution
  ${colorize('tasks watch <id|name>', 'cyan')}            Monitor with auto-recovery (--interval, --max-wait)
  ${colorize('tasks auto-resume [id|name]', 'cyan')}      Supervisor daemon: auto-resume failed/stalled tasks
  ${colorize('tasks rename <id|name> <new>', 'cyan')}     Rename a task (live for transfers, alias for all types)
  ${colorize('tasks retry-failed', 'cyan')}               Retry every failed task
  ${colorize('tasks delete <id|name> --yes', 'cyan')}     Delete a task
  ${colorize('transfer <from> <to>', 'cyan')}             Create a cloud-to-cloud transfer task
  ${colorize('sync <from> <to>', 'cyan')}                 Create a sync task (--realtime, --twoway)
  ${colorize('backup <from> <to>', 'cyan')}               Create a backup task
  ${colorize('remote-upload <url> --cloud <drive>', 'cyan')}  Offline download (HTTP/HTTPS/Magnet), --path <folder>
  ${colorize('supervisor [status]', 'cyan')}              Show auto-resume daemon status & audit logs
  ${colorize('supervisor start', 'cyan')}                 Install & start macOS launchd auto-resume daemon
  ${colorize('supervisor stop', 'cyan')}                  Stop & uninstall macOS launchd supervisor daemon
  ${colorize('supervisor log', 'cyan')}                   View supervisor execution & auto-resume logs
  ${colorize('flow <file|json>', 'cyan')}                 Run a declarative multi-step workflow
  ${colorize('shares [list]', 'cyan')}                    List shared files & links

${colorize('GLOBAL OPTIONS:', 'bright')}
  --json                                  Machine-readable JSON output
  --raw                                   Include the raw page model in task JSON
  --status <success|failure|syncing|paused>  Filter by execution status
  --type <${TASK_TYPES.join('|')}>       Filter tasks by type
  --one-time / --recurring                Filter by cadence
  --once                                  Execute a single supervisor pass and exit
  --query, -q <keyword>                   Filter by keyword
  --limit <n>                             Show at most n rows
  --interval <sec>                        Poll interval for 'tasks watch'/'auto-resume' (default 15)
  --max-wait <sec>                        Give up after n seconds in 'tasks watch' (default 3600)
  --max-retries <n>                       Max retry attempts per task in supervisor
  --stalled-timeout <sec>                 Seconds without progress before auto-resuming (default 180)
  --cloud <name>                          Destination drive for remote-upload
  --name <taskName>                       Name for a created task
  --realtime / --twoway                   Sync mode flags
  --vps                                   Execute via 24/7 Cloud VPS headless session (multcloud-vps)
  --yes, -y                               Confirm a destructive action
  --help, -h                              Show this help

${colorize('EXAMPLES:', 'bright')}
  multcloud tasks --type remote --json
  multcloud tasks watch "Sample Task" --interval 15 --max-wait 600
  multcloud tasks auto-resume --once
  multcloud explorer list "Baidu 1"
  multcloud remote-upload "magnet:?xt=urn:btih:..." --cloud "Google Drive 5"
`);
}

function applyLimit(rows, flags) {
  return flags.limit ? rows.slice(0, flags.limit) : rows;
}

async function main() {
  const args = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(`\n${colorize('ERROR:', 'red')} ${err.message}\n`);
    process.exit(2);
  }

  const { positional, flags } = parsed;
  if (args.length === 0 || flags.help) {
    printHelp();
    return;
  }

  const backendEnv = (process.env.MULTCLOUD_BACKEND || '').toLowerCase().trim();
  const useRemoteVps = (flags.vps || backendEnv === 'cloud' || backendEnv === 'vps') && process.platform !== 'linux';
  if (useRemoteVps) {
    const vpsHost = process.env.MULTCLOUD_VPS_HOST || 'multcloud-vps';
    const remoteArgs = args.filter(a => a !== '--vps');
    const quoted = remoteArgs.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
    const { spawnSync } = await import('child_process');
    const res = spawnSync('ssh', [vpsHost, `/usr/local/bin/multcloud ${quoted}`], {
      stdio: 'inherit',
      maxBuffer: 32 * 1024 * 1024
    });
    process.exit(res.status ?? 1);
  }

  const cmd = positional[0] || 'help';

  try {
    switch (cmd) {
      case 'account': {
        const data = await getAccountInfo();
        emit(data, flags, () => {
          printHeader('Account Overview');
          console.log(`  Plan:             ${colorize(unknownOr(data.plan), 'green')}`);
          console.log(`  Traffic Used:     ${colorize(unknownOr(data.trafficUsed), 'yellow')}`);
          console.log(`  Traffic Limit:    ${colorize(unknownOr(data.trafficTotal), 'cyan')}`);
          console.log(`  Traffic Summary:  ${colorize(unknownOr(data.trafficSummary), 'bright')}`);
          console.log(`  Target Page:      ${colorize(data.url, 'dim')}`);
          if (data.trafficKnown === false) {
            console.log(`  ${colorize('Note: traffic could not be read from the page; nothing above is a stored default.', 'dim')}`);
          }
          console.log();
        });
        break;
      }

      case 'stats': {
        const data = await getAggregatedStats();
        emit(data, flags, () => {
          printHeader('MultCloud Aggregated Metrics');
          console.log(`  ${colorize('Plan & Quota:', 'bright')}`);
          console.log(`    - Subscription:     ${colorize(unknownOr(data.account.plan), 'green')}`);
          console.log(`    - Traffic Used:     ${colorize(unknownOr(data.account.trafficUsed), 'yellow')} / ${unknownOr(data.account.trafficTotal)}`);
          console.log();
          console.log(`  ${colorize('Storage Capacity Across All Clouds:', 'bright')}`);
          if (!data.storage.measured) {
            console.log(`    ${colorize('not measured - no drive reported a readable capacity', 'yellow')}`);
          } else {
            console.log(`    - Total Bound:      ${colorize(data.storage.totalCapacityTB + ' TB', 'bright')} (from ${data.storage.drivesCounted} drive(s))`);
            console.log(`    - Used Space:       ${colorize(data.storage.usedCapacityTB + ' TB', 'yellow')} (${data.storage.utilizationPercent}%)`);
            console.log(`    - Free Space:       ${colorize(data.storage.freeCapacityTB + ' TB', 'green')}`);
            if (data.storage.drivesUncounted > 0) {
              console.log(`    - Not counted:      ${colorize(String(data.storage.drivesUncounted) + ' drive(s) with no readable capacity', 'yellow')}`);
            }
          }
          console.log();
          console.log(`  ${colorize('Cloud Accounts:', 'bright')}`);
          console.log(`    - Total Bound:      ${data.clouds.total}`);
          console.log(`    - Quota reported:   ${colorize(String(data.clouds.quotaOk), 'green')}`);
          console.log(`    - Quota missing:    ${data.clouds.quotaUnavailable + data.clouds.quotaUnknown > 0 ? colorize(String(data.clouds.quotaUnavailable + data.clouds.quotaUnknown), 'yellow') : '0'} ${colorize('(a quota lookup, not an auth check)', 'dim')}`);
          (data.clouds.quotaUnavailableList || []).forEach(name => console.log(`      ${colorize('?', 'yellow')} ${name}`));
          console.log();
          console.log(`  ${colorize('Tasks Execution Health:', 'bright')}`);
          console.log(`    - Total Tasks:      ${data.tasks.total}`);
          console.log(`    - Successful:       ${colorize(String(data.tasks.success), 'green')}`);
          console.log(`    - Failed:           ${data.tasks.failure > 0 ? colorize(String(data.tasks.failure), 'red') : '0'}`);
          console.log(`    - Syncing/Active:   ${colorize(String(data.tasks.syncing), 'cyan')}`);
          console.log(`    - Paused:           ${data.tasks.paused}`);
          console.log(`    - Unclassified:     ${data.tasks.unknown > 0 ? colorize(String(data.tasks.unknown), 'yellow') : '0'}`);
          console.log(`    - Success Rate:     ${colorize(data.tasks.successRate, 'green')}`);
          if (data.tasks.successRateNote) console.log(`      ${colorize(data.tasks.successRateNote, 'dim')}`);
          console.log();
        });
        break;
      }

      case 'doctor': {
        const data = await runDoctor();
        emit(data, flags, () => {
          printHeader(`MultCloud Diagnostic Health Check [Score: ${data.score}]`);
          data.checks.forEach(check => {
            const badge = check.status === 'PASS' ? colorize('PASS', 'green')
              : check.status === 'WARN' ? colorize('WARN', 'yellow') : colorize('FAIL', 'red');
            console.log(`  [${badge}]  ${colorize(check.name, 'bright')}`);
            console.log(`          ${colorize(check.details, 'dim')}`);
          });
          console.log();
          console.log(data.allHealthy
            ? `  ${colorize('All systems operational.', 'green')}\n`
            : `  ${colorize('Issues detected. Review the warnings above.', 'yellow')}\n`);
        });
        if (!data.ok) process.exitCode = 1;
        break;
      }

      case 'drives': {
        const data = await listDrives();
        emit(data, flags, () => {
          printHeader(`Connected Drives (${data.drives.length})`);
          printTable(['#', 'Name', 'Drive Type'],
            data.drives.map((d, i) => [String(i + 1), d.name, d.driveType || '--']));
          console.log();
        });
        break;
      }

      case 'clouds': {
        const sub = positional[1] || 'list';
        if (sub === 'rename') {
          const [oldName, newName] = positional.slice(2);
          if (!oldName || !newName) throw new Error('Usage: multcloud clouds rename <oldName> <newName>');
          const res = assertOk(await renameCloud(oldName, newName), `Could not rename "${oldName}"`);
          emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Cloud drive renamed: "${oldName}" -> "${newName}"\n`));
        } else if (sub === 'properties' || sub === 'info') {
          const cloudName = positional[2];
          if (!cloudName) throw new Error('Usage: multcloud clouds properties <cloudName>');
          const res = await getCloudProperties(cloudName);
          emit(res, flags, () => {
            printHeader(`Cloud Drive Properties: ${res.name}`);
            console.log(`  Status:      ${formatStatus(res.status)}`);
            console.log(`  Capacity:    ${res.capacityKnown ? `${res.used} / ${res.total}` : colorize('unknown (not shown on the page)', 'dim')}`);
            console.log(`  Details:     ${colorize(res.details || 'N/A', 'dim')}`);
            console.log();
          });
        } else {
          const data = await listClouds(flags);
          emit(data, flags, () => {
            printHeader(`Connected Cloud Accounts (${data.totalCount} Total: ${data.quotaOkCount} with quota, ${data.quotaUnavailableCount + data.quotaUnknownCount} without)`);
            printTable(['#', 'Type', 'Account Name', 'Used', 'Total', 'Quota'],
              applyLimit(data.clouds, flags).map((c, i) => [
                String(i + 1), c.type, c.name,
                c.used || colorize('--', 'dim'),
                c.total || colorize('--', 'dim'),
                c.quota === 'ok' ? colorize('reported', 'green') : colorize(c.quota, 'yellow')
              ]));
            console.log();
          });
        }
        break;
      }

      case 'explorer':
      case 'ls': {
        const sub = positional[1] || 'list';
        if (sub === 'rename') {
          const [cloud, folder, oldName, newName] = positional.slice(2);
          if (!cloud || !oldName || !newName) throw new Error('Usage: multcloud explorer rename <cloud> <folderPath> <oldName> <newName>');
          const res = assertOk(await renameExplorerItem(cloud, folder || '', oldName, newName), `Could not rename "${oldName}"`);
          emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Renamed: "${oldName}" -> "${newName}"\n`));
        } else if (sub === 'delete' || sub === 'rm') {
          const [cloud, folder, itemName] = positional.slice(2);
          if (!cloud || !itemName) throw new Error('Usage: multcloud explorer delete <cloud> <folderPath> <itemName> --yes');
          const res = assertOk(await deleteExplorerItem(cloud, folder || '', itemName, flags.yes), `Could not delete "${itemName}"`);
          emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Deleted from Cloud Explorer: "${res.deleted || itemName}"\n`));
        } else {
          const cloud = sub === 'list' ? positional[2] : sub;
          const folder = sub === 'list' ? (positional[3] || '') : (positional[2] || '');
          if (!cloud) throw new Error('Usage: multcloud explorer list <cloudName> [folderPath]');
          const data = assertOk(await listExplorerFiles(cloud, folder), `Could not list "${cloud}"`);
          emit(data, flags, () => {
            printHeader(`Cloud Explorer: ${data.cloud} (Path: ${data.currentPath}) [${data.count} items]`);
            printTable(['#', 'Type', 'Name', 'Size', 'Date Modified'],
              applyLimit(data.files, flags).map((f, i) => [
                String(i + 1),
                f.type === 'folder' ? colorize('Dir', 'blue') : colorize('File', 'dim'),
                f.name, f.size, f.date
              ]));
            console.log();
          });
        }
        break;
      }

      case 'tasks': {
        const sub = positional[1] || 'list';

        if (sub === 'rename') {
          const [target, newName] = positional.slice(2);
          if (!target || !newName) throw new Error('Usage: multcloud tasks rename <id|oldName> <newName>');
          const res = await renameTask(target, newName);
          emit(res, flags, () => {
            console.log(`\n${colorize('OK', 'green')} Task rename processed:`);
            console.log(`  - Original:        "${colorize(res.oldName, 'dim')}"`);
            console.log(`  - New name:        "${colorize(res.newName, 'bright')}"`);
            console.log(`  - Local alias:     ${colorize('saved', 'green')}`);
            console.log(`  - Server rename:   ${res.isLiveServerRenamed
              ? colorize('persisted on MultCloud', 'green')
              : colorize(`not persisted${res.liveRenameError ? ` (${res.liveRenameError})` : ''}`, 'yellow')}\n`);
          });
        } else if (sub === 'run') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks run <id|name>');
          const res = assertOk(await runTask(target), `Could not start "${target}"`);
          emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Task triggered: ${res.taskName || target} (${res.taskId})\n`));
        } else if (sub === 'watch' || sub === 'monitor') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks watch <id|name> [--interval <sec>] [--max-wait <sec>]');
          const interval = flags.interval ?? 5;
          const maxWait = flags.maxWait ?? 3600;
          if (!flags.json) {
            printHeader(`Watching Task: ${target}`);
            console.log(`  ${colorize(`Polling every ${interval}s, giving up after ${maxWait}s.`, 'dim')}\n`);
          }
          const res = await watchTask(target, {
            interval,
            maxWait,
            onUpdate: (update) => {
              if (flags.json) return;
              if (update.type === 'retry_attempt') {
                console.log(`\n  ${colorize('Auto-recovery:', 'yellow')} ${update.message}\n`);
              } else {
                process.stdout.write(`\r  [${new Date().toLocaleTimeString()}] Status: ${formatStatus(update.status)} | Runs: ${update.runCount ?? '?'} | Files: ${update.lastLog?.totalFileCount ?? 0}   `);
              }
            }
          });
          if (!flags.json) console.log('\n');
          emit(res, flags, () => console.log(`${res.ok ? colorize('OK', 'green') : colorize('ENDED', 'yellow')} Watch finished with status: ${formatStatus(res.status)}${res.error ? ` - ${res.error}` : ''}\n`));
          if (!res.ok) process.exitCode = 1;
        } else if (sub === 'auto-resume' || sub === 'supervisor' || sub === 'watch-all') {
          const target = positional[2];
          const interval = flags.interval ?? 15;
          const maxRetries = flags.maxRetries ?? Infinity;
          const stalledTimeout = flags.stalledTimeout ?? 180;
          const once = flags.once || false;

          if (!flags.json) {
            printHeader('Task Supervisor Daemon');
            console.log(`  ${colorize(`Monitoring mode: ${once ? 'Single Pass (--once)' : 'Continuous Daemon'}`, 'bright')}`);
            console.log(`  ${colorize(`Interval: ${interval}s | Stalled Timeout: ${stalledTimeout}s | Max Retries: ${maxRetries === Infinity ? 'Unlimited' : maxRetries}`, 'dim')}`);
            if (target) console.log(`  ${colorize(`Filtered by: "${target}"`, 'yellow')}`);
            console.log();
          }

          const res = await autoResumeTasks({
            interval,
            maxRetries,
            stalledTimeout,
            query: target || flags.query,
            once,
            onUpdate: (ev) => {
              if (flags.json) return;
              if (ev.type === 'resume_attempt') {
                console.log(`  [${colorize(new Date().toLocaleTimeString(), 'dim')}] ${colorize('AUTO-RESUME:', 'yellow')} ${ev.taskName} (${colorize(ev.taskId, 'dim')}) -> reason: ${colorize(ev.reason, 'bright')} (attempt ${ev.attempt})`);
              } else if (ev.type === 'cycle_complete') {
                if (!once) {
                  process.stdout.write(`\r  [${new Date().toLocaleTimeString()}] Checked ${ev.tasksChecked} tasks. Resumed: ${ev.resumedCount}   `);
                }
              } else if (ev.type === 'error') {
                console.log(`  [${colorize(new Date().toLocaleTimeString(), 'dim')}] ${colorize('ERROR:', 'red')} ${ev.message}`);
              }
            }
          });

          if (!flags.json && !once) console.log('\n');
          emit(res, flags, () => {
            if (once) {
              console.log(`\n${colorize('OK', 'green')} Supervisor single-pass complete: ${res.inspectedCount} task(s) inspected, ${res.resumedCount} resumed.`);
              (res.actions || []).forEach(a => {
                console.log(`  - ${a.taskName}: resumed from ${a.status} (${a.reason})`);
              });
              console.log();
            }
          });
        } else if (sub === 'retry-failed') {
          const res = await retryFailedTasks();
          emit(res, flags, () => {
            console.log(`\n${colorize('OK', 'green')} Batch retry: ${res.retriedCount}/${res.totalFailed} failed task(s) triggered.`);
            (res.results || []).filter(r => !r.success).forEach(r =>
              console.log(`  ${colorize('x', 'red')} ${r.name}: ${r.error || 'not triggered'}`));
            console.log();
          });
          if (!res.ok) process.exitCode = 1;
        } else if (sub === 'logs' || sub === 'log') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks logs <id|name>');
          const res = assertOk(await getTaskLogs(target), `Could not read logs for "${target}"`);
          emit(res, flags, () => {
            printHeader(`Task Execution Logs: ${res.taskName}`);
            console.log(`  Task ID:            ${colorize(res.taskId, 'dim')}`);
            console.log(`  Status:             ${formatStatus(res.status)}`);
            console.log(`  Run Count:          ${colorize(unknownOr(res.runCount), 'bright')}`);
            if (res.cronExpression) console.log(`  Cron Schedule:      ${colorize(res.cronExpression, 'cyan')}`);
            console.log(`  Source:             ${colorize(res.sourcePath, 'bright')}`);
            console.log(`  Destination:        ${colorize(res.destPath, 'bright')}`);
            if (res.logUnavailableReason) {
              console.log(`  ${colorize(`Detailed history unavailable: ${res.logUnavailableReason}`, 'yellow')}`);
            }
            if (res.lastLog) {
              console.log(`\n  ${colorize('Last Execution:', 'bright')}`);
              console.log(`    - Start Time:     ${res.lastLog.taskStartTime || 'N/A'}`);
              console.log(`    - Duration:       ${res.lastLog.durationSeconds}s`);
              console.log(`    - Total Files:    ${res.lastLog.totalFileCount}`);
              console.log(`    - Total Data:     ${(res.lastLog.totalBytes / (1024 * 1024)).toFixed(2)} MB`);
              console.log(`    - Result:         ${formatStatus(res.lastLog.response)}`);
              if (res.lastLog.errorList?.length) {
                console.log(`    - Errors:         ${colorize(JSON.stringify(res.lastLog.errorList), 'red')}`);
              }
            }
            console.log();
          });
        } else if (sub === 'versions') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks versions <id|name>');
          const res = assertOk(await getTaskVersions(target), `Could not read versions for "${target}"`);
          emit(res, flags, () => {
            printHeader(`Backup Task Versions: ${res.taskName} (${res.versionCount} snapshots)`);
            if (res.versions?.length) {
              printTable(['#', 'Version', 'Snapshot Time', 'Files', 'Size'],
                applyLimit(res.versions, flags).map((v, i) => [
                  String(i + 1), String(v.versionNum), v.createTime, String(v.count),
                  (v.size / (1024 * 1024)).toFixed(2) + ' MB'
                ]));
            } else {
              console.log(`  ${colorize('No snapshot versions recorded for this task.', 'dim')}`);
            }
            console.log();
          });
        } else if (sub === 'options') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks options <id|name>');
          const res = assertOk(await getTaskOptions(target), `Could not read options for "${target}"`);
          emit(res, flags, () => {
            printHeader(`Task Options & Policies: ${res.taskName}`);
            console.log(JSON.stringify(res.options, null, 2));
            console.log();
          });
        } else if (sub === 'inspect' || sub === 'details') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks inspect <id|name>');
          const res = assertOk(await inspectTask(target), `Could not inspect "${target}"`);
          emit(res, flags, () => {
            printHeader(`Task Deep Inspection: ${res.taskName}`);
            console.log(`  Task ID:            ${colorize(res.taskId || 'N/A', 'dim')}`);
            console.log(`  Status:             ${formatStatus(res.status)}`);
            console.log(`  Cadence:            ${colorize(res.cadence, res.isOneTime ? 'yellow' : 'cyan')}`);
            console.log(`  Source Drive/Path:  ${colorize(res.sourcePath, 'bright')}`);
            console.log(`  Target Drive/Path:  ${colorize(res.destPath, 'bright')}`);
            console.log(`  Run Count:          ${unknownOr(res.runCount)}`);
            if (res.lastLog) {
              console.log(`\n  ${colorize('Last Execution:', 'bright')}`);
              console.log(`    - Start Time:     ${res.lastLog.taskStartTime || 'N/A'}`);
              console.log(`    - Duration:       ${res.lastLog.durationSeconds}s`);
              console.log(`    - Total Data:     ${(res.lastLog.totalBytes / (1024 * 1024)).toFixed(2)} MB`);
              console.log(`    - Total Files:    ${res.lastLog.totalFileCount}`);
            }
            if (res.options && Object.keys(res.options).length > 0) {
              console.log(`\n  ${colorize('Options & Policies:', 'bright')}`);
              console.log(`    - Replace Mode:         ${res.options.replace === 2 ? 'Overwrite if Different' : res.options.replace}`);
              console.log(`    - Auto-Rename Special:  ${res.options.isChar === 1 ? 'Yes' : 'No'}`);
              console.log(`    - Delete Source Files:  ${res.options.isRemove === 1 ? 'Yes' : 'No'}`);
              console.log(`    - Keep Modification:    ${res.options.isKeep === 1 ? 'Yes' : 'No'}`);
              console.log(`    - Keep in One Folder:   ${res.options.keepRoot === 1 ? 'Yes' : 'No'}`);
            }
            if (res.versions?.length) console.log(`\n  ${colorize('Backup Snapshots:', 'bright')} ${res.versions.length}`);
            console.log();
          });
        } else if (sub === 'delete') {
          const target = positional[2];
          if (!target) throw new Error('Usage: multcloud tasks delete <id|name> --yes');
          const res = assertOk(await deleteTask(target, flags.yes), `Could not delete "${target}"`);
          emit(res, flags, () => {
            console.log(`\n${colorize('OK', 'green')} Task deleted: ${res.taskName} (${res.taskId})`);
            console.log(`  Confirmed gone from the task list: ${res.verifiedGone === true ? colorize('yes', 'green') : colorize(String(res.verifiedGone), 'yellow')}\n`);
          });
        } else {
          const data = await listTasks(flags);
          emit(data, flags, () => {
            printHeader(`Task List (${data.totalCount} Total: ${data.successCount} Success, ${data.failureCount} Failure, ${data.syncingCount} Syncing, ${data.unknownCount} Unclassified, ${data.oneTimeCount} One-time)`);
            printTable(['#', 'Type', 'Name', 'Alias', 'Cadence', 'Source -> Dest', 'Status', 'Last Run'],
              applyLimit(data.tasks, flags).map((t, i) => [
                String(i + 1),
                t.type,
                t.taskName,
                t.aliasName ? colorize(t.aliasName, 'cyan') : colorize('--', 'dim'),
                t.isOneTime ? colorize('One-time', 'yellow') : colorize(t.cadence, 'cyan'),
                `${t.sourcePath || '--'} -> ${t.destPath || '--'}`,
                formatStatus(t.status),
                t.lastRun ? t.lastRun.slice(0, 16) : '--'
              ]));
            console.log();
          });
        }
        break;
      }

      case 'transfer': {
        const [, from, to] = positional;
        if (!from || !to) throw new Error('Usage: multcloud transfer <source_cloud/path> <dest_cloud/path> [--name <taskName>]');
        const res = assertOk(await createTransfer({ from, to, name: flags.name }), 'Could not create the transfer task');
        emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Transfer task created: "${from}" -> "${to}"${res.taskId ? ` (${res.taskId})` : ''}\n`));
        break;
      }

      case 'sync': {
        const [, from, to] = positional;
        if (!from || !to) throw new Error('Usage: multcloud sync <source_cloud> <dest_cloud> [--realtime] [--twoway]');
        const res = assertOk(await createSync({ from, to, realtime: flags.realtime, twoway: flags.twoway, name: flags.name }), 'Could not create the sync task');
        emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Sync task created: "${from}" -> "${to}" (${res.mode}${res.twoway ? ', two-way' : ''})\n`));
        break;
      }

      case 'backup': {
        const [, from, to] = positional;
        if (!from || !to) throw new Error('Usage: multcloud backup <source_cloud> <dest_cloud> [--name <taskName>]');
        const res = assertOk(await createBackup({ from, to, name: flags.name }), 'Could not create the backup task');
        emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Backup task created: "${from}" -> "${to}"${res.taskId ? ` (${res.taskId})` : ''}\n`));
        break;
      }

      case 'remote-upload':
      case 'offline': {
        const url = positional[1];
        if (!url) throw new Error('Usage: multcloud remote-upload <url|magnet> --cloud <target_cloud> [--path <folder>]');
        // `name` is forwarded so the module can REFUSE it. The page has no name
        // control, and dropping the flag here would repeat the bug that made
        // the documented --cloud a silent no-op on this same command.
        const res = assertOk(
          await createRemoteUpload({ url, cloud: flags.cloud, path: flags.path, name: flags.name }),
          'Could not submit the remote upload'
        );
        emit(res, flags, () => console.log(`\n${colorize('OK', 'green')} Remote upload task created: "${url}" -> "${res.to}"${res.taskId ? ` (${res.taskId})` : ''}\n`));
        break;
      }

      case 'flow': {
        const flowInput = positional[1];
        if (!flowInput) throw new Error('Usage: multcloud flow <workflow.json | JSON string>');
        const flowDef = fs.existsSync(flowInput)
          ? JSON.parse(fs.readFileSync(flowInput, 'utf8'))
          : JSON.parse(flowInput);
        const res = await runFlow(flowDef);
        emit(res, flags, () => {
          printHeader(`Flow Execution: ${res.flowName} (${res.successCount}/${res.totalSteps} steps succeeded)`);
          res.results.forEach((s, idx) => {
            const badge = s.success ? colorize('PASS', 'green') : colorize('FAIL', 'red');
            console.log(`  Step ${idx + 1} [${s.action}]: ${badge} (${s.duration}ms)${s.error ? ` - ${s.error}` : ''}`);
          });
          console.log();
        });
        if (!res.ok) process.exitCode = 1;
        break;
      }

      case 'shares': {
        const data = await listShares();
        emit(data, flags, () => {
          printHeader(`Shared Files & Links (${data.count} items)`);
          if (data.shares.length === 0) {
            console.log(`  ${colorize('No shared files or active share links found.', 'dim')}\n`);
          } else {
            printTable(['#', 'Name', 'Type', 'Size', 'Shared On', 'Link'],
              applyLimit(data.shares, flags).map((s, i) => [
                String(i + 1), s.name, s.type, s.size, s.sharedOn, s.link || colorize('--', 'dim')
              ]));
            console.log();
          }
        });
        break;
      }

      case 'supervisor':
      case 'daemon': {
        const sub = positional[1] || 'status';
        if (sub === 'start' || sub === 'install') {
          const interval = flags.interval ?? 180;
          const query = flags.query || positional[2] || '';
          const res = assertOk(await installSupervisorDaemon({ interval, query }), 'Could not install supervisor daemon');
          emit(res, flags, () => {
            console.log(`\n${colorize('OK', 'green')} MultCloud supervisor daemon installed and started via launchd.`);
            console.log(`  Label:     ${res.label}`);
            console.log(`  Interval:  ${res.interval}s`);
            console.log(`  Query:     ${res.query}`);
            console.log(`  Plist:     ${colorize(res.plistPath, 'dim')}\n`);
          });
        } else if (sub === 'stop' || sub === 'uninstall') {
          const res = assertOk(await uninstallSupervisorDaemon(), 'Could not uninstall supervisor daemon');
          emit(res, flags, () => {
            console.log(`\n${colorize('OK', 'green')} MultCloud supervisor daemon stopped and unloaded.`);
            console.log(`  Unloaded: ${res.unloaded ? colorize('yes', 'green') : 'no'}`);
            console.log(`  Removed:  ${res.removed ? colorize('yes', 'green') : 'no'}\n`);
          });
        } else if (sub === 'log' || sub === 'logs') {
          const limit = flags.limit || 50;
          const res = readSupervisorLogs(limit);
          emit(res, flags, () => {
            printHeader(`Supervisor Logs (${res.logs?.length ?? 0}/${res.totalLines ?? 0} lines)`);
            console.log(`  Log file: ${colorize(res.logPath, 'dim')}\n`);
            if (!res.logs?.length) {
              console.log(`  ${colorize('No log entries recorded yet.', 'dim')}\n`);
            } else {
              res.logs.forEach(l => console.log(`  ${l}`));
              console.log();
            }
          });
        } else {
          const status = await getSupervisorStatus();
          emit(status, flags, () => {
            printHeader('MultCloud Auto-Resume Supervisor Daemon Status');
            console.log(`  Daemon Label:     ${colorize(status.label, 'cyan')}`);
            console.log(`  Installed:        ${status.installed ? colorize('Yes (LaunchAgent present)', 'green') : colorize('No', 'yellow')}`);
            console.log(`  Loaded (launchd): ${status.loaded ? colorize('Yes', 'green') : colorize('No', 'yellow')}`);
            if (status.pid) console.log(`  Active PID:       ${colorize(String(status.pid), 'bright')}`);
            if (status.lastExitStatus !== null) console.log(`  Last Exit Code:   ${status.lastExitStatus === 0 ? colorize('0 (Success)', 'green') : colorize(String(status.lastExitStatus), 'red')}`);
            console.log(`  Last Cycle:       ${status.lastCycleTime || colorize('None recorded', 'dim')}`);
            console.log(`  Total Resumes:    ${colorize(String(status.totalResumesRecorded), 'bright')}`);
            console.log(`  Log File:         ${colorize(status.logPath, 'dim')}`);
            if (status.recentResumes?.length) {
              console.log(`\n  ${colorize('Recent Resume Actions:', 'bright')}`);
              status.recentResumes.forEach(r => console.log(`    ${r}`));
            }
            if (!status.installed) {
              console.log(`\n  ${colorize('Route B Cloud:', 'green')} Cloud supervisor active on ${colorize('multcloud-vps', 'cyan')} (94.250.201.125).`);
              console.log(`  ${colorize('Tip:', 'yellow')} Check remote status with: ${colorize('ssh multcloud-vps "node /opt/multcloud-daemon/cli.js status"', 'bright')}`);
            }
            console.log();
          });
        }
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n${colorize('ERROR:', 'red')} ${err.message}\n`);
    process.exit(1);
  } finally {
    await closeHeadlessSession();
  }
}

const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('multcloud.js') || process.argv[1].endsWith('/multcloud') || process.argv[1].endsWith('/mc-cli')
);
if (invokedDirectly) main();
