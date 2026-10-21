import fs from 'fs';
import { getAccountInfo } from './account.js';
import { listClouds } from './clouds.js';
import { listTasks, retryFailedTasks, runTask } from './tasks.js';
import { createTransfer } from './transfer.js';
import { createSync } from './sync.js';
import { createBackup } from './backup.js';
import { createRemoteUpload } from './remote_upload.js';
import { getStats } from './stats.js';
import { runDoctor } from './doctor.js';

/**
 * Execute an automated multi-step pipeline / flow.
 */
export async function executeFlow(flowInput) {
  let flow = flowInput;

  // If path to file, read and parse
  if (typeof flowInput === 'string') {
    if (fs.existsSync(flowInput)) {
      const content = fs.readFileSync(flowInput, 'utf-8');
      flow = JSON.parse(content);
    } else {
      try {
        flow = JSON.parse(flowInput);
      } catch (e) {
        throw new Error('Invalid flow input: must be a JSON string or path to a JSON file.');
      }
    }
  }

  const flowName = flow.name || 'Custom MultiCloud Flow';
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepName = step.name || `Step ${i + 1}: ${step.action}`;
    const action = step.action?.toLowerCase();
    const startedAt = Date.now();

    try {
      let stepOutput;
      switch (action) {
        case 'doctor':
        case 'check':
          stepOutput = await runDoctor();
          break;
        case 'stats':
        case 'metrics':
          stepOutput = await getStats();
          break;
        case 'account':
          stepOutput = await getAccountInfo();
          break;
        case 'clouds':
          stepOutput = await listClouds(step.options || {});
          break;
        case 'tasks':
          stepOutput = await listTasks(step.options || {});
          break;
        case 'retry_failed':
        case 'retry':
          stepOutput = await retryFailedTasks();
          break;
        case 'run_task':
        case 'run':
          stepOutput = await runTask(step.target || step.taskId || step.name);
          break;
        case 'transfer':
          stepOutput = await createTransfer({ from: step.from, to: step.to, name: step.name });
          break;
        case 'sync':
          stepOutput = await createSync({
            from: step.from,
            to: step.to,
            realtime: step.realtime || false,
            twoway: step.twoway || false,
            name: step.name
          });
          break;
        case 'backup':
          stepOutput = await createBackup({ from: step.from, to: step.to, name: step.name });
          break;
        case 'remote_upload':
        case 'download':
          stepOutput = await createRemoteUpload({ url: step.url, cloud: step.cloud, path: step.path });
          break;
        default:
          throw new Error(`Unknown flow action: "${step.action}"`);
      }

      // A step that returns `{ok:false}` is a failed step. Treating any
      // non-throwing call as SUCCESS is how a flow could report all-green while
      // every one of its actions declined to run.
      const declined = stepOutput && typeof stepOutput === 'object' && stepOutput.ok === false;
      results.push({
        step: i + 1,
        name: stepName,
        action,
        status: declined ? 'ERROR' : 'SUCCESS',
        success: !declined,
        duration: Date.now() - startedAt,
        error: declined ? (stepOutput.error || 'step reported ok:false') : undefined,
        result: stepOutput
      });
      if (declined && step.stopOnError !== false) break;
    } catch (err) {
      results.push({
        step: i + 1,
        name: stepName,
        action,
        status: 'ERROR',
        success: false,
        duration: Date.now() - startedAt,
        error: err.message
      });

      if (step.stopOnError !== false) {
        break;
      }
    }
  }

  const allSuccess = results.every(r => r.status === 'SUCCESS');

  return {
    ok: allSuccess,
    flowName,
    totalSteps: steps.length,
    completedSteps: results.length,
    successCount: results.filter(r => r.status === 'SUCCESS').length,
    passedSteps: results.filter(r => r.status === 'SUCCESS').length,
    errorCount: results.filter(r => r.status === 'ERROR').length,
    // `steps` is an alias for `results`: the CLI renderer read `res.steps` and
    // crashed with a TypeError on every non-JSON `flow` invocation.
    steps: results,
    results
  };
}

export const runFlow = executeFlow;
