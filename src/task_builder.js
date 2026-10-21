import { evaluate, navigateToOrThrow, jsv } from './client.js';
import { listTasks } from './tasks.js';

/**
 * Shared engine for the three "builder" pages (Cloud Transfer, Cloud Sync,
 * Cloud Backup).
 *
 * These pages share a shape: two `.task-box` selectors, a picker modal, an
 * editable task name and one submit button. Before this module existed the
 * logic was copied into `transfer.js` and then re-stubbed — incompletely — in
 * `sync.js` and `backup.js`, each returning `ok: true` whether or not it had
 * done anything.
 *
 * The pickers are NOT one widget, and which one a box opens is a property of
 * the PAGE, not of the box's role (all measured live 2026-08-31, confirmed by
 * screenshot and by DOM dump):
 *
 *   Element-UI tree  Rows are `.el-tree-node__content`, multi-select via
 *                    `.el-checkbox__inner` (the label gains `is-checked`),
 *                    expand via `.el-tree-node__expand-icon` (gains `expanded`).
 *   Hand-rolled tree Rows are `.tree-node-div`, the name lives in
 *                    `.tr-tree-name-span` (its `title` holds the untruncated
 *                    name, with a trailing space), select by clicking that span
 *                    (the row gains `tr-click`), expand by clicking
 *                    `i.pull-triangle` (which becomes `i.down-triangle`). It has
 *                    no checkboxes and no radios anywhere.
 *
 *   Cloud Transfer   FROM = Element-UI tree, TO = hand-rolled tree.
 *   Cloud Sync       both = hand-rolled tree (and it is the DESTINATION that is
 *                    plural here, the mirror of Transfer).
 *   Cloud Backup     see the live DOM-contract test; detected at runtime.
 *
 * Both trees can be in the DOM at once and only one is visible, so a selector
 * that does not filter on visibility silently drives the wrong one. The shipped
 * version selected the destination with `.el-radio__inner` — an element that
 * exists nowhere on any of these pages — fell back to clicking the row, left
 * the TO box empty, and submitted anyway. MultCloud refuses a task with no
 * destination, so `transfer`, `sync` and `backup` could never have created
 * anything. `createBuilderTask`'s read-back is what surfaced it; the page
 * itself reported nothing.
 *
 * This module therefore detects the visible widget instead of assuming one.
 */

const PAGES = {
  transfer: { section: 'Cloud Transfer', url: 'https://app.multcloud.com/mc_project/cloud_transfer', submit: 'Transfer Now', source: 'picker', nameEditable: true },
  sync:     { section: 'Cloud Sync',     url: 'https://app.multcloud.com/mc_project/cloud_sync',     submit: 'Sync Now',     source: 'picker', nameEditable: true },
  backup:   { section: 'Cloud Backup',   url: 'https://app.multcloud.com/mc_project/cloud_backup',   submit: 'Backup Now',   source: 'picker', nameEditable: true },
  // Remote Upload renders the SAME two `.task-box` layout and the same
  // hand-rolled destination tree as the three builder pages (measured live
  // 2026-08-31: two boxes, box 0 the link, box 1 the destination, submit
  // `button.transfer-button` "Upload Now"). Only the source differs -- it is
  // filled by a dialog rather than a picker -- and the page carries no
  // `.edit-task-icon`, so a task name cannot be set here at all.
  remote:   { section: 'Remote Upload',  url: 'https://app.multcloud.com/mc_project/remote_task',    submit: 'Upload Now',   source: 'link',   nameEditable: false }
};

/**
 * ADD_LINK_CONTRACT — why the Remote Upload dialog is driven the way it is.
 *
 * Measured live on the page, 2026-08-31:
 *
 *   - The dialog is `.popup`, NOT `.el-dialog` / `.modal` / `.dialog-footer`,
 *     and its commit button is `button.saveCloud` (text "OK"). The shipped
 *     implementation searched only the three Element-UI selectors, found
 *     nothing, and — being written as `if (saveBtn) saveBtn.click()` — skipped
 *     the commit entirely and still returned `{ok: true, action: 'submitted'}`.
 *   - The page carries a SECOND, hidden textarea: the subscription
 *     cancellation feedback box, placeholder "…the reason why you leave…".
 *     The shipped selector list ended in a bare `textarea`, so on any render
 *     where that box comes first in document order the download URL is typed
 *     into an account-cancellation form. The input is therefore taken from
 *     inside the visible popup, and a candidate whose placeholder does not
 *     mention a link is refused rather than used.
 *   - MultCloud rewrites the committed link to the RESOLVED FILENAME in the
 *     source box (a URL ending `agpl-3.0.txt` renders as `agpl-3.0.txt`), so
 *     the box is verified as "no longer the empty marker" rather than as
 *     "contains the URL".
 */

