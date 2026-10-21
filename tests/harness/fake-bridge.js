import { setTransport, resetTransport } from '../../src/client.js';

/**
 * A fake OpenCLI transport.
 *
 * It records EVERY argument it is handed, including ones no test reads yet. A
 * double whose signature accepts a value and silently drops it reads as
 * coverage while making the property untestable — which is how a wrong request
 * can sit behind a green suite.
 */
export function installFakeBridge(router) {
  const calls = [];

  setTransport(async (args, opts) => {
    const record = { args, opts, kind: args[2], payload: args[3] ?? null };
    calls.push(record);

    const reply = typeof router === 'function' ? router(record, calls) : router;
    if (reply === undefined || reply === null) {
      throw new Error(`fake bridge: no reply configured for ${JSON.stringify(args.slice(0, 3))}\npayload starts: ${String(record.payload).slice(0, 120)}`);
    }
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply), stderr: '' };
  });

  return {
    calls,
    /** Scripts sent to the browser, in order. */
    scripts: () => calls.filter(c => c.kind === 'eval').map(c => c.payload),
    /** URLs opened, in order. */
    opens: () => calls.filter(c => c.kind === 'open').map(c => c.payload),
    restore: () => resetTransport()
  };
}

/**
 * A router that answers the session/navigation chatter every module performs
 * before its real query, then delegates page reads to `handlers`.
 *
 * `handlers` is an array of `[substringOfScript, replyOrFn]`. The FIRST match
 * wins, so put specific patterns before general ones.
 */
export function pageRouter({ url = 'https://app.multcloud.com/mc_project/task_list', handlers = [] } = {}) {
  let currentUrl = url;

  return (record) => {
    if (record.kind === 'open') {
      currentUrl = record.payload;
      return { isOpen: true, url: currentUrl, isLoggedIn: true };
    }

    const script = String(record.payload || '');

    // ensureSession probe
    if (script.includes('isLoggedIn')) {
      return { isOpen: true, url: currentUrl, isLoggedIn: true };
    }
    // navigateTo current-location probe
    if (script.includes('() => location.href')) return currentUrl;
    // navigateTo sidebar click, matched on a marker unique to that script.
    // A generic `const wanted =` also matches any page script using the same
    // variable name, and when two did, this router swallowed them: once the
    // builder submit (three behavioural tests failed for reasons unrelated to
    // the code under test) and once the explorer delete (which then reported
    // `{clicked: false}` as its delete result).
    if (/const wantedSection = "/.test(script)) {
      const m = /const wantedSection = "((?:[^"\\]|\\.)*)"/.exec(script);
      const wanted = m ? m[1] : '';
      const routes = {
        'Task List': 'task_list',
        'Manage Clouds and Emails': 'home_page',
        'Cloud Transfer': 'cloud_transfer',
        'Cloud Sync': 'cloud_sync',
        'Cloud Backup': 'cloud_backup',
        'Remote Upload': 'remote_task',
        'Shares': 'shares'
      };
      if (routes[wanted]) {
        currentUrl = `https://app.multcloud.com/mc_project/${routes[wanted]}`;
        return { clicked: true };
      }
      return { clicked: false };
    }

    for (const [needle, reply] of handlers) {
      if (script.includes(needle)) {
        return typeof reply === 'function' ? reply(script, record) : reply;
      }
    }
    return undefined;
  };
}
