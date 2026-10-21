import { getStats } from './stats.js';
import { ensureSession, evaluate, isHeadlessBackendEnabled } from './client.js';


/** A healthy round trip adds well under this to an in-page sleep. */
const TIMER_SLACK_MS = 5000;

/**
 * Is the browser tab's clock being throttled?
 *
 * Chrome intensively throttles timers in a hidden tab. Measured 2026-08-31: an
 * in-page `setTimeout(2000)` took **116 seconds** of wall clock while the
 * MultCloud tab sat in the background. Every create command sleeps in-page
 * between steps, so a hidden tab silently turns them into a bridge timeout at
 * ~115s whose message says nothing about visibility -- three live magnet runs
 * were lost to it before anyone timed a sleep.
 *
 * `observedMs === null` means the probe never came back at all, which is the
 * throttled case seen from behind a client timeout.
 */
export function classifyTimerLatency(requestedMs, observedMs) {
  if (observedMs === null || observedMs === undefined) return 'throttled';
  return observedMs > requestedMs + TIMER_SLACK_MS ? 'throttled' : 'ok';
}

/**
 * Health check & diagnostic doctor for MultCloud agentic toolchain.
 */
export async function runDoctor() {
  const checks = [];

  // Check 1: Session Bridge (Desktop OpenCLI 2.0 or Cloud Headless Session)
  const headless = isHeadlessBackendEnabled();
  const bridgeLabel = headless
    ? 'Headless Cloud Session (puppeteer-core + session.json)'
    : 'OpenCLI Browser Bridge (127.0.0.1:19825)';
  let sessionState;
  try {
    sessionState = await ensureSession();
    checks.push({
      name: bridgeLabel,
      status: 'PASS',
      details: headless ? 'Connected to active Headless Chrome session' : 'Connected to active Chrome session'
    });
  } catch (err) {
    checks.push({
      name: headless ? 'Headless Cloud Session' : 'OpenCLI Browser Bridge',
      status: 'FAIL',
      details: `Bridge connection failed: ${err.message}`
    });
    return { ok: false, score: '0%', checks };
  }

  // Check 1b: is the page's clock real?
  const PROBE_MS = 400;
  let observedMs = null;
  const probeStart = Date.now();
  try {
    await evaluate(`(async () => { await new Promise(r => setTimeout(r, ${PROBE_MS})); return true; })()`,
      { timeout: 15000 });
    observedMs = Date.now() - probeStart;
  } catch (err) {
    observedMs = null;
  }
  if (classifyTimerLatency(PROBE_MS, observedMs) === 'ok') {
    checks.push({
      name: 'Browser Tab Responsiveness',
      status: 'PASS',
      details: `Page timers run at full speed (${PROBE_MS}ms slept in ${observedMs}ms round trip)`
    });
  } else {
    checks.push({
      name: 'Browser Tab Responsiveness',
      status: 'WARN',
      details: `Page timers are throttled${observedMs === null ? ' (the probe did not return)' : ` (${PROBE_MS}ms slept took ${observedMs}ms)`}. ` +
        'Chrome does this to a hidden tab. Reads still work, but every create command sleeps between ' +
        'steps and will exceed the bridge\'s ~115s limit. Bring the Chrome window holding the ' +
        'MultCloud tab to the front before running transfer/sync/backup/remote-upload.'
    });
  }

  // Check 2: MultCloud Web Auth
  if (sessionState && sessionState.isLoggedIn === true) {
    checks.push({
      name: 'MultCloud Web Authentication',
      status: 'PASS',
      details: `Logged in on ${sessionState.url || 'app.multcloud.com'}`
    });
  } else if (sessionState && sessionState.isLoggedIn === false) {
    checks.push({
      name: 'MultCloud Web Authentication',
      status: 'WARN',
      details: `Session is on a sign-in page (${sessionState.url || 'unknown URL'}). Log in to app.multcloud.com in the "mc" Chrome session.`
    });
  } else {
    // Not the same thing, and the difference matters: the previous version said
    // "logged out" whenever the probe itself failed to answer.
    checks.push({
      name: 'MultCloud Web Authentication',
      status: 'WARN',
      details: 'Could not determine the session state — the page did not answer the probe. This is not evidence that you are logged out.'
    });
  }

  // Check 3: Live Stats & Tokens
  try {
    const stats = await getStats();
    
    // Plan
    checks.push({
      name: 'Subscription Plan',
      status: 'PASS',
      details: `${stats.account.plan} (Traffic Used: ${stats.account.trafficUsed} / ${stats.account.trafficTotal})`
    });

    // Cloud quota readability.
    //
    // This check used to read MultCloud's "Failed" label as an expired OAuth
    // token and tell the user to re-authorize. It is a quota lookup: on
    // 2026-08-31 it marked 13 of 21 drives Failed, including two that a
    // transfer had just successfully read from and written to in the same
    // minute. Saying "your token expired" about a working drive sends the user
    // to fix something that is not broken, so this now reports only what the
    // page actually stated.
    const unavailable = stats.clouds.quotaUnavailable + stats.clouds.quotaUnknown;
    if (unavailable === 0) {
      checks.push({
        name: 'Cloud Quota Readability',
        status: 'PASS',
        details: `All ${stats.clouds.total} connected cloud accounts reported a quota`
      });
    } else {
      const names = stats.clouds.quotaUnavailableList;
      checks.push({
        name: 'Cloud Quota Readability',
        status: 'WARN',
        details: `${unavailable} of ${stats.clouds.total} drive(s) did not report a quota: ` +
                 `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}. ` +
                 `Storage totals are a floor. This is not an authorization check — such a drive is usually still usable.`
      });
    }

    // Task Execution
    if (stats.tasks.failure === 0) {
      checks.push({
        name: 'Transfer & Sync Task Health',
        status: 'PASS',
        details: `All ${stats.tasks.total} tasks passing (Success Rate: ${stats.tasks.successRate})`
      });
    } else {
      checks.push({
        name: 'Transfer & Sync Task Health',
        status: 'WARN',
        details: `${stats.tasks.failure} task(s) in failed state. Run 'multcloud tasks retry-failed' to recover.`
      });
    }

    const passedCount = checks.filter(c => c.status === 'PASS').length;
    const score = `${Math.round((passedCount / checks.length) * 100)}%`;

    return {
      ok: true,
      score,
      allHealthy: stats.clouds.quotaUnavailable === 0 && stats.clouds.quotaUnknown === 0 && stats.tasks.failure === 0,
      checks,
      stats
    };
  } catch (err) {
    checks.push({
      name: 'Data Extraction',
      status: 'FAIL',
      details: err.message
    });
    return { ok: false, score: '50%', checks };
  }
}
