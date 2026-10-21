import { cli, Strategy } from '@jackwener/opencli/registry';
import { getStats } from './src/stats.js';

export const command = cli({
  site: 'multcloud',
  name: 'stats',
  access: 'read',
  description: 'View aggregate storage metrics, success rates, and cloud health stats',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  columns: [
    'account',
    'storage',
    'clouds',
    'tasks'
  ],
  func: async () => {
    return await getStats();
  }
});
