import { evaluate, navigateToOrThrow, jsv } from './client.js';
import { listDrives } from './explorer.js';

/**
 * Human-readable label for MultCloud's internal `cloudName` / `driveType`.
 * Derived from the page's own vocabulary rather than guessed from the drive's
 * display name, which users are free to call anything.
 */
const TYPE_LABELS = {
  baiDu: 'Baidu Netdisk',
  gmail: 'Gmail',
  google_drive: 'Google Drive',
  google_drive_sharedWithMe: 'Google Drive (Shared)',
  gSuite: 'Google Workspace',
  googlePhotos: 'Google Photos',
  oneDriveV2: 'OneDrive',
  oneDrive4Business: 'OneDrive for Business',
  dropbox: 'Dropbox',
  box: 'Box',
  mega: 'MEGA'
};

const UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Format a byte count the way MultCloud does. `null` in, `null` out. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes === 0) return '0Bytes';
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)}${UNITS[i]}`;
}

const normName = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * List every connected cloud drive or email account, with quota where the page
 * has it.
 *
 * Two things were wrong here and both made the output quietly incomplete:
 *
 * 1. The roster came from scraping the DOM for anything whose text contained
 *    `TB/`, `GB/`, `MB/` or the word `Failed`. The Manage Clouds page renders
 *    drives in THREE places — `.cloud-box` cards, `.home-cloud` cards and the
 *    sidebar `.menu-option` list — and which drive lands in which changes
 *    between loads. Measured 2026-08-31: the account has **21** drives and this
 *    command reported **12**, a different twelve on different runs, while
 *    `stats` summed storage over that subset and called it the account total.
 *    The roster now comes from the page's own `clouds` array via `listDrives`.
 *
 * 2. The word `Failed` was reported as `status: Failed` and `doctor` turned it
 *    into "N cloud drive(s) have expired OAuth tokens". It is not an auth
 *    signal. It is the QUOTA lookup, shown in the same slot that otherwise
 *    holds the account email, and it flips between runs. Measured 2026-08-31,
 *    at a moment when the sidebar marked 13 of 21 drives `Failed`:
 *
 *      OneDrive 1        Failed  -> transferred FROM it, task Success
 *      Google Drive 2   Failed  -> transferred TO it, wrote and deleted
 *      Shared Drive 1               Failed  -> listed 197 entries
 *      Google Drive 3             Failed  -> listed (drive is simply empty)
 *      Google Photos 1 yang@ …     Failed  -> listed Albums / Photos
 *
 *    So this module reports `quota: 'ok' | 'unavailable'` and claims nothing
 *    about OAuth, because nothing on this page says anything about OAuth.
 */
export async function listClouds(options = {}) {
  const roster = await listDrives();   // navigates to Manage Clouds and Emails

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const txt = (e) => e ? String(e.textContent || '').replace(/\\s+/g, ' ').trim() : '';

    // Give the lazily-loaded capacity cards a moment, but never wait on them:
    // several never resolve, and a timeout is not a value.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const boxes = document.querySelectorAll('.cloud-box').length;
      const loading = Array.from(document.querySelectorAll('.drive-capacity')).filter(e => txt(e) === 'Loading').length;
      if (boxes > 0 && loading === 0) break;
      await sleep(300);
    }

    const capacities = Array.from(document.querySelectorAll('.cloud-box')).map(e => ({
      name: txt(e.querySelector('.drive-bold-name')),
      capacity: txt(e.querySelector('.drive-capacity'))
    })).filter(x => x.name);

    // The sidebar shows the account email, or the word "Failed" when the quota
    // lookup did not come back. Same slot, two very different meanings.
    const sidebar = Array.from(document.querySelectorAll('.menu-option')).map(o => ({
      name: txt(o.querySelector('.option-title')) || txt(o).split(' ')[0],
      full: txt(o),
      desc: txt(o.querySelector('.option-desc'))
    })).filter(x => x.desc);

    return { ok: true, capacities, sidebar };
  })()`;

  const page = (await evaluate(js)) || {};
  const capByName = new Map((page.capacities || []).map(c => [normName(c.name), c.capacity]));
  const sidebar = page.sidebar || [];

  let clouds = (roster.drives || []).map(d => {
    const key = normName(d.name);
    const rendered = capByName.get(key) || '';
    const side = sidebar.find(s => normName(s.full).startsWith(key)) || null;
    const desc = side ? side.desc : '';

    const usedBytes = Number.isFinite(d.usedBytes) ? d.usedBytes : null;
    const totalBytes = Number.isFinite(d.totalBytes) ? d.totalBytes : null;

    // Prefer the page model's exact bytes; fall back to the rendered string.
    let used = usedBytes === null ? null : formatBytes(usedBytes);
    let total = totalBytes === null ? null : formatBytes(totalBytes);
    let capacity = (used && total) ? `${used}/${total}` : null;
    if (!capacity && rendered && rendered !== 'Loading' && rendered !== 'Failed') {
      const [u, t] = rendered.split('/');
      used = (u || '').trim() || null;
      total = (t || '').trim() || null;
      capacity = rendered;
    }

    const quota = capacity ? 'ok' : (desc === 'Failed' || rendered === 'Failed' ? 'unavailable' : 'unknown');

    return {
      name: d.name,
      id: d.id,
      type: TYPE_LABELS[d.driveType] || d.driveType || 'Cloud Storage',
      driveType: d.driveType,
      email: desc && desc !== 'Failed' && desc.includes('@') ? desc : '',
      usedBytes,
      totalBytes,
      used,
      total,
      capacity,
      capacityKnown: !!capacity,
      // What the page actually told us. It says nothing about OAuth — see the
      // module comment; five drives marked "unavailable" were read successfully
      // in the same minute.
      quota
    };
  });

  if (options.status) {
    const raw = String(options.status).toLowerCase();
    const alias = { active: 'ok', failed: 'unavailable', ok: 'ok', unavailable: 'unavailable', unknown: 'unknown' };
    const want = alias[raw];
    if (!want) {
      throw new Error(
        `Unknown --status "${options.status}" for clouds. This filter now selects on quota readability, ` +
        `not on OAuth health, because the page does not report OAuth health. Use: ok | unavailable | unknown.`
      );
    }
    clouds = clouds.filter(c => c.quota === want);
  }

  if (options.query) {
    const q = options.query.toLowerCase();
    clouds = clouds.filter(c => c.name.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q));
  }

  const unreadable = clouds.filter(c => !c.capacityKnown);
  const warnings = unreadable.length > 0
    ? [`MultCloud did not return a quota for ${unreadable.length} of ${clouds.length} drive(s): ` +
       `${unreadable.map(c => c.name).join(', ')}. Storage totals derived from this list are a floor, not a total. ` +
       `This is a quota lookup, not an authorization check — such a drive is usually still readable and writable.`]
    : [];

  // Truncation is applied last and reported, so a caller can never mistake a
  // capped array for the whole account. Counters stay whole.
  const matched = clouds.length;
  const cap = Number(options.limit);
  const rows = Number.isFinite(cap) && cap > 0 ? clouds.slice(0, cap) : clouds;

  return {
    ok: true,
    totalCount: matched,
    count: matched,
    returnedCount: rows.length,
    limited: rows.length < matched,
    quotaOkCount: clouds.filter(c => c.quota === 'ok').length,
    quotaUnavailableCount: clouds.filter(c => c.quota === 'unavailable').length,
    quotaUnknownCount: clouds.filter(c => c.quota === 'unknown').length,
    capacityUnreadableCount: unreadable.length,
    rosterSource: roster.source,
    warnings,
    clouds: rows
  };
}

