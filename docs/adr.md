# Architecture Decisions (ADR)

## ADR-001: Browser Bridge over Raw Reverse-Engineered HTTP Calls

- **Context**: MultCloud (`app.multcloud.com`) does not have a public API. It protects its `/action.php` backend with client-side JavaScript AES encryption, session cookies, and CAPTCHAs.
- **Decision**: Drive MultCloud via OpenCLI Browser Bridge / Chrome DevTools Protocol connecting to the user's active logged-in browser session.
- **Rationale**:
  1. The browser transparently executes all client-side AES cryptography and token refreshes.
  2. The user is already logged in with Lifetime Unlimited status.
  3. Zero risk of breaking when MultCloud rotates frontend obfuscation or encryption keys.

## ADR-002: Standalone CLI + OpenCLI Adapter Dual Entry Point

- **Context**: Both standalone terminal execution (`multcloud tasks`) and agentic OpenCLI tooling (`opencli multcloud tasks`) are valuable.
- **Decision**: Build core logic in `src/` and expose via both `bin/multcloud.js` (standalone) and `~/.opencli/clis/multcloud/` (OpenCLI).
- **Rationale**: Unifies the implementation, ensuring zero drift between the two interfaces.

## ADR-003: One transport chokepoint, injectable for tests

- **Context**: Every module shelled out to `opencli` independently through
  `runOpenCli`, so nothing could be exercised without a live authenticated
  browser. 18 of the 20 original tests needed one, no test ran the CLI itself,
  and every serious defect lived in the untested `bin` ↔ `src` seam.
- **Decision**: `src/client.js` holds one transport function.
  `setTransport()` / `resetTransport()` swap it. Everything reaches the browser
  through `evaluate()`.
- **Rationale**: It makes the offline suite possible without a parallel
  implementation, and it keeps one place to enforce the retry policy. The rule
  that pays for it: never add a second route to the network.

## ADR-004: `jsv()` for every value interpolated into a browser script

- **Context**: Values were embedded as `'${v.replace(/'/g, "\\'")}'`. That
  escapes single quotes and nothing else, so a value ending in a backslash closed
  the literal and the rest executed as code in the authenticated session.
  Reachable without any crafted CLI input: `retry-failed` feeds task *names*
  from the page back into the next script, and a `flow.json` supplies `from` /
  `to` / `name` directly.
- **Decision**: `jsv()` (JSON.stringify plus U+2028/U+2029 escaping) at every
  interpolation site. `tests/injection.test.js` asserts the payload is inert, and
  also asserts the old pattern really did execute it so the fixture cannot rot.
- **Rationale**: The safe form already existed in `src/backup.js`; the bug was
  that it had not been applied uniformly.

## ADR-005: Read identity from the page, never from constants

- **Context**: `src/explorer.js` carried a map of seven MultCloud drive
  `tokenId`s and the owner's account handles, with an unconditional fallback to
  the Baidu drive — so an unknown drive name was browsed as Baidu while the
  output was labelled with the drive the user asked for. `src/tasks.js` had a
  hardcoded user id fallback.
- **Decision**: Discover drives from the page's own array (`allDrivesArr`), and
  resolve names through `resolveDrive()`, which refuses unknown and ambiguous
  input. No account identifier appears in source, and `tests/fixtures.test.js`
  keeps them out of the committed fixtures too.
- **Rationale**: The constants were account data in a repo, they went stale on
  any re-auth, and the fallback produced confidently mislabelled output.

## ADR-006: A write is verified by read-back, not by its reply

- **Context**: `createBackup` clicked a selector that did not exist on a page it
  had not reached, never chose a destination, never pressed a button, and
  returned `{ok: true}`. `createSync` returned `ok: true` on every path. The
  dispatcher printed a green tick without reading `ok` at all, for nine commands.
- **Decision**: `createBuilderTask()` snapshots task ids, submits, then re-lists
  and reports `ok` only if a new id appeared. `deleteTask` confirms the id is
  gone. `assertOk()` in the dispatcher turns any `ok: false` into a non-zero exit.
  When the read-back cannot run, the result says `verified: 'unknown'`.
