import { cli, Strategy } from '@jackwener/opencli/registry';
import { listDrives, listExplorerFiles, renameExplorerItem, deleteExplorerItem } from './src/explorer.js';

export const command = cli({
  site: 'multcloud',
  name: 'explorer',
  access: 'write',
  description: 'Browse, rename and delete files in MultCloud Cloud Explorer',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'subcommand', positional: true, required: false, help: 'drives | list | rename | delete (default: list)' },
    { name: 'cloud', positional: true, required: false, help: 'Cloud drive name' },
    { name: 'folder', positional: true, required: false, help: 'Folder path inside the drive' },
    { name: 'itemName', positional: true, required: false, help: 'File or folder name' },
    { name: 'newName', positional: true, required: false, help: 'New name, for rename' },
    { name: 'yes', type: 'boolean', required: false, help: 'Confirm a delete (required)' }
  ],
  columns: ['ok', 'cloud', 'currentPath', 'count', 'files'],
  func: async (kwargs = {}) => {
    const sub = kwargs.subcommand || 'list';
    if (sub === 'drives') return await listDrives();
    if (sub === 'rename') return await renameExplorerItem(kwargs.cloud, kwargs.folder || '', kwargs.itemName, kwargs.newName);
    if (sub === 'delete' || sub === 'rm') return await deleteExplorerItem(kwargs.cloud, kwargs.folder || '', kwargs.itemName, !!kwargs.yes);
    return await listExplorerFiles(kwargs.cloud, kwargs.folder || '');
  }
});
