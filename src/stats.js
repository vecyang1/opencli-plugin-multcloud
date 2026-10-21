import { getAccountInfo } from './account.js';
import { listClouds } from './clouds.js';
import { listTasks } from './tasks.js';

/**
 * Generate comprehensive operational statistics and health metrics for MultCloud.
 * Executes sequentially to avoid browser tab navigation race conditions.
 */
export async function getStats() {
  const account = await getAccountInfo();
  const cloudsRes = await listClouds();
  const tasksRes = await listTasks();

  const tasks = tasksRes.tasks || [];
  const clouds = cloudsRes.clouds || [];

  // Storage totals come from the page model's exact byte counts. They used to
  // be re-parsed out of the FORMATTED capacity string, which threw away
  // precision and silently contributed 0 for any unit the parser did not know.
  const BYTES_PER_TB = 1024 ** 4;
  let totalStorageBytes = 0;
  let usedStorageBytes = 0;
  let countedDrives = 0;
  const uncountedDrives = [];

  for (const c of clouds) {
    if (Number.isFinite(c.usedBytes) && Number.isFinite(c.totalBytes)) {
      countedDrives++;
      usedStorageBytes += c.usedBytes;
      totalStorageBytes += c.totalBytes;
    } else {
      uncountedDrives.push(c.name);
    }
  }

  const totalStorageTB = totalStorageBytes / BYTES_PER_TB;
  const usedStorageTB = usedStorageBytes / BYTES_PER_TB;

  const successCount = tasks.filter(t => t.status === 'Success').length;
  const failureCount = tasks.filter(t => t.status === 'Failure').length;
  const syncingCount = tasks.filter(t => t.status === 'Syncing').length;
  const pausedCount = tasks.filter(t => t.status === 'Paused').length;
  const partialCount = tasks.filter(t => t.status === 'Partial Success').length;
  const unknownCount = tasks.filter(t => t.status === 'Unknown' || (!['Success', 'Failure', 'Syncing', 'Paused', 'Partial Success'].includes(t.status))).length;
  const totalTasks = tasks.length;
  const successRate = totalTasks > 0 ? ((successCount / totalTasks) * 100).toFixed(1) : '100.0';

  // Aggregates carry their own warnings so `--json` stays clean while a human
  // still learns the totals are a floor.
  const warnings = [
    ...(cloudsRes.warnings || []),
    ...(tasksRes.warnings || [])
  ];
  if (countedDrives === 0 && clouds.length > 0) {
    warnings.push('Capacity could not be read for ANY drive; storage totals below are not a measurement. Re-run once the Manage Clouds page has finished rendering.');
  } else if (uncountedDrives.length > 0) {
    warnings.push(`Storage totals exclude ${uncountedDrives.length} drive(s) with no readable capacity: ${uncountedDrives.join(', ')}.`);
  }

  const storageMeasured = countedDrives > 0;

  return {
    ok: true,
    warnings,
    account: {
      plan: account.plan,
      trafficUsed: account.trafficUsed,
      trafficTotal: account.trafficTotal,
      trafficKnown: account.trafficKnown !== false
    },
    storage: {
      measured: storageMeasured,
      drivesCounted: countedDrives,
      drivesUncounted: uncountedDrives.length,
      totalCapacityTB: storageMeasured ? totalStorageTB.toFixed(2) : null,
      usedCapacityTB: storageMeasured ? usedStorageTB.toFixed(2) : null,
      freeCapacityTB: storageMeasured ? (totalStorageTB - usedStorageTB).toFixed(2) : null,
      utilizationPercent: storageMeasured && totalStorageTB > 0 ? ((usedStorageTB / totalStorageTB) * 100).toFixed(1) : null
    },
    clouds: {
      total: clouds.length,
      // Quota readability, NOT authorization health. MultCloud shows the word
      // "Failed" in the slot that otherwise holds the account email when its
      // quota lookup does not return; drives marked that way were measured on
      // 2026-08-31 to be fully readable and writable. See `src/clouds.js`.
      quotaOk: clouds.filter(c => c.quota === 'ok').length,
      quotaUnavailable: clouds.filter(c => c.quota === 'unavailable').length,
      quotaUnknown: clouds.filter(c => c.quota === 'unknown').length,
      quotaUnavailableList: clouds.filter(c => c.quota !== 'ok').map(c => c.name)
    },
    tasks: {
      total: totalTasks,
      success: successCount,
      failure: failureCount,
      syncing: syncingCount,
      paused: pausedCount,
      partial: partialCount,
      unknown: unknownCount,
      successRate: `${successRate}%`,
      successRateNote: unknownCount > 0
        ? `${unknownCount} task(s) with an unclassified status count against this rate.`
        : '',
      failedList: tasks.filter(t => t.status === 'Failure').map(t => ({ id: t.taskId, name: t.taskName }))
    }
  };
}

export const getAggregatedStats = getStats;