- **Rationale**: The most expensive failure in this tool was never a crash; it
  was a green tick for something that did not happen.

## ADR-007: OpenCLI adapters are thin, and use the registry API

- **Context**: `clouds`, `explorer` and `tasks` were written in a
  commander-style `export default function (cli)` shape that OpenCLI does not
  load, so `opencli multcloud tasks` — printed in the README, the skill and the
  capability card — answered `unknown command 'tasks'`. Separately, adapters
  declared `func: async (page, kwargs)` while OpenCLI passes kwargs **first**
  when `browser: false`, so every flag and positional argument was discarded.
  And `account.js` carried its own copy of the scraping logic, which drifted.
- **Decision**: Every adapter uses `cli({...})` with `func: async (kwargs) =>`
  and delegates straight into `src/`. No adapter contains extraction logic.
- **Rationale**: Two entry points, one implementation. Verified by invoking each
  adapter, not by reading it.

## ADR-008: The picker widget is detected, never assumed

- **Context**: `transfer`, `sync` and `backup` had never created a task. All
  three selected the destination with `.el-radio__inner`, an element that exists
  on none of those pages, fell back to clicking the tree row, left the TO box
  empty, and submitted anyway. MultCloud refuses a task with no destination.
  The pages carry **two** tree widgets and show one at a time: an Element-UI
  tree (`.el-tree-node__content`, `.el-checkbox__inner`) and a hand-rolled one
  (`.tree-node-div`, `.tr-tree-name-span`, `i.pull-triangle`, row class
  `tr-click`). Which one a box opens is a property of the page, not of the box's
  role — Cloud Transfer uses one of each, Cloud Sync uses the hand-rolled tree
  for both.
- **Decision**: `src/task_builder.js` detects the visible widget and drives it.
  Every stage reads its own result back — the row must show as selected, and the
  `.task-box` must show the requested leaf — before the next stage runs, and
  before submit.
- **Rationale**: A role-to-widget mapping is an assumption about a page we do
  not own. Detection costs one query and cannot silently address the wrong tree.

## ADR-009: A label is reported as what it measures, not as what it suggests

- **Context**: The Manage Clouds sidebar prints `Failed` in the slot that
  otherwise holds the account email. `listClouds` reported that as
  `status: 'Failed'` and `doctor` rendered it as "N cloud drive(s) have expired
  OAuth tokens", with a remedy of re-authorizing in Chrome. It is the **quota**
  lookup. Measured 2026-08-31, when the sidebar marked 13 of 21 drives `Failed`:
  a transfer read from `OneDrive 1` and wrote to
  `Google Drive 2` in the same minute, and `Shared Drive 1`,
  `Google Drive 3` and `Google Photos 1` all listed their contents.
- **Decision**: The field is `quota: 'ok' | 'unavailable' | 'unknown'`, the
  warning says storage totals are a floor, and nothing in this CLI claims to
  know OAuth health, because nothing on the page reports it. A live test asserts
  the words `oauth`, `expired` and `token` do not appear in `clouds` output.
- **Rationale**: A confident wrong diagnosis costs more than no diagnosis: it
  sends the user to re-authorize working drives and to distrust the ones that
  work.

## ADR-010: The roster comes from the page model, never from what rendered

- **Context**: `listClouds` scraped the DOM for anything whose text contained
  `TB/`, `GB/`, `MB/` or `Failed`, and `listDrives` took the first non-empty of
  three Vue arrays. The Manage Clouds page renders drives in three places and
  loads them progressively, so both were reading a *sample*. Measured on one
  page load: the account has **21** drives; `clouds` reported **12** and
  Explorer could address **15**, with membership changing between runs —
  `explorer list "OneDrive 3"` answered `No connected drive matches`
  and listed fifteen others as if that settled it.
- **Decision**: `listDrives` merges every drive array by id and reports its
  sources; `listClouds` builds on that roster and uses the DOM only to fill in
  quota. Unreadable quota is `null` with a named warning, never an omission.
  A live test asserts the two commands agree drive for drive.
