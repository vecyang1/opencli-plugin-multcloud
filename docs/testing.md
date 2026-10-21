# Testing

`npm test` is **hermetic**: it runs with no browser, no network and no MultCloud
account, and it must stay that way. `npm run test:live` is the opt-in read-only
suite that talks to the real session.

## Why the split

The suite this replaced declared 20 tests, of which 18 required a live
authenticated browser. That number described one machine at one moment: on any
other machine the suite could not pass at all, and no test ever executed
`bin/multcloud.js`, which is exactly where every serious defect lived.

## How offline tests reach the code

`src/client.js` owns the single path to the outside world. `setTransport()`
replaces it; nothing else in the codebase opens a socket, so swapping the
transport is sufficient — and there is deliberately no second route that could
bypass it.

```js
import '../tests/harness/sandbox.js';           // ALWAYS first
import { installFakeBridge, pageRouter } from './harness/fake-bridge.js';

const bridge = installFakeBridge(pageRouter({
  handlers: [['taskList', JSON.stringify(rows)]]
}));
try {
  // ... exercise src/ ...
  bridge.scripts();   // every script sent to the browser
  bridge.calls;       // every argument, including ones no test reads yet
} finally { bridge.restore(); }
```

The fake answers the browser; it does not execute it. So it returns the shape the
**in-page script returns** (`taskId`, `taskName`, ...), not MultCloud's internal
Vue model.

## Isolation

`tests/harness/sandbox.js` is the only place allowed to set `MULTCLOUD_HOME`, and
every test file must import it **before** anything from `src/`.
`tests/fixtures.test.js` enforces that ordering and reports how many files it
graded.

`MULTCLOUD_HOME` is a *location*, not a credential: unsetting it does not mean
"use nothing", it means "use `~/.multcloud/`" — the real alias registry, which
holds live task labels. So it is set to a temp directory, never deleted, and a
test asserts the real file is byte-identical after the run.

## Fixtures

`tests/fixtures/*.json` are captured from the live page by
`node tests/harness/record.js <tasks|clouds|account|shares|drives>`, so tests are
graded against bytes MultCloud actually produced. The recorder refuses any
mutating command.

Everything it writes is scrubbed: 32-hex identifiers become `fake0000…N` and
email addresses become `redacted@example.invalid`. `tests/fixtures.test.js`
asserts no unscrubbed identifier survives — fixtures are committed, and this
repo previously carried seven real drive tokenIds in source.

Re-record when MultCloud's markup changes and a fixture-backed test starts
disagreeing with reality. Do not hand-edit a fixture to make a test pass unless
reality moved.

## The gates worth knowing about

| File | What it guarantees |
|---|---|
| `tests/contract.test.js` | Every `multcloud …` command printed in any Markdown file, the skill, or `--help` parses. Reports its own subject count. |
| `tests/scripts.test.js` | Every string sent to the browser is valid JavaScript. The fake bridge answers scripts without running them, so this is the only offline gate that catches a browser-side `SyntaxError`. |
| `tests/injection.test.js` | `jsv()` renders a breakout payload inert — and asserts the *old* escaping really did execute it, so the exploit fixture cannot rot into a tautology. |
| `tests/tasks.test.js` | Ambiguous targets are refused; deletes are id-only and verified by read-back. Also: a task whose payload states no status reads as `Unknown`, never as a hardcoded calm-sounding default — and the classifier the page runs is the same function source the test calls, so the two cannot drift. |
| `tests/honesty.test.js` | Unreadable values surface as `null` plus a warning, never as `0` or a stored default. |
| `tests/creation.test.js` | A create that produced no task reports failure. Also: every builder submit asks for a time budget larger than the transport default; the link stage's waits fit inside the bridge's own ~115s `Runtime.evaluate` ceiling; the torrent content-selection dialog is committed; and no failure message claims a rejection the script never observed. |
| `tests/client.test.js` | `evaluate()` forwards a caller's `timeout` to the transport (it used to accept and drop it), still defaults to 30s, and a timeout is reported *as* a timeout with the command echo capped instead of 300 lines of script standing in for a reason. |
| `tests/dispatcher.test.js` | Runs the real binary: unknown flags, missing values, confirmation gates. |
| `tests/fixtures.test.js` | Sandbox isolation and fixture scrubbing. |
| `tests/escaping.test.js` | No backslash inside a template literal that the template would eat before the browser sees it. Catches `\\b` → backspace and `\\(` → `(`, both of which compile and match nothing. Reports its own file count. |
| `tests/deletion.test.js` | `explorer delete` reports failure when the item is still listed afterwards; both deletes scope their confirmation to the delete dialog rather than to any button on the page reading "Delete". |
| `tests/fixtures.test.js` | Also: no test file imports a harness script that runs on import, and the committed fixtures are unchanged when the suite ends. |
| `tests/coverage-shape.test.js` | The denominator gate. Every export whose name is mutation-shaped must be called by a hermetic test, or be allowlisted **with the reason it only reads**; a second test proves no allowlisted name has been renamed away. Also asserts at least one test executes `bin/multcloud.js` as a process. Reports its own counts and refuses to pass if its extractor finds an implausibly small population. |

## Why the coverage-shape gate exists

The handover suite was 20 tests that called nine read functions thirty-four
times, **zero** write functions, and never ran the binary. All nine read paths
worked; all six write paths were broken. That is the shape this gate measures,
because nothing else in a green run distinguishes "covers everything" from
"covers only the half that cannot lie" — reads are cheap and safe to exercise,
writes are expensive and destructive, so coverage drifts to reads on its own.

It went red on its first run against `retryFailedTasks`, a bulk mutation with no
hermetic test. When you add a function that mutates the account, this gate is
what tells you the test is missing; do not silence it by allowlisting unless the
function genuinely only reads, and say so in the reason string.

## Proving the offline suite is actually offline

The claim "no browser, no account" is worth re-checking rather than believing,
because it was false for a while: `tests/fixtures.test.js` imported `scrub` from
`record.js`, whose `main()` runs on import, so every `npm test` opened the live
session and rewrote all five fixtures. Two gates guard it now, and this is the
end-to-end proof — run the suite with `opencli` off `PATH`:

```bash
mkdir -p /tmp/binonly && ln -sf "$(command -v node)" /tmp/binonly/node
PATH=/tmp/binonly node --test --test-concurrency=1 tests/*.test.js
```

151/151 pass with the bridge unreachable. Anything that shells out would fail
here, loudly.

## Adding a test

1. Import the sandbox first.
2. Prefer the fake bridge over a mock of a `src/` function — a stub that sits on
   the boundary you care about erases the property you are testing.
3. When you fix a defect, make the test fail first with the fix reverted. A gate
   that has only ever seen working code is not evidence.
4. Do not identify a script by an internal helper name. `tests/creation.test.js`
   keyed the builder submit on a function name; renaming that helper turned four
   assertions green-for-nothing. Key on a parameter the script must carry
   (`BUILDER_MARKER`), and give the navigation script a name nothing else uses
   (`wantedSection`) — a generic `const wanted =` collided with two page scripts
   and the fake router silently swallowed both.
