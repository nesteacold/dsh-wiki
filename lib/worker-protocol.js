// dsh-wiki — Host-pinned worker protocol loader and deterministic prompt builder (spec 007 follow-up).
//
// DORMANT: nothing imports this module yet. lib/index.js still keeps background jobs gated off and
// lib/jobs.js still builds its own prompt. This file is the reviewable contract for the prompt that
// can replace jobs.js buildPrompt() only after the T018-T020 release gates pass; it is not wired in
// here and it opens nothing.
//
// Design constraints:
// - The protocols are exactly two fixed, plugin-owned files, derived from this module's own
//   location: <plugin>/skills/worker-protocol.md for canonical generation and
//   <plugin>/skills/translation-protocol.md for translation. There is no path parameter, no config
//   override, no skills-service lookup and no repository path: a caller cannot point a loader at
//   other text.
// - The plugin root, the skills directory and the file itself must be regular, non-symlink entries
//   (lstat; Windows junctions report as symlinks). The file is opened once and read through the
//   handle, so the classified inode is the one whose bytes are hashed.
// - Protocol hash and prompt hash are separate exports of the result: `protocolSha256` is SHA-256 of
//   the exact protocol file bytes, `promptSha256` is SHA-256 of the exact UTF-8 prompt string. They
//   are never conflated, so a job can be reproduced from (protocolSha256, promptSha256).
// - The prompt prose is English-only, the line endings are LF-only and the output is deterministic:
//   the same validated inputs produce identical bytes. All interpolated paths are JSON-quoted (they
//   may contain legitimate Unicode), the job/staging relationship is checked against the job id, and
//   the effective configuration is projected onto the eight known fields.
// - The final prompt is denied if it contains a raw skill gesture (a slash-prefixed lowercase
//   token), a C0 control, CR, an invisible Unicode line separator/bidirectional control/BOM, or if
//   it exceeds the size bound. This check runs over the whole assembled prompt, so a hostile root
//   name cannot smuggle a gesture or a fake line through an interpolated value.
//
// LIMITATIONS (do not oversell this module):
// - Instructions are not isolation. Preseeding a prompt text does not confine tools, child agents or
//   context loaders, and it is not an OS sandbox, sandbox policy, permission boundary or write fence.
//   The separate lib/worker-guard.js policy layer is also not a kernel boundary.
// - Context-loader isolation is NOT solved by preseeding. Repo instruction files (AGENTS.md,
//   CLAUDE.md, README variants), the Host's skill catalog and the Host's own context assembly run
//   outside this module and can still inject text into the same session. Calling this "preseeded"
//   is accurate; calling it "isolated" would not be.
// - Path *shape* only: this module rejects relative/traversal/control-character paths and a staging
//   directory that is not the job's own. Realpath/no-follow containment for root, staging, live and
//   backup (T020) and actual staging-only write enforcement (T019) remain release blockers.
// - Ancestors above the plugin root are outside this module's control and are not validated here;
//   the plugin root itself is.
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(MODULE_DIR, "..");
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

/** The one protocol file this loader can ever read. Fixed, plugin-owned, never caller-supplied. */
export const WORKER_PROTOCOL_FILE = path.join(SKILLS_DIR, "worker-protocol.md");

/** The translation protocol file: fixed, plugin-owned and never caller-supplied. */
export const TRANSLATION_PROTOCOL_FILE = path.join(SKILLS_DIR, "translation-protocol.md");

/** Target-language shape accepted by the translation prompt builder (mirrors the request validator). */
const TARGET_LANG_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TARGET_LANG_MAX = 35;

/**
 * Active wiki directory name; a job stages in the sibling `<root>/.dsh-wiki.staging-<jobId>`.
 * Fixed to the spec 007 name on purpose: a future Host custom `wikiDirName` must be threaded through
 * explicitly at wiring time (and re-reviewed) rather than silently accepted here.
 */
export const WIKI_DIR_NAME = ".dsh-wiki";

/** Exact staging prefix the builder accepts (the job id must follow it). */
export const WORKER_STAGING_PREFIX = `${WIKI_DIR_NAME}.staging-`;