/** Text every unselected `.task-box` shows. Presence of it means "still empty". */
export const EMPTY_BOX_MARKER = /click here to select/i;

export function pageFor(kind) {
  const page = PAGES[kind];
  if (!page) throw new Error(`Unknown builder page "${kind}". Known: ${Object.keys(PAGES).join(', ')}`);
  return page;
}

/**
 * Build the in-browser script that fills one builder page and submits it.
 * `modeClicks` are labels clicked before selection (e.g. "Real Time Sync").
 *
 * Every stage reads its own result back before the next one runs, so a picker
 * that silently did nothing is reported as the step that failed rather than
 * carried into a submit.
 */
function buildScript({ from, to, name, submitLabel, modeClicks, link, sourceMode, phase }) {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const fromPath = ${jsv(from)};
    const toPath = ${jsv(to)};
    const sourceLink = ${jsv(link || '')};
    const sourceMode = ${jsv(sourceMode || 'picker')};
    // 'all' does the whole flow in one eval (picker sources, which are fast).
    // 'link' stages the source and stops; 'finish' assumes it is already
    // staged. The split exists because a torrent's resolve + content dialog
    // plus the destination tree exceeds the bridge's one-eval ceiling.
    const phase = ${jsv(phase || 'all')};
    const taskName = ${jsv(name || '')};
    const submitLabel = ${jsv(submitLabel)};
    const modeClicks = ${jsv(modeClicks || [])};
    const EMPTY = /click here to select/i;

    // Measured live 2026-08-31 against the real Remote Upload page.
    // A magnet is not settled in 10s -- MultCloud resolves the torrent first --
    // and the old wait turned "still working" into a confident claim that the
    // link had been refused, quoting dialog text that is present either way.
    // BRIDGE_EVAL_CEILING_MS is not ours to pick: the
    // OpenCLI bridge kills one Runtime.evaluate at ~115s, so every in-page wait
    // has to fit under it or it is a promise the transport cannot keep.
    const BRIDGE_EVAL_CEILING_MS = 115000;
    const LINK_DIALOG_CLOSE_MS = 50000;
    const TORRENT_CONTENT_MS = 15000;

    const vis = (el) => !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
    const boxes = () => Array.from(document.querySelectorAll('.task-box'));
    const boxText = (i) => ((boxes()[i] || {}).innerText || '').replace(/\\s+/g, ' ').trim();
    const splitPath = (p) => String(p).split(/[/\\\\]/).map(s => s.trim()).filter(Boolean);

    /**
     * Pick exactly one row. Exact (trimmed) match wins; otherwise a unique
     * substring match. More than one candidate is refused rather than guessed,
     * because guessing here picks somebody else's folder.
     */
    const pickOne = (rows, nameOf, want) => {
      const exact = rows.filter(r => nameOf(r) === want);
      if (exact.length === 1) return { row: exact[0] };
      if (exact.length > 1) return { error: 'Ambiguous: ' + exact.length + ' entries are named "' + want + '"' };
      const loose = rows.filter(r => nameOf(r).includes(want));
      if (loose.length === 1) return { row: loose[0] };
      if (loose.length > 1) return { error: '"' + want + '" matches ' + loose.length + ' entries: ' + loose.map(nameOf).join(', ') };
      return { error: null };
    };

    const waitFor = async (fn, ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > deadline) return null;
        await sleep(200);
      }
    };

    /**
     * One picker driver for both widgets.
     *
     * Which widget a box opens is a per-page fact, not a per-role one:
     * Cloud Transfer opens the Element-UI tree for FROM and the hand-rolled
     * tree for TO, while Cloud Sync and Cloud Backup use the hand-rolled tree
     * for both. Detecting the visible widget is therefore the only thing that
     * survives the difference; hard-coding "source = checkboxes" was how the
     * destination came to be clicked with a selector the page has never had.
     */
    const detectPicker = async () => {
      const el = () => Array.from(document.querySelectorAll('.el-tree-node__content')).filter(vis);
      const custom = () => Array.from(document.querySelectorAll('.tree-node-div')).filter(vis);
      const kind = await waitFor(() => {
        if (el().length) return 'element-ui';
        if (custom().length) return 'custom';
        return null;
      }, 12000);
      if (!kind) return null;

      if (kind === 'element-ui') {
        return {
          kind,
          rows: el,
          nameOf: (r) => (r.innerText || '').trim(),
          isExpanded: (r) => {
            const i = r.querySelector('.el-tree-node__expand-icon');
            return !!i && i.classList.contains('expanded');
          },
          expander: (r) => r.querySelector('.el-tree-node__expand-icon'),
          selector: (r) => r.querySelector('.el-checkbox__inner'),
          isSelected: (r) => {
            const label = r.querySelector('.el-checkbox');
            return !!label && /is-checked/.test(label.className);
          }
        };
      }
      return {
        kind,
        rows: custom,
        nameOf: (r) => {
          const s = r.querySelector('.tr-tree-name-span');
          return s ? String(s.getAttribute('title') || s.innerText || '').trim() : '';
        },
        isExpanded: (r) => !r.querySelector('i.pull-triangle'),
        expander: (r) => r.querySelector('i.pull-triangle'),
        selector: (r) => r.querySelector('.tr-tree-name-span'),
        // Token check, not a regex: this string is inside a template literal, so
        // a backslash-b word boundary written here reaches the page as a raw
        // backspace character. That matched nothing, so a row that HAD been selected
        // was reported as 'clicked but never became selected'.
        isSelected: (r) => (' ' + r.className + ' ').indexOf(' tr-click ') !== -1
      };
    };

    const selectInPicker = async (pathStr, which) => {
      const picker = await detectPicker();
      if (!picker) return { ok: false, error: 'The ' + which + ' picker never showed a tree' };

      const parts = splitPath(pathStr);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;

        const found = await waitFor(() => {
          const p = pickOne(picker.rows(), picker.nameOf, part);
          return p.row ? p : (p.error ? p : null);
        }, 12000);

        if (!found) {
          return { ok: false, error: 'Not found in the ' + which + ' tree: ' + part,
                   available: picker.rows().map(picker.nameOf).slice(0, 20) };
        }
        if (found.error) return { ok: false, error: found.error };

        const row = found.row;
        row.scrollIntoView({ block: 'center' });
        await sleep(200);

        if (isLast) {
          const wantedName = picker.nameOf(row);

          // These pages keep their component alive across navigation, so a
          // previous run's selection is still marked when the picker reopens.
          // Clicking a marked row TOGGLES IT OFF, which is how "clicked it but
          // it never became selected" happens on a page that is working fine.
          // Clear anything else first, then click only if not already ours.
          for (const other of picker.rows()) {
            if (picker.nameOf(other) === wantedName) continue;
            if (!picker.isSelected(other)) continue;
            const h = picker.selector(other);
            if (h) { h.click(); await sleep(500); }
          }

          const current = picker.rows().find(r => picker.nameOf(r) === wantedName) || row;
          if (!picker.isSelected(current)) {
            const handle = picker.selector(current);
            if (!handle) return { ok: false, error: 'No way to select "' + part + '" in the ' + which + ' tree' };
            handle.click();
            const marked = await waitFor(() => {
              const again = picker.rows().find(r => picker.nameOf(r) === wantedName) || current;
              return picker.isSelected(again) ? true : null;
            }, 5000);
            if (!marked) {
              return { ok: false, error: 'Clicked "' + part + '" in the ' + which + ' tree but it never became selected' };
            }
          }
        } else if (!picker.isExpanded(row)) {
          const expander = picker.expander(row);
          if (!expander) return { ok: false, error: '"' + part + '" cannot be expanded in the ' + which + ' tree' };
          expander.click();
          const next = parts[i + 1];
          const appeared = await waitFor(
            () => picker.rows().some(r => picker.nameOf(r).includes(next)) || null, 12000);
          if (!appeared) return { ok: false, error: 'Expanded "' + part + '" but "' + next + '" never appeared' };
        }
      }
      return { ok: true, picker: picker.kind };
    };

    const confirmModal = async (which) => {
      const okBtns = Array.from(document.querySelectorAll('.task-button, button'))
        .filter(b => (b.innerText || '').trim() === 'OK' && vis(b));
      if (okBtns.length === 0) return { ok: false, error: 'OK button not found on the ' + which + ' modal' };
      okBtns[okBtns.length - 1].click();
      await sleep(1800);
      return { ok: true };
    };

    // Fill the source box from the "Add Link" dialog (Remote Upload only).
    // See ADD_LINK_CONTRACT in this module for why each selector is what it is.
    const addLinkSource = async () => {
      const trigger = Array.from(document.querySelectorAll('div, button, span, a'))
        .find(e => (e.textContent || '').trim() === 'Add Link' && vis(e));
      if (!trigger) return { ok: false, error: 'The "Add Link" control is not on this page' };
      trigger.click();

      const popup = await waitFor(() => Array.from(document.querySelectorAll('.popup')).filter(vis)[0] || null, 8000);
      if (!popup) return { ok: false, error: 'The "Add Link" dialog never opened' };

      const box = await waitFor(() => {
        const inside = Array.from(popup.querySelectorAll('textarea')).filter(vis)[0];
        if (inside) return inside;
        return Array.from(document.querySelectorAll('textarea'))
          .filter(t => vis(t) && /link|magnet|url/i.test(String(t.placeholder || '')))[0] || null;
      }, 8000);
      if (!box) return { ok: false, error: 'The link input never appeared inside the "Add Link" dialog' };
      if (/reason why you leave/i.test(String(box.placeholder || ''))) {
        return { ok: false, error: 'Refusing to type into the subscription-feedback textarea; the link dialog input was not found' };
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, sourceLink);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      if (box.value !== sourceLink) {
        return { ok: false, error: 'The link input did not accept the value', got: box.value };
      }

      const commit = Array.from(popup.querySelectorAll('button'))
        .filter(b => vis(b) && (b.textContent || '').trim() === 'OK');
      if (!commit.length) {
        return { ok: false, error: 'The "Add Link" dialog has no OK button' };
      }
      commit[commit.length - 1].click();

      // A torrent has a step an HTTP link does not, and this is where every
      // magnet was lost. MultCloud does not close this dialog on success -- it
      // REPLACES it with "Select Content to Upload", listing the files inside
      // the torrent (measured: Sintel resolved to "Name(11/11)", Sintel.mp4,
      // 123.25 MB, commit button.foot-download). So "the popup count
      // reached zero" is the success condition for a URL and is unreachable for
      // a torrent -- which is why a fully-resolved magnet was reported as an
      // invalid link. Wait for EITHER outcome, then finish the torrent one.
      const settled = await waitFor(() => {
        const open = Array.from(document.querySelectorAll('.popup')).filter(vis);
        if (open.length === 0) return { closed: true };
        const content = open.find(p => p.querySelector('button.foot-download'));
        if (content) return { content };
        return null;
      }, LINK_DIALOG_CLOSE_MS);

      if (!settled) {
        const msg = (popup.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
        return { ok: false, error: 'The "Add Link" dialog neither closed nor opened a content ' +
          'selection within ' + Math.round(LINK_DIALOG_CLOSE_MS / 1000) + 's. MultCloud may have ' +
          'refused the link, or may still be resolving it. The dialog showed: ' + msg };
      }

      if (settled.content) {
        // MultCloud arrives with every file already ticked (the header reads
        // "Name(11/11)"), so this confirms the whole torrent rather than
        // inventing a selection the caller never asked for.
        settled.content.querySelector('button.foot-download').click();
        const done = await waitFor(
          () => (Array.from(document.querySelectorAll('.popup')).filter(vis).length === 0) || null,
          TORRENT_CONTENT_MS);
        if (!done) {
          return { ok: false, error: 'The torrent content dialog stayed open after OK' };
        }
      }
      return { ok: true };
    };

    // ---- run -------------------------------------------------------------
    for (const label of modeClicks) {
      const btn = Array.from(document.querySelectorAll('button, div, span'))
        .find(e => (e.innerText || '').trim() === label && vis(e));
      if (!btn) return { ok: false, step: 'mode', error: 'Mode control not found: ' + label };
      if (label === 'Real Time Sync' && btn.classList && btn.classList.contains('realTime-select')) {
        continue;
      }
      btn.click();
      await sleep(900);
    }

    if (boxes().length < 2) {
      return { ok: false, step: 'layout', error: 'Expected two selection boxes on this page, found ' + boxes().length };
    }

    let fromRes = { ok: true, picker: null };
    if (sourceMode === 'link') {
      if (phase !== 'finish') {
        const linkRes = await addLinkSource();
        if (!linkRes.ok) return { ok: false, step: 'link_source', error: linkRes.error, got: linkRes.got };
      }
      // The staged link is verified the same way a picked folder is: the box
      // must stop showing the "click here to select" marker and must hold
      // something. MultCloud rewrites the link to the resolved FILENAME here
      // (a URL ending in agpl-3.0.txt became the box text "agpl-3.0.txt"), so
      // asserting the box contains the URL would fail on a working page.
      if (EMPTY.test(boxText(0)) || !boxText(0)) {
        return { ok: false, step: 'link_verify',
                 error: phase === 'finish'
                   ? 'The staged link is no longer in the source box; the page was reset between phases'
                   : 'The link was accepted by the dialog but the source box is still empty',
                 boxText: boxText(0) };
      }
      if (phase === 'link') {
        return { ok: true, step: 'link_staged', boxes: [boxText(0), boxText(1)] };
      }
    } else {
      const fromLeaf = splitPath(fromPath).slice(-1)[0] || '';
      if (!EMPTY.test(boxText(0)) && boxText(0).includes(fromLeaf)) {
        fromRes = { ok: true, picker: 'reused' };
      } else {
        boxes()[0].click();
        await sleep(2000);
        fromRes = await selectInPicker(fromPath, 'source');
        if (!fromRes.ok) return { ok: false, step: 'from_selection', error: fromRes.error, available: fromRes.available };
        const fromOk = await confirmModal('source');
        if (!fromOk.ok) return { ok: false, step: 'from_confirm', error: fromOk.error };
        if (EMPTY.test(boxText(0)) || !boxText(0).includes(fromLeaf)) {
          return { ok: false, step: 'from_verify',
                   error: 'The FROM box does not show "' + fromLeaf + '" after selecting "' + fromPath + '"',
                   boxText: boxText(0) };
        }
      }
    }

    const toLeaf = splitPath(toPath).slice(-1)[0] || '';
    let toRes = { ok: true, picker: null };
    if (!EMPTY.test(boxText(1)) && boxText(1).includes(toLeaf)) {
      toRes = { ok: true, picker: 'reused' };
    } else {
      boxes()[1].click();
      await sleep(2000);
      toRes = await selectInPicker(toPath, 'destination');
      if (!toRes.ok) return { ok: false, step: 'to_selection', error: toRes.error, available: toRes.available };
      const toOk = await confirmModal('destination');
      if (!toOk.ok) return { ok: false, step: 'to_confirm', error: toOk.error };
      if (EMPTY.test(boxText(1)) || !boxText(1).includes(toLeaf)) {
        return { ok: false, step: 'to_verify',
                 error: 'The TO box does not show "' + toLeaf + '" after selecting "' + toPath + '"',
                 boxText: boxText(1) };
      }
    }

    let nameSet = null;
    if (taskName) {
      const editIcon = document.querySelector('.edit-task-icon');
      if (!editIcon) return { ok: false, step: 'name_open', error: 'Task-name edit control (.edit-task-icon) not found' };
      editIcon.click();
      const input = await waitFor(() => {
        const el = document.querySelector('input.edit-input');
        return vis(el) ? el : null;
      }, 5000);
      if (!input) return { ok: false, step: 'name_input', error: 'Task-name input (input.edit-input) never appeared' };

      // Vue listens on the native setter, not on assignment to .value.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, taskName);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);

      const sure = document.querySelector('i.name-sure');
      if (!sure) return { ok: false, step: 'name_commit', error: 'Task-name confirm control (i.name-sure) not found' };
      sure.click();
      await sleep(1000);

      const label = document.querySelector('.operating-input .task-name, #syncName .task-name, .task-name');
      nameSet = label ? label.innerText.trim() : null;
      if (nameSet !== taskName) {
        return { ok: false, step: 'name_verify', error: 'Task name did not take', wanted: taskName, got: nameSet };
      }
    }

    const submitBtn = Array.from(document.querySelectorAll('button.transfer-button, button, .transfer-button'))
      .find(b => (b.innerText || '').trim() === submitLabel && vis(b));
    if (!submitBtn) return { ok: false, step: 'submit', error: '"' + submitLabel + '" button not found' };

    const finalBoxes = [boxText(0), boxText(1)];
    submitBtn.click();
    await sleep(1500);

    // If Real Time Sync (or any task) opens the idling/notice confirmation dialog, dismiss it.
    const noticeBtn = await waitFor(() => {
      const btn = document.querySelector('.realtime-idling-bottom button, .idling-body button');
      return (btn && vis(btn)) ? btn : null;
    }, 4000);
    if (noticeBtn) {
      const check = document.querySelector('.noIdlingcheck-small');
      if (check && vis(check)) check.click();
      noticeBtn.click();
      await sleep(2500);
    } else {
      await sleep(2500);
    }

    return { ok: true, step: 'submitted', boxes: finalBoxes, nameSet, pickers: [fromRes.picker, toRes.picker], url: location.href };
  })()`;
}

/**
 * How long the builder script may run in the browser.
 *
 * This is an interactive flow, not a query: open a picker, wait for a tree,
 * expand it, confirm two modals, submit. The transport's 30s default fits that
 * only when nothing is slow. It does not fit a magnet -- MultCloud resolves
 * torrent metadata after the link is committed, and the create was killed
 * mid-flow, which on a mutating call is the worst possible place to stop.
 * The cost of a generous budget is a slow failure; the cost of a short one is
 * a create whose outcome nobody knows.
 */
const BUILDER_SCRIPT_TIMEOUT_MS = 150000;

/**
 * The budget for staging a link source on its own.
 *
 * Deliberately below the bridge's ~115s ceiling rather than above it: this
 * phase's whole purpose is to stay inside one eval, so a client timeout that
 * fires first gives a clearer message than the transport's would.
 */
const LINK_STAGE_TIMEOUT_MS = 100000;

/**
 * Create a task on a builder page and VERIFY it exists afterwards.
 *
 * The submit click is not the receipt. A task id that was not in the list
 * before and is in the list after is. When the read-back cannot run, the result
 * says `verified: 'unknown'` rather than claiming success.
 */
export async function createBuilderTask(kind, { from, to, name, modeClicks, link } = {}) {
  const page = pageFor(kind);

  if (page.source === 'link') {
    if (!link) throw new Error(`A link is required for ${kind}.`);
    if (!to) throw new Error(`A destination cloud is required for ${kind}.`);
    // The Remote Upload page has no `.edit-task-icon`, so there is nowhere to
    // put a name. Silently dropping it is what made the documented `--cloud`
    // flag a no-op on this same command; refuse instead and name the layer
    // that CAN carry it.
    if (name) {
      throw new Error(
        'MultCloud does not offer a task name on the Remote Upload page, so --name cannot be applied. ' +
        'Create the task, then run: multcloud tasks rename "<id>" "<name>" (a local alias).'
      );
    }
  } else if (!from || !to) {
    throw new Error(`Both a source and a destination are required for ${kind}.`);
  }

  let before = null;
  try {
    const snapshot = await listTasks();
    before = new Set((snapshot.tasks || []).map(t => t.taskId));
  } catch (e) {
    before = null;
  }

  await navigateToOrThrow(page.section, page.url);

  const common = { from, to, name, submitLabel: page.submit, modeClicks, link, sourceMode: page.source };

  // A link source is staged in its own eval. Resolving a torrent and confirming
  // its content dialog is slow, and adding the destination tree and the submit
  // on top of it exceeds the bridge's one-eval ceiling -- measured three times
  // live, each killed mid-flow. The page keeps the staged source between the
  // two calls, and phase 'finish' re-checks that it is still there rather than
  // assuming it.
  if (page.source === 'link') {
    const staged = await evaluate(
      buildScript({ ...common, phase: 'link' }),
      { idempotent: false, timeout: LINK_STAGE_TIMEOUT_MS }) || {};
    if (!staged.ok) {
      return { ok: false, kind, from: link || null, to, verified: false, ...staged };
    }
  }

  const script = buildScript({ ...common, phase: page.source === 'link' ? 'finish' : 'all' });
  // Mutating: never retried.
  const res = await evaluate(script, { idempotent: false, timeout: BUILDER_SCRIPT_TIMEOUT_MS }) || {};

  if (!res.ok) {
    return { ok: false, kind, from: from || link || null, to, verified: false, ...res };
  }

  let created = null;
  let verified = 'unknown';
  if (before) {
    try {
      const after = await listTasks();
      const fresh = (after.tasks || []).filter(t => !before.has(t.taskId));
      if (fresh.length > 0) {
        created = { taskId: fresh[0].taskId, taskName: fresh[0].taskName };
        verified = true;
      } else {
        verified = false;
      }
    } catch (e) {
      verified = 'unknown';
    }
  }

  if (verified === false) {
    return {
      ok: false,
      kind, from: from || link || null, to,
      verified: false,
      submitted: res,
      error: `The ${page.submit} button was clicked with FROM="${(res.boxes || [])[0] || '?'}" and TO="${(res.boxes || [])[1] || '?'}" but no new task appeared in the task list.`
    };
  }

  return {
    ok: true,
    kind,
    action: `${kind}_created`,
    from: from || link || null,
    to,
    taskName: created?.taskName || name || '',
    taskId: created?.taskId || null,
    verified
  };
}
