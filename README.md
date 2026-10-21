# opencli-plugin-multcloud

Drive [MultCloud](https://app.multcloud.com) from the command line — cloud-to-cloud
transfer, sync, backup, offline remote upload (HTTP/magnet), Cloud Explorer, and
task observability.

MultCloud has **no public API**. Its payloads are AES-encrypted client-side and
posted to `/action.php` with a session cookie, so this plugin drives the real web
app through an authenticated Chrome session over the OpenCLI browser bridge.
Everything goes out through one chokepoint (`src/client.js`), which is also the
seam the offline test suite injects into.

## What makes this different from a scraper

Every claim the CLI makes is one it checked:

- **A write is verified by read-back.** A create confirms a new task id appeared;
  a delete confirms the id is gone. The page's reply is not the receipt — the
  worst bugs this project ever had were commands that returned success having
  done nothing at all.
- **Unknown is `null`, never `0` and never a default.** Fields carry `*Known`
  companions and aggregates carry a `warnings` array printed to **stderr**, so
  `--json` pipes stay clean while a human still learns the totals are a floor.
- **Ambiguity is refused.** A name matching more than one task or drive is an
  error listing the candidates. Mutations act by id only.
- **`ok: false` exits non-zero**, and an unknown flag exits 2 rather than being
  ignored.
- **Destructive commands require `--yes`** — both `tasks delete` and
  `explorer delete`.

## Install

```bash
opencli plugin install github:vecyang1/opencli-plugin-multcloud
opencli multcloud doctor
```

That registers twelve `opencli multcloud …` commands. For the standalone binary:

```bash
npm install -g opencli-plugin-multcloud
multcloud doctor
```

### Prerequisites

- Node 20+
- [`@jackwener/opencli`](https://github.com/jackwener/opencli) with its Chrome
  bridge on `127.0.0.1:19825`
- A Chrome tab logged in to `app.multcloud.com`, bound to the OpenCLI session
  named `mc`

`multcloud doctor` names whichever of these is missing.

## Use

```bash
multcloud doctor
multcloud doctor --vps
multcloud account
multcloud stats
multcloud clouds
multcloud clouds --status unavailable
multcloud clouds --vps
multcloud drives
```

Pass `--vps` (or set `MULTCLOUD_BACKEND=cloud`) to delegate any command over SSH
to a 24/7 headless Linux VPS session (`MULTCLOUD_VPS_HOST`, backed by
`puppeteer-core` and `session.json` inside `src/client.js`), running the exact
same 18 modules with zero background-tab timer throttling.

```bash
multcloud tasks
multcloud tasks --type remote --status failure
multcloud tasks --one-time
multcloud tasks --query archive --limit 5
multcloud tasks inspect "<id|name|alias>"
multcloud tasks logs "<id|name|alias>"
multcloud tasks watch "<id|name|alias>" --interval 15 --max-wait 600
multcloud tasks retry-failed
multcloud tasks delete "<id|name|alias>" --yes
```

```bash
multcloud transfer "Drive A/Folder" "Drive B" --name "Nightly"
multcloud sync "Drive A" "Drive B" --realtime
multcloud sync "Drive A" "Drive B" --twoway
multcloud backup "Drive A" "Drive B" --name "Snapshot"
multcloud remote-upload "https://example.com/file.iso" --cloud "Drive B" --path "Some/Folder"
```

```bash
multcloud explorer list "Drive A" "Some/Folder"
multcloud explorer rename "Drive A" "" "old.mp4" "new.mp4"
multcloud explorer delete "Drive A" "" "old.mp4" --yes
multcloud flow workflow.json
```

`--type` takes `transfer | sync | backup | remote`. Remote uploads are `linkTask`
internally; the CLI normalizes that.

`remote-upload` requires `--cloud`, and **rejects** `--name`: the Remote Upload
page carries no task-name control, so a name there can only be a local alias
(`multcloud tasks rename`). Both flags were previously accepted and dropped.

A **magnet or torrent** takes a different path through the page than an HTTP
URL, and it is slower. MultCloud resolves the torrent first and then, instead of
closing the Add Link dialog, opens a `Select Content to Upload` list of the files
inside it. The CLI waits for that, confirms the selection MultCloud arrives with
(every file already ticked), and only then submits. So a torrent create takes
tens of seconds longer than a URL — that is resolution time, not a hang. If it
reports that the dialog "neither closed nor opened a content selection", that is
a timeout, **not** a verdict on your link: read the account back with
`multcloud tasks --type remote` before retrying.

## Things the page will not tell you

These cost real debugging time and are worth knowing before you script this app
yourself:

- **Direct URL navigation does not work** for `cloud_transfer`, `cloud_sync`,
  `cloud_backup` or `remote_task`. The SPA stays on whatever route it held. This
  plugin clicks the sidebar and verifies arrival.
- **The two selection boxes on a builder page are different widgets**, and which
  is which depends on the page — Cloud Transfer pairs an Element-UI tree with a
  hand-rolled one, Cloud Sync uses the hand-rolled tree for both. There is no
  radio button anywhere on any of them, which is why the first version of this
  code had never once created a task.
- **"Failed" next to a drive is a quota lookup, not an expired token.** It sits
  in the slot that otherwise holds the account email and it flips between runs;
  drives marked that way are usually still fully readable and writable. This
  plugin reports `quota: ok | unavailable | unknown` and claims nothing about
  authorization.
- **The Manage Clouds page renders drives in three places and loads them
  progressively**, so scraping it returns a changing subset of the account. The
  roster is taken from the page's own model instead.
- **Baidu Netdisk** restricts third-party access to `/apps/Multcloud`
  (`我的应用数据 ➔ Multcloud`). Stage files there with Baidu's own instant copy
  first, or a transfer will not see them.
- **Renaming has two layers.** MultCloud only accepts in-place renaming for
  transfer tasks; sync, backup and remote-upload names are bound to schedules or
  torrent metadata. `tasks rename` always writes a local alias and additionally
  attempts the server rename, reporting each outcome separately.
- **A task card has two shapes.** Transfer/sync/backup cards hide Delete behind
  a "..." menu; a remote-upload card has no menu and carries Delete directly.
  `tasks delete` detects which, searches only inside the resolved card, and
  refuses when the count is not exactly one.
- **A hidden browser tab silently breaks every create.** Chrome throttles page
  timers in a background tab — an in-page `setTimeout(2000)` was measured taking
  **116 seconds**. Every create sleeps between steps, so a hidden tab pushes the
  script past the bridge's ~115s limit for one `Runtime.evaluate` and it dies
  mid-flow with a message that says nothing about visibility. Reads are
  unaffected, because reads do not sleep. `multcloud doctor` reports this as
  **Browser Tab Responsiveness**; run it first, and bring the Chrome window
  holding the MultCloud tab to the front before any create.
- **The Remote Upload page hides a second textarea** — the subscription
  cancellation feedback box. A bare `textarea` selector can pick it, which types
  a download URL into an account-cancellation form. The link input is taken from
  inside the visible dialog.

`docs/adr.md` records why each of these is handled the way it is.

## Testing

```bash
npm test
npm run test:live
```

`npm test` is hermetic — no browser, no network, no MultCloud account. That claim
is checked rather than asserted: the suite also passes with `opencli` removed
from `PATH`. `npm run test:live` is opt-in and read-only.

`docs/testing.md` explains the harness and the gates; `docs/architecture.md`
explains the chokepoint, the navigation contract and the builder-page widgets.

## State on disk

`~/.multcloud/aliases.json` maps task id to a human label, because MultCloud only
permits in-place renaming of transfer tasks. Set `MULTCLOUD_HOME` to relocate it;
anything writing there under test must.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

If you run a modified version of this over a network, the AGPL requires you to
offer its source to your users. OpenCLI itself is Apache-2.0 and is a *peer*
dependency — this plugin is a separate work that talks to it, not a derivative of
it, and installing them together does not relicense OpenCLI.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: when you fix a defect,
make the test fail first with the fix reverted — a gate that has only ever seen
working code is not evidence.
