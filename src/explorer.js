import { evaluate, navigateToOrThrow, jsv } from './client.js';

/**
 * Cloud Explorer.
 *
 * Drives used to be listed here as a hardcoded map of seven MultCloud
 * `tokenId` values belonging to one account, with an unconditional fallback to
 * the Baidu drive. Two problems: those identifiers were account data committed
 * to source, and any drive outside the map was silently browsed as Baidu while
 * the output was labelled with the drive the user asked for. The page publishes
 * its own drive array, so we read it instead (verified live 2026-08-31: entries
 * carry `name`, `id`, `driveType`, `rootId`).
 */
/**
 * Vue data keys that hold a drive array on the Manage Clouds page. `clouds` is
 * the complete roster; the other two are progressive views of it and are read
 * only to fill gaps.
 */
const DRIVE_ARRAY_KEYS = ['clouds', 'allLoadDrivesArr', 'allDrivesArr'];

/**
 * Read every connected drive, with the identifiers needed to address it.
 *
 * Drives used to be listed here as a hardcoded map of seven MultCloud
 * `tokenId` values belonging to one account, with an unconditional fallback to
 * the Baidu drive. That was replaced by reading the page's own array — but by
 * taking the FIRST key that held a non-empty array, in the order
 * `allDrivesArr, allLoadDrivesArr, clouds`.
 *
 * Those arrays are not the same list. Measured live 2026-08-31 on one page
 * load: `allDrivesArr` 0, `allLoadDrivesArr` **15**, `clouds` **21**. The
 * fifteen are the drives loaded so far, so six real drives — every OneDrive and
 * both Google Photos accounts — were missing, and `explorer list "OneDrive0
 * @personal"` answered `No connected drive matches` while listing fifteen
 * others as if that settled it. Worse, membership changes between page loads,
 * so the same command answered differently minutes apart.
 *
 * We therefore merge every array we can see, keyed by id, and report which
 * sources contributed.
 */
export async function listDrives() {
  await navigateToOrThrow('Manage Clouds and Emails', 'https://app.multcloud.com/mc_project/home_page');

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const keys = ${jsv(DRIVE_ARRAY_KEYS)};
    const deadline = Date.now() + 10000;

    const collect = () => {
      const byId = new Map();
      const sources = [];
      const comps = Array.from(document.querySelectorAll('*')).map(e => e.__vue__).filter(Boolean);
      for (const key of keys) {
        let seen = 0;
        for (const c of comps) {
          let v;
          try { v = (c && c[key] !== undefined) ? c[key] : (c && c.$data ? c.$data[key] : undefined); } catch (e) { continue; }
          if (!Array.isArray(v) || !v.length) continue;
          seen += v.length;
          for (const d of v) {
            if (!d) continue;
            const info = d.driveInfo || {};
            const id = d.id || d.keyId || info.id || '';
            const name = String(d.name || info.name || d.cloudName || d.showName || '').trim();
            if (!id || !name) continue;
            if (byId.has(id)) continue;
            byId.set(id, {
              name,
              id,
              driveType: d.driveType || info.cloudName || d.type || '',
              rootId: d.rootId || info.rootId || '/',
              // Bytes, straight from the page model, or null when this drive's
              // quota has not been fetched. Never 0 — that is a real answer.
              usedBytes: Number.isFinite(info.usedSpace) ? info.usedSpace : null,
              totalBytes: Number.isFinite(info.totalSpace) ? info.totalSpace : null
            });
          }
        }
        if (seen) sources.push(key);
      }
      return { drives: Array.from(byId.values()), sources };
    };

    let best = collect();
    while (Date.now() < deadline && best.drives.length === 0) {
      await sleep(250);
      best = collect();
    }
    if (!best.drives.length) return { ok: false, error: 'The page did not expose a drive list.' };
    return { ok: true, source: best.sources.join('+'), sources: best.sources, drives: best.drives };
  })()`;

  const res = await evaluate(js);
  if (!res || !res.ok) {
    throw new Error(res?.error || 'Could not read the connected drive list.');
  }
  return res;
}

/**
 * Resolve a drive name to exactly one drive. Ambiguity is refused, not guessed,
 * and an unknown name is an error rather than a silent fallback.
 */
export async function resolveDrive(cloudName) {
  const target = String(cloudName ?? '').trim();
  if (!target) throw new Error('A cloud drive name is required.');

  const { drives } = await listDrives();
  const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const tiers = [
    drives.filter(d => d.id === target),
    drives.filter(d => norm(d.name) === norm(target)),
    drives.filter(d => norm(d.name).includes(norm(target)))
  ];

  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) {
      throw new Error(
        `"${target}" matches ${tier.length} drives. Use the exact name:\n` +
        tier.map(d => `  - ${d.name}`).join('\n')
      );
    }
  }

  throw new Error(
    `No connected drive matches "${target}". Available:\n` +
    drives.map(d => `  - ${d.name}`).join('\n')
  );
}

/**
 * Open Cloud Explorer on a specific drive.
 */
export async function openExplorer(cloudName) {
  const drive = await resolveDrive(cloudName);
  const url = `https://app.multcloud.com/mc_project/cloud_exploer`
    + `?cloudType=${encodeURIComponent(drive.driveType)}`
    + `&folderId=${encodeURIComponent(drive.rootId || '/')}`
    + `&folderName=${encodeURIComponent(drive.name)}`
    + `&tokenId=${encodeURIComponent(drive.id)}`;

  await navigateToOrThrow(`Cloud Explorer (${drive.name})`, url);
  await new Promise(r => setTimeout(r, 2000));
  return { ok: true, url, drive };
}

