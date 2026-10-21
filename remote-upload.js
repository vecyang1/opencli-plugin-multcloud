import { cli, Strategy } from '@jackwener/opencli/registry';
import { createRemoteUpload } from './src/remote_upload.js';

export const command = cli({
  site: 'multcloud',
  name: 'remote-upload',
  access: 'write',
  description: 'Add an offline remote upload task (HTTP/HTTPS/Magnet link) to a connected cloud drive',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'url', positional: true, required: true, help: 'Download URL or Magnet link' },
    { name: 'cloud', type: 'string', required: true, help: 'Target cloud drive name' },
    { name: 'path', type: 'string', required: false, help: 'Folder inside the target drive' }
  ],
  // Columns are the module's ACTUAL return keys, measured, not guessed. This
  // list previously named fields the module has never returned (blank columns
  // forever) and omitted `verified`, which is the whole point of the read-back:
  // it is what separates "the button was clicked" from "a task exists".
  columns: ['action', 'url', 'targetCloud', 'targetPath', 'taskId', 'verified'],
  func: async (kwargs = {}) => {
    return await createRemoteUpload({
      url: kwargs.url,
      targetCloud: kwargs.cloud,
      targetPath: kwargs.path
    });
  }
});
