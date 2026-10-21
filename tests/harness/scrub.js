/**
 * Redact account-identifying material before anything reaches disk.
 *
 * This lives in its own module with no side effects, and that is the point.
 * It used to be exported from `tests/harness/record.js`, which calls `main()`
 * at module scope, so `tests/fixtures.test.js` importing this one function
 * silently ran a full recording against the live session.
 *
 * Fixtures are committed, so anything left here is permanent. What counts as
 * "identifying" was too narrow: the first version replaced 32-hex ids and
 * emails, which let a `magnet:?xt=urn:btih:<40 hex>` through untouched —
 * naming a specific torrent one of the account's remote-upload tasks had
 * fetched. Its guard could not see it either, because `\b[0-9a-f]{32}\b` does
 * not match inside a 40-character run. Both now key on runs of >= 32 hex.
 *
 * Replacement is deterministic, so a re-record produces a stable diff.
 */

/** A hex run this long is an identifier, whatever the surrounding syntax. */
export const ID_HEX_MIN = 32;

const ID_RUN = new RegExp(`[0-9a-f]{${ID_HEX_MIN},}`, 'gi');

/**
 * Synthetic replacement of the same length, so shapes survive scrubbing.
 *
 * Padded with `x`, which is deliberately NOT a hex digit. A replacement of
 * `fake` + zeros is itself a 37-character hex run at length 40, so the guard
 * that looks for identifier-length hex correctly flagged the scrubber's own
 * output. A sentinel that can be mistaken for the thing it replaces is not a
 * sentinel.
 */
function syntheticFor(index, length) {
  const head = 'fakex'.slice(0, Math.min(5, length));
  const tail = String(index);
  const pad = Math.max(0, length - head.length - tail.length);
  return (head + 'x'.repeat(pad) + tail).slice(0, length);
}

export function scrub(text) {
  const seen = new Map();
  return String(text)
    .replace(ID_RUN, (id) => {
      const key = id.toLowerCase();
      if (!seen.has(key)) seen.set(key, syntheticFor(seen.size + 1, id.length));
      return seen.get(key);
    })
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'redacted@example.invalid');
}
