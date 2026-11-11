// dsh-wiki — public code / releaseReason projection of POST /dsh-wiki/api/jobs/recovery-execute.
//
// The recovery route publishes the recovery plan's `code` (the executor returns `code: plan.code`) and
// the manager's `releaseReason` through two allowlists. That is only correct while those allowlists cover
// everything the producers can emit, so every expectation below is re-derived from the PRODUCER SOURCE
// (lib/journal.js plan codes, lib/jobs.js release reasons) — never from the allowlist itself, which would
// be a tautology that keeps passing after a producer grows a value the route silently drops.
//
// The plan-code list has to live in lib/index.js as the one copy: lib/journal.js may not export it (its
// export surface is pinned to nine names by tools/journal-test.mjs, a security assertion this task may
// not edit). This test is what keeps that copy honest — it re-derives the whole set from journal.js's
// source text and fails when the two disagree in either direction.
//
// Covered:
//   - every code `planRecovery` can return: the literal `return result(...)` sites, the three
//     single-interpolation observation helpers expanded over their parsed call-site arguments, and the
//     terminal families expanded over the terminal phases parsed from the planner's own binding;
//   - every `result(...)` call form in journal.js is accounted for, so a call the extraction cannot read
//     (non-literal code argument, non-literal helper argument, direct `makeResult(...)` call) fails the
//     run with its source line instead of silently shrinking the derived set;
//   - the route's PLAN_CODES equals that re-derived set (drift in either direction fails);
//   - every code is on CODE_ALLOWED, every releaseReason jobs.js emits is on RELEASE_REASON_ALLOWED;
//   - both extractions are non-vacuous (an empty match set is a failure, never a pass);
//   - an unknown/hostile value still collapses to the documented fallback (fail closed preserved).
//
// Run: node tools/recovery-code-projection-test.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const lib = (name) => import(pathToFileURL(path.join(here, "..", "lib", name)).href);
const { __recoveryProjectionInternals: projection } = await lib("index.js");
const { planCodes: PLAN_CODES, codeAllowed, releaseReasonAllowed, releaseCodeAllowed, projectOptionalValue } = projection;

const FAILS = [];
let CHECKS = 0;
const check = (name, ok, detail = "") => {
  CHECKS += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
  if (!ok) FAILS.push(name);
};
const sorted = (values) => [...values].sort();
const sameSet = (left, right) => left.size === right.size && sorted(left).every((value, index) => value === sorted(right)[index]);

const journalSource = readFileSync(path.join(here, "..", "lib", "journal.js"), "utf8");
const jobsSource = readFileSync(path.join(here, "..", "lib", "jobs.js"), "utf8");
const executorSource = readFileSync(path.join(here, "..", "lib", "publish-executor.js"), "utf8");

// ---------- plan codes, from lib/journal.js ----------