/** The only tools the worker may use; mirrors lib/worker-guard.js ALLOWED_TOOLS. */
export const WORKER_TOOL_SCOPE = Object.freeze(["read", "glob", "grep", "write", "edit"]);

/** The only effective-config fields the prompt may carry, in stable order. */
export const WORKER_CONFIG_FIELDS = Object.freeze([
  "language",
  "granularity",
  "pages",
  "tree",
  "wordsPerPage",
  "diagrams",
  "citations",
  "skeleton",
]);

/**
 * A raw skill gesture as the Host's loaders recognize it: a slash-prefixed lowercase token at the
 * start of a line or after whitespace, ending at whitespace or end of text. The final prompt must
 * never match this, including through interpolated values.
 */
export const RAW_SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(-[a-z0-9]+)*)(?=\s|$)/;

export const WORKER_PROTOCOL_LIMITS = Object.freeze({
  maxProtocolBytes: 64 * 1024,
  maxPromptBytes: 256 * 1024,
  maxPathLength: 4096,
  maxJobIdLength: 64,
});

const DEFAULT_IO = Object.freeze({ lstat, open });

const isWin = process.platform === "win32";

export class WorkerProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerProtocolError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new WorkerProtocolError(code, message);
};

const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Case/format-insensitive path equality for the host platform (canonical inputs expected). */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const trim = (value) => (value.length > 1 ? value.replace(/[\\/]+$/, "") : value);
  const left = trim(a);
  const right = trim(b);
  return isWin ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function splitSegments(value) {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

const hasControlChar = (value) => /[\u0000-\u001f\u007f]/.test(value);

/**
 * Invisible characters that can start a visual line or reorder text: Unicode line/paragraph
 * separators, bidirectional embeddings/overrides/isolates, and a byte-order mark. A repository path
 * may technically contain one; it is refused here because the prompt is line-oriented text.
 */
const UNSAFE_INVISIBLE = /[\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

/** Own keys only, all string, no symbols; a proxy that cannot be inspected is rejected. */
function ownStringKeys(value, code, label) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code, `${label} cannot be inspected`);
  }
  for (const key of keys) {
    if (typeof key !== "string") fail(code, `${label} must not have symbol keys`);
  }
  return keys;
}

function safeGet(object, key, code, label) {
  try {
    return object[key];
  } catch {
    fail(code, `${label}.${key} cannot be read`);
  }
}

// ---------- paths ----------

/**
 * Validate one absolute path used by the prompt builder. Rejects non-strings, empty values,
 * overlong values, control characters/NUL, leading/trailing whitespace, non-absolute paths,
 * Windows UNC/device and drive-relative forms, "." and ".." segments, and any spelling that is not
 * already canonical (so a path cannot carry a lexical shortcut into the prompt).
 */
function canonicalAbsolutePath(value, label, code) {
  if (typeof value !== "string") fail(code, `${label} must be a string`);
  if (value.length === 0) fail(code, `${label} must not be empty`);
  if (value.length > WORKER_PROTOCOL_LIMITS.maxPathLength) {
    fail(code, `${label} is longer than ${WORKER_PROTOCOL_LIMITS.maxPathLength} characters`);
  }
  if (hasControlChar(value)) fail(code, `${label} contains a control character or NUL byte`);
  if (UNSAFE_INVISIBLE.test(value)) {
    fail(code, `${label} contains an unsafe Unicode line separator, bidirectional control or byte-order mark`);
  }
  if (value !== value.trim()) fail(code, `${label} must not have leading or trailing whitespace`);
  if (!path.isAbsolute(value)) fail(code, `${label} must be an absolute path, got ${JSON.stringify(value)}`);
  if (isWin) {
    if (/^[\\/]{2}/.test(value)) fail(code, `${label} must not be a UNC or device path`);
    if (/^[a-zA-Z]:(?![\\/])/.test(value)) fail(code, `${label} must not be a drive-relative path`);
  }
  for (const segment of splitSegments(value)) {
    if (segment === "..") fail(code, `${label} must not contain a ".." segment`);
    if (segment === ".") fail(code, `${label} must not contain a "." segment`);
  }
  const resolved = path.resolve(value);
  if (!samePath(resolved, value)) {
    fail(code, `${label} must already be canonical (no "." segments, ".." segments or separator changes); use ${JSON.stringify(resolved)}`);
  }
  return resolved;
}

