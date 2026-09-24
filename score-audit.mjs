#!/usr/bin/env node
/**
 * score-audit.mjs — do the tracker, the report, and the model all agree?
 *
 * A score is written down three times: the report header, the report's Machine
 * Summary, and the tracker row. Only one of them is authoritative, because only
 * score-model.mjs implements the live rubric. Nothing checked that they matched, and
 * they had drifted apart in thirteen post-cutover reports before anyone looked.
 *
 * Most of that drift is harmless history: the 2026-07-27 model adoption re-scored the
 * tracker through apply-model.mjs and left the older report headers where they were.
 * That is expected and is reported separately from real disagreement.
 *
 * What is NOT harmless is a report written AFTER the cutover that disagrees with its
 * row, because one of the two numbers is simply wrong, and a stale header in a report
 * read the night before an interview is worse than no header at all.
 *
 * The model decides. Neither the row nor the header gets the benefit of the doubt.
 *
 * Run:
 *   node score-audit.mjs              # report disagreements
 *   node score-audit.mjs --all        # include pre-cutover history
 *   node score-audit.mjs --fix        # rewrite headers/rows to the model value
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { applyModel, loadPrefs } from './score-model.mjs';

const CUTOVER = '2026-07-27';   // the day score-model.mjs became the only rubric
const TOL = 0.051;              // both sides are printed to one decimal
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const ALL = args.includes('--all');

const prefs = loadPrefs();
const TRACKER = 'data/applications.md';

// No tracker is not agreement. Say so, and exit with a code distinct from both.
if (!existsSync(TRACKER)) {
  console.log(`NOT CHECKED: ${TRACKER} does not exist yet (onboarding required).`);
  process.exit(2);
}
const trackerLines = readFileSync(TRACKER, 'utf8').split('\n');

// Keyed by the report FILENAME the row links to, never by the row's own number.
// A tracker row number is not its report's file number: merge-tracker assigns row
// numbers from the tracker's own sequence, so after any merge where the two
// sequences differ the number-keyed lookup silently compares row N against report
// N and every pair is off by one. That is not theoretical. On 2026-09-19 reports
// 591-602 merged as rows 592-603 and this tool reported four false disagreements;
// an earlier run of --fix in the same shape wrote scores into the wrong rows and
// the tracker had to be restored by following the links. The link is the join key
// the pipeline rules already declare authoritative, so use it.
const rows = new Map();
const unlinked = [];
trackerLines.forEach((line, i) => {
  if (!line.trim().startsWith('|')) return;
  const c = line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
  if (c.length < 8 || !/^\d+$/.test(c[0])) return;
  const idx = c.findIndex(x => /^[\d.]+\s*\/\s*5$/.test(x));
  if (idx < 0) return;
  const link = line.match(/\]\(\s*(?:\.\.\/)?reports\/([^)\s]+)\s*\)/);
  if (!link) { unlinked.push(Number(c[0])); return; }
  rows.set(link[1], { score: parseFloat(c[idx]), line: i, cell: idx, num: Number(c[0]) });
});

const field = (t, k) => {
  const m = t.match(new RegExp('^\\s*' + k + ':\\s*"?([^"\\n]+)', 'm'));
  return m ? m[1].trim().replace(/"$/, '') : null;
};

const near = (a, b) => a !== null && b !== null && Math.abs(a - b) <= TOL;

// What separates the location from the reason inside `location_final`.
// eval-write.mjs wrote an em dash until the repository's rule against that
// character was applied to generated output, and now writes " -- ". Both have
// to parse: several hundred reports already on disk carry the old separator and
// they must not silently drop out of the model replay. The legacy branch is
// compatibility for reports already written, NOT a form still emitted.
// The character is built by code point rather than typed, because nothing in
// this repository may contain it literally, including this file.
const EM_DASH = String.fromCharCode(0x2014);
const LOC_SEP = new RegExp('\\s+(?:' + EM_DASH + '|--)\\s+');

let history = 0, disagree = [], unreadable = [], legacy = [];
for (const f of readdirSync('reports').sort()) {
  // Three digits is the floor, not the ceiling. A \d{3} scan stops seeing the
  // corpus the day it passes 999, and an unaudited report looks exactly like an
  // agreeing one from here.
  const m = f.match(/^(\d{3,})-.*?(\d{4}-\d{2}-\d{2})\.md$/);
  if (!m) continue;
  const num = Number(m[1]), date = m[2];
  const t = readFileSync(join('reports', f), 'utf8');
  const header = parseFloat((t.match(/^\*\*Score:\*\*\s*([\d.]+)/m) || [])[1]);
  const row = rows.get(f);
  if (!row || Number.isNaN(header)) continue;

  const n = k => { const v = field(t, k); return v === null ? null : Number(v); };

  // The report's own Machine Summary carries the number whoever wrote it computed.
  // That is the comparison that actually matters and it needs no replay: the header,
  // the Machine Summary and the tracker row should all say the same thing, whatever
  // script produced them. Replaying the model was the wrong primary test, because it
  // only reproduces eval-write.mjs output and flagged every hand-authored report as
  // broken when it was merely written to a different schema.
  const stated = n('final');
  if (stated === null || Number.isNaN(stated)) {
    if (!near(row.score, header)) unreadable.push({ num, f, row: row.score, header });
    continue;
  }

  // model_base is eval-write.mjs's signature. Where it appears, the model can be
  // replayed as a second opinion; elsewhere the stated final is taken at its word.
  let model = null;
  const [mcv, ns, cp, cu] = ['match_w_cv', 'north_star', 'comp', 'cultural_signals'].map(n);
  // The replay also needs location_final in eval-write's exact "<location>
  // <sep> <why>" shape. Reports that put prose there ("Santa Monica is a listed
  // option, inside the SoCal commute ceiling.") give the arrangement detector a
  // different string than the model was originally handed, and the replay then
  // disagrees with a report that is perfectly self-consistent. Seven such false
  // positives is worse than no second opinion on those seven.
  const locRaw = field(t, 'location_final');
  if (field(t, 'model_base') !== null && locRaw !== null && LOC_SEP.test(locRaw)
      && ![mcv, ns, cp, cu].some(v => v === null || Number.isNaN(v))) {
    const base = (mcv + ns + cp + cu) / 4 + (n('red_flags_adj') || 0);
    // location_final is "<location> <sep> <why>" and comp_posted may read "not
    // published", but the model was handed the bare location and an empty string.
    const locFinal = locRaw.split(LOC_SEP)[0].trim();
    const cpPosted = field(t, 'comp_posted');
    // A posted band is only re-armed as a comp gate when the report says it
    // measures TOTAL compensation. This replay used to relabel every
    // comp_posted figure as comp_total_est, which is the same mislabelling
    // eval-write.mjs carried: score-model gates on total, most postings print
    // base, and a sub-floor BASE band says nothing about total because bonus
    // and equity are unknown. eval-write now withholds the field for a
    // non-total basis, so a replay that kept relabelling would disagree with
    // every correctly-written report from here on.
    //
    // Only the answers that positively deny a total basis suppress it. The
    // legacy corpus writes "posted" and "not_posted", which say whether a
    // figure exists rather than what it measures, so those keep the old
    // behaviour and this change is a no-op on the 565 rows already audited.
    const cpBasis = String(field(t, 'comp_basis') || '').trim().toLowerCase();
    const notTotal = cpBasis === 'base' || cpBasis === 'unknown';
    model = applyModel(Math.round(base * 1000) / 1000, {
      text: `comp_total_est: "${(!cpPosted || cpPosted === 'not published' || notTotal) ? '' : cpPosted}"\n`
        + `location: "${locFinal}"\n`,
      company: field(t, 'company'), role: field(t, 'role'), prefs,
    }).final;
  }

  if (near(row.score, stated) && near(header, stated)
      && (model === null || near(model, stated))) continue;

  // Pre-cutover reports are NOT reconcilable and must never be auto-fixed.
  // Re-running the model on them assumes their stored dimensions are the ones the
  // tracker was computed from, and for the historical corpus that is false: the
  // 2026-07-20 double-count fix zeroed red_flags_adj inside reports that had
  // already been scored, so the arithmetic legitimately no longer reproduces the
  // row. Recomputing 61 of those and calling the difference an error would have
  // rewritten most of the board on a premise this script cannot check.
  if (date < CUTOVER) { history++; if (ALL) legacy.push({ num, f, date, row: row.score, header, stated }); continue; }

  disagree.push({ num, f, date, row: row.score, header, stated, model, rowRef: row });
}

console.log(`${rows.size} tracker rows, ${disagree.length} live disagreement(s), `
  + `${history} pre-${CUTOVER} report(s) not reconcilable`
  + `${unreadable.length ? `, ${unreadable.length} without a Machine Summary` : ''}`
  // A row with no parseable report link cannot be audited at all. Say so rather
  // than dropping it: "not checked" and "agrees" are different answers, and the
  // old number-keyed version could not tell them apart.
  + `${unlinked.length ? `, ${unlinked.length} NOT CHECKED (no report link)` : ''}\n`);

if (unlinked.length) {
  console.log(`rows with no report link, audited by nothing: ${unlinked.join(', ')}\n`);
}

if (disagree.length) {
  console.log('num  date        tracker  header   stated  what disagrees with the report');
  console.log('-'.repeat(88));
  for (const d of disagree) {
    const parts = [];
    if (!near(d.header, d.stated)) parts.push('report header');
    if (!near(d.row, d.stated)) parts.push('tracker row');
    if (d.model !== null && !near(d.model, d.stated))
      parts.push(`model says ${d.model.toFixed(2)}`);
    console.log(`${d.num}  ${d.date}  ${String(d.row).padEnd(8)} ${String(d.header).padEnd(8)} `
      + `${d.stated.toFixed(2).padEnd(7)} ${parts.join(', ')}`);
  }
}
// Listed only on request. These are reports written before the Machine Summary
// existed, so they state no final of their own and cannot be checked; the gap
// between their header and their row is the 2026-07-27 re-score, which is history
// rather than a defect. Printing 174 of them by default buries the real findings.
if (ALL) {
  for (const u of unreadable) {
    console.log(`${u.num}  no stated final (pre-Machine-Summary); tracker ${u.row} `
      + `vs header ${u.header}`);
  }
}
if (ALL && legacy.length) {
  console.log(`\nhistorical, NOT auto-fixable (${legacy.length}) — the tracker is`
    + ` authoritative for these; the model cannot be re-run because their stored`
    + ` dimensions were edited after the row was scored:`);
  for (const d of legacy) {
    console.log(`  ${d.num}  ${d.date}  tracker ${d.row}  header ${d.header}  `
      + `stated ${d.stated.toFixed(2)}`);
  }
}

if (!FIX) {
  if (disagree.length) console.log('\nrewrite both sides to the model value with: node score-audit.mjs --fix');
  process.exit(disagree.length ? 1 : 0);
}

let hdr = 0, trk = 0;
for (const d of disagree) {
  const v = d.stated.toFixed(1);
  if (!near(d.stated, d.header)) {
    const t = readFileSync(join('reports', d.f), 'utf8');
    writeFileSync(join('reports', d.f),
      t.replace(/^\*\*Score:\*\*\s*[\d.]+\/5/m, `**Score:** ${v}/5`));
    hdr++;
  }
  if (!near(d.stated, d.row)) {
    const c = trackerLines[d.rowRef.line].split('|');
    // +1: the split on a line starting with "|" yields an empty first element, so
    // the cell indexes counted above are all one to the left of the split array.
    c[d.rowRef.cell + 1] = c[d.rowRef.cell + 1].replace(/[\d.]+\s*\/\s*5/, `${v}/5`);
    trackerLines[d.rowRef.line] = c.join('|');
    trk++;
  }
}
if (trk) writeFileSync(TRACKER, trackerLines.join('\n'));
console.log(`\nrewrote ${hdr} report header(s) and ${trk} tracker row(s) to the model value`);
