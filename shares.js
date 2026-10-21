import { cli, Strategy } from '@jackwener/opencli/registry';
import { listShares } from './src/shares.js';

export const command = cli({
  site: 'multcloud',
  name: 'shares',
  access: 'read',
  description: 'List all shared files and shared links in MultCloud',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  columns: [
    'fileName',
    'type',
    'size',
    'sharedOn',
    'allowUpload'
  ],
  func: async () => {
    const res = await listShares();
    return res.shares || [];
  }
});