- **Rationale**: An incomplete list looks exactly like a complete one. The only
  defence is to take the roster from the source that owns it.

## ADR-011: Deletion is scoped to one confirmed target, and read back

- **Context**: `explorer delete` dispatched a `contextmenu` event, searched the
  whole document for `innerText === 'Delete'`, clicked what it found, and
  returned `{ok: true}` with no read-back — deleting nothing, three times, on a
  live Google Drive. `tasks delete` matched its menu on `innerText`, which this
  page reports as empty, so every delete failed; and it searched the document
  for the confirmation, while **every task card carries its own Delete button**.
- **Decision**: Match labels with `textContent`. Select exactly one row and
  refuse if the selection is not exactly the target. Scope the confirmation to
  the dialog (`#delete` / `#deleteTask`) and, in Cloud Explorer, require the
  button to read `Delete(1)` — the count is the page's own receipt. Read back
  and report `verifiedGone`.
- **Rationale**: The two failure modes of an irreversible operation are doing
  nothing while claiming success, and doing it to the wrong thing. A
  document-wide text search is capable of both.

## ADR-012: No escape reaches the browser through a template literal

- **Context**: Every browser script is built with a template literal, so the
  template consumes one level of backslashes. Two escapes shipped that way on
  the same day: `/\btr-click\b/` became `/<backspace>tr-click<backspace>/` and
  `/^Delete\(\d+\)$/` became `/^Delete(d+)$/`. Both compile, both match nothing,
  and both produced a *plausible* wrong answer — "the row never became selected"
  about a selected row, "no confirm button" about an open dialog.
- **Decision**: Prefer escape-free logic (`indexOf`, character comparison, class
  tokens) in emitted scripts. Where an escape is unavoidable, double it.
  `tests/escaping.test.js` scans every `src/` file for backslashes inside
  template-literal text and allows only those whose eaten form is equivalent.
- **Rationale**: The correctness of these literals is invisible on screen, in a
  diff and in a grep. The only place the question is decidable is the source.

## ADR-013: Remote Upload runs on the shared builder engine, not its own copy

- **Context**: `remote-upload` was the last create command with its own
  implementation of a MultCloud page, and the last one whose success came from a
  click rather than a read-back. It returned
  `{ok: true, action: 'submitted'}` after pressing "Upload Now", with no check
  that a task existed. Measured live 2026-08-31, it could not have worked: it
  looked for the link dialog's commit button with
  `.el-dialog button, .modal button, .dialog-footer button`, on a page whose
  dialog is `.popup` and whose button is `button.saveCloud` — and the search was
  written `if (saveBtn) saveBtn.click()`, so a miss was silent. The link was
  typed and never committed. Its selector list also ended in a bare `textarea`,
  and the page carries a hidden second one: the subscription-cancellation
  feedback box.
- **Decision**: The Remote Upload page renders the same two-`.task-box` layout
  and the same hand-rolled destination tree as Cloud Transfer/Sync/Backup, so it
  became a fourth `kind` in `src/task_builder.js` rather than a second
  implementation. `src/remote_upload.js` is now a thin wrapper. The only
  page-specific part is the source stage: a dialog instead of a picker. The link
  input is taken from inside the *visible* popup, and a candidate whose
  placeholder does not mention a link is refused by name.
- **Rationale**: One engine means one picker driver, one read-back and one place
  a page change has to be answered. The independent copy is exactly how this
  command kept a defect the other three had already had fixed.
- **Note**: MultCloud rewrites the committed link to the resolved *filename* in
  the source box (a URL ending `agpl-3.0.txt` renders as `agpl-3.0.txt`), so the
  box is verified as "no longer the empty marker", not as "contains the URL".
  The page has no `.edit-task-icon`, so `--name` is **refused** with a message
  naming `tasks rename` (the local alias layer) rather than silently dropped.

## ADR-014: A task card has two shapes, and only one has a menu

- **Context**: `tasks delete` opened the card's "..." menu
  (`.task-operate-menu`) and clicked the `Delete` row inside it. Measured live
  2026-08-31 against a real remote-upload task, that failed with
  `Task menu button not found for id …` — which reads like a missing card. The
  card was there. A remote-upload (`linkTask`) card has no menu at all: it
  carries a direct `button.white-button` labelled Delete inside
  `.option-operate`.
