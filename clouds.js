import { cli, Strategy } from '@jackwener/opencli/registry';
import { listClouds, renameCloud, getCloudProperties } from './src/clouds.js';

export const command = cli({
  site: 'multcloud',
  name: 'clouds',
  access: 'write',
  description: 'List connected cloud storage & email accounts, or rename / inspect one',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'subcommand', positional: true, required: false, help: 'list | rename | properties (default: list)' },
    { name: 'target', positional: true, required: false, help: 'Cloud drive name' },
    { name: 'newName', positional: true, required: false, help: 'New name, for rename' },
    { name: 'status', type: 'string', required: false, help: 'Filter by quota readability: ok|unavailable|unknown' },
    { name: 'limit', help: 'Return at most N rows' },
    { name: 'query', type: 'string', required: false, help: 'Filter by name or email' }
  ],
  columns: ['totalCount', 'quotaOkCount', 'quotaUnavailableCount', 'capacityUnreadableCount', 'warnings', 'clouds'],
  func: async (kwargs = {}) => {
    const sub = kwargs.subcommand || 'list';
    if (sub === 'rename') return await renameCloud(kwargs.target, kwargs.newName);
    if (sub === 'properties' || sub === 'info') return await getCloudProperties(kwargs.target);
    return await listClouds({ status: kwargs.status, query: kwargs.query, limit: kwargs.limit });
  }
});