/**
 * List files and folders for a drive path.
 */
export async function listExplorerFiles(cloudName, folderPath = '') {
  const { drive } = await openExplorer(cloudName);

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const targetPath = ${jsv(folderPath)};

    for (let i = 0; i < 25; i++) {
      if (document.querySelectorAll('tr, .table-tr, .el-table__row').length > 1) break;
      await sleep(200);
    }

    if (targetPath && targetPath !== '/') {
      const parts = targetPath.split('/').filter(Boolean);
      for (const part of parts) {
        const rows = Array.from(document.querySelectorAll('tr, .table-tr, .el-table__row'));
        const targetRow = rows.find(r => r.innerText && r.innerText.includes(part));
        if (!targetRow) return { ok: false, error: 'Folder not found on the path: ' + part };
        targetRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await sleep(2000);
      }
    }

    const rows = Array.from(document.querySelectorAll('tr.table-tr, tr.el-table__row, tr')).filter(r => {
      const text = r.innerText?.trim() || '';
      return text && !text.includes('File Name') && !text.includes('Date Modified') && !text.includes('Type Size') && !text.includes('Add Cloud');
    });

    const files = rows.map(r => {
      const nameDiv = r.querySelector('.name-edit-div, [class*="file-name"], [class*="name"]');
      const name = nameDiv?.innerText?.trim() || r.innerText.split('\\n')[0].trim();
      const isFolder = !!r.querySelector('.folder, [class*="folder"]') || !r.innerText.includes('.');
      const tds = Array.from(r.querySelectorAll('.cloud-td-twoDiv, td'));
      return {
        name,
        type: isFolder ? 'folder' : 'file',
        size: tds[0]?.innerText?.trim() || '--',
        date: tds[1]?.innerText?.trim() || '--'
      };
    }).filter(f => f.name && f.name.length > 1 && f.name !== 'Type Size' && f.name !== 'File Name');

    const breadcrumb = Array.from(document.querySelectorAll('.navigation-path span, [class*="breadcrumb"] span')).map(e => e.innerText?.trim()).filter(Boolean);

    return { ok: true, currentPath: breadcrumb.join('/') || '', count: files.length, files };
  })()`;

  const res = await evaluate(js);
  // The drive name comes from the resolver, never from the caller's spelling:
  // labelling one drive's listing with another drive's name is how the old
  // Baidu fallback produced confidently mislabelled output.
  return { ...(res || {}), cloud: drive.name, driveId: drive.id, currentPath: res?.currentPath || drive.name };
}

/**
 * Find exactly one row by name inside the currently open folder.
 * Shared by rename and delete so both refuse ambiguity identically.
 */
function rowResolverScript(itemName) {
  return `
    const wantedItem = ${jsv(itemName)};
    const norm = (v) => String(v || '').trim();
    const rows = Array.from(document.querySelectorAll('tr.table-tr, tr.el-table__row, tr'));
    const named = rows.map(r => {
      const nameDiv = r.querySelector('.name-edit-div, [class*="file-name"], [class*="name"]');
      // textContent, not innerText: innerText depends on layout and this page
      // reports it as empty for several controls that are plainly on screen.
      const name = norm(nameDiv ? nameDiv.textContent : '') || norm((r.textContent || '').split('\\n')[0]);
      return { row: r, name };
    }).filter(x => x.name);

    let hits = named.filter(x => x.name === wantedItem);
    if (hits.length === 0) hits = named.filter(x => x.name.includes(wantedItem));
    if (hits.length === 0) return { ok: false, error: 'Item not found in this folder: ' + wantedItem };
    if (hits.length > 1) return { ok: false, error: hits.length + ' items match "' + wantedItem + '": ' + hits.map(h => h.name).join(', ') + '. Use the exact name.' };
    var targetRow = hits[0].row;
    var resolvedName = hits[0].name;
  `;
}

/**
 * Rename a file or folder.
 */
export async function renameExplorerItem(cloudName, folderPath, oldName, newName) {
  if (!oldName || !newName) throw new Error('Both the current name and the new name are required.');
  await listExplorerFiles(cloudName, folderPath);

  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    ${rowResolverScript(oldName)}
    const nextName = ${jsv(newName)};

    targetRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await sleep(600);

    const renameOpt = Array.from(document.querySelectorAll('.menu-item, li, [class*="menu"]')).find(e => e.innerText && e.innerText.trim() === 'Rename');
    if (!renameOpt) return { ok: false, error: 'Rename option not found in the context menu' };
    renameOpt.click();
    await sleep(600);

    const input = targetRow.querySelector('input.name-input, input');
    if (!input) return { ok: false, error: 'Rename input not found' };
    input.value = nextName;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(1500);
    return { ok: true, oldName: resolvedName, newName: nextName };
  })()`;

  return await evaluate(js, { idempotent: false });
}

