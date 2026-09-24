#!/usr/bin/env node
/**
 * board-recompute.mjs — shadow board built from computed scores.
 *
 * Recomputes every tracker row's global from its report's own stated dimensions using
 * the rubric in modes/_shared.md, then compares that ranking against the tracker's
 * stated scores. It NEVER writes to data/applications.md; the output is a standalone
 * markdown artifact so the two rankings can be compared before anything is adopted.
 *
 * Why this exists: a 2026-07-27 audit found the stated global disagrees with the stated
 * dimensions in ~80% of parseable reports, and that most divergences follow no
 * consistent arithmetic. The board ranks on the stated number and the 4.0 line drives
 * apply decisions, so the two rankings can disagree about what to work on.
 *
 * UNITS (fixed 2026-08-12). This compared the tracker's score against BASE:
 *
 *     base  = average(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj
 *     final = min(5, base * compFactor * prefFactor * arrFactor)
 *
 * The tracker states FINAL — verified against 322 rows: 314 match final within 0.05,
 * only 151 match base. Comparing final to base made the modifiers look like drift and
 * reported "11 of 25 actionable leads fall below 4.0" on a board that was correct, and
 * it prompted a bogus suggestion to move the cutoff to ~3.88 to restore the shortlist
 * size. The recompute now applies the full model, so both sides are in the same units.
 *
 * Usage:
 *   node board-recompute.mjs                     # write output/board-recomputed-<date>.md
 *   node board-recompute.mjs --stdout            # print the summary only
 *   node board-recompute.mjs --threshold 4.0
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { applyModel, loadPrefs } from './score-model.mjs';

const { parseScores, computeGlobal } = await import(
  new URL('./audit-scores.mjs', import.meta.url).href
).catch(async () => {
  // audit-scores.mjs runs its own audit on import; fall back to a local copy of the
  // two pure helpers if that is ever undesirable.
  throw new Error('audit-scores.mjs must be importable from the repo root');
});

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };

const TRACKER = join('data', 'applications.md');
const REPORTS = 'reports';
const THRESHOLD = parseFloat(val('--threshold', '4.0'));
const DEAD = new Set(['Rejected', 'Discarded', 'SKIP']);

if (!existsSync(TRACKER)) {
  console.log('no tracker at data/applications.md — nothing to recompute');
  process.exit(0);
}

const rows = [];
for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const c = line.split('|').map((x) => x.trim());
  if (c.length < 8) continue;
  if (!/^\d+$/.test(c[1] || '')) continue;
  const sm = (c[5] || '').match(/([\d.]+)\/5/);
  if (!sm) continue;
  const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  rows.push({
    num: parseInt(c[1], 10),
    date: c[2],
    company: c[3],
    role: c[4],
    stated: parseFloat(sm[1]),
    status: c[6],
    report: rm ? rm[1].split('/').pop() : null,
  });
}

const prefs = loadPrefs();
let recomputed = 0, unresolved = 0;
const invalid = [];
for (const r of rows) {
  if (!r.report) { unresolved++; continue; }
  const p = join(REPORTS, r.report);
  if (!existsSync(p)) { unresolved++; continue; }
  const text = readFileSync(p, 'utf-8');
  const s = parseScores(text);
  const base = s ? computeGlobal(s) : null;
  if (base === null) { unresolved++; continue; }
  // Apply the same modifiers the tracker's score already carries, so the two
  // rankings are comparable. Without this the modifiers read as drift.
  const modelled = applyModel(base, { company: r.company, role: r.role, prefs, text });
  const g = modelled ? modelled.final : base;
  r.base = Math.round(base * 100) / 100;
  r.factors = modelled
    ? { comp: modelled.compFactor, pref: modelled.prefFactor, arr: modelled.arrFactor }
    : null;
  // A computed score outside 0-5 is not a score, it is corrupt input: every dimension
  // is 0-5 and red_flags_adj is a penalty, so the result cannot exceed 5. Ranking such a
  // row would put a data error at the top of the shortlist.
  if (g > 5 || g < 0) { invalid.push({ ...r, bogus: Math.round(g * 100) / 100, rf: s.red_flags_adj }); continue; }
  r.computed = Math.round(g * 100) / 100;
  r.delta = Math.round((r.computed - r.stated) * 100) / 100;
  r.dims = s;
  recomputed++;
}

const live = rows.filter((r) => !DEAD.has(r.status));
const scored = live.filter((r) => r.computed !== undefined);

const statedIn = live.filter((r) => r.stated >= THRESHOLD);
const computedIn = scored.filter((r) => r.computed >= THRESHOLD);

const dropped = scored.filter((r) => r.stated >= THRESHOLD && r.computed < THRESHOLD);
const promoted = scored.filter((r) => r.stated < THRESHOLD && r.computed >= THRESHOLD);
const held = scored.filter((r) => r.stated >= THRESHOLD && r.computed >= THRESHOLD);
const unknown = live.filter((r) => r.computed === undefined && r.stated >= THRESHOLD);

const fmt = (n) => (n === undefined || n === null ? '  -  ' : n.toFixed(2).padStart(5));

console.log('board recompute');
console.log(`  tracker rows            : ${rows.length}`);
console.log(`    recomputed            : ${recomputed}`);
console.log(`    no parseable report   : ${unresolved}`);
console.log('');
console.log(`  live rows (not rejected/discarded/skip): ${live.length}`);
console.log(`    actionable >= ${THRESHOLD} by STATED score  : ${statedIn.length}`);
console.log(`    actionable >= ${THRESHOLD} by COMPUTED score: ${computedIn.length}`);
console.log('');
console.log(`    held  (>= ${THRESHOLD} both ways)  : ${held.length}`);
console.log(`    dropped out of the list  : ${dropped.length}`);
console.log(`    promoted into the list   : ${promoted.length}`);
console.log(`    unknown (unparseable)    : ${unknown.length}  <- currently on the list, cannot verify`);

if (invalid.length) {
  console.log('');
  console.log(`  INVALID — computed outside 0-5, corrupt input, excluded from ranking: ${invalid.length}`);
  for (const r of invalid) {
    console.log(`    #${r.num} ${r.company} — computed ${r.bogus} (red_flags_adj = ${r.rf})`);
  }
}

// The two systems are on DIFFERENT SCALES. red_flags_adj is almost always negative, so
// the computed value sits systematically below the holistic one. Judging both at the same
// 4.0 line therefore conflates "the scores are wrong" with "the threshold was calibrated
// against a different scale". Report the equivalent cutoff so the two can be separated.
if (scored.length) {
  const cs = scored.map((r) => r.computed).sort((a, b) => b - a);
  const ss = live.map((r) => r.stated);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const equiv = cs[Math.min(statedIn.length, cs.length) - 1];
  console.log('');
  console.log('  SCALE CHECK');
  console.log(`    stated   : max ${Math.max(...ss).toFixed(2)}  mean ${mean(ss).toFixed(2)}`);
  console.log(`    computed : max ${Math.max(...cs).toFixed(2)}  mean ${mean(cs).toFixed(2)}`);
  if (equiv !== undefined) {
    console.log(`    a computed cutoff of ~${equiv.toFixed(2)} produces the same shortlist SIZE as 4.0 stated`);
  }
}

if (promoted.length) {
  console.log('');
  console.log('  PROMOTED — below 4.0 on the board, but the dimensions say otherwise:');
  for (const r of promoted.sort((a, b) => b.computed - a.computed)) {
    console.log(`    ${fmt(r.stated)} -> ${fmt(r.computed)}  #${String(r.num).padEnd(4)} ${r.company} — ${(r.role || '').slice(0, 52)}`);
  }
}

const top = scored.slice().sort((a, b) => b.computed - a.computed).slice(0, 15);
console.log('');
console.log(`  TOP 15 BY COMPUTED SCORE:`);
for (const r of top) {
  console.log(`    ${fmt(r.computed)} (was ${fmt(r.stated)})  #${String(r.num).padEnd(4)} ${r.company} — ${(r.role || '').slice(0, 46)}`);
}

if (!has('--stdout')) {
  mkdirSync('output', { recursive: true });
  const today = new Date === null ? '' : (rows[0]?.date || 'undated');
  const out = join('output', `board-recomputed.md`);
  const L = [];
  L.push('# Board, recomputed from report dimensions');
  L.push('');
  L.push('Generated by `board-recompute.mjs`. This is a SHADOW board: `data/applications.md` is untouched.');
  L.push('');
  L.push('`global = average(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj`');
  L.push('');
  L.push(`- tracker rows: ${rows.length}, recomputed ${recomputed}, unparseable ${unresolved}`);
  L.push(`- actionable >= ${THRESHOLD}: **${statedIn.length} stated** vs **${computedIn.length} computed**`);
  L.push(`- held ${held.length}, dropped ${dropped.length}, promoted ${promoted.length}, unverifiable ${unknown.length}`);
  L.push('');
  L.push('## Ranked by computed score');
  L.push('');
  L.push('| # | Company | Role | Computed | Stated | Delta | Status |');
  L.push('|---|---------|------|----------|--------|-------|--------|');
  for (const r of scored.slice().sort((a, b) => b.computed - a.computed)) {
    L.push(`| ${r.num} | ${r.company} | ${(r.role || '').replace(/\|/g, '-')} | ${r.computed.toFixed(2)} | ${r.stated.toFixed(1)} | ${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)} | ${r.status} |`);
  }
  L.push('');
  L.push('## Currently on the shortlist but unverifiable');
  L.push('');
  L.push('These rows sit at or above the threshold on the board, but their report has no parseable');
  L.push('score block, so the computed score cannot be checked.');
  L.push('');
  for (const r of unknown.sort((a, b) => b.stated - a.stated)) {
    L.push(`- **${r.stated.toFixed(1)}** #${r.num} ${r.company} — ${r.role} (${r.report || 'no report link'})`);
  }
  writeFileSync(out, L.join('\n') + '\n', 'utf-8');
  console.log('');
  console.log(`  wrote ${out}`);
}