- **Decision**: Detect the shape. If a menu trigger exists, drive the menu as
  before; otherwise require **exactly one** visible Delete button inside the
  resolved card and refuse to guess when there is any other number. Both
  branches search inside the resolved card only, never the document. The result
  reports which shape was used (`cardShape: 'menu' | 'direct'`).
- **Rationale**: The dangerous failure of an irreversible action is not "it
  refused", it is "it acted on a neighbour". Widening the search to the document
  would have made remote deletes work and made every delete unsafe. The refusal
  on an unexpected count is the part that keeps the widening honest.

## ADR-015: A backtick in a comment inside a browser script is a gated defect

- **Context**: Every browser script is a template literal, so a backtick written
  inside a *comment* in that script ends the template. This has now happened
  three times in this repo, each time while documenting a selector the ordinary
  way (`` `button.saveCloud` ``). Twice it was a `SyntaxError`, which is loud.
  It does not have to be: an even number of backticks on the line closes and
  reopens the template, leaving a file that parses and a script with the
  comment's text spliced in as code.
- **Decision**: `tests/escaping.test.js` gained a second scanner that reports any
  backtick on a comment-shaped line inside a template literal, alongside the
  existing backslash scanner. Both print how many files they graded.
- **Rationale**: The existing scanner cannot see this — a backtick in template
  text is exactly how a template legitimately ends — so it needed its own check.
  The explanation belongs at module scope anyway, where it is not shipped to the
  browser.

## ADR-016: The suite must prove it ran the half that can lie

**Date**: 2026-08-31
**Status**: accepted
**Context**

Every defect this project has fixed since `c04c81d` sat on a write path, and
none of them was hard to find once anybody executed the path. The handover suite
called nine read functions thirty-four times, called **zero** of its six write
functions, and never executed the binary as a process. All nine exercised read
paths worked. All six unexercised write paths were broken — the four creates
selected a destination with `.el-radio__inner` (an element nowhere on those
pages) and submitted anyway; both deletes returned `ok: true` having deleted
nothing.

The correlation is causal, not lucky: an unexecuted path has no feedback signal,
so a selector written against a page nobody loaded stays a guess. And the drift
is structural rather than careless — a read is cheap and safe to exercise, a
write costs an account mutation and cleanup, so coverage moves toward reads
unless something counts.

Per-defect gates (ADR-011, ADR-012, ADR-013, ADR-015) each lock one mistake
already made. None of them notices the *next* write function added without a
test, which is the mistake that produced all the others.

**Decision**

`tests/coverage-shape.test.js` enumerates every export whose name is
mutation-shaped and asserts each is called by a hermetic test. A name that only
reads must be listed in `READ_ONLY_DESPITE_THE_NAME` **with its reason**, and a
companion test asserts every allowlisted name still exists, so a rename cannot
silently shrink the denominator. A third test asserts at least one hermetic test
executes `bin/multcloud.js` as a process, because argv parsing, exit codes and
ordering are unobservable from inside a module test.

The gate prints what it graded (11 mutating exports across 56 exports in 17
modules) and refuses to pass when its extractor returns an implausibly small
population — an extractor that finds nothing would otherwise pass every
assertion beneath it. It excludes its own file from the binary-spawner scan,
since it must spell `execFile|spawn|child_process` literally to search for them.

**Consequences**

- Adding a mutating export without a test fails the suite by name.
- It went red on its first run: `retryFailedTasks` walks the failed list and
  presses play on each row — a bulk mutation with no hermetic test. Tests were
  written rather than the name allowlisted.
- Writing those tests exposed a second layer. A mutant re-resolving each task
  **by name** instead of by its already-resolved id escaped them, because with
  unique names both implementations emit an identical request; the property only
  became observable with a fixture holding two tasks that share a name. That
  fixture is now `retries the task that failed, not another one that shares its
  name`.
- Judgement stays prose: which functions count as mutating, and how much live
  proof a change deserves, are not decidable and are not asserted.