// planRecovery builds every result through one local `result(decision, code, reason, actions)` helper, so
// the code argument is a quoted literal or a single-interpolation template. Matching `result(` rather than
// `return result(` also catches the three arrow-returning observation helpers.
const RESULT_CALL = /\bresult\s*\(\s*"[a-z-]+"\s*,\s*(?:`([^`]*)`|"([^"\\]*)")/g;
const literalCodes = new Set();
const templates = [];
for (const match of journalSource.matchAll(RESULT_CALL)) {
  if (match[2] !== undefined) literalCodes.add(match[2]);
  else templates.push(match[1]);
}

// The terminal phases come from the planner's own binding, not from a copy of the switch labels.
const TERMINAL_BINDING = /const\s+terminal\s*=\s*journal\.phase\s*===\s*"([a-z-]+)"\s*\?\s*"\1"\s*:\s*"([a-z-]+)"\s*;/;
const terminalMatch = journalSource.match(TERMINAL_BINDING);
const terminalPhases = terminalMatch ? [terminalMatch[1], terminalMatch[2]] : [];

// The observation helpers: `const drift = (artifact) => result(..., `${artifact}-identity-drift`, ...)`,
// plus every argument each one is actually called with.
const HELPER_DEF = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\(([A-Za-z_$][\w$]*)\)\s*=>\s*result\s*\(\s*"[a-z-]+"\s*,\s*`([^`]*)`/g;
const helpers = new Map();
for (const match of journalSource.matchAll(HELPER_DEF)) {
  const [, name, param, body] = match;
  const args = new Set();
  for (const call of journalSource.matchAll(new RegExp(`\\b${name}\\(\\s*"([a-z-]+)"\\s*\\)`, "g"))) args.add(call[1]);
  helpers.set(name, { param, body, args });
}

const INTERPOLATION = /\$\{([A-Za-z_$][\w$]*)\}/g;
const parsedTemplates = templates.map((body) => ({ body, names: [...body.matchAll(INTERPOLATION)].map((match) => match[1]) }));

const derived = new Set(literalCodes);
const unexpanded = [];
for (const { body, names } of parsedTemplates) {
  const name = names.length === 1 ? names[0] : undefined;
  if (name === "terminal" && terminalPhases.length === 2) {
    for (const phase of terminalPhases) derived.add(body.replace(INTERPOLATION, phase));
    continue;
  }
  // Bind by the helper's own result-template body, never by its parameter name: all three helpers take
  // `artifact`, so a parameter-name lookup resolves every template to the first matching helper and
  // expands it with that helper's call-site arguments — a code only another helper emits is then missed
  // (and a code it does not emit is invented) while the set comparison still passes.
  const helper = name === undefined ? undefined : [...helpers.values()].find((candidate) => candidate.body === body);
  if (helper && helper.args.size > 0) {
    for (const argument of helper.args) derived.add(body.replace(INTERPOLATION, argument));
    continue;
  }
  unexpanded.push(body);
}

check("journal.js: the plan-code extraction is not vacuous (literals, helpers and terminal phases all parsed)",
  literalCodes.size >= 15 && helpers.size >= 3 && parsedTemplates.length >= 6 && terminalPhases.length === 2
  && [...helpers.values()].every((helper) => helper.args.size > 0),
  `literals=${literalCodes.size} helpers=${helpers.size} templates=${parsedTemplates.length} terminal=${JSON.stringify(terminalPhases)}`);
check("journal.js: every plan-code template is expanded from source (none left unresolved)",
  unexpanded.length === 0, JSON.stringify(unexpanded));

// ---------- accounting guard: every call form in the producer source must be consumed ----------
//
// The three regexes above are deliberately narrow, so three call forms produce a plan code that
// `derived` never contains while every check below still passes: a helper invoked with a non-literal
// argument (`drift(kind)`), a ternary code argument (`result("manual", flag ? "a" : "b", ...)`), and a
// plan built by calling `makeResult(...)` directly. Account for every call form instead of trusting the
// regexes: each `result(` occurrence must be one the extraction consumed, each helper call must pass a
// literal the expansion can enumerate, and no unaccounted `makeResult(...)` call may exist.

// Source view with comment text and string/template/regex content blanked to spaces, keeping the length
// and every newline so an index in the view is the same index in the source. A naive scan is unsafe in
// both directions here: this file's own header prose names the helper, and the regex literal /[<>"|?*]/
// carries a quote that would otherwise open a bogus string state and blank real code.
function viewWithoutLiterals(source) {
  const view = [...source];
  const mask = (start, end) => {
    for (let index = start; index <= end; index += 1) {
      if (source[index] !== "\n" && source[index] !== "\r") view[index] = " ";
    }
  };
  const interpolationDepths = [];
  let state = "code";
  let inRegexClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      mask(index, index);
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      mask(index, index);
      if (char === "*" && next === "/") {
        mask(index + 1, index + 1);
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state === "regex") {
      mask(index, index);
      if (char === "\\") {
        mask(index + 1, index + 1);
        index += 1;
        continue;
      }
      if (char === "[") inRegexClass = true;
      else if (char === "]") inRegexClass = false;
      else if (char === "/" && !inRegexClass) state = "code";
      continue;
    }
    if (state === "single" || state === "double") {
      mask(index, index);
      if (char === "\\") {
        mask(index + 1, index + 1);
        index += 1;
        continue;
      }
      if ((state === "single" && char === "'") || (state === "double" && char === '"')) state = "code";
      continue;
    }
    if (state === "template") {
      mask(index, index);
      if (char === "\\") {
        mask(index + 1, index + 1);
        index += 1;
        continue;
      }
      if (char === "`") {
        state = "code";
        continue;
      }
      if (char === "$" && next === "{") {
        mask(index + 1, index + 1);
        index += 1;
        interpolationDepths.push(0);
        state = "code";
      }
      continue;
    }
    // state === "code"
    if (char === "/" && next === "/") {
      mask(index, index + 1);
      index += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      mask(index, index + 1);
      index += 1;
      state = "block-comment";
      continue;
    }
    if (char === '"' || char === "'") {
      mask(index, index);
      state = char === '"' ? "double" : "single";
      continue;
    }
    if (char === "`") {
      mask(index, index);
      state = "template";
      continue;
    }
    if (interpolationDepths.length > 0) {
      const top = interpolationDepths.length - 1;
      if (char === "{") interpolationDepths[top] += 1;
      else if (char === "}") {
        if (interpolationDepths[top] === 0) {
          interpolationDepths.pop();
          state = "template";
          mask(index, index);
          continue;
        }
        interpolationDepths[top] -= 1;
      }
    }
    if (char === "/") {
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(view[previous])) previous -= 1;
      const before = previous >= 0 ? view[previous] : "";
      let wordStart = previous;
      while (wordStart >= 0 && /[\w$]/.test(view[wordStart])) wordStart -= 1;
      const word = view.slice(wordStart + 1, previous + 1);
      // `/` opens a regex literal only where an expression may start; journal.js has no division, so this
      // only ever has to tell a regex from a comment (handled above).
      const startsRegex = before === "" || /[=(,:;!&|?{}[+\-*%~^<>]/.test(before)
        || /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(word);
      if (startsRegex) {
        state = "regex";
        inRegexClass = false;
        mask(index, index);
      }
    }
  }
  return view.join("");
}

const codeView = viewWithoutLiterals(journalSource);
const lineNumberAt = (index) => journalSource.slice(0, index).split("\n").length;
const sourceLineAt = (index) => {
  const start = journalSource.lastIndexOf("\n", index - 1) + 1;
  const end = journalSource.indexOf("\n", index);
  return journalSource.slice(start, end === -1 ? undefined : end).trim();
};
const siteLabel = (index) => `line ${lineNumberAt(index)}: ${sourceLineAt(index)}`;
// An unconsumed `result(` call usually spans several lines, so name the opening line AND the first two
// argument lines: that is where a ternary or an identifier code argument actually sits.
const callSiteLabel = (index) => {
  const lines = journalSource.split("\n");
  const startLine = lineNumberAt(index);
  const labels = [`line ${startLine}: ${lines[startLine - 1].trim()}`];
  for (let next = startLine; next < lines.length && labels.length < 3; next += 1) {
    if (lines[next].trim() !== "") labels.push(`line ${next + 1}: ${lines[next].trim()}`);
  }
  return labels.join("  ");
};

// `result(` calls and the one `const result = (...)` definition. The distinction is what makes the
// equation below meaningful: a definition is legitimately not a code-carrying call.
const RESULT_OCCURRENCE = /\bresult\s*(?:=\s*)?\(/g;
const RESULT_DEFINITION_AT = /result\s*=\s*\(/y;
const RESULT_CALL_AT = new RegExp(RESULT_CALL.source, "y");
const resultCallSites = [];
const resultDefinitionSites = [];
const unconsumedResultSites = [];
for (const occurrence of codeView.matchAll(RESULT_OCCURRENCE)) {
  const { index } = occurrence;
  RESULT_DEFINITION_AT.lastIndex = index;
  if (RESULT_DEFINITION_AT.test(codeView)) {
    resultDefinitionSites.push(index);
    continue;
  }
  RESULT_CALL_AT.lastIndex = index;
  if (RESULT_CALL_AT.test(journalSource)) resultCallSites.push(index);
  else unconsumedResultSites.push(index);
}
const totalResultOccurrences = resultCallSites.length + resultDefinitionSites.length + unconsumedResultSites.length;
// The extraction must match exactly the call occurrences accounted for here: a match that only exists
// inside a comment or a string would be a phantom that inflates the derived set without a real call.
const extractedResultSites = [...journalSource.matchAll(RESULT_CALL)].map((match) => match.index);
const phantomResultSites = extractedResultSites.filter((index) => !resultCallSites.includes(index));

// Every helper call site must pass one literal the expansion enumerates, and each helper's own template
// must be in the extraction exactly once (the two regexes agreeing is what makes expansion possible).
const helperIssues = [];
for (const [name, helper] of helpers) {
  const callSites = [...codeView.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].map((match) => match.index);
  const literalAt = new RegExp(`\\b${name}\\s*\\(\\s*"([a-z-]+)"\\s*\\)`, "y");
  const literalArgs = new Set();
  const nonLiteralSites = [];
  for (const index of callSites) {
    literalAt.lastIndex = index;
    const call = literalAt.exec(journalSource);
    if (call) literalArgs.add(call[1]);
    else nonLiteralSites.push(index);
  }
  const bodyMatches = templates.filter((body) => body === helper.body).length;
  if (bodyMatches !== 1) helperIssues.push(`${name}: its result template appears ${bodyMatches}x in the extraction`);
  if (nonLiteralSites.length > 0) helperIssues.push(`${name}: non-literal call(s) ${nonLiteralSites.map(siteLabel).join("; ")}`);
  if (!sameSet(literalArgs, helper.args)) {
    helperIssues.push(`${name}: extraction args ${JSON.stringify(sorted(helper.args))} != source args ${JSON.stringify(sorted(literalArgs))}`);
  }
}

// The only legitimate `makeResult(` sites are its definition and the pass-through inside `result`; a
// direct call would produce a code that neither the literal nor the template extraction can see.
const HELPER_DEFINITION = /\bconst\s+result\s*=\s*\([^)]*\)\s*=>\s*makeResult\s*\([^)]*\)\s*;/;
const helperDefinition = HELPER_DEFINITION.exec(journalSource);
const helperDefinitionSpan = helperDefinition ? [helperDefinition.index, helperDefinition.index + helperDefinition[0].length] : [-1, -1];
const makeResultSites = [...codeView.matchAll(/\bmakeResult\s*\(/g)].map((match) => match.index);
const directMakeResultSites = makeResultSites.filter((index) => {
  const isDefinition = /function\s+$/.test(codeView.slice(Math.max(0, index - 16), index));
  const isPassThrough = index >= helperDefinitionSpan[0] && index < helperDefinitionSpan[1];
  return !isDefinition && !isPassThrough;
});

check("journal.js: the accounting view is sound (length preserved, literal text masked, code anchors intact)",
  codeView.length === journalSource.length
  && codeView.includes("const result = (decision")
  && codeView.includes("function makeResult(")
  && !codeView.includes("a worker is reported alive for this transaction")
  && !codeView.includes("${artifact}-identity-drift")
  && totalResultOccurrences >= 25,
  JSON.stringify({ sameLength: codeView.length === journalSource.length, totalResultOccurrences }));
check("journal.js: every result( occurrence is accounted for (a call form the extraction cannot read fails the run)",
  resultCallSites.length + resultDefinitionSites.length === totalResultOccurrences
  && resultDefinitionSites.length === 1
  && unconsumedResultSites.length === 0
  && phantomResultSites.length === 0,
  JSON.stringify({
    matchedCalls: resultCallSites.length,
    definitionSites: resultDefinitionSites.length,
    totalResultOccurrences,
    unconsumed: unconsumedResultSites.map(callSiteLabel),
    matchedOutsideCode: phantomResultSites.map(siteLabel),
  }));
check("journal.js: every helper call passes a literal this extraction can enumerate (no code escapes a variable call)",
  helperIssues.length === 0, JSON.stringify(helperIssues));
check("journal.js: no plan code is produced by a direct makeResult(...) call the extraction cannot see",
  helperDefinition !== null && makeResultSites.length === 2 && directMakeResultSites.length === 0,
  JSON.stringify({ helperDefinition: helperDefinition !== null, makeResultSites: makeResultSites.length,
    direct: directMakeResultSites.map(siteLabel) }));

const planCodes = new Set(PLAN_CODES);
check("the route's PLAN_CODES is frozen and duplicate-free",
  Object.isFrozen(PLAN_CODES) && planCodes.size === PLAN_CODES.length,
  `${PLAN_CODES.length} listed, ${planCodes.size} distinct`);
check("PLAN_CODES equals every code re-derived from lib/journal.js source (no drift in either direction)",
  sameSet(planCodes, derived),
  `only in PLAN_CODES: ${JSON.stringify(sorted(planCodes).filter((code) => !derived.has(code)))}; only in source: ${JSON.stringify(sorted(derived).filter((code) => !planCodes.has(code)))}`);

// The executor is what puts a plan code into the route's result; a plan code that stopped being forwarded
// would make the allowlist coverage moot.
const forwarded = (executorSource.match(/code:\s*plan\.code/g) ?? []).length;
check("publish-executor.js forwards the plan code verbatim at every return site",
  forwarded === (executorSource.match(/decision:\s*plan\.decision/g) ?? []).length && forwarded >= 3,
  `forwarded=${forwarded}`);

const uncoveredCodes = sorted(derived).filter((code) => !codeAllowed.has(code));
check(`recovery-execute CODE_ALLOWED covers all ${derived.size} plan codes`,
  uncoveredCodes.length === 0, JSON.stringify(uncoveredCodes));

// ---------- release reasons, from lib/jobs.js ----------

const RELEASE_REASON = /releaseReason:\s*"([^"]*)"/g;
const releaseReasons = new Set([...jobsSource.matchAll(RELEASE_REASON)].map((match) => match[1]));
const uncoveredReasons = sorted(releaseReasons).filter((reason) => !releaseReasonAllowed.has(reason));
check("jobs.js: the releaseReason extraction is not vacuous",
  releaseReasons.size >= 5, `${releaseReasons.size} values`);
check(`recovery-execute RELEASE_REASON_ALLOWED covers all ${releaseReasons.size} release reasons jobs.js emits`,
  uncoveredReasons.length === 0, JSON.stringify(uncoveredReasons));

// ---------- fail-closed projection is unchanged ----------

check("releaseCode is projected through the same allowlist as code", releaseCodeAllowed === codeAllowed);

const UNKNOWN = "0f5b1c8e3a7d4e29";
check("an unknown code still projects to internal-error (fail closed)",
  projectOptionalValue(UNKNOWN, codeAllowed, "internal-error") === "internal-error");
check("a path-shaped hostile code never survives projection",
  !codeAllowed.has("C:\\Users\\secret\\key")
  && projectOptionalValue("C:\\Users\\secret\\key", codeAllowed, "internal-error") === "internal-error");
check("an unknown releaseReason still projects to null (fail closed)",
  projectOptionalValue(UNKNOWN, releaseReasonAllowed, null) === null);
check("an absent code/releaseReason stays null instead of becoming an error",
  projectOptionalValue(undefined, codeAllowed, "internal-error") === null
  && projectOptionalValue(null, releaseReasonAllowed, null) === null);
check("a recovery plan code and the success release reasons pass through verbatim",
  projectOptionalValue("crash-between-renames", codeAllowed, "internal-error") === "crash-between-renames"
  && projectOptionalValue("published", codeAllowed, "internal-error") === "published"
  && projectOptionalValue("reconciled", releaseReasonAllowed, null) === "reconciled"
  && projectOptionalValue("no-fence", releaseReasonAllowed, null) === "no-fence");

console.log(FAILS.length ? `\nFAILED (${FAILS.length} of ${CHECKS} checks)` : `\nPASS ${CHECKS} checks`);
process.exit(FAILS.length ? 1 : 0);
