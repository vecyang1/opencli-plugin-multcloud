# MultCloud CLI Architecture

## Overview

MultCloud (`app.multcloud.com`) is a cloud-to-cloud transfer and sync SaaS with
no public REST API. It encrypts AJAX payloads client-side and authenticates with
session cookies. This project drives the real app through an authenticated
browser session (OpenCLI daemon / Chrome DevTools Protocol), so encryption,
token refresh and bot checks stay the browser's problem.

```
Terminal / agent                     OpenCLI
  multcloud <cmd> [--vps]              opencli multcloud <cmd>
        |                                        |
        v                                        v
  bin/multcloud.js                    ~/.opencli/clis/multcloud/*.js
        \                                       /
         \______________  src/  _______________/          one implementation,
                            |                             two entry points
                     src/client.js                        THE chokepoint
                   /               \
  Desktop (OpenCLI 2.0)        Cloud VPS (multcloud-vps / --vps)
  opencli browser --session mc   puppeteer-core + session.json
  CDP 127.0.0.1:19825            Headless Google Chrome (24/7)
                   \               /
             logged-in tab (app.multcloud.com)
```

## The chokepoint

Every module reaches the browser through `evaluate()` in `src/client.js`, which
reaches the outside world through a single transport interface. There is
deliberately no second path outside `src/client.js`: `setTransport()` is what
lets the whole codebase run offline under test, and a module that opened its own
socket or spawned ad-hoc Puppeteer scripts would silently opt out of the test
suite, the retry policy, `jsv()` escaping, and read-back verification.

`src/client.js` supports two production backends behind the same `transport(args, { timeout })` signature (see ADR-019):

1. **Desktop Backend (macOS)**: Shells out to `opencli browser --session mc <subcommand>`, normalized automatically by `formatOpenCliArgs()` for OpenCLI 2.0 compatibility. Connects to the user's active desktop Chrome session via the OpenCLI Browser Bridge (`127.0.0.1:19825`). If the local bridge is not connected, `runOpenCli()` appends an actionable remedy hint suggesting `--vps`.
2. **Headless Cloud Backend (Linux VPS `multcloud-vps` / `MULTCLOUD_BACKEND=headless`)**: Driven by `headlessTransport()` inside `src/client.js` using `puppeteer-core` and `/opt/multcloud-daemon/session.json` (`cookies` + `evaluateOnNewDocument(localStorage)`). Passing `--vps` (or `MULTCLOUD_BACKEND=cloud`) on macOS transparently delegates any `multcloud <cmd>` over SSH to `/usr/local/bin/multcloud` on `multcloud-vps`, running the exact same 18 `src/` modules against the 24/7 cloud session with zero background-tab timer throttling.

Two properties live there:

- **Idempotency.** `runOpenCli(args, { idempotent })` retries reads three times
  and mutations **never**. A create or delete that timed out client-side may
  already have landed server-side, and retrying it submits the mutation twice.
- **Value encoding.** `jsv(value)` builds every value that is interpolated into a
  browser script. See ADR-004.
- **The time budget.** `evaluate(js, { timeout })` forwards the caller's budget;
  it used to accept the key and drop it, so everything ran under the transport's
  30s default. The real ceiling, though, is not ours: the OpenCLI bridge kills a
  single `Runtime.evaluate` at **~115s**. Any one browser script has to finish
  inside that, so an interactive flow that needs longer must be split into
  phases with polling between them rather than given a larger number. See
  ADR-017.

One consequence worth stating, because it costs a debugging session: the bridge
serves one CDP connection, so a second `eval` fired while a long one is running
contends with it. Observing a live create by probing the page mid-flight is how
a healthy run gets a 30s read timeout — the measurement disturbs the thing being
measured. Read the account back **after** the command returns, not during.

## Navigation

`app.multcloud.com` is a single-page app whose creation routes cannot be reached
by loading their URL. Measured 2026-08-31: opening `/mc_project/cloud_transfer`,
`/cloud_sync`, `/cloud_backup` or `/remote_task` directly leaves the app on
whichever route it already held.

So `navigateTo()` tries, in order: already-there → sidebar click → URL, and
**verifies** the resulting route. `navigateToOrThrow()` is what every module
actually calls, because acting on the wrong page is how a create command can
silently do nothing while reporting success.

## Module map