**Mutation-tested**: a new untested mutating export -> red; an allowlisted name
renamed away -> red; the extractor broken so it finds nothing -> red. Restored
-> green.


## ADR-017: The browser time budget, and a ceiling that is not ours to choose

**Date**: 2026-08-31
**Status**: accepted

**Context**

`evaluate()` declared `evaluate(jsCode, options = {})` and destructured
`const { idempotent = true } = options`. Any caller passing a time budget got
the transport's 30s default instead — silently, because an options bag that
ignores a key cannot report that it did. Nothing had noticed, because the only
flow that needs longer than 30s is the one flow nobody had ever run: an offline
torrent download, where MultCloud resolves the torrent before it settles the
dialog. The magnet create was killed mid-flow at 32.6s on a **mutating** call.

Two things made it read as a page defect rather than a budget defect:

- `execFile` reports a timeout as `Command failed: <the whole command>`. For a
  browser script that is 300 lines with no stated cause, so a timeout, a page
  rejection and a crash all printed the same wall of text.
- The in-script guard `if (box.value !== sourceLink)` compares the browser's
  textarea against the browser's own copy of the value, so it can confirm the
  page took what we sent and can never see a value corrupted before it arrived.

Raising our own budget then exposed a second ceiling, which is **not ours**: the
OpenCLI bridge kills a single `Runtime.evaluate` at ~115s
(`cdp_timeout — the page may be blocked by a native dialog`). A client timeout
above that is a promise the transport cannot keep.

**Decision**

- `evaluate()` forwards `timeout`. `tests/client.test.js` asserts it reaches the
  transport, and that omitting it still yields 30s.
- The builder submit asks for a budget its own flow can fit in, and every
  in-page wait is sized against `BRIDGE_EVAL_CEILING_MS`, asserted in
  `tests/creation.test.js` — a wait longer than the ceiling is a bug, not a
  preference.
- `runOpenCli` names a timeout as a timeout (`execFile` sets `killed`) and caps
  the echoed command, so the reason stays readable. The message is raised from
  shared code, so it says only what every caller shares and does **not** guess
  which operation was slow.
- Our client budget deliberately sits *above* the bridge ceiling: when the
  bridge gives up first, its message is more specific than ours.

**Consequence**

An interactive flow that legitimately needs more than ~115s cannot be one
`evaluate` call and must be split into phases with Node polling between them.
Today the remote-upload flow fits; if MultCloud gets slower, that split is the
next change, not a bigger number.

## ADR-018: A torrent has a step an HTTP link does not

**Date**: 2026-08-31
**Status**: accepted

**Context**

`addLinkSource` treated "every popup closed" as the success condition after
committing the Add Link dialog. That is correct for an HTTP/HTTPS URL, which is
all T-037 exercised.

It is unreachable for a torrent. Measured live 2026-08-31: once MultCloud
resolves a magnet it does not close the dialog — it **replaces** it with
`Select Content to Upload`, listing the files inside the torrent. For the
Blender Foundation's Sintel (CC-BY): `Name(11/11)`, `Sintel.mp4`, `mp4`,
`123.25 MB`, commit button `button.foot-download`, every file pre-selected.

So the popup count never reached zero, the CLI timed out waiting, and reported
`Please enter valid link` — quoting the dialog's own text as proof. That text is
present in the dialog whether or not anything is wrong, so the CLI was asserting
a cause it had never observed, about a magnet that had been accepted and fully
resolved. The evidence that settled it was a bare page read showing the resolved
file list on screen while the CLI was calling the link invalid.

**Decision**

- After committing Add Link, wait for **either** outcome: every popup closed, or
  a popup carrying `button.foot-download`. Commit the content dialog when it
  appears, then wait for it to close.
- Confirm the selection MultCloud arrives with rather than inventing one. It
  pre-ticks every file; choosing a subset is a feature nobody asked for, and
  guessing it here would silently drop files from a user's download.
- The failure message no longer claims a rejection it did not observe. It says
  the dialog neither closed nor opened a content selection within N seconds, and
  quotes the dialog as *text seen*, not as a diagnosis.

