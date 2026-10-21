import { cli, Strategy } from '@jackwener/opencli/registry';
import { runDoctor } from './src/doctor.js';

export const command = cli({
  site: 'multcloud',
  name: 'doctor',
  access: 'read',
  description: 'Run diagnostic health check on the MultCloud browser session, plan, cloud quota and task health',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  columns: [
    'ok',
    'score',
    'allHealthy',
    'checks'
  ],
  func: async () => {
    return await runDoctor();
  }
});
