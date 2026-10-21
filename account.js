import { cli, Strategy } from '@jackwener/opencli/registry';
import { getAccountInfo } from './src/account.js';

/**
 * Thin adapter. The extraction lives in src/account.js and nowhere else — this
 * file used to carry its own copy of the page-scraping logic, which drifted:
 * it still reported the string 'Unknown' where the owning module now reports
 * null, so the two entry points disagreed about the same account.
 */
export const command = cli({
  site: 'multcloud',
  name: 'account',
  access: 'read',
  description: 'View MultCloud account status, subscription plan, and data traffic quota',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  columns: ['plan', 'trafficUsed', 'trafficTotal', 'trafficSummary', 'trafficKnown', 'user', 'url'],
  func: async () => await getAccountInfo()
});