**Consequence**

`remote-upload` is the only command with a page-shape branch that depends on the
*kind of link*, not on the page. `tests/creation.test.js` gates all three parts:
the content-dialog commit is present, no unobserved-rejection claim is made, and
the link stage's waits fit inside the bridge ceiling.

## ADR-019: Dual-Transport Chokepoint (Desktop OpenCLI 2.0 + Headless Cloud VPS)

**Date**: 2026-10-21
**Status**: accepted

**Context**

Two fractures caused agents to bypass `src/` and write 20+ ad-hoc `puppeteer-core`
`.mjs` scripts on `multcloud-vps` (`/opt/multcloud-daemon/check_*.mjs`,
`setup_sync_*.mjs`, `trigger_*.mjs`):

1. **OpenCLI 2.0 CLI Flag Breaking Change**: `@jackwener/opencli` v2.0.0 removed
   `rewriteBrowserArgv` from `main.js`. Positional session arguments
   (`opencli browser mc eval ...`) now fail with `unknown command 'mc'`, requiring
   `opencli browser --session mc eval ...`.
2. **Cloud VPS Headless Gap**: Only the daemon (`operations/cloud-daemon/supervisor.js`)
   had been deployed to `multcloud-vps`. The 18-module CLI (`src/` + `bin/multcloud.js`)
   was not installed on `multcloud-vps`, and `src/client.js` only shelled out to
   `opencli browser` (which in `@jackwener/opencli` v2.0.0 hardcodes
   `new BrowserBridge()` inside `dist/src/commands/browser.js` rather than using
   `getBrowserFactory()` / `CDPBridge`). Whenever the local macOS Chrome bridge was
   closed or an agent SSHed into `multcloud-vps` to inspect drives, browse folders,
   or create a sync task, the CLI could not run — tempting agents to re-implement
   Element-UI / hand-rolled tree pickers from scratch in throwaway `.mjs` scripts.

**Decision**

Extend the single transport chokepoint in `src/client.js` (preserving ADR-003)
rather than writing parallel scripts:

1. **OpenCLI 2.0 Argument Normalizer (`formatOpenCliArgs`)**: `src/client.js`
   normalizes `['browser', '<session>', '<subcmd>', ...]` into
   `['browser', '--session', '<session>', '<subcmd>', ...]` before invoking
   `opencli`, keeping all existing callers and test expectations intact.
2. **Native Headless Cloud Transport (`headlessTransport`)**: When running on the
   Linux Cloud VPS (`/opt/multcloud-daemon/session.json` present on Linux) or when
   `MULTCLOUD_BACKEND=headless`, `src/client.js` drives Headless Google Chrome via
   `puppeteer-core`, hydrating cookies and `localStorage` via
   `evaluateOnNewDocument` from `session.json` and implementing the exact
   `tabs` / `open` / `eval` contract expected by `ensureSession()`, `evaluate()`,
   and `navigateTo()`.
3. **Remote VPS Delegation (`--vps` / `MULTCLOUD_BACKEND=cloud`)**: Passing
   `--vps` to `bin/multcloud.js` on macOS delegates the command over SSH to
   `/usr/local/bin/multcloud` on `multcloud-vps` (`/opt/multcloud-cli`), where
   timers run at full speed (`~412ms` for a `400ms` probe) with zero background-tab
   throttling.
4. **Error-Time Remedy Hint (Rung 3)**: When the local OpenCLI Browser Bridge is
   unreachable on macOS, `runOpenCli()` appends:
   `Hint: Local OpenCLI Browser Bridge is not connected. Pass --vps (or set MULTCLOUD_BACKEND=cloud) to execute against the 24/7 Cloud VPS session on multcloud-vps.`

**Consequence**

Every one of the 18 modules in `src/` (`clouds`, `drives`, `explorer`, `tasks`,
`transfer`, `sync`, `backup`, `remote-upload`, `doctor`, `flow`) runs identically
on macOS desktop and on `multcloud-vps`. Agents have zero reason to write one-off
Puppeteer scripts on the VPS.