/**
 * Rename a connected cloud drive via the 3-dots menu in Manage Clouds and Emails.
 */
export async function renameCloud(oldName, newName) {
  await navigateToOrThrow('Manage Clouds and Emails', 'https://app.multcloud.com/mc_project/add_cloud');

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const targetName = ${jsv(oldName)};
    const nextName = ${jsv(newName)};

    const cards = Array.from(document.querySelectorAll('.drive-items, [class*="drive-item"], .el-card, [data-v-045b41fc]')).filter(c => c.innerText && c.innerText.includes(targetName));
    const card = cards.find(c => c.innerText.includes(targetName));
    if (!card) return { ok: false, error: 'Cloud drive card not found: ' + targetName };

    const dotBtn = card.querySelector('.icon-more, [class*="more"], .el-dropdown, [class*="menu"]') || card.querySelector('i, div:last-child');
    if (dotBtn) dotBtn.click();
    await sleep(600);

    const renameOpt = Array.from(document.querySelectorAll('.menu-option, div, li, span')).find(e => e.innerText && e.innerText.trim() === 'Rename');
    if (renameOpt) {
      renameOpt.click();
      await sleep(600);

      const input = document.querySelector('input.el-input__inner, input[type="text"]');
      if (input) {
        input.value = nextName;
        input.dispatchEvent(new Event('input', { bubbles: true }));

        const okBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && b.innerText.trim() === 'OK');
        if (okBtn) {
          okBtn.click();
          await sleep(1500);
          return { ok: true, oldName: targetName, newName: nextName };
        }
      }
    }

    return { ok: false, error: 'Could not trigger cloud rename' };
  })()`;

  return await evaluate(js);
}

/**
 * Extract technical properties and quota metadata for a specific cloud drive.
 */
export async function getCloudProperties(cloudName) {
  const data = await listClouds({ query: cloudName });
  const cloud = data.clouds.find(c => c.name.toLowerCase().includes(cloudName.toLowerCase()));

  if (!cloud) {
    throw new Error(`Cloud drive not found matching: "${cloudName}"`);
  }

  return {
    ok: true,
    name: cloud.name,
    type: cloud.type,
    status: cloud.status,
    capacity: cloud.capacity,
    used: cloud.used,
    total: cloud.total,
    capacityKnown: cloud.capacityKnown,
    details: cloud.summary
  };
}