/**
 * Delete a file or folder.
 *
 * `confirm` is required. This deletes real files in the user's cloud storage
 * and previously had no gate at all, while its sibling `deleteTask` did.
 */
export async function deleteExplorerItem(cloudName, folderPath, itemName, confirm = false) {
  if (!confirm) {
    throw new Error('Deleting a cloud file or folder requires explicit confirmation (--yes flag)');
  }
  if (!itemName) throw new Error('An item name is required.');

  await listExplorerFiles(cloudName, folderPath);

  /*
   * Cloud Explorer deletes through the toolbar, not through a context menu.
   *
   * The previous implementation dispatched a `contextmenu` event and then
   * searched the whole document for anything reading "Delete" via `innerText`.
   * The event does open a menu, but the search matched an unrelated element,
   * the confirmation search matched an unrelated button, and the function
   * returned `{ok: true, deleted: <name>}` having removed nothing — three times
   * in a row against a live drive, with no read-back to contradict it.
   *
   * Measured live 2026-08-31:
   *   row            `tr.table-tr`; selected rows carry `tr-back-ground` and
   *                  their check icon flips `nocheck-small` -> `check-small`
   *   select         click `.tr-check-box` on the row
   *   toolbar        `button.single-button` whose textContent is "Delete"
   *   confirm dialog `#delete` inside `.popup`, one button reading "Delete(N)"
   *                  where N is the number of selected items
   */
  const js = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const vis = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0;
    ${rowResolverScript(itemName)}

    const dataRows = () => Array.from(document.querySelectorAll('tr.table-tr'));
    const rowName = (r) => {
      const n = r.querySelector('.name-edit-div');
      return n ? String(n.textContent || '').trim() : '';
    };
    const isSelected = (r) => (' ' + r.className + ' ').indexOf(' tr-back-ground ') !== -1;

    // Exactly one row may be selected when Delete is pressed: the toolbar acts
    // on the SELECTION, not on the row that was resolved.
    for (const r of dataRows()) {
      if (rowName(r) === resolvedName) continue;
      if (!isSelected(r)) continue;
      const box = r.querySelector('.tr-check-box');
      if (box) { box.click(); await sleep(300); }
    }
    if (!isSelected(targetRow)) {
      const box = targetRow.querySelector('.tr-check-box');
      if (!box) return { ok: false, error: 'No selection control on the row for ' + resolvedName };
      box.click();
      await sleep(600);
    }

    const chosen = dataRows().filter(isSelected).map(rowName);
    if (chosen.length !== 1 || chosen[0] !== resolvedName) {
      return { ok: false, error: 'Refusing to delete: the selection is ' + JSON.stringify(chosen) +
                                 ' but the target is ' + JSON.stringify(resolvedName) };
    }

    const toolbarDelete = Array.from(document.querySelectorAll('button.single-button'))
      .find(b => (b.textContent || '').trim() === 'Delete' && vis(b));
    if (!toolbarDelete) return { ok: false, error: 'Toolbar Delete button not found' };
    toolbarDelete.click();

    // Wait for the BUTTON, not merely for the dialog. Its label is computed
    // from the selection, so the dialog exists for a moment with the count not
    // yet rendered — long enough for a check that only waited on the container
    // to report "confirmation button not found" on a dialog that was fine.
    // Parsed, not matched. A regex literal written here passes through a
    // template literal first, which eats one level of backslashes: the version
    // that read /^Delete\\(\\d+\\)$/ in the editor reached the page as
    // /^Delete(d+)$/ and matched nothing, so a dialog that was open, visible and
    // correct was reported as having no confirm button.
    const deleteCount = (raw) => {
      const t = String(raw || '').trim();
      if (t.indexOf('Delete(') !== 0 || t.charAt(t.length - 1) !== ')') return null;
      const inner = t.slice(7, -1);
      if (!inner.length) return null;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] < '0' || inner[k] > '9') return null;
      }
      return Number(inner);
    };

    let dialog = null;
    let confirmBtn = null;
    for (let i = 0; i < 40 && !confirmBtn; i++) {
      const el = document.querySelector('#delete');
      if (vis(el) && el.textContent && el.textContent.indexOf('delete the selected items') !== -1) {
        dialog = el;
        confirmBtn = Array.from(el.querySelectorAll('button')).filter(vis)
          .find(b => deleteCount(b.textContent) !== null) || null;
      }
      if (!confirmBtn) await sleep(250);
    }
    if (!dialog) return { ok: false, error: 'Delete confirmation dialog (#delete) never appeared' };
    if (!confirmBtn) {
      return { ok: false, error: 'Delete confirmation button never showed a count inside #delete',
               dialogButtons: Array.from(dialog.querySelectorAll('button')).map(b => (b.textContent || '').trim()) };
    }
    const label = (confirmBtn.textContent || '').trim();
    if (label !== 'Delete(1)') {
      return { ok: false, error: 'Refusing to confirm: the dialog offers "' + label + '", not Delete(1)' };
    }

    confirmBtn.click();
    await sleep(2000);
    return { ok: true, deleted: resolvedName, confirmed: label };
  })()`;

  const res = await evaluate(js, { idempotent: false });

  // Read back: the reply is not the receipt. This function used to return the
  // page's word for it and was wrong every time.
  let stillPresent = null;
  try {
    const after = await listExplorerFiles(cloudName, folderPath);
    const names = (after.files || []).map(f => String(f.name || '').trim());
    stillPresent = names.includes(String(itemName).trim());
  } catch (e) {
    stillPresent = null;
  }

  if (res && res.ok && stillPresent === true) {
    return {
      ok: false,
      cloud: cloudName,
      folder: folderPath,
      item: itemName,
      verifiedGone: false,
      error: `The page reported a delete but "${itemName}" is still listed in ${folderPath || '/'}.`
    };
  }

  return {
    ...(res || {}),
    cloud: cloudName,
    folder: folderPath,
    item: itemName,
    verifiedGone: stillPresent === false ? true : (stillPresent === null ? 'unknown' : false)
  };
}
