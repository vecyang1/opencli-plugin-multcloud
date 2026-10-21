import { cli, Strategy } from '@jackwener/opencli/registry';
import { createSync } from './src/sync.js';

export const command = cli({
  site: 'multcloud',
  name: 'sync',
  access: 'write',
  description: 'Create a cloud-to-cloud file sync task in MultCloud',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'from', positional: true, required: true, help: 'Source cloud drive name' },
    { name: 'to', positional: true, required: true, help: 'Destination cloud drive name' },
    { name: 'realtime', type: 'bool', default: false, help: 'Enable real-time continuous sync' },
    { name: 'twoway', type: 'bool', default: false, help: 'Enable two-way bidirectional sync' },
    { name: 'name', type: 'string', required: false, help: 'Optional custom task name' }
  ],
  // Columns are the module's ACTUAL return keys, measured, not guessed. This
  // list previously named fields the module has never returned (blank columns
  // forever) and omitted `verified`, which is the whole point of the read-back:
  // it is what separates "the button was clicked" from "a task exists".
  columns: ['action', 'from', 'to', 'mode', 'twoway', 'taskId', 'verified'],
  func: async (kwargs = {}) => {
    return await createSync({
      from: kwargs.from,
      to: kwargs.to,
      realtime: kwargs.realtime,
      twoway: kwargs.twoway,
      name: kwargs.name
    });
  }
});
