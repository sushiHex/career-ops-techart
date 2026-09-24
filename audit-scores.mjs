#!/usr/bin/env node
/**
 * audit-scores.mjs — scoring-integrity checker for reports/.
 *
 * modes/_shared.md defines the global score as:
 *     global = average(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj
 *
 * This recomputes that from each report's own stated dimensions and compares it to the
 * stated global. It exists because an audit on 2026-07-27 found the two disagree in the
 * large majority of reports, and that the stated global is often not derived from the
 * dimensions by ANY consistent rule (only ~15% of the divergences were explained by the
 * red-flag adjustment simply being dropped).
 *
 * That matters because the board ranks on `global` and the 4.0 line drives apply
 * decisions, so a drifting global silently reshapes the shortlist.
 *
 * Legacy reports are reported but do NOT fail the run: failing on a large historical
 * backlog makes a check permanently red and therefore ignored. Reports dated on or after
 * BASELINE are held to the formula and DO fail the run, so new work cannot drift.
 *
 * Usage:
 *   node audit-scores.mjs              # summary + gate on post-baseline reports
 *   node audit-scores.mjs --list       # also list every divergence
 *   node audit-scores.mjs --actionable # only rows the tracker treats as actionable 4.0+
 *   node audit-scores.mjs --baseline 2026-08-01
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { isMain } from './cli-guard.mjs';
import { applyModel, loadPrefs } from './score-model.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };

const REPORTS = 'reports';
const TRACKER = join('data', 'applications.md');
// score-model.mjs is side-effect free on import (no CLI, no top-level logging),
// so importing it here does not disturb board-recompute.mjs, which imports this
// module for parseScores/computeGlobal.
const BASELINE = val('--baseline', '2026-07-27');
const TOL = 0.06;

// Field names drifted across ~400 reports. Accept the observed variants rather than
// treating a rename as missing data: `comp_score` and `score` alone accounted for dozens
// of reports being written off as unparseable.
const ALIASES = {
  match_w_cv: ['match_w_cv', 'match'],
  north_star: ['north_star', 'northstar', 'north star'],
  comp: ['comp_score', 'comp'],
  cultural_signals: ['cultural_signals', 'cultural', 'culture'],
  red_flags_adj: ['red_flags_adj', 'red_flags', 'red flags'],
  global: ['global', 'global_score', 'score'],
};
const FIELDS = Object.keys(ALIASES);
const DIMS = ['match_w_cv', 'north_star', 'comp', 'cultural_signals'];

const completeness = (c) => DIMS.filter((k) => c && c[k] !== null && c[k] !== undefined).length;

/**
 * Reports use several shapes for the score block. Rather than committing to whichever
 * shape matches first, extract a candidate from EVERY shape and keep the most complete.
 * The old precedence-based version silently returned a half-filled YAML match and never
 * fell through to a perfectly good table further down the same file.
 */