| Module | Responsibility |
|---|---|
| `src/client.js` | Transport chokepoint, retry policy, JSON extraction, verified navigation, `jsv()` value encoding |
| `src/paths.js` | Single owner of on-disk locations; honours `MULTCLOUD_HOME` |
| `src/account.js` | Plan and traffic quota |
| `src/clouds.js` | Connected drives on the page's own roster, quota readability |
| `src/explorer.js` | Drive discovery from the live page, file browse/rename/delete |
| `src/tasks.js` | Task listing, type vocabulary, target resolution, inspect/logs/versions/options, run, retry, delete, watch, rename, alias registry |
| `src/task_builder.js` | Shared engine for the Transfer / Sync / Backup **and Remote Upload** pages, with read-back verification |
| `src/transfer.js`, `src/sync.js`, `src/backup.js`, `src/remote_upload.js` | Thin wrappers over the builder engine |
| `src/shares.js` | Shared files and links |
| `src/stats.js` | Aggregates, with warnings when a total is a floor |
| `src/doctor.js` | Health diagnosis |
| `src/flow.js` | Declarative multi-step workflows |
| `src/ui.js` | Colour, status badges, width-aware tables, stderr warnings |
| `bin/multcloud.js` | CLI dispatcher: flag table, `assertOk`, rendering |

## Data contracts

- **Unknown is not zero.** A value the page did not yield is `null`, and carries a
  `*Known` companion (`trafficKnown`, `capacityKnown`, `storage.measured`).
  Aggregates carry a `warnings` array, printed to stderr.
- **Task types** are normalized into `transfer | sync | backup | remote` by
  `normalizeTaskType()`. MultCloud's own names (`cloudTransfer`, `linkTask`,
  `cloudbackup`) never reach a user-facing filter.
- **Targets** are resolved by `resolveTask()` / `resolveDrive()`: exact id, then
  exact name/alias, then unique substring. More than one match is an error that
  lists the candidates.
- **Writes are verified by read-back**, not by the reply. Creates confirm a new
  task id appeared; deletes confirm the id is gone (`verifiedGone`), including
  `explorer delete`.
- **Rosters come from the page model, not from the DOM.** `listDrives()` merges
  every drive array Vue exposes and reports its `sources`; `listClouds()` builds
  on that and uses the DOM only for quota. The Manage Clouds page renders drives
  in three places and loads them progressively, so a scrape sees a changing
  sample — 12 of 21 on the run that exposed this. See ADR-010.
- **A page label is reported as what it measures.** MultCloud's `Failed` marker
  is a quota lookup and is surfaced as `quota: 'unavailable'`. This CLI makes no
  OAuth claim anywhere. See ADR-009.

## Driving the builder pages

Cloud Transfer / Sync / Backup each show two `.task-box` selectors, and the
picker behind a box is **one of two different widgets**:

| | rows | select | expand | selected marker |
|---|---|---|---|---|
| Element-UI tree | `.el-tree-node__content` | `.el-checkbox__inner` | `.el-tree-node__expand-icon` | label gains `is-checked` |
| Hand-rolled tree | `.tree-node-div` | `.tr-tree-name-span` | `i.pull-triangle` → `i.down-triangle` | row gains `tr-click` |

Cloud Transfer opens the Element-UI tree for FROM and the hand-rolled one for
TO; Cloud Sync opens the hand-rolled tree for both. Both trees can be in the DOM
at once with only one visible, so every query filters on visibility and
`src/task_builder.js` detects the widget rather than assuming a mapping. Task
name is edited through `.edit-task-icon` → `input.edit-input` → `i.name-sure`.
See ADR-008.

**Escapes.** Every browser script is a template literal, so the template eats one
level of backslashes before the page sees them. Prefer `indexOf` and character
comparisons in emitted scripts; `tests/escaping.test.js` fails the build on a
single backslash inside template text. See ADR-012.

## State

`~/.multcloud/aliases.json` (or `$MULTCLOUD_HOME/aliases.json`) maps task id to a
human label. It exists because MultCloud only permits in-place renaming of
transfer tasks; the alias layer gives every task type a stable name. Renames
report which of the two layers actually took effect.

## What this project deliberately does not do

- No hand-rolled HTTP to `/action.php`. Payloads are AES-encrypted client-side.
- No hardcoded account identifiers. Drives and the user context are read from the
  live page; see ADR-005.
- No credential handling of any kind. Authentication is the browser session's.
