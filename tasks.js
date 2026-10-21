import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  listTasks, inspectTask, getTaskLogs, getTaskVersions, getTaskOptions,
  runTask, retryFailedTasks, deleteTask, renameTask
} from './src/tasks.js';

/**
 * OpenCLI loads adapters written with the cli() registry API. This file used
 * the commander-style `export default function (cli)` shape, which OpenCLI
 * silently does not load — so `opencli multcloud tasks`, the command printed
 * in the README, the skill and the capability card, answered
 * "unknown command 'tasks'" for its whole existence.
 */
export const command = cli({
  site: 'multcloud',
  name: 'tasks',
  access: 'write',
  description: 'List, inspect, run, rename, retry and delete MultCloud transfer/sync/backup tasks',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'subcommand', positional: true, required: false, help: 'list | inspect | logs | versions | options | run | retry-failed | rename | delete (default: list)' },
    { name: 'target', positional: true, required: false, help: 'Task id, name, or alias' },
    { name: 'newName', positional: true, required: false, help: 'New name, for rename' },
    { name: 'status', type: 'string', required: false, help: 'Filter by status' },
    { name: 'type', type: 'string', required: false, help: 'Filter by type: transfer|sync|backup|remote' },
    { name: 'query', type: 'string', required: false, help: 'Filter by keyword' },
    { name: 'raw', type: 'boolean', required: false, help: 'Include the raw page model' },
    { name: 'yes', type: 'boolean', required: false, help: 'Confirm a delete' },
    { name: 'limit', help: 'Return at most N rows' }
  ],
  columns: ['totalCount', 'successCount', 'failureCount', 'syncingCount', 'unknownCount', 'warnings', 'tasks'],
  func: async (kwargs = {}) => {
    const sub = kwargs.subcommand || 'list';
    const target = kwargs.target;
    switch (sub) {
      case 'inspect': return await inspectTask(target);
      case 'logs': return await getTaskLogs(target);
      case 'versions': return await getTaskVersions(target);
      case 'options': return await getTaskOptions(target);
      case 'run': return await runTask(target);
      case 'retry-failed': return await retryFailedTasks();
      case 'rename': return await renameTask(target, kwargs.newName);
      case 'delete': return await deleteTask(target, !!kwargs.yes);
      case 'list':
      default:
        return await listTasks({
          status: kwargs.status, type: kwargs.type, query: kwargs.query, raw: !!kwargs.raw, limit: kwargs.limit
        });
    }
  }
});
