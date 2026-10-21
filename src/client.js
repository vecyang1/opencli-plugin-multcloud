import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export const SESSION_NAME = 'mc';
export const BASE_URL = 'https://app.multcloud.com';

/**
 * Normalize OpenCLI browser arguments for OpenCLI 2.0+ (`--session <name>`).
 */
export function formatOpenCliArgs(args) {
  return (args[0] === 'browser' && args[1] === SESSION_NAME)
    ? ['browser', '--session', SESSION_NAME, ...args.slice(2)]
    : args;
}

let _headlessBrowser = null;
let _headlessPage = null;
let _headlessInitPromise = null;
let _headlessIdleTimer = null;

function scheduleHeadlessIdleClose(ms = 5000) {
  if (_headlessIdleTimer) clearTimeout(_headlessIdleTimer);
  _headlessIdleTimer = setTimeout(() => {
    closeHeadlessSession().catch(() => {});
  }, ms);
  if (_headlessIdleTimer && typeof _headlessIdleTimer.unref === 'function') {
    _headlessIdleTimer.unref();
  }
}

export async function closeHeadlessSession() {
  if (_headlessIdleTimer) {
    clearTimeout(_headlessIdleTimer);
    _headlessIdleTimer = null;
  }
  const b = _headlessBrowser;
  _headlessBrowser = null;
  _headlessPage = null;
  _headlessInitPromise = null;
  if (b) {
    try { await b.close(); } catch (_) {}
  }
}

export function isHeadlessBackendEnabled() {
  const mode = (process.env.MULTCLOUD_BACKEND || '').toLowerCase().trim();
  if (mode === 'headless' || mode === 'puppeteer') return true;
  if (mode === 'opencli') return false;
  if (process.platform === 'linux') {
    const sessionPath = process.env.MULTCLOUD_SESSION_PATH || '/opt/multcloud-daemon/session.json';
    return fs.existsSync(sessionPath);
  }
  return false;
}

async function loadPuppeteer() {
  try {
    const mod = await import('puppeteer-core');
    return mod.default || mod;
  } catch (_) {
    const mod = await import('/opt/multcloud-daemon/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js');
    return mod.default || mod;
  }
}