export function parseScores(text) {
  const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };
  const pick = (form, get) => {
    const o = { form };
    for (const f of FIELDS) {
      let v = null;
      for (const a of ALIASES[f]) { v = get(a); if (v !== null && v !== undefined) break; }
      o[f] = v ?? null;
    }
    return o;
  };
  const candidates = [];

  // 1. YAML block:  scores:\n  match_w_cv: 4.2
  // Trailing `# comment` must be tolerated: the provenance markers written by the
  // re-derivation passes carry one, and a stricter pattern terminated the block early
  // and silently dropped every field below the first annotated line.
  for (const m of text.matchAll(/scores:\s*\n((?:[ \t]*[\w ]+:\s*-?[\d.]+[ \t]*(?:#[^\n]*)?\n)+)/g)) {
    const b = m[1];
    candidates.push(pick('yaml', (k) => {
      const x = b.match(new RegExp(`^[ \\t]*${k}:\\s*(-?[\\d.]+)`, 'im')); return x ? num(x[1]) : null;
    }));
  }

  // 2. Inline dict:  scores: {match_w_cv: 3.3, ...}
  for (const m of text.matchAll(/scores:\s*\{([^}]*)\}/g)) {
    const b = m[1];
    candidates.push(pick('inline', (k) => {
      const x = b.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*(-?[\\d.]+)`, 'i')); return x ? num(x[1]) : null;
    }));
  }

  // 3. Markdown table:  | match_w_cv | 4.2 |
  candidates.push(pick('table', (k) => {
    const x = text.match(new RegExp(`\\|\\s*\\**${k}\\**[^|]*\\|\\s*\\**\\s*(-?[\\d.]+)`, 'i')); return x ? num(x[1]) : null;
  }));

  // 4. Loose key/value anywhere:  match_w_cv: 4.2   (outside any scores: block)
  candidates.push(pick('loose', (k) => {
    const x = text.match(new RegExp(`^[ \\t]*${k}:\\s*(-?[\\d.]+)`, 'im')); return x ? num(x[1]) : null;
  }));

  // 5. Prose run:  match 4.2 · North Star 4.6 · comp 4.6 · cultural 4.7 · red flags -0.3
  candidates.push(pick('prose', (k) => {
    const x = text.match(new RegExp(`\\b${k}\\b[^\\d\\n-]{0,12}(-?[\\d.]+)`, 'i')); return x ? num(x[1]) : null;
  }));

  candidates.sort((a, b) => completeness(b) - completeness(a));
  return candidates[0] || null;
}

export function computeGlobal(s) {
  const dims = [s.match_w_cv, s.north_star, s.comp, s.cultural_signals];
  if (dims.some((d) => d === null || d === undefined)) return null;
  const rf = s.red_flags_adj ?? 0;
  return dims.reduce((a, b) => a + b, 0) / 4 + rf;
}

function reportDate(name) {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Report paths the tracker treats as an actionable 4.0+ lead. */
function actionableReports() {
  if (!existsSync(TRACKER)) return new Map();
  const out = new Map();
  for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 8) continue;
    const sm = (c[5] || '').match(/([\d.]+)\/5/);
    if (!sm) continue;
    const score = parseFloat(sm[1]);
    const status = c[6];
    const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
    if (score >= 4.0 && !['Rejected', 'Discarded', 'SKIP'].includes(status) && rm) {
      // `role` is needed by prefFactor: a de-prioritised title keeps only a
      // fraction of its company preference, so omitting it overstates the score.
      out.set(rm[1].split('/').pop(), { company: c[3], role: c[4], score, status });
    }
  }
  return out;
}

// Pure helpers above are importable. Everything below is the CLI, and must not run
// on import (board-recompute.mjs imports parseScores/computeGlobal from here).
if (!isMain(import.meta.url)) { /* imported as a library */ } else {

const files = readdirSync(REPORTS).filter((f) => f.endsWith('.md')).sort();
const actionable = actionableReports();

let parsed = 0, unparsed = 0, ok = 0, diverge = 0, positiveRf = 0;
let gated = 0, gatedBad = 0, gatedUnparsed = 0;
// Closed by a hard constraint before scoring: legitimately dimensionless, counted
// and named rather than skipped, because "never scored" and "score missing" are
// different answers and only one of them is a defect.
let gateClosed = 0;
const gateClosedFiles = [];
const rows = [];
const unparsedGated = [];

for (const f of files) {
  const text = readFileSync(join(REPORTS, f), 'utf-8');
  const s = parseScores(text);
  const calc = s ? computeGlobal(s) : null;
  if (calc === null || s.global === null || s.global === undefined) {
    // A role closed by a HARD CONSTRAINT was never scored, and has no dimensions to
    // record. That is not a missing score block, it is an honest one: the report
    // carries `in_bounds: false`, the gate that closed it, and null dimensions.
    // Demanding four numbers here would force whoever writes the report to invent
    // judgements nobody made, and zeros would then read as real assessments of
    // culture and fit. Five such reports landed on 2026-09-19 when the location gate
    // closed two Cursor reqs, an Adobe Firefly req, 1X and an NVIDIA req before any
    // scoring happened, which is the most common outcome of any sweep.
    //
    // The opt-out is deliberately narrow and self-proving: it requires an explicit
    // `in_bounds: false` AND every dimension actually null. You cannot silence a
    // genuinely missing block with it, because declaring out-of-bounds is a
    // checkable claim that the report must also justify in its gate.
    const declaredOut = /^[ \t]*in_bounds:\s*false\b/m.test(text);
    const dimsAllNull = s && DIMS.every(k => s[k] === null || s[k] === undefined);
    if (declaredOut && dimsAllNull) { gateClosed++; gateClosedFiles.push(f); continue; }

    unparsed++;
    // A post-baseline report with no machine-readable score block must FAIL, not be
    // quietly skipped. Skipping is exactly how the legacy backlog of 150+ unparseable
    // reports accumulated: the board ranks on numbers nothing can verify.
    const d0 = reportDate(f);
    if (d0 && d0 >= BASELINE) { gated++; gatedUnparsed++; unparsedGated.push(f); }
    continue;
  }
  parsed++;
  if ((s.red_flags_adj ?? 0) > 0) positiveRf++;

  // Since the 2026-07-27 model adoption, `global` is the post-modifier score
  // (base x compFactor x prefFactor x arrFactor), so comparing it to the raw
  // dimension average would report every modified report as a divergence. The
  // invariant this audit owns is that the BASE derives from the dimensions;
  // `model_base` records it. Reports with no modifiers have no model_base and
  // are checked against `global` exactly as before.
  const mb = text.match(/^[ \t]*model_base:\s*(-?[\d.]+)/m);
  const stated = mb ? parseFloat(mb[1]) : s.global;

  const delta = stated - calc;
  const bad = Math.abs(delta) > TOL;
  if (bad) diverge++; else ok++;

  const d = reportDate(f);
  const isGated = d && d >= BASELINE;
  if (isGated) { gated++; if (bad) gatedBad++; }

  if (bad) {
    rows.push({ file: f, stated, calc: +calc.toFixed(2), delta: +delta.toFixed(2),
                rf: s.red_flags_adj ?? 0, gated: isGated, actionable: actionable.get(f) || null });
  }
}

// How many actionable 4.0+ leads survive a recompute?
//
// UNITS (fixed 2026-08-12): the tracker's 4.0 line is stated in FINAL, i.e.
// base * compFactor * prefFactor * arrFactor. Comparing it against `base` alone
// counted every modifier as a shortfall and reported 11 of 25 leads falling
// below the line on a board that was correct. Verified against 322 rows: 314
// match final within 0.05, only 151 match base. Compare like with like.
const prefs = loadPrefs();
let actParsed = 0, actDrop = 0;
for (const [f, meta] of actionable) {
  const p = join(REPORTS, f);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf-8');
  const s = parseScores(text);
  const base = s ? computeGlobal(s) : null;
  if (base === null) continue;
  const modelled = applyModel(base, {
    company: meta?.company || '', role: meta?.role || '', prefs, text,
  });
  const calc = modelled ? modelled.final : base;
  actParsed++;
  if (calc < 4.0) actDrop++;
}

console.log('scoring audit');
console.log('  formula: global = average(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj');
console.log('');
console.log(`  reports total        : ${files.length}`);
console.log(`    parsed             : ${parsed}`);
// Split the unparseable count by era. The four-dimension rubric was adopted on
// BASELINE; a report written before it recorded only a flat score, so it is not
// broken and its dimensions cannot be recovered without inventing them. Reported
// as one number, this read as a large repair backlog. Verified 2026-08-12: every
// one of them predates BASELINE, and none is on the actionable 4.0+ list, so
// nothing here affects an apply decision. The count after BASELINE is the number
// that matters and is already gated to fail the run below.
console.log(`    no parseable scores: ${unparsed}  (${unparsed - gatedUnparsed} pre-${BASELINE}, dimensions never recorded; ${gatedUnparsed} after)`);
if (gateClosed) {
  console.log(`    closed by a hard constraint before scoring: ${gateClosed}  (in_bounds: false, dimensions legitimately null)`);
  for (const f of gateClosedFiles) console.log(`      ${f}`);
}
console.log(`    formula agrees     : ${ok}`);
console.log(`    formula DIVERGES   : ${diverge}${parsed ? ` (${Math.round((100 * diverge) / parsed)}% of parsed)` : ''}`);
if (positiveRf) console.log(`    red_flags_adj > 0  : ${positiveRf}  (a penalty cannot be positive)`);
console.log('');
console.log(`  actionable 4.0+ leads with a parseable report: ${actParsed}`);
console.log(`    would fall below 4.0 under the formula     : ${actDrop}`);
console.log('');
console.log(`  gate: reports dated >= ${BASELINE}`);
console.log(`    checked  : ${gated}`);
console.log(`    diverging: ${gatedBad}`);

if (has('--list') || has('--actionable')) {
  const show = has('--actionable') ? rows.filter((r) => r.actionable) : rows;
  console.log('');
  console.log('  ' + 'REPORT'.padEnd(56) + 'STATED  FORMULA  DELTA');
  for (const r of show.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    const tag = r.actionable ? '  <- actionable 4.0+' : '';
    console.log('  ' + r.file.slice(0, 54).padEnd(56) +
      String(r.stated).padEnd(8) + String(r.calc).padEnd(9) +
      (r.delta > 0 ? '+' : '') + r.delta + tag);
  }
}

console.log(`    unparseable: ${gatedUnparsed}`);

if (gatedBad > 0 || gatedUnparsed > 0) {
  console.log('');
  if (gatedBad > 0) {
    console.error(`FAIL: ${gatedBad} report(s) dated >= ${BASELINE} do not match the documented formula.`);
    console.error('Either fix the report, or change the rubric in modes/_shared.md and move the baseline.');
  }
  if (gatedUnparsed > 0) {
    console.error(`FAIL: ${gatedUnparsed} report(s) dated >= ${BASELINE} have no machine-readable score block.`);
    for (const f of unparsedGated) console.error(`  - ${f}`);
    console.error('Every report needs a "## Machine Summary" yaml block with the five score fields.');
  }
  process.exit(1);
}

console.log('');
console.log(diverge > 0
  ? `note: ${diverge} legacy report(s) diverge. Not gated, but the board ranks on these numbers.`
  : 'all parsed reports match the formula.');

}
