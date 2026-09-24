#!/usr/bin/env node
/**
 * rederive-red-flags.mjs — re-derive red_flags_adj against the rubric's own definition.
 *
 * modes/_shared.md reserves red_flags_adj for things the four scored dimensions
 * STRUCTURALLY cannot capture:
 *   1. posting-pattern risk  (ghost req, evergreen/pipeline listing, compliance-only
 *      posting, likely pre-identified internal candidate)
 *   2. legitimacy            (dead posting, 404, absent from the company's own ATS, scam)
 *   3. a genuinely separate risk with no home in the four dimensions
 * and explicitly EXCLUDES: skill/credential/seniority gaps (-> match_w_cv), comp
 * shortfalls (-> comp), culture/instability (-> cultural_signals).
 *
 * A 2026-07-27 audit found the field non-zero on 94% of roles, and that ~79% of the
 * penalties with a readable rationale cite content a dimension had already scored. One
 * report states "No new information beyond what's already captured in B and D" and
 * applies a penalty anyway.
 *
 * POLICY (deterministic, auditable):
 *   - rationale names ONLY sanctioned content        -> keep the penalty
 *   - rationale names ONLY dimension content         -> zero it (double-count)
 *   - rationale is absent or too thin to classify    -> zero it. The rubric's default is
 *                                                       0; an unevidenced penalty is not
 *                                                       defensible.
 *   - rationale mixes both                           -> FLAG, do not guess the split
 *
 * Usage:
 *   node rederive-red-flags.mjs            # dry run
 *   node rederive-red-flags.mjs --apply
 *   node rederive-red-flags.mjs --flagged  # list only the mixed cases needing a human
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const { parseScores } = await import(new URL('./audit-scores.mjs', import.meta.url).href);

import { guardArgs } from './cli-guard.mjs';

const { argv: args } = guardArgs({
  name: 'rederive-red-flags.mjs',
  summary: 're-derive red_flags_adj across reports from their own evidence',
  flags: [
    ['--apply', 'write the re-derived values (default is preview only)'],
    ['--all', 'consider every report, not only flagged ones'],
    ['--flagged', 'restrict to reports already carrying a red flag'],
    ['--selftest', 'check the classifier and the next-step advice'],
  ],
  notes: 'Previews by default. Nothing is written without --apply.',
  writesByDefault: false,
});
const APPLY = args.includes('--apply');
const ONLY_FLAGGED = args.includes('--flagged');
const REPORTS = 'reports';
const TRACKER = join('data', 'applications.md');

// Sanctioned: the four dimensions have nowhere to put these.
const SANCTIONED = /ghost|evergreen|pipeline req|compliance[- ]only|pre-?identified|dead posting|\b404\b|absent from|not in the (?:live )?ats|legitimac|posting[- ]pattern|stale posting|repost|no longer (?:listed|live)|scam|fraud|unverif|could not confirm.{0,24}(?:live|open|req)/i;
// Excluded: each of these has a dimension that already scored it.
const DIMENSIONAL = [
  [/below .{0,14}floor|sub-?floor|comp(?:ensation)? (?:shortfall|gap|miss|risk)|salary|pay band|posted .{0,10}range|\$\d{2,3}\s*K/i, 'comp'],
  [/phd|master'?s|degree|clearance|\d\+? years?|credential|skill gap|domain mismatch|role-?type|customer-?facing|quota|distributed systems|typescript|research engineer|seniority/i, 'match_w_cv'],
  [/layoff|churn|glassdoor|culture|instability|attrition|toxic|return[- ]to[- ]office|\brto\b/i, 'cultural_signals'],
];

// Keyword matching alone is not enough: reports routinely mention a sanctioned category
// in order to RULE IT OUT ("Legitimacy is Tier 1, verified LIVE", "no posting-risk or
// legitimacy concern", "already priced elsewhere"). Matching the bare word there would
// preserve exactly the penalties this pass exists to remove, so a sanctioned hit only
// counts when it is not negated in its immediate context.
const NEGATED = /\b(?:no|not|none|without|zero|clean|clear|verified|confirmed|tier 1|absent of)\b[^.]{0,60}$/i;
const NEGATING_CLAUSE = /already priced|already captured|restat|no (?:genuinely )?new information|no independent|verified live|posting is live|is tier 1|no posting-?risk|no legitimacy/i;

export function rationale(text) {
  let why = '';
  const block = text.match(/##+[^\n]*Red Flags?[^\n]*\n([\s\S]{0,900}?)(?:\n##|$)/i);
  if (block) why += block[1];
  const inline = text.match(/(?:red[- ]flag|biggest blocker|gating)[^\n]{0,400}/ig);
  if (inline) why += ' ' + inline.join(' ');
  return why.replace(/\s+/g, ' ').trim();
}

/**
 * Classify one written rationale against the rubric. Pure: no fs, no tracker, so
 * --selftest can pin the verdicts without the user layer being present.
 *
 * @param {string} why - rationale() output for one report
 * @returns {{verdict: 'keep'|'zero'|'flag', reason: string}}
 */
