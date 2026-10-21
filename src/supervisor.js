import fs from 'fs';
import path from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const SUPERVISOR_LABEL = 'com.vec.multcloud-auto-resume';

export function getSupervisorPlistPath() {
  const home = process.env.HOME || '';
  return path.join(home, 'Library', 'LaunchAgents', `${SUPERVISOR_LABEL}.plist`);
}

export function getSupervisorLogPath() {
  const home = process.env.MULTCLOUD_HOME || path.join(process.env.HOME || '', '.multcloud');
  return path.join(home, 'auto_resume.log');
}

export function generatePlistContent(options = {}) {
  const interval = options.interval || 180;
  const nodeBin = process.execPath;
  const projectRoot = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
  const binScript = path.join(projectRoot, 'bin', 'multcloud.js');
  const multcloudHome = process.env.MULTCLOUD_HOME || path.join(process.env.HOME || '', '.multcloud');
  const stdoutLog = path.join(multcloudHome, 'daemon.stdout.log');
  const stderrLog = path.join(multcloudHome, 'daemon.stderr.log');
  const query = options.query || '';

  const args = [nodeBin, binScript, 'tasks', 'auto-resume', '--once'];
  if (query) {
    args.push('--query', query);
  }

  const argsXml = args.map(a => `        <string>${a}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SUPERVISOR_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartInterval</key>
    <integer>${interval}</integer>
    <key>StandardOutPath</key>
    <string>${stdoutLog}</string>
    <key>StandardErrorPath</key>
    <string>${stderrLog}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${path.join(process.env.HOME || '', '.local', 'bin')}</string>
        <key>HOME</key>
        <string>${process.env.HOME || ''}</string>
        <key>MULTCLOUD_HOME</key>
        <string>${multcloudHome}</string>
    </dict>
</dict>
</plist>
`;
}

export async function installSupervisorDaemon(options = {}) {
  const plistPath = getSupervisorPlistPath();
  const plistDir = path.dirname(plistPath);
  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  const logPath = getSupervisorLogPath();
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Unload previous version if running
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
  } catch (e) {}

  const content = generatePlistContent(options);
  fs.writeFileSync(plistPath, content, 'utf8');

  try {
    execSync(`launchctl load -w "${plistPath}"`);
  } catch (e) {
    return { ok: false, error: `Failed to load launchd daemon: ${e.message}`, plistPath };
  }

  return {
    ok: true,
    action: 'daemon_installed',
    label: SUPERVISOR_LABEL,
    plistPath,
    interval: options.interval || 180,
    query: options.query || 'all'
  };
}

export async function uninstallSupervisorDaemon() {
  const plistPath = getSupervisorPlistPath();
  let unloaded = false;

  try {
    execSync(`launchctl unload -w "${plistPath}" 2>/dev/null || true`);
    unloaded = true;
  } catch (e) {}

  let removed = false;
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    removed = true;
  }

  return {
    ok: true,
    action: 'daemon_uninstalled',
    label: SUPERVISOR_LABEL,
    unloaded,
    removed
  };
}

export async function getSupervisorStatus() {
  const plistPath = getSupervisorPlistPath();
  const logPath = getSupervisorLogPath();
  const installed = fs.existsSync(plistPath);

  let loaded = false;
  let pid = null;
  let lastExitStatus = null;

  try {
    const out = execSync(`launchctl list | grep "${SUPERVISOR_LABEL}" || true`, { encoding: 'utf8' }).trim();
    if (out) {
      loaded = true;
      const parts = out.split(/\s+/);
      if (parts[0] !== '-') pid = Number(parts[0]);
      if (parts[1] !== '-') lastExitStatus = Number(parts[1]);
    }
  } catch (e) {}

  let recentActions = [];
  let totalResumes = 0;
  let lastCycleTime = null;
  let recentLogs = [];

  if (fs.existsSync(logPath)) {
    try {
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      recentLogs = lines.slice(-20);

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!lastCycleTime && line.includes('Supervisor started')) {
          const m = line.match(/^\[(.*?)\]/);
          if (m) lastCycleTime = m[1];
        }
        if (line.includes('RESUME_TRIGGERED')) {
          totalResumes++;
          if (recentActions.length < 10) {
            recentActions.push(line);
          }
        }
      }
    } catch (e) {}
  }

  return {
    ok: true,
    label: SUPERVISOR_LABEL,
    installed,
    loaded,
    pid,
    lastExitStatus,
    plistPath: installed ? plistPath : null,
    logPath,
    lastCycleTime,
    totalResumesRecorded: totalResumes,
    recentResumes: recentActions,
    recentLogs
  };
}

export function readSupervisorLogs(maxLines = 50) {
  const logPath = getSupervisorLogPath();
  if (!fs.existsSync(logPath)) {
    return { ok: true, logs: [], logPath, message: 'Log file does not exist yet.' };
  }
  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    return {
      ok: true,
      logPath,
      totalLines: lines.length,
      logs: lines.slice(-maxLines)
    };
  } catch (e) {
    return { ok: false, error: e.message, logPath };
  }
}
