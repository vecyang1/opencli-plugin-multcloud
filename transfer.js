import { cli, Strategy } from '@jackwener/opencli/registry';
import { createTransfer } from './src/transfer.js';

export const command = cli({
  site: 'multcloud',
  name: 'transfer',
  access: 'write',
  description: 'Create a cloud-to-cloud file transfer task in MultCloud',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'from', positional: true, required: true, help: 'Source cloud drive name' },
    { name: 'to', positional: true, required: true, help: 'Destination cloud drive name' },
    { name: 'name', type: 'string', required: false, help: 'Optional custom task name' }
  ],
  // Columns are the module's ACTUAL return keys, measured, not guessed. This
  // list previously named fields the module has never returned (blank columns
  // forever) and omitted `verified`, which is the whole point of the read-back:
  // it is what separates "the button was clicked" from "a task exists".
  columns: ['action', 'from', 'to', 'taskName', 'taskId', 'verified'],
  func: async (kwargs = {}) => {
    return await createTransfer({
      from: kwargs.from,
      to: kwargs.to,
      name: kwargs.name
    });
  }
});