export function classifyRationale(why) {
  let sanctioned = false;
  if (SANCTIONED.test(why) && !NEGATING_CLAUSE.test(why)) {
    // check the 60 characters before each sanctioned hit for a negation
    const re = new RegExp(SANCTIONED.source, 'gi');
    let m;
    while ((m = re.exec(why)) !== null) {
      if (!NEGATED.test(why.slice(Math.max(0, m.index - 60), m.index))) { sanctioned = true; break; }
    }
  }
  const hits = DIMENSIONAL.filter(([re]) => re.test(why)).map(([, d]) => d);
  if (why.length < 25) return { verdict: 'zero', reason: 'no stated rationale' };
  if (sanctioned && hits.length) return { verdict: 'flag', reason: `mixed: sanctioned + ${hits.join('/')}` };
  if (sanctioned) return { verdict: 'keep', reason: 'genuine posting/legitimacy risk' };
  if (hits.length) return { verdict: 'zero', reason: `double-count of ${hits.join('/')}` };
  return { verdict: 'zero', reason: 'rationale names no sanctioned category' };
}

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    fails.push(`${name}${detail ? `  (${detail})` : ''}`);
  };
  const verdict = (why) => classifyRationale(why).verdict;
  const reason = (why) => classifyRationale(why).reason;

  // 1. THE LOADED GUN. This pass zeroes red_flags_adj across 253 reports, which changes
  //    `base` on every one of them, so it has to tell the operator how to re-score. It
  //    used to name a second tracker writer that computed base and wrote it into the
  //    tracker's FINAL column, discarding compFactor, prefFactor, arrFactor and the 5.0
  //    cap: 234 rows would have moved, including the top lead from 4.8 to 4.5. That
  //    writer lost its write path and is not shipped in this repository. Assert on
  //    what the script PRINTS, since a printed command is the invocation path, and let
  //    the comments name the old file freely.
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
  const printed = (self.match(/console\.log\([^\n]*\)/g) || []).join('\n');
  ok('advice: nothing printed names a base-shaped tracker writer',
    !/recompute-tracker/.test(printed));
  ok('advice: the next step is the sanctioned pass', /apply-model\.mjs/.test(printed));
  ok('advice: the operator is told to verify afterwards', /score-audit\.mjs/.test(printed));

  // 2. A rationale that names ONLY sanctioned content keeps its penalty. This is the
  //    shape a red flag is actually for.
  ok('keep: evergreen posting', verdict(
    'Red flags (-0.25): first published over a year ago and still open, an evergreen req.'
  ) === 'keep');

  // 3. A sanctioned WORD used to rule the risk OUT must not keep the penalty. Matching
  //    the bare keyword here would preserve exactly the penalties this pass removes.
  ok('negated: "legitimacy verified live" is not a red flag', verdict(
    'Red flags: legitimacy is Tier 1, verified live on the company ATS, so no posting-risk concern remains.'
  ) === 'zero');

  // 4. Content a scored dimension already carries is a double-count and gets zeroed.
  //    This is the 2026-07-20 fix: penalising a comp shortfall here charges it twice,
  //    once in the comp dimension and again in the adjustment.
  ok('zero: comp shortfall belongs to the comp dimension', verdict(
    'Red flags: the posted salary band tops out below the floor, so the pay is the blocker on this one.'
  ) === 'zero');
  ok('zero: names the dimension it double-counts', reason(
    'Red flags: the posted salary band tops out below the floor, so the pay is the blocker on this one.'
  ) === 'double-count of comp');

  // 5. Mixed rationales are FLAGGED for a human, never split by guess. Guessing the
  //    split is how a genuine posting risk gets silently zeroed alongside the gap.
  ok('flag: sanctioned plus dimensional needs a ruling', verdict(
    'Red flags: evergreen pipeline req still open a year on, and the JD demands a PhD plus 10+ years the candidate does not have.'
  ) === 'flag');

  // 6. Too thin to classify is zeroed, because the rubric's default is 0 and an
  //    unevidenced penalty is not defensible. The length test runs FIRST, so a thin
  //    rationale is zeroed even when it contains a sanctioned word.
  ok('thin: no stated rationale', reason('ghost req') === 'no stated rationale');

  console.log(`rederive-red-flags selftest: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  FAIL  ${f}`);
  return fails.length === 0;
}

