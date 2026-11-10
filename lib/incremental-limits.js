// dsh-wiki — the shared shapes of the incremental update option (spec 013 §2.3), defined once.
//
// Why a leaf module instead of two copies: lib/worker-protocol.js (the prompt builder) and lib/jobs.js
// (the job manager) must agree on the same caps and the same commit shape. The owner-approved dormancy
// rule says **lib/jobs.js must not import ./worker-protocol.js** — the prompt builder is injected by the
// Host, and tools/worker-protocol-test.mjs plus tools/jobs-worker-test.mjs each pin that with an
// assertion. Keeping two hand-synchronized copies worked, but "cannot drift" had to be re-established
// by a comparison test on every edit. This module is imported by both and imports neither, so the rule
// is untouched: no module here imports another, and this file has no imports of its own.
//
// Nothing here is executable policy: the caps are contract (a set above them is refused, never trimmed),
// and COMMIT_RE is an object-name shape (git sha1 or sha256; abbreviations and refs are not object
// names). Both consumers apply their own validation around them.

/**
 * Caps for the optional `incremental` affected set (spec 013 §2.3). They are part of the contract, not a
 * suggestion: an affected set above them is refused, never trimmed into a "smaller looking" increment.
 * 500 is honest for this feature — the only measured corpus affected 23 of 31 pages in one diff, and
 * "500 affected pages" is a full rebuild wearing an incremental label.
 */
export const INCREMENTAL_LIMITS = Object.freeze({
  maxEntries: 500,
  maxFilePaths: 500,
  maxIdLength: 200,
  maxPathLength: 4096,
});

/** A full commit object name: git sha1 (40 hex) or sha256 (64 hex). Abbreviations and refs are refused. */
export const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
