import { evaluate, navigateToOrThrow, jsv } from './client.js';
import { aliasFile } from './paths.js';
import fs from 'fs';
import path from 'path';

/**
 * Canonical task-type vocabulary.
 *
 * MultCloud's own `icon`/`type` values are internal ("cloudTransfer",
 * "linkTask"). `--type` is a documented user-facing filter, so it must be
 * evaluated against a stable vocabulary rather than whatever the page happens
 * to call things. `linkTask` is a remote upload; before this map existed
 * `--type remote` matched nothing and reported "you own none".
 */
export const TASK_TYPES = ['transfer', 'sync', 'backup', 'remote'];

export function normalizeTaskType(rawType, numericType) {
  const t = String(rawType || '').toLowerCase();
  if (t.includes('link') || t.includes('remote')) return 'remote';
  if (t.includes('backup')) return 'backup';
  if (t.includes('sync')) return 'sync';
  if (t.includes('transfer')) return 'transfer';
  if (numericType === 1) return 'transfer';
  if (numericType === 2) return 'sync';
  if (numericType === 6) return 'backup';
  return 'unknown';
}

export function getAliases() {
  try {
    const f = aliasFile();
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch (e) {}
  return {};
}

export function saveAlias(taskId, aliasName) {
  try {
    const f = aliasFile();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const aliases = getAliases();
    aliases[taskId] = aliasName;
    fs.writeFileSync(f, JSON.stringify(aliases, null, 2), 'utf8');
  } catch (e) {
    throw new Error(`Could not write the alias registry at ${aliasFile()}: ${e.message}`);
  }
}

/**
 * Remove an alias. Called after a delete so a stale label cannot outlive the
 * task it named and then match some future task by substring.
 */
export function dropAlias(taskId) {
  try {
    const f = aliasFile();
    if (!fs.existsSync(f)) return;
    const aliases = getAliases();
    if (!(taskId in aliases)) return;
    delete aliases[taskId];
    fs.writeFileSync(f, JSON.stringify(aliases, null, 2), 'utf8');
  } catch (e) {
    throw new Error(`Could not update the alias registry at ${aliasFile()}: ${e.message}`);
  }
}

/**
 * List all transfer, sync, and backup tasks with comprehensive filtering and status normalization.
 */
export async function listTasks(options = {}) {
  await navigateToOrThrow('Task List', 'https://app.multcloud.com/mc_project/task_list');

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const deadline = Date.now() + 10000;

    let comp = null;
    let list = [];

    // Wait for Vue taskList component to populate
    while (Date.now() < deadline) {
      const all = Array.from(document.querySelectorAll('*')).map(e => e.__vue__).filter(Boolean);
      comp = all.find(c => (c.taskList && c.taskList.length > 0) || (c.$data?.taskList && c.$data.taskList.length > 0));
      if (comp) {
        list = comp.taskList || comp.$data.taskList;
        if (list && list.length > 0) break;
      }
      await sleep(150);
    }

    if (list && list.length > 0) {
      return list.map(item => {
        let status = 'Unknown';

        const cardEl = Array.from(document.querySelectorAll('.grid-card, .el-card')).find(c => {
          const chk = c.querySelector('input');
          return chk && chk.value === item.id;
        });
        const cardTxtEl = cardEl?.querySelector('.status-txt-text, .function-status');
        const cardTxt = (cardTxtEl?.innerText || '').trim();
        const cardCls = ((cardTxtEl?.className || '') + ' ' + (cardEl?.className || '')).toLowerCase();

        if (cardCls.includes('task-failure') || cardTxt.includes('Failure') || cardTxt.includes('Failed') || item.result === -1 || item.result === 0 || item.result === 2 || item.statusTxt === 'Failure' || item.statusTxt === 'Failed') {
          status = 'Failure';
        } else if (cardCls.includes('task-syncing') || cardTxt.includes('Syncing') || item.statusTxt === 'Syncing' || item.status === 1) {
          status = 'Syncing';
        } else if (cardCls.includes('task-paused') || cardTxt.includes('Paused') || item.statusTxt === 'Paused') {
          status = 'Paused';
        } else if (cardTxt.includes('Cancel') || cardEl?.innerText?.includes('Cancel') || /[0-9]+.*[KMG]B\\/s/.test(cardTxt)) {
          status = 'Transferring';
        } else if (cardTxt.includes('Waiting')) {
          status = 'Scheduled';
        } else if (cardCls.includes('task-success') || cardTxt.includes('Success') || item.result === 1 || item.statusTxt === 'Success') {
          status = 'Success';
        } else if (item.status === 2) {
          status = (item.type === 1 || item.icon === 'cloudTransfer') ? 'Scheduled' : 'Paused';
        } else if (item.lastLog?.response === 'success' && item.result !== -1 && item.result !== 0 && item.result !== 2 && item.statusTxt !== 'Failure') {
          status = 'Success';
        } else if (item.statusTxt) {
          status = item.statusTxt;
        }

        const isOneTime = !item.schedules || item.schedules.disabled === true || item.schedules.type === 'Now';
        let cadence = 'One-time Task';
        if (status === 'Syncing') cadence = 'Real-Time Continuous';
        else if (item.schedules && !item.schedules.disabled) {
          const type = item.schedules.type || 'Recurring';
          const times = (item.schedules.times || []).join(', ') || item.schedules.time || '';
          cadence = times ? \`\${type} \${times}\` : type;
        }

        const sourceNode = item.fromItem?.lists?.[0];
        const destNode = item.toItem?.lists?.[0];
        const sourcePath = sourceNode?.name || sourceNode?.fileName || sourceNode?.filename || '';
        const destPath = destNode?.name || destNode?.fileName || destNode?.filename || '';

        return {
          taskId: item.id || '',
          taskName: item.name?.trim() || '',
          typeRaw: item.icon || '',
          typeNumeric: typeof item.type === 'number' ? item.type : null,
          status,
          isOneTime,
          cadence,
          schedule: isOneTime ? 'Off' : cadence,
          sourcePath,
          destPath,
          progress: item.progress || item.lastLog?.response || '100%',
          speed: item.speed || '--',
          lastRun: item.lastLog?.taskStartTimeStr || (item.lastLog?.taskStartTime ? new Date(item.lastLog.taskStartTime).toISOString() : ''),
          rawItem: item
        };
      });
    }

    // DOM fallback
    const cards = Array.from(document.querySelectorAll('.grid-card, .el-card.grid-card'));
    return cards.map(c => {
      const fullText = c.innerText?.trim() || '';
      const lines = fullText.split('\\n').map(s => s.trim()).filter(Boolean);
      const title = lines[0] || 'Unknown Task';

      let status = 'Unknown';
      if (fullText.includes('Success')) status = 'Success';
      else if (fullText.includes('Failure') || fullText.includes('Failed')) status = 'Failure';
      else if (fullText.includes('Syncing')) status = 'Syncing';
      else if (fullText.includes('Paused')) status = 'Paused';
      else if (fullText.includes('Cancel') || /[0-9]+(\\.[0-9]+)?(KB|MB|GB)\\/s/i.test(fullText)) status = 'Transferring';

      const scheduleLine = lines.find(l => l.startsWith('Schedule:')) || '';
      const schedule = scheduleLine ? scheduleLine.replace('Schedule:', '').trim() : 'Off';
      const isOneTime = schedule === 'Off' && !status.includes('Syncing');

      return {
        taskId: c.getAttribute('id') || c.getAttribute('data-id') || '',
        taskName: title,
        typeRaw: fullText.includes('Sync') ? 'cloudSync' : fullText.includes('Backup') ? 'cloudBackup' : 'cloudTransfer',
        typeNumeric: null,
        status,
        isOneTime,
        cadence: isOneTime ? 'One-time Task' : schedule,
        schedule,
        sourcePath: lines[2] || '',
        destPath: lines[3] || '',
        progress: '100%',
        speed: '--',
        lastRun: ''
      };
    }).filter(t => t.taskName && t.taskName !== 'Task List');
  })()`;

  let tasks = await evaluate(js, { timeout: 60000 });
  if (!Array.isArray(tasks)) tasks = [];

  // Normalize the page's internal type names into the documented vocabulary
  // before any filtering, so `--type remote` can reach `linkTask` rows.
  tasks = tasks.map(task => ({
    ...task,
    type: normalizeTaskType(task.typeRaw, task.typeNumeric)
  }));

  // A real-time sync that is currently running is not a one-time task, whatever
  // its (absent) schedule says.
  tasks = tasks.map(task => task.status === 'Syncing'
    ? { ...task, isOneTime: false, cadence: task.cadence || 'Real-Time Continuous' }
    : task);

  if (options.status) {
    const s = options.status.toLowerCase();
    tasks = tasks.filter(task => task.status.toLowerCase().includes(s));
  }

  if (options.type) {
    const t = String(options.type).toLowerCase();
    if (!TASK_TYPES.includes(t)) {
      throw new Error(`Unknown --type "${options.type}". Valid values: ${TASK_TYPES.join(', ')}`);
    }
    tasks = tasks.filter(task => task.type === t);
  }

  const aliases = getAliases();
  tasks = tasks.map(task => {
    const alias = aliases[task.taskId];
    // `rawItem` is the whole Vue model (source/destination node trees, options,
    // schedules). It is useful for debugging and wrong to emit by default into
    // --json output that agents pipe into logs, so it is opt-in.
    const { rawItem, ...rest } = task;
    return {
      ...rest,
      ...(options.raw ? { rawItem } : {}),
      aliasName: alias || '',
      displayName: alias || task.taskName
    };
  });

  if (options.query) {
    const q = options.query.toLowerCase();
    tasks = tasks.filter(task => 
      task.taskId.toLowerCase().includes(q) ||
      task.taskName.toLowerCase().includes(q) ||
      (task.displayName && task.displayName.toLowerCase().includes(q)) ||
      task.sourcePath.toLowerCase().includes(q) ||
      task.destPath.toLowerCase().includes(q)
    );
  }

  if (options.oneTime !== undefined) {
    tasks = tasks.filter(t => t.isOneTime === options.oneTime);
  }

  const unknownCount = tasks.filter(t => t.status === 'Unknown').length;
  const warnings = [];
  if (unknownCount > 0) {
    warnings.push(`${unknownCount} task(s) have a status this CLI could not classify; they are excluded from the success rate.`);
  }

  // Truncation is applied last and reported. Counters describe the whole
  // matched set, so a capped array can never read as the whole account.
  const cap = Number(options.limit);
  const rows = Number.isFinite(cap) && cap > 0 ? tasks.slice(0, cap) : tasks;

  return {
    ok: true,
    totalCount: tasks.length,
    returnedCount: rows.length,
    limited: rows.length < tasks.length,
    successCount: tasks.filter(t => t.status === 'Success').length,
    failureCount: tasks.filter(t => t.status === 'Failure').length,
    syncingCount: tasks.filter(t => t.status === 'Syncing').length,
    pausedCount: tasks.filter(t => t.status === 'Paused').length,
    unknownCount,
    oneTimeCount: tasks.filter(t => t.isOneTime).length,
    recurringCount: tasks.filter(t => !t.isOneTime).length,
    warnings,
    tasks: rows
  };
}

/**
 * Resolve a user-supplied id / name / alias to exactly ONE task.
 *
 * Every mutating operation goes through this. It exists because the previous
 * code matched a rendered-text substring inside the browser and let
 * `Array.find` pick the first hit — so `delete "Photos Sync"` could delete
 * "Photos Sync v2", irreversibly. Matching is narrowed in precedence order and
 * an ambiguous query is refused rather than guessed.
 */
export async function resolveTask(taskIdOrName, options = {}) {
  const target = String(taskIdOrName ?? '').trim();
  if (!target) throw new Error('A task id, name, or alias is required.');

  const data = options.taskData || await listTasks();
  const all = data.tasks || [];
  const lower = target.toLowerCase();
  const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const tiers = [
    all.filter(t => t.taskId === target),
    all.filter(t => norm(t.taskName) === norm(target) || norm(t.aliasName) === norm(target)),
    all.filter(t => norm(t.taskName).includes(norm(target)) || norm(t.aliasName).includes(norm(target))),
    all.filter(t => norm(t.sourcePath).includes(lower) || norm(t.destPath).includes(lower))
  ];

  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) {
      const listed = tier.map(t => `  - ${t.taskId}  ${t.displayName || t.taskName}`).join('\n');
      throw new Error(
        `"${target}" matches ${tier.length} tasks. Re-run with the task id to disambiguate:\n${listed}`
      );
    }
  }

  throw new Error(`No task matches "${target}". Run \`multcloud tasks\` to list them.`);
}

/**
 * Deeply inspect a task card: extracts files, exact paths, execution logs, versions, and options.
 */
/**
 * The task status, or an honest admission that the page did not state one.
 *
 * This used to fall back to a hardcoded calm-sounding status, which invented
 * a confident, reassuring value
 * for a payload that carried no status at all. Measured 2026-08-31: two magnet
 * tasks listed as `Unknown` (correct -- the list payload has no status for
 * them) inspected as `Normal`, and I spent several steps treating "Normal" as
 * something MultCloud had said. It had not. A verdict with no input is
 * `Unknown`, never the benign end of the scale.
 */
export function taskStatusFromItem(item = {}) {
  if (item.statusTxt === 'Syncing' || item.status === 1) return 'Syncing';
  if (item.result === -1 || item.result === 0 || item.result === 2 || item.statusTxt === 'Failure' || item.statusTxt === 'Failed') return 'Failure';
  if (item.statusTxt === 'Paused') return 'Paused';
  if (item.result === 1 || item.statusTxt === 'Success') return 'Success';
  return item.statusTxt || 'Unknown';
}

export async function inspectTask(taskIdOrName) {
  let resolved;
  try {
    resolved = await resolveTask(taskIdOrName);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  await navigateToOrThrow('Task List', 'https://app.multcloud.com/mc_project/task_list');

  const aliases = getAliases();
  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const deadline = Date.now() + 10000;
    const targetId = ${jsv(resolved.taskId)};

    // One implementation, two runtimes: the SAME function source that Node
    // unit-tests is injected here, so the page cannot drift from the test.
    const statusOf = ${taskStatusFromItem.toString()};

    let comp = null;
    let list = [];

    while (Date.now() < deadline) {
      const all = Array.from(document.querySelectorAll('*')).map(e => e.__vue__).filter(Boolean);
      comp = all.find(c => (c.taskList && c.taskList.length > 0) || (c.$data?.taskList && c.$data.taskList.length > 0));
      if (comp) {
        list = comp.taskList || comp.$data.taskList;
        if (list && list.length > 0) break;
      }
      await sleep(150);
    }

    // Exact id only. The caller already resolved the name or alias to a single
    // task in Node, where an ambiguous query is refused instead of guessed.
    let item = null;
    if (list && list.length > 0) {
      item = list.find(t => t.id === targetId);
    }

    if (item && comp?.Utils) {
      // No hardcoded account id fallback: if the page has not exposed the user
      // object we cannot ask the backend for logs, and saying so beats
      // silently querying under somebody else's identifier.
      const user = comp.user || comp.$data?.user || null;

      // Fetch task full log details with timeout protection
      let logData = null;
      let logUnavailableReason = user ? '' : 'page did not expose the account context';
      if (user) {
        try {
          logData = await Promise.race([
            comp.Utils.doTasksRequest('get', { ud: user.id, type: item.type, id: item.id }),
            sleep(2000)
          ]);
        } catch (e) { logUnavailableReason = String(e && e.message || e); }
        if (!logData) logUnavailableReason = logUnavailableReason || 'log request timed out';
      }

      // Fetch backup versions if backup task with timeout protection
      let versionsData = null;
      if (user && (item.type === 6 || item.icon === 'cloudbackup')) {
        try {
          versionsData = await Promise.race([
            comp.Utils.doTasksRequest('list_versions', { ud: user.id, type: item.type, id: item.id }),
            sleep(2000)
          ]);
        } catch (e) {}
      }

      const isOneTime = !item.schedules || item.schedules.disabled === true || item.schedules.type === 'Now';
      let cadence = 'One-time Task';
      if (item.status === 1 || item.statusTxt === 'Syncing') cadence = 'Real-Time Continuous';
      else if (item.schedules && !item.schedules.disabled) {
        const type = item.schedules.type || 'Recurring';
        const times = (item.schedules.times || []).join(', ') || item.schedules.time || '';
        cadence = times ? \`\${type} \${times}\` : type;
      }

      const fromList = item.fromItem?.lists?.[0];
      const toList = item.toItem?.lists?.[0];

      return {
        ok: true,
        taskId: item.id,
        taskName: item.name?.trim() || '',
        type: item.icon || (item.type === 1 ? 'cloudTransfer' : item.type === 2 ? 'cloudSync' : item.type === 6 ? 'cloudBackup' : 'task'),
        status: statusOf(item),
        isOneTime,
        cadence,
        cronExpression: logData?.tasks?.[0]?.cronExpression || '',
        logUnavailableReason,
        runCount: logData?.tasks?.[0]?.runCount ?? (item.lastLog ? 1 : null),
        source: fromList?.nodes?.[fromList.nodes.length - 1]?.fileName || fromList?.filename || fromList?.name || '',
        sourcePath: fromList?.nodes?.map(n => n.fileName || n.filename).reverse().join('/') || fromList?.name || '',
        destination: toList?.nodes?.[toList.nodes.length - 1]?.fileName || toList?.filename || toList?.name || '',
        destPath: toList?.nodes?.map(n => n.fileName || n.filename).reverse().join('/') || toList?.name || '',
        lastLog: {
          response: item.lastLog?.response || 'success',
          taskStartTime: item.lastLog?.taskStartTimeStr || (item.lastLog?.taskStartTime ? new Date(item.lastLog.taskStartTime).toISOString() : ''),
          durationSeconds: item.lastLog?.taskElaspedTimeLong ? Math.round(item.lastLog.taskElaspedTimeLong / 1000) : 0,
          totalBytes: item.lastLog?.totalBytes || 0,
          totalFileCount: item.lastLog?.totalFileCount || 0,
          readyTranFileCount: item.lastLog?.readyTranFileCount || 0,
          errorList: item.lastLog?.errorList || []
        },
        options: item.options || {},
        versions: (versionsData?.backup_versions || []).map(v => ({
          versionNum: v.versionNum,
          createTime: v.createTime ? new Date(v.createTime).toISOString() : '',
          count: v.updateInfo?.conut || v.updateInfo?.count || 0,
          size: v.updateInfo?.size || 0
        }))
      };
    }

    return { ok: false, error: 'Task id no longer present in the task list: ' + targetId };
  })()`;

  const res = await evaluate(js);
  if (res && res.ok) {
    const alias = aliases[res.taskId];
    res.aliasName = alias || '';
    res.displayName = alias || res.taskName;
    if (alias) res.taskName = alias;
  }
  return res;
}

/**
 * Fetch execution logs for a task.
 */
export async function getTaskLogs(taskIdOrName) {
  const inspected = await inspectTask(taskIdOrName);
  if (!inspected.ok) return inspected;

  return {
    ok: true,
    taskId: inspected.taskId,
    taskName: inspected.taskName,
    status: inspected.status,
    runCount: inspected.runCount,
    cronExpression: inspected.cronExpression,
    sourcePath: inspected.sourcePath,
    destPath: inspected.destPath,
    lastLog: inspected.lastLog
  };
}

/**
 * Fetch backup versions for a backup task.
 */
export async function getTaskVersions(taskIdOrName) {
  const inspected = await inspectTask(taskIdOrName);
  if (!inspected.ok) return inspected;

  return {
    ok: true,
    taskId: inspected.taskId,
    taskName: inspected.taskName,
    versionCount: (inspected.versions || []).length,
    versions: inspected.versions || []
  };
}

/**
 * Fetch task transmission options / policy.
 */
export async function getTaskOptions(taskIdOrName) {
  const inspected = await inspectTask(taskIdOrName);
  if (!inspected.ok) return inspected;

  return {
    ok: true,
    taskId: inspected.taskId,
    taskName: inspected.taskName,
    options: inspected.options || {}
  };
}

/**
 * Trigger execution of a specific task immediately.
 */
export async function runTask(taskIdOrName, options = {}) {
  let resolved = options.task;
  if (!resolved) {
    const raw = String(taskIdOrName ?? '').trim();
    if (/^[0-9a-fA-F]{32}$/.test(raw)) {
      const aliases = getAliases();
      resolved = { taskId: raw, taskName: aliases[raw] || raw, displayName: aliases[raw] || raw };
    } else {
      resolved = await resolveTask(taskIdOrName);
    }
  }

  await navigateToOrThrow('Task List', 'https://app.multcloud.com/mc_project/task_list');

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const targetId = ${jsv(resolved.taskId)};

    const findCard = () => {
      const cards = Array.from(document.querySelectorAll('.grid-card, .el-card'));
      return cards.find(c => {
        const chk = c.querySelector('input');
        return chk && chk.value === targetId;
      });
    };

    const handleCard = (card) => {
      if (!card) return null;
      const playBtn = card.querySelector('.task-operate-play, .operate-menu-btn.task-operate-play, [class*="play"]');
      if (!playBtn) {
        const txt = card.querySelector('.status-txt-text')?.innerText?.trim() || '';
        const buttons = Array.from(card.querySelectorAll('button, .operate-menu-btn, [class*="btn"]'));
        const hasCancelOrPause = buttons.some(b => ['cancel', 'pause', '暂停', '取消'].some(w => (b.innerText || b.className || '').toLowerCase().includes(w)));
        const cardText = ((card.innerText || '') + ' ' + txt).toLowerCase();
        const isRunning = hasCancelOrPause || ['%', 'mb/s', 'kb/s', 'waiting', 'sync', 'transfer', 'progress', '运行', '传输', '等待'].some(w => cardText.includes(w));
        if (isRunning) {
          return { ok: true, action: 'already_running', taskId: targetId, message: '任务已处于运行或就绪状态 (' + (txt || '传输中') + ')' };
        }
        return { ok: false, error: 'Play button not found on the card for task ' + targetId };
      }
      playBtn.click();
      return { ok: true, action: 'started', taskId: targetId };
    };

    // Fast path: if card is already visible without scrolling, click immediately (avoids background-tab timer throttling)
    let card = findCard();
    if (card) {
      const res = handleCard(card);
      if (res) return res;
    }

    const scrollers = Array.from(document.querySelectorAll('.el-scrollbar__wrap, .task-list-box, body, html, #app'));
    scrollers.forEach(s => { s.scrollTop = 0; });

    for (let step = 0; step < 8; step++) {
      card = findCard();
      if (card) {
        const res = handleCard(card);
        if (res) return res;
      }

      if (scrollers[0]) {
        scrollers[0].scrollTop += 500;
        await sleep(300);
      }
    }

    return { ok: false, error: 'Task card not found for id ' + targetId };
  })()`;

  // Mutating: a timeout here may mean the click already landed, so this must
  // not be retried.
  const res = await evaluate(js, { idempotent: false });
  return { ...(res || {}), taskId: resolved.taskId, taskName: resolved.displayName || resolved.taskName };
}

/**
 * Retry every failed task.
 */
export async function retryFailedTasks() {
  const taskData = await listTasks({ status: 'failure' });
  const failed = taskData.tasks || [];

  if (failed.length === 0) {
    return { ok: true, totalFailed: 0, retriedCount: 0, results: [], message: 'No failed tasks found to retry.' };
  }

  const results = [];
  for (const task of failed) {
    try {
      // Pass the already-resolved task. Re-resolving by name here was how a
      // batch retry could start a different task than the one that failed.
      const res = await runTask(task.taskId, { task });
      results.push({ taskId: task.taskId, name: task.displayName || task.taskName, success: !!res.ok, error: res.ok ? undefined : res.error });
    } catch (e) {
      results.push({ taskId: task.taskId, name: task.displayName || task.taskName, success: false, error: e.message });
    }
  }

  const retriedCount = results.filter(r => r.success).length;
  return {
    ok: retriedCount === failed.length,
    totalFailed: failed.length,
    retriedCount,
    results
  };
}

/**
 * Delete a task.
 */
export async function deleteTask(taskIdOrName, confirm = false) {
  if (!confirm) {
    throw new Error('Deletion requires explicit confirmation (--yes flag)');
  }

  const resolved = await resolveTask(taskIdOrName);

  await navigateToOrThrow('Task List', 'https://app.multcloud.com/mc_project/task_list');

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const targetId = ${jsv(resolved.taskId)};

    const scrollers = Array.from(document.querySelectorAll('.el-scrollbar__wrap, .task-list-box, body, html, #app'));
    scrollers.forEach(s => { s.scrollTop = 0; });
    await sleep(400);

    let card = null;
    for (let step = 0; step < 8 && !card; step++) {
      // Deletion is irreversible: the victim is identified only by id.
      card = Array.from(document.querySelectorAll('.el-card.grid-card, .grid-card, .el-card')).find(c => {
        const chk = c.querySelector('input');
        return chk && chk.value === targetId;
      });
      if (!card && scrollers[0]) { scrollers[0].scrollTop += 500; await sleep(300); }
    }
    if (!card) return { ok: false, error: 'Task card not found for id ' + targetId };

    // Task cards come in TWO shapes, and only one has a menu.
    //
    //   transfer/sync/backup  a "..." trigger (.task-operate-menu) opening
    //                         three .operate-menu-item rows: View Logs,
    //                         Options, Delete.
    //   remote upload         no menu at all. The card carries a direct
    //   (linkTask)            button.white-button labelled Delete inside
    //                         .option-operate.
    //
    // Measured live 2026-08-31: requiring the menu made "tasks delete" fail on
    // every remote-upload task with "Task menu button not found", which reads
    // like a missing card rather than an unsupported card shape.
    //
    // Both branches search INSIDE the resolved card only. Every card on the
    // page carries its own Delete, so a document-wide search can irreversibly
    // delete a different task than the one that was asked for.
    const label = (e) => (e.textContent || '').trim();
    const dotBtn = card.querySelector('.task-operate-menu, .icon-more, [class*="more"]');
    let deleteOpt = null;
    let cardShape = null;

    if (dotBtn) {
      cardShape = 'menu';
      dotBtn.click();
      await sleep(500);

      // textContent, not innerText. The card menu is rendered but reports an
      // empty innerText (it is laid out off the card's own box), so matching on
      // innerText found nothing and every delete failed with "Delete option not
      // present in the task menu" while the option was sitting right there.
      const menuLabels = Array.from(card.querySelectorAll('.operate-menu-item'));
      deleteOpt = menuLabels.find(e => label(e) === 'Delete');
      if (!deleteOpt) {
        return { ok: false, error: 'Delete option not present in the task menu',
                 menu: menuLabels.map(label) };
      }
    } else {
      cardShape = 'direct';
      const direct = Array.from(card.querySelectorAll('button'))
        .filter(b => label(b) === 'Delete' && b.offsetWidth > 0);
      if (direct.length !== 1) {
        return { ok: false,
                 error: 'This task card has no menu and ' + direct.length + ' visible Delete buttons; refusing to guess which one to press',
                 controls: Array.from(card.querySelectorAll('button')).map(label) };
      }
      deleteOpt = direct[0];
    }
    deleteOpt.click();

    // Confirm ONLY inside the delete dialog. Every task card carries its own
    // "Delete" button, so a document-wide search for a button labelled Delete
    // can irreversibly delete a different task than the one that was asked for.
    let dialog = null;
    for (let i = 0; i < 25 && !dialog; i++) {
      const el = document.querySelector('#deleteTask');
      if (el && el.offsetWidth > 0 && /delete the task/i.test(el.textContent || '')) dialog = el;
      else await sleep(200);
    }
    if (!dialog) return { ok: false, error: 'Delete confirmation dialog (#deleteTask) never appeared' };

    const confirmBtn = Array.from(dialog.querySelectorAll('button'))
      .find(b => b.offsetWidth > 0 && ['Delete', 'Yes', 'OK'].includes((b.textContent || '').trim()));
    if (!confirmBtn) {
      return { ok: false, error: 'Delete confirmation button not found inside #deleteTask',
               dialogButtons: Array.from(dialog.querySelectorAll('button')).map(b => (b.textContent || '').trim()) };
    }
    confirmBtn.click();
    await sleep(1800);
    return { ok: true, deleted: targetId, cardShape };
  })()`;

  const res = await evaluate(js, { idempotent: false });

  // Read back: the task must actually be gone. The reply is not the receipt.
  let stillPresent = null;
  try {
    const after = await listTasks();
    stillPresent = (after.tasks || []).some(t => t.taskId === resolved.taskId);
  } catch (e) {
    stillPresent = null;
  }

  if (res && res.ok && stillPresent === true) {
    return { ok: false, taskId: resolved.taskId, error: 'The UI reported a delete but the task is still in the list.' };
  }
  if (res && res.ok && stillPresent === false) {
    dropAlias(resolved.taskId);
  }

  return {
    ...(res || {}),
    taskId: resolved.taskId,
    taskName: resolved.displayName || resolved.taskName,
    verifiedGone: stillPresent === false ? true : (stillPresent === null ? 'unknown' : false)
  };
}

export async function watchTask(taskIdOrName, options = {}) {
  const intervalSec = options.interval || 5;
  const maxRetries = options.maxRetries ?? 3;
  // A watch that cannot end is a watch that hangs a scheduled job forever.
  const maxWaitSec = options.maxWait ?? 3600;
  const onUpdate = options.onUpdate || (() => {});
  const startedAt = Date.now();
  let retriesCount = 0;

  const resolved = await resolveTask(taskIdOrName);

  while (true) {
    const info = await inspectTask(resolved.taskId);
    if (!info.ok) {
      throw new Error(`Failed to watch task: ${info.error}`);
    }

    const status = (info.status || '').toLowerCase();
    onUpdate({
      taskId: info.taskId,
      taskName: info.taskName,
      status: info.status,
      lastLog: info.lastLog,
      runCount: info.runCount
    });

    if (status === 'success') {
      return { ok: true, status: 'Success', task: info };
    }

    if (status === 'failure' || status === 'paused' || status === 'stopped') {
      if (retriesCount < maxRetries) {
        retriesCount++;
        onUpdate({
          type: 'retry_attempt',
          message: `Task "${info.taskName}" entered ${info.status}. Triggering auto-recovery (${retriesCount}/${maxRetries})...`
        });
        await runTask(resolved.taskId, { task: resolved });
      } else {
        return { ok: false, status: info.status, task: info, error: `Task reached ${info.status} after ${maxRetries} retries` };
      }
    }

    const elapsedSec = (Date.now() - startedAt) / 1000;
    if (elapsedSec >= maxWaitSec) {
      return {
        ok: false,
        status: info.status,
        task: info,
        timedOut: true,
        error: `Gave up after ${Math.round(elapsedSec)}s (maxWait ${maxWaitSec}s); last status was ${info.status}.`
      };
    }

    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }
}

/**
 * Rename a task.
 *
 * Two layers: a local alias registry that works for every task type, and a live
 * server-side rename that MultCloud only permits for transfer tasks. The return
 * value reports which of the two actually happened; it never claims the server
 * accepted a rename it refused.
 */
export async function renameTask(taskIdOrName, newName) {
  if (!newName || !newName.trim()) {
    throw new Error('New task name is required');
  }

  const cleanName = newName.trim();
  const resolved = await resolveTask(taskIdOrName);
  const info = await inspectTask(resolved.taskId);
  if (!info.ok) {
    throw new Error(`Task not found matching: ${taskIdOrName}`);
  }

  saveAlias(info.taskId, cleanName);

  let liveRename = null;
  let liveRenameError = '';
  try {
    await navigateToOrThrow('Task List', 'https://app.multcloud.com/mc_project/task_list');

    const js = `(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const targetId = ${jsv(info.taskId)};
      const cleanNewName = ${jsv(cleanName)};

      const scrollers = Array.from(document.querySelectorAll('.el-scrollbar__wrap, .task-list-box, body, html, #app'));
      scrollers.forEach(s => { s.scrollTop = 0; });
      await sleep(400);

      for (let scrollStep = 0; scrollStep < 10; scrollStep++) {
        const all = Array.from(document.querySelectorAll('*')).map(e => e.__vue__).filter(Boolean);
        const cards = all.filter(c => typeof c.editTaskListName === 'function' && typeof c.submitTaskListName === 'function');

        const card = cards.find(c => {
          const it = c.taskItem || c.item || c.task;
          return it && it.id === targetId;
        });

        if (card) {
          const it = card.taskItem || card.item || card.task;
          card.editTaskListName(it);
          card.showTaskName = cleanNewName;
          await sleep(200);
          await card.submitTaskListName(it);
          await sleep(1000);
          return { ok: true, name: it.name || cleanNewName };
        }

        if (scrollers[0]) {
          scrollers[0].scrollTop += 500;
          await sleep(400);
        }
      }

      return { ok: false, error: 'No renameable task card found for id ' + targetId };
    })()`;

    liveRename = await evaluate(js, { idempotent: false });
    if (liveRename && !liveRename.ok) liveRenameError = liveRename.error || '';
  } catch (e) {
    liveRenameError = e.message;
  }

  return {
    ok: true,
    taskId: info.taskId,
    oldName: info.taskName,
    newName: cleanName,
    aliasSaved: true,
    isLiveServerRenamed: liveRename?.ok || false,
    liveRenameError: liveRename?.ok ? '' : liveRenameError
  };
}

/**
 * Auto-recovery supervisor daemon: continuously or periodically monitors tasks,
 * detects Failure, Paused, or stalled states (0-100 B/s or frozen progress for stalledTimeout seconds),
 * and automatically triggers recovery / resume.
 */
export async function autoResumeTasks(options = {}) {
  const intervalSec = options.interval ?? 15;
  const maxRetries = options.maxRetries ?? Infinity;
  const stalledTimeoutSec = options.stalledTimeout ?? 180;
  const query = options.query || options.tasks || '';
  const once = !!options.once;
  const logFile = options.logFile || path.join(process.env.MULTCLOUD_HOME || path.join(process.env.HOME || '', '.multcloud'), 'auto_resume.log');
  const onUpdate = options.onUpdate || (() => {});
  const maxRuns = options.maxRuns ?? (once ? 1 : Infinity);

  try {
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {}

  const logEntry = (line) => {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${line}\n`;
    try {
      fs.appendFileSync(logFile, formatted, 'utf8');
    } catch (e) {}
  };

  logEntry(`Supervisor started: interval=${intervalSec}s, maxRetries=${maxRetries}, stalledTimeout=${stalledTimeoutSec}s, query="${query}"`);

  const state = {};
  let iterations = 0;
  const resumeHistory = [];

  while (iterations < maxRuns) {
    iterations++;
    let taskListRes;
    try {
      taskListRes = await listTasks(query ? { query } : {});
    } catch (err) {
      onUpdate({ type: 'error', message: `Failed to fetch tasks: ${err.message}` });
      logEntry(`ERROR: Failed to fetch tasks: ${err.message}`);
      if (once) return { ok: false, error: err.message };
      await new Promise(r => setTimeout(r, intervalSec * 1000));
      continue;
    }

    const tasks = taskListRes.tasks || [];
    const actionsTaken = [];
    const now = Date.now();

    for (const task of tasks) {
      const id = task.taskId;
      if (!id) continue;

      if (!state[id]) {
        state[id] = {
          retries: 0,
          lastRunTime: 0,
          lastStatus: task.status,
          lastProgress: task.progress,
          lastBytes: task.rawItem?.lastLog?.fileTotalReadedBytes || 0,
          lastChangeTime: now
        };
      }

      const st = state[id];
      const status = task.status;
      const currentBytes = task.rawItem?.lastLog?.fileTotalReadedBytes || 0;
      const currentProgress = task.progress;
      const currentSpeed = task.speed;

      if (currentProgress !== st.lastProgress || currentBytes !== st.lastBytes) {
        st.lastProgress = currentProgress;
        st.lastBytes = currentBytes;
        st.lastChangeTime = now;
      }

      let reason = null;

      if (status === 'Failure') {
        reason = 'task_failure';
      } else if (status === 'Paused') {
        reason = 'task_paused';
      } else if (status === 'Transferring') {
        const timeSinceChange = (now - st.lastChangeTime) / 1000;
        const speedStalled = currentSpeed === '0 B/s' || currentSpeed === '0B/s' || currentSpeed === '--';
        if (speedStalled && timeSinceChange >= stalledTimeoutSec) {
          reason = `stalled_transfer (${Math.round(timeSinceChange)}s without progress, speed: ${currentSpeed})`;
        }
      }

      if (reason) {
        // Cooldown: at least 10s between attempts on the same task
        if (now - st.lastRunTime < 10000) {
          continue;
        }

        if (st.retries >= maxRetries) {
          onUpdate({
            type: 'max_retries_reached',
            taskId: id,
            taskName: task.displayName || task.taskName,
            retries: st.retries,
            message: `Task "${task.displayName || task.taskName}" reached maximum retry limit (${st.retries}/${maxRetries})`
          });
          continue;
        }

        st.retries++;
        st.lastRunTime = now;
        st.lastChangeTime = now;

        const actionInfo = {
          taskId: id,
          taskName: task.displayName || task.taskName,
          reason,
          status,
          attempt: st.retries,
          timestamp: new Date().toISOString()
        };

        logEntry(`RESUME_TRIGGERED taskId=${id} name="${actionInfo.taskName}" reason="${reason}" status="${status}" attempt=${st.retries}`);
        onUpdate({
          type: 'resume_attempt',
          ...actionInfo,
          message: `Resuming "${actionInfo.taskName}" (${id}) due to ${reason} (attempt ${st.retries})`
        });

        try {
          const runRes = await runTask(id, { task });
          actionInfo.runResult = runRes;
          actionsTaken.push(actionInfo);
          resumeHistory.push(actionInfo);
          logEntry(`RESUME_RESULT taskId=${id} ok=${!!runRes?.ok} action=${runRes?.action || 'none'}`);
        } catch (runErr) {
          actionInfo.error = runErr.message;
          actionsTaken.push(actionInfo);
          resumeHistory.push(actionInfo);
          logEntry(`RESUME_ERROR taskId=${id} error="${runErr.message}"`);
          onUpdate({
            type: 'resume_error',
            taskId: id,
            error: runErr.message
          });
        }
      }
    }

    onUpdate({
      type: 'cycle_complete',
      iteration: iterations,
      tasksChecked: tasks.length,
      resumedCount: actionsTaken.length,
      actionsTaken
    });

    if (once || iterations >= maxRuns) {
      return {
        ok: true,
        inspectedCount: tasks.length,
        resumedCount: actionsTaken.length,
        actions: actionsTaken,
        tasks: tasks.map(t => ({ taskId: t.taskId, name: t.displayName || t.taskName, status: t.status }))
      };
    }

    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }

  return {
    ok: true,
    totalIterations: iterations,
    totalResumes: resumeHistory.length,
    resumeHistory
  };
}

export const watchAllTasks = autoResumeTasks;