if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1);

const rows = [];
for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const c = line.split('|').map((x) => x.trim());
  if (c.length < 8 || !/^\d+$/.test(c[1] || '')) continue;
  const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  if (!rm) continue;
  const p = join(REPORTS, rm[1].split('/').pop());
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf-8');
  const s = parseScores(text);
  if (!s || !(s.red_flags_adj < 0)) continue;

  const why = rationale(text);
  const { verdict, reason } = classifyRationale(why);

  rows.push({ num: c[1], co: c[3], role: c[4], path: p, rf: s.red_flags_adj, verdict, reason, why });
}

const keep = rows.filter((r) => r.verdict === 'keep');
const zero = rows.filter((r) => r.verdict === 'zero');
const flag = rows.filter((r) => r.verdict === 'flag');

if (ONLY_FLAGGED) {
  console.log(`mixed rationales needing a human ruling: ${flag.length}\n`);
  for (const r of flag) console.log(`  rf ${String(r.rf).padStart(5)}  #${r.num.padEnd(4)} ${r.co.slice(0, 24).padEnd(24)} ${r.reason}`);
  process.exit(0);
}

console.log('re-derive red_flags_adj against the rubric');
console.log(`  reports with a negative red_flags_adj: ${rows.length}`);
console.log(`    KEEP  genuine posting/legitimacy risk : ${keep.length}`);
console.log(`    ZERO  double-count or unevidenced     : ${zero.length}`);
console.log(`    FLAG  mixed, needs a human ruling     : ${flag.length}`);
console.log('');
const byReason = {};
for (const r of zero) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
console.log('  zeroed, by reason:');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
console.log('');
console.log('  kept (these are what a red flag is actually for):');
for (const r of keep.slice(0, 10)) console.log(`    rf ${String(r.rf).padStart(5)}  #${r.num.padEnd(4)} ${r.co.slice(0, 22).padEnd(22)} ${r.why.slice(0, 76)}`);

if (!APPLY) {
  console.log('');
  console.log('  DRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

// Only the unevidenced cases are safe to zero mechanically. Keyword classification of a
// written rationale proved unreliable in testing: it preserved penalties on reports that
// mention a category only to RULE IT OUT, and kept two that were plainly match_w_cv
// content. Those go to a judgment pass instead of being guessed at here.
const target = args.includes('--all') ? zero : zero.filter((r) => r.reason === 'no stated rationale');
if (!args.includes('--all')) {
  console.log('');
  console.log(`  applying to the ${target.length} unevidenced cases only.`);
  console.log(`  ${zero.length - target.length} with a written rationale are left for the judgment pass.`);
}

let written = 0;
for (const r of target) {
  let text = readFileSync(r.path, 'utf-8');
  if (text.includes('red_flags_adj_original')) continue;
  const before = text;
  text = text.replace(/^([ \t]*)red_flags_adj:\s*(-?[\d.]+)\s*$/m,
    `$1red_flags_adj: 0\n$1red_flags_adj_original: $2   # zeroed 2026-07-27: ${r.reason}`);
  if (text === before) {
    text = text.replace(/(['"]?red_flags_adj['"]?\s*:\s*)(-?[\d.]+)/,
      `$1 0`) + `\n<!-- red_flags_adj_original: ${r.rf} (zeroed 2026-07-27: ${r.reason}) -->\n`;
  }
  if (text === before) {
    text = text.replace(/(\|\s*\**red_flags_adj\**[^|]*\|\s*\**\s*)(-?[\d.]+)/i, `$1 0`)
      + `\n<!-- red_flags_adj_original: ${r.rf} (zeroed 2026-07-27: ${r.reason}) -->\n`;
  }
  if (text === before) continue;
  writeFileSync(r.path, text, 'utf-8');
  written++;
}
console.log('');
console.log(`  reports updated: ${written} (original preserved as red_flags_adj_original)`);
// Zeroing a red flag changes `base` on every report touched, so the tracker is now stale
// and something must re-score it. This used to send the operator to recompute-tracker.mjs
// --apply --reports, which computed base = average(4 dims) + red_flags_adj and wrote THAT
// into the tracker's score column. The column holds final = min(5, base x compFactor x
// prefFactor x arrFactor), so the advice discarded every modifier and the cap: 234 rows,
// 114 up and 120 down, with the best lead falling 4.8 to 4.5. apply-model.mjs is
// the only pass that may write a score; score-audit.mjs then proves tracker and reports
// still agree.
console.log('  next: node apply-model.mjs             # dry run, read the moves first');
console.log('        node apply-model.mjs --apply     # the only sanctioned score writer');
console.log('        node score-audit.mjs             # confirm tracker and reports agree');
