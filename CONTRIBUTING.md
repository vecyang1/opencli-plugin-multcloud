# Contributing

## Ground rules

1. **Read `docs/architecture.md` and `docs/testing.md` first.** They record page
   contracts measured against the live app, not guessed from markup.
2. **Prove a fix.** Reintroduce the defect and watch the gate go red, then
   restore it and watch it go green. Every gate in this repo was added that way.
3. **Never claim a write succeeded because the page said so.** Read it back.
4. **Unknown is `null`.** Never `0`, never a plausible default, never a silent
   omission. If a total excludes something, say what and how many.

## Running the suites

```bash
npm test
npm run test:live
```

To prove the offline suite really is offline, run it with `opencli` off `PATH`:

```bash
mkdir -p /tmp/binonly && ln -sf "$(command -v node)" /tmp/binonly/node
PATH=/tmp/binonly node --test --test-concurrency=1 tests/*.test.js
```

## Fixtures

`tests/fixtures/*.json` are captures of real page traffic, scrubbed by
`tests/harness/scrub.js`. Re-record with `npm run record` when MultCloud's markup
changes and a fixture-backed test starts disagreeing with reality.

**Review a re-record before committing it.** The scrubber removes identifier-
length hex runs and email addresses, but it cannot know that your task names,
folder paths and magnet links are private. They are yours, and they will be in
the diff. The fixtures shipped here were additionally anonymised field by field.

Do not hand-edit a fixture to make a test pass unless reality moved.

## Browser scripts

Everything sent to the page is built with a template literal, so the template
consumes one level of backslashes before the browser sees it. Prefer `indexOf`
and character comparisons over regexes in emitted scripts; `tests/escaping.test.js`
fails the build on a single backslash inside template text, because that class of
bug compiles cleanly and matches nothing.

## License

By contributing you agree your work is licensed under AGPL-3.0-or-later.