function validateRoot(value) {
  const root = canonicalAbsolutePath(value, "root", "invalid-root");
  if (samePath(root, path.parse(root).root)) {
    fail("invalid-root", "the repository root must not be a filesystem root");
  }
  return root;
}

function validateJobId(value) {
  if (typeof value !== "string") fail("invalid-job-id", "jobId must be a string");
  if (!new RegExp(`^[a-z0-9]{1,${WORKER_PROTOCOL_LIMITS.maxJobIdLength}}$`).test(value)) {
    fail(
      "invalid-job-id",
      `jobId must be 1-${WORKER_PROTOCOL_LIMITS.maxJobIdLength} lowercase ASCII letters or digits; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The staging directory must be exactly `<root>/.dsh-wiki.staging-<jobId>`: same parent as the live
 * wiki directory, prefix fixed, suffix equal to the validated job id. A true sibling of the repo, a
 * directory inside the live wiki, or a name carrying another id is rejected.
 */
function validateStage(root, value, jobId) {
  const stage = canonicalAbsolutePath(value, "stageDir", "invalid-staging");
  const expected = path.join(root, `${WORKER_STAGING_PREFIX}${jobId}`);
  if (!samePath(stage, expected)) {
    fail("invalid-staging", `stageDir must be exactly ${JSON.stringify(expected)}; got ${JSON.stringify(stage)}`);
  }
  if (!samePath(path.dirname(stage), root)) {
    fail("invalid-staging", `stageDir's parent must be the repository root ${JSON.stringify(root)}; got ${JSON.stringify(path.dirname(stage))}`);
  }
  const name = path.basename(stage);
  if (!name.startsWith(WORKER_STAGING_PREFIX)) {
    fail("invalid-staging", `stageDir must start with ${JSON.stringify(WORKER_STAGING_PREFIX)}`);
  }
  const suffix = name.slice(WORKER_STAGING_PREFIX.length);
  if (suffix !== jobId) {
    fail("invalid-staging", `stageDir's job id suffix ${JSON.stringify(suffix)} does not match jobId ${JSON.stringify(jobId)}`);
  }
  return stage;
}

// ---------- effective config ----------

const requireEnum = (value, name, allowed) => {
  if (typeof value !== "string") fail("invalid-config", `${name} must be a string`);
  if (!allowed.includes(value)) {
    fail("invalid-config", `${name} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value;
};

const requireInteger = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid-config", `${name} must be an integer ${min}-${max}; got ${JSON.stringify(value)}`);
  }
  return value;
};

function projectNested(value, name, fields) {
  if (!isPlainObject(value)) fail("invalid-config", `${name} must be a plain object`);
  const keys = ownStringKeys(value, "invalid-config", name);
  for (const key of keys) {
    if (!fields.includes(key)) fail("invalid-config", `${name} has an unknown field ${JSON.stringify(key)} (allowed: ${fields.join(", ")})`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail("invalid-config", `${name} is missing ${JSON.stringify(key)}`);
  }
  return value;
}

/**
 * Project the Host-resolved effective configuration onto the eight known fields, validate it, and
 * return a deep-frozen canonical object.
 *
 * The accepted input is the canonical-English configuration the Host resolved with the builder:
 * `python3 build_wiki_site.py resolve-config --repo <root> --set language=en --dry-run`, whose
 * stdout is the DIRECT resolved object (one JSON object, printed by the builder). Parse that stdout
 * and pass the resulting object here. It is NOT the `.resolved` member of
 * `<root>/.dsh-wiki/generation-meta.json` and not the generation-meta wrapper: `--dry-run` writes
 * nothing, so stdout is the only source of truth, and the builder prints the object itself.
 *
 * Because the Host resolves with `--set language=en`, the builder's zero-config default `auto` never
 * reaches this function. Only canonical English is accepted: `language` must be exactly "en", with no
 * auto-detection and no normalization, so `auto`, `en-US`, `EN`, padded strings and every other
 * locale fail here instead of being rewritten to "en".
 *
 * Unknown fields (including `profile`, which resolve-config expands before printing) are rejected
 * rather than silently carried into the prompt.
 */
export function projectEffectiveConfig(config) {
  if (!isPlainObject(config)) {
    fail(
      "invalid-config",
      "the effective configuration must be a plain object (the direct object printed on stdout by `resolve-config --repo <root> --set language=en --dry-run`, not the generation-meta `.resolved` wrapper)",
    );
  }
  const keys = ownStringKeys(config, "invalid-config", "the effective configuration");
  for (const key of keys) {
    if (!WORKER_CONFIG_FIELDS.includes(key)) {
      fail("invalid-config", `unknown configuration field ${JSON.stringify(key)}; the worker prompt only accepts ${WORKER_CONFIG_FIELDS.join(", ")}`);
    }
  }
  for (const key of WORKER_CONFIG_FIELDS) {
    if (!Object.hasOwn(config, key)) fail("invalid-config", `the effective configuration is missing ${JSON.stringify(key)}`);
  }

  const language = safeGet(config, "language", "invalid-config", "the effective configuration");
  if (language !== "en") {
    fail("invalid-config", `the worker is canonical English only: language must be exactly "en"; got ${JSON.stringify(language)}`);
  }
  const granularity = requireEnum(safeGet(config, "granularity", "invalid-config", "the effective configuration"), "granularity", ["theme", "file", "hybrid"]);
  const diagrams = requireEnum(safeGet(config, "diagrams", "invalid-config", "the effective configuration"), "diagrams", ["none", "minimal", "rich"]);
  const citations = requireEnum(safeGet(config, "citations", "invalid-config", "the effective configuration"), "citations", ["relaxed", "strict"]);

  const pages = projectNested(safeGet(config, "pages", "invalid-config", "the effective configuration"), "pages", ["min", "max"]);
  const pagesMin = requireInteger(safeGet(pages, "min", "invalid-config", "pages"), "pages.min", 1, 100);
  const pagesMax = requireInteger(safeGet(pages, "max", "invalid-config", "pages"), "pages.max", 1, 100);
  if (pagesMin > pagesMax) fail("invalid-config", `pages.min (${pagesMin}) must be <= pages.max (${pagesMax})`);

  const tree = projectNested(safeGet(config, "tree", "invalid-config", "the effective configuration"), "tree", ["maxChildren", "maxDepth"]);
  const maxChildren = requireInteger(safeGet(tree, "maxChildren", "invalid-config", "tree"), "tree.maxChildren", 2, 16);
  const maxDepth = requireInteger(safeGet(tree, "maxDepth", "invalid-config", "tree"), "tree.maxDepth", 2, 6);

  const wordsPerPage = safeGet(config, "wordsPerPage", "invalid-config", "the effective configuration");
  if (!Array.isArray(wordsPerPage) || wordsPerPage.length !== 2) {
    fail("invalid-config", "wordsPerPage must be an array of exactly two integers [min, max]");
  }
  const wordsMin = requireInteger(wordsPerPage[0], "wordsPerPage[0]", 100, 5000);
  const wordsMax = requireInteger(wordsPerPage[1], "wordsPerPage[1]", 100, 5000);
  if (wordsMin > wordsMax) fail("invalid-config", `wordsPerPage[0] (${wordsMin}) must be <= wordsPerPage[1] (${wordsMax})`);

  const skeleton = projectNested(safeGet(config, "skeleton", "invalid-config", "the effective configuration"), "skeleton", ["knownIssues"]);
  const knownIssues = safeGet(skeleton, "knownIssues", "invalid-config", "skeleton");
  if (typeof knownIssues !== "boolean") fail("invalid-config", "skeleton.knownIssues must be a boolean");

  return Object.freeze({
    language: "en",
    granularity,
    pages: Object.freeze({ min: pagesMin, max: pagesMax }),
    tree: Object.freeze({ maxChildren, maxDepth }),
    wordsPerPage: Object.freeze([wordsMin, wordsMax]),
    diagrams,
    citations,
    skeleton: Object.freeze({ knownIssues }),
  });
}

// ---------- protocol loading ----------

async function requireRegularDirectory(io, target, label, code) {
  let info;
  try {
    info = await io.lstat(target);
  } catch (error) {
    fail(code, `${label} is not accessible (${error?.code ?? "error"})`);
  }
  if (info.isSymbolicLink()) fail(code, `${label} must not be a symbolic link or junction`);
  if (!info.isDirectory()) fail(code, `${label} must be a directory`);
}

async function readProtocolBytes(io, file = WORKER_PROTOCOL_FILE) {
  let info;
  try {
    info = await io.lstat(file);
  } catch (error) {
    fail("invalid-protocol-file", `the pinned worker protocol file is not accessible (${error?.code ?? "error"})`);
  }
  if (info.isSymbolicLink()) {
    fail("invalid-protocol-file", "the pinned worker protocol file must not be a symbolic link or junction");
  }
  if (!info.isFile()) fail("invalid-protocol-file", "the pinned worker protocol file must be a regular file");
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    fail("invalid-protocol-file", "the pinned worker protocol file must be a non-empty regular file");
  }
  if (size > WORKER_PROTOCOL_LIMITS.maxProtocolBytes) {
    fail("protocol-too-large", `the pinned worker protocol file is ${size} bytes; the limit is ${WORKER_PROTOCOL_LIMITS.maxProtocolBytes}`);
  }

  let handle;
  try {
    handle = await io.open(file, "r");
  } catch (error) {
    fail("invalid-protocol-file", `the pinned worker protocol file could not be opened (${error?.code ?? "error"})`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("invalid-protocol-file", "the opened worker protocol handle is not a regular file");
    const sizeNow = Number(stat.size);
    if (!Number.isSafeInteger(sizeNow) || sizeNow <= 0) {
      fail("invalid-protocol-file", "the opened worker protocol file is empty");
    }
    if (sizeNow > WORKER_PROTOCOL_LIMITS.maxProtocolBytes) {
      fail("protocol-too-large", `the opened worker protocol file is ${sizeNow} bytes; the limit is ${WORKER_PROTOCOL_LIMITS.maxProtocolBytes}`);
    }
    const buffer = await handle.readFile();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      fail("invalid-protocol-file", "the worker protocol file read returned no bytes");
    }
    if (buffer.length > WORKER_PROTOCOL_LIMITS.maxProtocolBytes) {
      fail("protocol-too-large", `the worker protocol file grew to ${buffer.length} bytes; the limit is ${WORKER_PROTOCOL_LIMITS.maxProtocolBytes}`);
    }
    return buffer;
  } catch (error) {
    if (error instanceof WorkerProtocolError) throw error;
    fail("invalid-protocol-file", `the worker protocol file could not be read (${error?.code ?? "error"})`);
  } finally {
    try {
      await handle.close();
    } catch {
      /* closing a read handle cannot change the decision */
    }
  }
}

/**
 * Load one of the two fixed, plugin-owned protocol files. The file is a module constant, never an
 * option, so a caller can only select which pinned protocol is read, never which path.
 */
async function loadProtocolFile(file, io) {
  await requireRegularDirectory(io, PLUGIN_ROOT, "the plugin root", "invalid-protocol-ancestor");
  await requireRegularDirectory(io, SKILLS_DIR, "the plugin skills directory", "invalid-protocol-ancestor");

  const buffer = await readProtocolBytes(io, file);
  const rawText = buffer.toString("utf8");
  if (!Buffer.from(rawText, "utf8").equals(buffer)) {
    fail("invalid-protocol-file", "the worker protocol file must be valid UTF-8");
  }
  if (rawText.charCodeAt(0) === 0xfeff) {
    fail("invalid-protocol-file", "the worker protocol file must not start with a byte-order mark");
  }
  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) fail("invalid-protocol-file", "the worker protocol file must not be empty");
  if (text.includes("\u0000")) fail("invalid-protocol-file", "the worker protocol file must not contain a NUL byte");

  return Object.freeze({
    path: file,
    text,
    sha256: sha256Hex(buffer),
    bytes: buffer.length,
    lineCount: text.split("\n").length,
  });
}

/**
 * Load the fixed, plugin-owned canonical-generation protocol file.
 *
 * There is deliberately no path option: callers may only inject `{ io: { lstat, open } }` for tests,
 * never a target file. Returns the LF-normalized text, the SHA-256 of the exact file bytes and the
 * byte size. Rejects symlinked/nonregular files and symlinked plugin/skills ancestors.
 */
export async function loadWorkerProtocol(options = {}) {
  if (!isPlainObject(options)) {
    fail("invalid-options", "loadWorkerProtocol takes an optional plain object with only an io override");
  }
  for (const key of ownStringKeys(options, "invalid-options", "the loadWorkerProtocol options")) {
    if (key !== "io") {
      fail("invalid-options", `loadWorkerProtocol does not accept ${JSON.stringify(key)}: the protocol path is fixed and cannot be supplied`);
    }
  }
  const io = { ...DEFAULT_IO };
  if (options.io !== undefined) {
    if (!isPlainObject(options.io)) fail("invalid-options", "the io override must be a plain object");
    for (const key of ownStringKeys(options.io, "invalid-options", "the io override")) {
      if (key !== "lstat" && key !== "open") fail("invalid-options", `the io override does not accept ${JSON.stringify(key)}`);
      const fn = safeGet(options.io, key, "invalid-options", "the io override");
      if (typeof fn !== "function") fail("invalid-options", `the io override ${key} must be a function`);
      io[key] = fn;
    }
  }

  return loadProtocolFile(WORKER_PROTOCOL_FILE, io);
}

// ---------- prompt building ----------

const PROMPT_HEADER = "# dsh-wiki worker protocol (Host-pinned, canonical English)";

function composePrompt({ protocol, jobId, root, stageDir, config }) {
  const lines = [
    PROMPT_HEADER,
    "",
    protocol.text.trimEnd(),
    "",
    "# Job",
    "",
    `Job id: ${JSON.stringify(jobId)}`,
    `Repository root (absolute): ${JSON.stringify(root)}`,
    `Staging wiki directory (absolute): ${JSON.stringify(stageDir)}`,
    `Target language: ${JSON.stringify("en")} (canonical English only; no other locale is written)`,
    "",
    "Effective configuration (validated, canonical JSON; do not change it):",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    "",
    "Write only `pages/<id>.md` and `cards/<id>.md` inside the staging wiki directory above.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The exact gate every prompt must pass before it may reach a worker session. Exported so tests (and
 * a future Host adapter) can prove the denial on assembled text, not only through one code path.
 */
export function assertWorkerPromptSafe(prompt) {
  if (typeof prompt !== "string") fail("invalid-prompt", "the worker prompt must be a string");
  if (prompt.includes("\r")) fail("invalid-prompt", "the worker prompt must use LF line endings only");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    fail("invalid-prompt", "the worker prompt contains a control character other than LF");
  }
  if (UNSAFE_INVISIBLE.test(prompt)) {
    fail("invalid-prompt", "the worker prompt contains an unsafe Unicode line separator, bidirectional control or byte-order mark");
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > WORKER_PROTOCOL_LIMITS.maxPromptBytes) {
    fail("prompt-too-large", `the worker prompt is ${bytes} bytes; the limit is ${WORKER_PROTOCOL_LIMITS.maxPromptBytes}`);
  }
  const gesture = RAW_SKILL_GESTURE.exec(prompt);
  if (gesture) {
    fail(
      "prompt-skill-gesture",
      `the worker prompt would contain a raw skill gesture (${JSON.stringify(gesture[0].trim())}); refusing to build a prompt a loader could interpret as an instruction`,
    );
  }
}

/**
 * Build the deterministic worker prompt for one job.
 *
 * @param {object} options
 * @param {string} options.jobId lowercase ASCII job id (jobs.js generates 16 hex characters)
 * @param {string} options.root absolute, canonical repository root
 * @param {string} options.stageDir absolute `<root>/.dsh-wiki.staging-<jobId>`
 * @param {object} options.config the DIRECT object printed on stdout by
 *   `build_wiki_site.py resolve-config --repo <root> --set language=en --dry-run` (exactly the eight
 *   known fields with canonical `language: "en"`); not the generation-meta `.resolved` wrapper
 * @returns {Promise<object>} frozen { prompt, promptSha256, protocolSha256, protocolPath, ... }
 */
export async function buildWorkerPrompt(options) {
  if (!isPlainObject(options)) {
    fail("invalid-options", "buildWorkerPrompt takes a plain object { jobId, root, stageDir, config }");
  }
  const accepted = ["jobId", "root", "stageDir", "config"];
  for (const key of ownStringKeys(options, "invalid-options", "the buildWorkerPrompt options")) {
    if (!accepted.includes(key)) {
      fail("invalid-options", `buildWorkerPrompt does not accept ${JSON.stringify(key)}`);
    }
  }
  for (const key of accepted) {
    if (!Object.hasOwn(options, key)) fail("invalid-options", `buildWorkerPrompt requires ${JSON.stringify(key)}`);
  }

  const jobId = validateJobId(safeGet(options, "jobId", "invalid-options", "the buildWorkerPrompt options"));
  const root = validateRoot(safeGet(options, "root", "invalid-options", "the buildWorkerPrompt options"));
  const stageDir = validateStage(root, safeGet(options, "stageDir", "invalid-options", "the buildWorkerPrompt options"), jobId);
  const config = projectEffectiveConfig(safeGet(options, "config", "invalid-options", "the buildWorkerPrompt options"));

  const protocol = await loadWorkerProtocol();
  const prompt = composePrompt({ protocol, jobId, root, stageDir, config });
  assertWorkerPromptSafe(prompt);

  return Object.freeze({
    prompt,
    promptSha256: sha256Hex(Buffer.from(prompt, "utf8")),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    // Separate, exact hashes: the protocol file bytes and the final prompt bytes.
    protocolSha256: protocol.sha256,
    protocolPath: protocol.path,
    protocolBytes: protocol.bytes,
    jobId,
    root,
    stageDir,
    targetLanguage: "en",
    toolScope: WORKER_TOOL_SCOPE,
    config,
  });
}

// ---------- translation prompt ----------

/**
 * The target language of a translation job: a BCP 47-shaped tag that is not the canonical en. The
 * canonical wiki is never rewritten by translation, so en is refused here instead of being accepted
 * as a no-op.
 */
function validateTargetLang(value) {
  if (typeof value !== "string") fail("invalid-target-lang", "targetLang must be a string");
  if (value.length === 0) fail("invalid-target-lang", "targetLang must not be empty");
  if (value.length > TARGET_LANG_MAX) {
    fail("invalid-target-lang", `targetLang is longer than ${TARGET_LANG_MAX} characters`);
  }
  if (!TARGET_LANG_RE.test(value)) {
    fail("invalid-target-lang", `targetLang must be a BCP 47-shaped language tag; got ${JSON.stringify(value)}`);
  }
  if (value === "en") {
    fail("invalid-target-lang", "targetLang must not be the canonical en: a translation job never rewrites the canonical wiki");
  }
  return value;
}

const TRANSLATION_PROMPT_HEADER = "# dsh-wiki translation worker protocol (Host-pinned)";

const LOCALES_DIR_NAME = "locales";

/** The translation units file the Host created with locales-init, relative to the staging wiki. */
export const translationUnitsPath = (targetLang) => `${LOCALES_DIR_NAME}/${targetLang}/wiki.json`;

/**
 * The locale mirror (relative to the staging wiki): byte-identical English copies of the canonical
 * `pages/` and `cards/` that the worker translates in place, and the input of the Host's own
 * `assemble` run. A translate job activates its worker guard on this directory, so the guard's write
 * policy (`pages/<name>.md`, `cards/<name>.md`) lands on the mirror and the canonical tree at the
 * staging root is not writable by the worker at all.
 */
export const translationMirrorPath = (targetLang) => `${LOCALES_DIR_NAME}/${targetLang}`;

function composeTranslationPrompt({ protocol, jobId, root, stageDir, config, targetLang }) {
  const units = translationUnitsPath(targetLang);
  const mirror = translationMirrorPath(targetLang);
  const lines = [
    TRANSLATION_PROMPT_HEADER,
    "",
    protocol.text.trimEnd(),
    "",
    "# Job",
    "",
    `Job id: ${JSON.stringify(jobId)}`,
    `Repository root (absolute): ${JSON.stringify(root)}`,
    `Staging wiki directory (absolute): ${JSON.stringify(stageDir)}`,
    `Target language: ${JSON.stringify(targetLang)}`,
    `Canonical language (do not translate it, do not rewrite it): ${JSON.stringify("en")}`,
    `Translation mirror (absolute, your only work area): ${JSON.stringify(path.join(stageDir, mirror))}`,
    `Translation mirror pages (relative to the staging wiki directory): ${JSON.stringify(`${mirror}/pages/`)}`,
    `Translation mirror cards (relative to the staging wiki directory): ${JSON.stringify(`${mirror}/cards/`)}`,
    `Translation units file (relative to the staging wiki directory; assembled by the Host after you stop, never written by you): ${JSON.stringify(units)}`,
    "",
    "Effective canonical configuration (validated, canonical JSON; do not change it):",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    "",
    `Translate the Markdown files under \`${mirror}/pages/\` and \`${mirror}/cards/\` in place.`,
    "The canonical `wiki.json`, `pages/`, `cards/` and `site/` at the staging root are the published canonical tree: they are not your input, and the Host restores them from the live wiki after you stop.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Build the deterministic translation worker prompt for one job.
 *
 * Same contract and same safety gate as `buildWorkerPrompt`, but the pinned protocol is
 * skills/translation-protocol.md and the job block names a non-en target language, the locale mirror
 * (`locales/<lang>/pages/` and `locales/<lang>/cards/`) the worker translates in place, and the
 * translation units file that the Host assembles from that Markdown afterwards. The canonical
 * configuration is still validated as canonical English (it describes the source wiki), while the
 * target language is carried separately and never rewritten to en.
 *
 * @param {object} options
 * @param {string} options.jobId lowercase ASCII job id (jobs.js generates 16 hex characters)
 * @param {string} options.root absolute, canonical repository root
 * @param {string} options.stageDir absolute `<root>/.dsh-wiki.staging-<jobId>`
 * @param {object} options.config the direct object printed on stdout by `resolve-config` (canonical
 *   en source configuration)
 * @param {string} options.targetLang BCP 47-shaped language tag that is not "en"
 * @returns {Promise<object>} frozen { prompt, promptSha256, protocolSha256, protocolPath, ... }
 */
export async function buildTranslationPrompt(options) {
  if (!isPlainObject(options)) {
    fail("invalid-options", "buildTranslationPrompt takes a plain object { jobId, root, stageDir, config, targetLang }");
  }
  const accepted = ["jobId", "root", "stageDir", "config", "targetLang"];
  for (const key of ownStringKeys(options, "invalid-options", "the buildTranslationPrompt options")) {
    if (!accepted.includes(key)) {
      fail("invalid-options", `buildTranslationPrompt does not accept ${JSON.stringify(key)}`);
    }
  }
  for (const key of accepted) {
    if (!Object.hasOwn(options, key)) fail("invalid-options", `buildTranslationPrompt requires ${JSON.stringify(key)}`);
  }

  const jobId = validateJobId(safeGet(options, "jobId", "invalid-options", "the buildTranslationPrompt options"));
  const root = validateRoot(safeGet(options, "root", "invalid-options", "the buildTranslationPrompt options"));
  const stageDir = validateStage(root, safeGet(options, "stageDir", "invalid-options", "the buildTranslationPrompt options"), jobId);
  const targetLang = validateTargetLang(safeGet(options, "targetLang", "invalid-options", "the buildTranslationPrompt options"));
  const config = projectEffectiveConfig(safeGet(options, "config", "invalid-options", "the buildTranslationPrompt options"));

  const protocol = await loadProtocolFile(TRANSLATION_PROTOCOL_FILE, { ...DEFAULT_IO });
  const prompt = composeTranslationPrompt({ protocol, jobId, root, stageDir, config, targetLang });
  assertWorkerPromptSafe(prompt);

  return Object.freeze({
    prompt,
    promptSha256: sha256Hex(Buffer.from(prompt, "utf8")),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    // Separate, exact hashes: the translation protocol bytes and the final prompt bytes.
    protocolSha256: protocol.sha256,
    protocolPath: protocol.path,
    protocolBytes: protocol.bytes,
    jobId,
    root,
    stageDir,
    targetLanguage: targetLang,
    translationUnits: translationUnitsPath(targetLang),
    translationMirror: translationMirrorPath(targetLang),
    toolScope: WORKER_TOOL_SCOPE,
    config,
  });
}