async function getHeadlessPage() {
  if (_headlessPage && _headlessBrowser && _headlessBrowser.connected) {
    return _headlessPage;
  }
  if (_headlessInitPromise) return _headlessInitPromise;

  _headlessInitPromise = (async () => {
    const sessionPath = process.env.MULTCLOUD_SESSION_PATH || '/opt/multcloud-daemon/session.json';
    if (!fs.existsSync(sessionPath)) {
      throw new Error(
        `MultCloud headless session file not found at ${sessionPath}. ` +
        'Run: node /opt/multcloud-daemon/cli.js auth'
      );
    }
    const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const puppeteer = await loadPuppeteer();
    const chromePath = process.env.MULTCLOUD_CHROME_PATH || '/usr/bin/google-chrome';

    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    if (Array.isArray(sessionData.cookies) && sessionData.cookies.length > 0) {
      await page.setCookie(...sessionData.cookies);
    }
    if (sessionData.localStorage && typeof sessionData.localStorage === 'object') {
      await page.evaluateOnNewDocument((ls) => {
        for (const [k, v] of Object.entries(ls)) {
          localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
      }, sessionData.localStorage);
    }

    _headlessBrowser = browser;
    _headlessPage = page;
    _headlessInitPromise = null;
    return page;
  })().catch((err) => {
    _headlessInitPromise = null;
    throw err;
  });

  return _headlessInitPromise;
}

async function headlessTransport(args, { timeout = 30000 } = {}) {
  if (_headlessIdleTimer) {
    clearTimeout(_headlessIdleTimer);
    _headlessIdleTimer = null;
  }
  try {
    const page = await getHeadlessPage();
    const kind = args[2];
    const payload = args[3];

    if (kind === 'open') {
      try {
        await page.goto(payload, { waitUntil: 'networkidle2', timeout: Math.min(timeout, 30000) });
      } catch (err) {
        const msg = String(err.message || '');
        if (!msg.includes('timeout') && !msg.includes('destroyed')) throw err;
      }
      // Wait up to 6s for Vue root instance to hydrate and dismiss any promo modals
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          const closeBtns = document.querySelectorAll('#newSalePopup .close, .popup-close, .el-dialog__headerbtn');
          closeBtns.forEach(btn => { try { if (btn.offsetParent !== null) btn.click(); } catch (_) {} });
          const hasVue = Array.from(document.querySelectorAll('*')).some(e => e.__vue__);
          if (hasVue) break;
          await sleep(250);
        }
      }).catch(() => {});
      return { stdout: JSON.stringify({ isOpen: true, url: page.url() }), stderr: '' };
    }

    if (kind === 'eval') {
      let timer = null;
      const evalPromise = page.evaluate(payload);
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Headless evaluate timed out after ${timeout}ms`);
          err.killed = true;
          err.signal = 'SIGTERM';
          reject(err);
        }, timeout);
      });
      try {
        const val = await Promise.race([evalPromise, timeoutPromise]);
        const stdout = typeof val === 'string' ? val : JSON.stringify(val ?? null);
        return { stdout, stderr: '' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    throw new Error(`Unsupported transport command: ${JSON.stringify(args.slice(0, 3))}`);
  } finally {
    scheduleHeadlessIdleClose(5000);
  }
}

/**
 * The single chokepoint. Every module reaches the browser through `evaluate()`,
 * which reaches the outside world through exactly one transport function.
 *
 * Swapping the transport is the ONLY supported way to run this code without a
 * live browser (see `tests/harness/fake-bridge.js`). There is deliberately no
 * second path to the network — adding one would defeat the point.
 */
const realTransport = (args, { timeout }) => {
  if (isHeadlessBackendEnabled()) {
    return headlessTransport(args, { timeout });
  }
  const finalArgs = formatOpenCliArgs(args);
  return execFileAsync('opencli', finalArgs, {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OPENCLI_HEADLESS: 'true' }
  });
};

let transport = realTransport;

export function setTransport(fn) {
  transport = fn || realTransport;
}

export function resetTransport() {
  transport = realTransport;
}

export function isRealTransport() {
  return transport === realTransport;
}

/**
 * Execute an OpenCLI command.
 *
 * `idempotent` decides whether a failure may be retried. A read can be retried
 * freely; a write cannot, because a call that timed out client-side may already
 * have succeeded server-side and retrying it submits the mutation twice. Callers
 * that mutate MUST pass `idempotent: false`.
 */
export async function runOpenCli(args = [], options = {}) {
  const { timeout = 30000, idempotent = true } = typeof options === 'number'
    ? { timeout: options }
    : options;

  const maxAttempts = idempotent ? 3 : 1;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Forward idempotency so a transport (and the test double) can see it.
      return await transport(args, { timeout, idempotent, attempt });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  const detail = [lastErr.stdout, lastErr.stderr].filter(Boolean).join('\n').trim();
  const suffix = idempotent ? '' : ' (not retried: this call mutates remote state)';

  // `execFile` sets `killed` when it reaps the child on timeout, and its
  // message is "Command failed: <the entire command>" -- for a browser script
  // that is 300 lines with no stated cause, so a timeout, a page rejection and
  // a crash all read identically. Say which one happened, and keep the reason
  // short enough to be read. `detail` still carries the browser's own error.
  //
  // This message is raised from shared code, so it says only what every caller
  // shares: it does NOT guess which operation was slow.
  if (lastErr.killed) {
    throw new Error(
      `OpenCLI execution failed${suffix}: timed out after ${Math.round(timeout / 1000)}s ` +
      `waiting for the browser to answer. The page may still have been working; ` +
      `read state back before assuming nothing happened.${detail ? `\n${detail}` : ''}`
    );
  }

  const brief = String(lastErr.message || '').split('\n')[0].slice(0, 200);
  const needsVpsHint = /not connected|attach failed|extension|ENOENT/i.test(`${brief} ${detail}`);
  const vpsHint = needsVpsHint
    ? '\nHint: Local OpenCLI Browser Bridge is not connected. Pass --vps (or set MULTCLOUD_BACKEND=cloud) to execute against the 24/7 Cloud VPS session on multcloud-vps.'
    : '';
  throw new Error(`OpenCLI execution failed${suffix}: ${brief}${detail ? `\n${detail}` : ''}${vpsHint}`);
}

/**
 * Extract JSON from CLI stdout.
 *
 * OpenCLI prints unstructured warning lines ("⚠ Plugin foo: ...") before the
 * payload, and those lines can contain braces. Rather than trusting the first
 * `{` in the stream, try each plausible start offset and keep the first one that
 * parses to completion.
 */
export function extractJsonFromOutput(output) {
  if (output === null || output === undefined) return null;

  const text = String(output);
  if (!text.trim()) return null;

  const tryParse = (candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (e) { /* fall through */ }
    // Tolerate trailing noise after a complete payload.
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'), trimmed.lastIndexOf('"'));
    if (end > 0) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(0, end + 1)) };
      } catch (e) { /* fall through */ }
    }
    return { ok: false };
  };

  // Drop leading diagnostic lines one at a time. This handles every top-level
  // JSON type, not just objects and arrays: `location.href` comes back as a
  // bare JSON string, and scanning only for `[`/`{` returned null for it —
  // which silently disabled the "am I on the right page?" check.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const attempt = tryParse(lines.slice(i).join('\n'));
    if (attempt.ok) return attempt.value;
  }

  // Last resort: start at each bracket, in case the payload shares a line with
  // preceding noise.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' || text[i] === '{') {
      const attempt = tryParse(text.slice(i));
      if (attempt.ok) return attempt.value;
    }
  }

  // OpenCLI prints objects and arrays as JSON but scalars RAW: `location.href`
  // arrives as a bare, unquoted URL. Treat a single leftover line as the string
  // it is, once the bridge's own diagnostic lines are removed.
  const NOISE = /^\s*(?:[\u26a0\u2716\u2717\u2713\u2714]|warning:|error:)/i;
  const meaningful = text.split('\n')
    .filter(l => l.trim() && !NOISE.test(l));

  if (meaningful.length === 1) {
    const only = meaningful[0].trim();
    if (!only.startsWith('{') && !only.startsWith('[')) return only;
  }

  throw new Error(`Failed to parse JSON from bridge output: ${text.slice(0, 200)}...`);
}

/**
 * Ensure the MultCloud session is open and authenticated.
 * Returns `{ isOpen, isLoggedIn, url }`; never throws for "logged out".
 *
 * The recovery path used to return whatever `browser open` printed, which has
 * no `isLoggedIn` field at all — so a single transient probe failure made
 * `doctor` announce "Session on sign-in page or logged out" about a session
 * that was fine. Observed 2026-08-31: WARN on one run, PASS on the next, same
 * healthy tab. A field that is missing must read as unknown, not as false.
 */
const SESSION_PROBE_JS = `(() => {
  return {
    isOpen: location.href.includes('multcloud.com'),
    url: location.href,
    isLoggedIn: !location.href.includes('sign.html') && !location.href.includes('login.html')
  };
})()`;

export async function ensureSession() {
  const probe = async () => {
    const { stdout } = await runOpenCli(['browser', SESSION_NAME, 'eval', SESSION_PROBE_JS]);
    return extractJsonFromOutput(stdout);
  };

  try {
    const res = await probe();
    if (res && res.isOpen && res.isLoggedIn) return res;
  } catch (err) {
    // Session may not exist yet; fall through and open the home page.
  }

  await runOpenCli(['browser', SESSION_NAME, 'open', `${BASE_URL}/mc_project/home_page`]);
  await new Promise(r => setTimeout(r, 2000));

  // Re-probe. Reporting the `open` command's own output here was the defect:
  // it looks like a session state and answers none of the questions asked of it.
  try {
    const res = await probe();
    if (res && typeof res.isLoggedIn === 'boolean') return res;
  } catch (err) {
    // fall through to the honest unknown below
  }

  return { isOpen: null, isLoggedIn: null, url: null, probed: false };
}

/**
 * Evaluate JavaScript in the MultCloud browser context.
 * Pass `{ idempotent: false }` when the script mutates remote state.
 */
export async function evaluate(jsCode, options = {}) {
  const { idempotent = true, timeout } = options;
  await ensureSession();
  // `timeout` was accepted here and dropped, so every caller silently ran under
  // the 30s default. A magnet remote-upload does not fit in 30s -- MultCloud
  // resolves torrent metadata after the link is committed -- and the create
  // died mid-flow reporting no cause at all. Forward what the caller asked for.
  const { stdout } = await runOpenCli(
    ['browser', SESSION_NAME, 'eval', jsCode], { idempotent, timeout });
  return extractJsonFromOutput(stdout);
}

/**
 * Navigate to a MultCloud section and CONFIRM we arrived.
 *
 * `app.multcloud.com` is a single-page app whose creation routes
 * (`cloud_transfer`, `cloud_sync`, `cloud_backup`, `remote_task`) cannot be
 * reached by loading their URL: measured 2026-08-31, opening any of those four
 * URLs directly leaves the app on whichever route it already held. The previous
 * implementation preferred the URL and only clicked the sidebar as a fallback,
 * so every create command silently configured itself against the wrong page —
 * which is why `backup` could look for a source box that was never there.
 *
 * Order is therefore: already-there -> sidebar click -> URL as last resort, and
 * the result reports whether the expected route was actually reached so callers
 * can refuse to act on the wrong page.
 */
export async function navigateTo(sectionName, fallbackUrl = '') {
  await ensureSession();

  const expectedSlug = fallbackUrl ? (fallbackUrl.split('/mc_project/')[1] || '').split('?')[0] : '';
  const currentSlug = async () => {
    const href = await evaluate(`(() => location.href)()`);
    return typeof href === 'string' ? (href.split('/mc_project/')[1] || '').split('?')[0] : '';
  };

  if (expectedSlug && (await currentSlug()) === expectedSlug) {
    return { ok: true, slug: expectedSlug, method: 'already-there' };
  }

  // The variable name is part of this script's identity: the offline harness
  // recognises the navigation script by it, and a generic `wanted` collided
  // twice with page scripts that happened to use the same name, silently
  // swallowing them.
  const navJs = `(() => {
    const wantedSection = ${jsv(sectionName)};
    const menuEl = Array.from(document.querySelectorAll('.menu-option, .option-name, .side-menu a, .left-menu a'))
      .find(e => e.innerText && e.innerText.trim() === wantedSection);
    if (menuEl) {
      const clickTarget = menuEl.closest('.menu-option') || menuEl;
      clickTarget.click();
      return { clicked: true };
    }
    const el = Array.from(document.querySelectorAll('a, div, span, li'))
      .find(e => e.innerText && e.innerText.trim() === wantedSection);
    if (el) {
      const clickTarget = el.closest('.menu-option') || el;
      clickTarget.click();
      return { clicked: true };
    }
    return { clicked: false };
  })()`;

  const navRes = await evaluate(navJs);
  if (navRes && navRes.clicked) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!expectedSlug || (await currentSlug()) === expectedSlug) {
        return { ok: true, slug: expectedSlug, method: 'sidebar' };
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  if (fallbackUrl) {
    await runOpenCli(['browser', SESSION_NAME, 'open', fallbackUrl]);
    await new Promise(r => setTimeout(r, 2500));
    const landed = await currentSlug();
    if (!expectedSlug || landed === expectedSlug) {
      return { ok: true, slug: landed, method: 'url' };
    }
    return {
      ok: false,
      slug: landed,
      method: 'url',
      error: `Could not reach "${sectionName}": expected /mc_project/${expectedSlug} but the app is on /mc_project/${landed || 'unknown'}.`
    };
  }

  return { ok: false, slug: '', method: 'none', error: `Could not reach "${sectionName}".` };
}

/**
 * Navigate, or throw. Use this before any action that mutates remote state:
 * acting on the wrong page is how a create command silently does nothing.
 */
export async function navigateToOrThrow(sectionName, fallbackUrl = '') {
  const res = await navigateTo(sectionName, fallbackUrl);
  if (!res.ok) throw new Error(res.error || `Could not reach "${sectionName}".`);
  return res;
}

/**
 * Embed a value into a script string that will be sent to the browser.
 *
 * The previous idiom escaped single quotes only, so a value ending in a
 * backslash closed the literal and everything after it executed as code — a
 * task name is enough to reach this, and task names come from the page. See
 * `tests/injection.test.js`, which asserts the exploit is inert.
 */
export function jsv(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
