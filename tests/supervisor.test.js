import '../tests/harness/sandbox.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { generatePlistContent, getSupervisorStatus, readSupervisorLogs, SUPERVISOR_LABEL } from '../src/supervisor.js';

describe('Supervisor module & diagnostics', () => {
  it('generates valid launchd plist content', () => {
    const plist = generatePlistContent({ interval: 120, query: 'Avatar' });
    assert.match(plist, /<key>Label<\/key>/);
    assert.match(plist, new RegExp(`<string>${SUPERVISOR_LABEL}<\/string>`));
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
    assert.match(plist, /<string>auto-resume<\/string>/);
    assert.match(plist, /<string>--once<\/string>/);
    assert.match(plist, /<string>--query<\/string>\s*<string>Avatar<\/string>/);
  });

  it('reports diagnostic status when uninstalled', async () => {
    const status = await getSupervisorStatus();
    assert.equal(status.ok, true);
    assert.equal(status.label, SUPERVISOR_LABEL);
    assert.ok('installed' in status);
    assert.ok('loaded' in status);
    assert.ok('logPath' in status);
    assert.ok(Array.isArray(status.recentResumes));
  });

  it('reads supervisor logs cleanly', () => {
    const logPath = path.join(process.env.MULTCLOUD_HOME, 'auto_resume.log');
    fs.writeFileSync(logPath, '[2026-09-21T10:00:00Z] Line 1\n[2026-09-21T10:01:00Z] RESUME_TRIGGERED id-1\n');
    const res = readSupervisorLogs(10);
    assert.equal(res.ok, true);
    assert.equal(res.logs.length, 2);
    assert.match(res.logs[1], /RESUME_TRIGGERED/);
  });
});
