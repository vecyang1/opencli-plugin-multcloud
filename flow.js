import { cli, Strategy } from '@jackwener/opencli/registry';
import { executeFlow } from './src/flow.js';

export const command = cli({
  site: 'multcloud',
  name: 'flow',
  access: 'write',
  description: 'Execute a declarative multi-step automation workflow across MultCloud tasks',
  domain: 'app.multcloud.com',
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'input', positional: true, required: true, help: 'Workflow JSON file path or JSON string' }
  ],
  columns: [
    'ok',
    'flowName',
    'totalSteps',
    'completedSteps',
    'successCount',
    'errorCount',
    'results'
  ],
  func: async (kwargs = {}) => {
    return await executeFlow(kwargs.input);
  }
});
