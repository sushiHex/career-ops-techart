#!/usr/bin/env node
/**
 * apply-model.mjs — apply the adopted scoring model to the tracker and reports.
 *
 * Adopted 2026-07-27, wiring five separately-tuned models into one pass. They
 * multiply, so applying them one at a time gives a different board than applying
 * them together; this is the single place that composes them.
 *
 *   base  = average(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj
 *   final = min(5, base * compFactor * prefFactor * arrFactor)
 *
 * See score-model.mjs for what each factor is and why.
 *
 * Provenance: the pre-model score is preserved as `global_premodel` in each
 * report's score block, and the factors are written alongside it, so any row can
 * be traced back and the pass is re-runnable rather than one-way.
 *
 * Usage:
 *   node apply-model.mjs              # dry run, prints what would change
 *   node apply-model.mjs --apply      # rewrite data/applications.md
 *   node apply-model.mjs --apply --reports   # also annotate reports/
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';

// Sibling modules resolve beside this file, so it runs from any directory; the
// data it reads (data/, reports/) stays relative to where it is run.
const here = (f) => new URL(f, import.meta.url).href;
const { parseScores, computeGlobal } = await import(here('audit-scores.mjs'));
const { applyModel, loadPrefs, MODEL } = await import(here('score-model.mjs'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REPORTS = args.includes('--reports');
const TRACKER = join('data', 'applications.md');
const TODAY = '2026-07-27';

const DEAD = new Set(['Rejected', 'Discarded', 'SKIP']);
const prefs = loadPrefs();
if (!existsSync(TRACKER)) {
  console.log(`no ${TRACKER} yet — nothing to apply`);
  process.exit(0);
}
if (!prefs.length) {
  // No preferred companies is a valid profile: every preference factor is then 1.0 and
  // the other modifiers still apply. Said once, so an empty block is not mistaken for
  // one that failed to load.
  console.log('no company_preference in the profile: every preference factor is 1.0');
}

const lines = readFileSync(TRACKER, 'utf-8').split('\n');
const out = [];
const changes = [];
const scored = [];
const malformed = [];
let live = 0, unparsed = 0;

for (const line of lines) {
  if (!line.startsWith('|')) { out.push(line); continue; }
  const c = line.split('|');
  const cells = c.map((x) => x.trim());
  if (cells.length < 8 || !/^\d+$/.test(cells[1] || '')) { out.push(line); continue; }

  const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  const p = rm ? join('reports', rm[1].split('/').pop()) : null;
  if (!p || !existsSync(p)) { out.push(line); continue; }

  const text = readFileSync(p, 'utf-8');
  const s = parseScores(text);
  const base = s ? computeGlobal(s) : null;
  if (base === null || base > 5 || base < 0) {
    if (!DEAD.has(cells[6])) unparsed++;
    out.push(line);
    continue;
  }
  if (!DEAD.has(cells[6])) live++;

  // Prefer the arrangement the report already recorded over re-deriving it. eval-write
  // computes it from the packet's clean location and persists it here, then writes a
  // location_final that is often prose. Re-deriving from that prose returns 'unknown',
  // whose factor is 1, so every onsite and hybrid row silently drifted UPWARD on each
  // run. This is what made a single --apply raise 11 rows that were already correct.
  const persistedArr = (text.match(/^\s*arrangement:\s*["']?([a-z]+)/im) || [])[1];
  const r = applyModel(base, {
    text, company: cells[3], role: cells[4], prefs, arrangement: persistedArr,
  });
  const shown = parseFloat(String(cells[5]).replace('/5', ''));
  const next = r.final.toFixed(1);

  const rec = {
    num: cells[1], co: cells[3], role: cells[4], status: cells[6],
    from: Number.isFinite(shown) ? shown : null, base: r.base, to: r.final,
    cf: r.compFactor, pf: r.prefFactor, af: r.arrFactor,
    pref: r.pref, damped: r.damped, arr: r.arrangement, path: p, dead: DEAD.has(cells[6]),
    compStatus: r.compStatus,
  };
  // Annotation covers every scored row, not just the ones whose tracker cell
  // moves. Keying it off `changes` left reports stale the moment the tracker
  // caught up: a second pass saw no delta and skipped the refresh, so the
  // report kept recording the factors from the run before.
  scored.push(rec);

  // Compare like for like: the tracker cell holds one decimal, so measure the
  // change against the value that will actually be written. Comparing against
  // the unrounded final makes any exact .x5 case report as moving on every run.
  if (!Number.isFinite(shown) || Math.abs(shown - parseFloat(next)) >= 0.05) {
    changes.push({
      num: cells[1], co: cells[3], role: cells[4], status: cells[6],
      from: Number.isFinite(shown) ? shown : null, base: r.base, to: r.final,
      cf: r.compFactor, pf: r.prefFactor, af: r.arrFactor,
      pref: r.pref, damped: r.damped, arr: r.arrangement, path: p, dead: DEAD.has(cells[6]),
    });
  }

  // Rebuild the row with the score cell replaced, preserving original spacing.
  // Guard first: a stray "|" inside a role or note shifts every later column, and
  // blind index-5 assignment would then overwrite whatever landed there — silent
  // corruption of the user's tracker. Only write into a cell that already looks
  // like a score; anything else is left untouched and reported.
  if (!/^\s*\d(\.\d+)?\/5\s*$/.test(c[5] ?? '')) {
    malformed.push(`#${cells[1]} ${cells[3]} — column 5 is "${String(c[5]).trim().slice(0, 30)}", not a score`);
    out.push(line);
    continue;
  }
  c[5] = c[5].replace(/\S.*\S|\S/, `${next}/5`);
  out.push(c.join('|'));
}

const liveChanges = changes.filter((x) => !x.dead);
const floorLabel = MODEL.COMP_FLOOR > 0 ? `$${MODEL.COMP_FLOOR}K` : 'none (no comp gate)';
console.log(`scoring model applied   floor ${floorLabel}  K=${MODEL.COMP_K}  step=${MODEL.PREF_STEP}  roleDamp=${MODEL.ROLE_DAMP}  hybrid=x${MODEL.HYBRID_DAMP.toFixed(3)}`);
console.log('');
console.log(`  live rows scored        : ${live}`);
console.log(`  live rows with no block : ${unparsed}`);
console.log(`  rows whose score moves  : ${changes.length} (${liveChanges.length} live)`);
if (malformed.length) {
  console.log('');
  console.log(`  SKIPPED as malformed (${malformed.length}) — score column is not a score, row left untouched:`);
  for (const m of malformed) console.log(`    ${m}`);
}
console.log('');

// The shortlist is what the model exists to get right; row-level score churn
// only matters insofar as it moves this.
// Comp coverage. The gate only fires on evidence about TOTAL comp, so a row whose
// posting shows base only is UNVERIFIED, not cheap — it is ranked on its comp
// DIMENSION (scored by a human who read the whole posting) and not gated. Making
// that visible matters: an invisible "unverified" reads as "fine".
const cs = (k) => scored.filter((x) => !x.dead && x.compStatus === k).length;
console.log(`  comp evidence: ${cs('clears')} clear the floor, ${cs('gated')} gated on a stated TOTAL,`);
console.log(`                 ${cs('unverified')} UNVERIFIED (base-only figure, total unknown), ${cs('no-figure')} no figure at all`);
console.log('');

const board = changes.filter((x) => !x.dead);
const wasActionable = board.filter((x) => (x.from ?? 0) >= 4).length;
const nowActionable = board.filter((x) => x.to >= 4).length;
const gatedOut = board.filter((x) => (x.from ?? 0) >= 4 && x.to < 4);
console.log(`  of the rows that move: ${wasActionable} were >= 4.0, ${nowActionable} are now`);
if (gatedOut.length) {
  console.log(`  dropped below the line by the model (${gatedOut.length}):`);
  for (const x of gatedOut.sort((a, b) => a.to - b.to)) {
    console.log(`    ${x.from} -> ${x.to.toFixed(2)}  comp x${x.cf.toFixed(2)}  #${x.num.padEnd(4)} ${x.co.slice(0, 20).padEnd(20)} ${x.role.slice(0, 30)}`);
  }
}
console.log('');

const up = liveChanges.filter((x) => x.from !== null && x.to > x.from).sort((a, b) => (b.to - b.from) - (a.to - a.from));
const dn = liveChanges.filter((x) => x.from !== null && x.to < x.from).sort((a, b) => (a.to - a.from) - (b.to - b.from));
const fmt = (x) => `${String(x.from ?? '?').padEnd(4)} -> ${x.to.toFixed(2).padEnd(5)} base ${x.base.toFixed(2)} comp x${x.cf.toFixed(2)} pref x${x.pf.toFixed(3)}${x.damped ? '(d)' : ''} ${x.arr.padEnd(7)} #${x.num.padEnd(4)} ${x.co.slice(0, 18).padEnd(18)} ${x.role.slice(0, 32)}`;
console.log(`  biggest rises (${up.length}):`);
for (const x of up.slice(0, 12)) console.log('    ' + fmt(x));
console.log('');
console.log(`  biggest falls (${dn.length}):`);
for (const x of dn.slice(0, 12)) console.log('    ' + fmt(x));
console.log('');

if (!APPLY) {
  console.log('  dry run — pass --apply to write data/applications.md');
  process.exit(0);
}

copyFileSync(TRACKER, TRACKER + '.bak');
writeFileSync(TRACKER, out.join('\n'), 'utf-8');
console.log(`  wrote ${TRACKER} (backup at ${TRACKER}.bak)`);

if (!REPORTS) process.exit(0);

// Annotate each report with the model output, preserving the pre-model score.
let touched = 0, refreshed = 0;
for (const x of scored) {
  let text = readFileSync(x.path, 'utf-8');
  const m = text.match(/^([ \t]*)global(?:_score)?:\s*([\d.]+)/m);
  if (!m) continue;

  // An existing annotation must be REFRESHED, not skipped. Skipping is how a
  // report ends up recording model_comp_factor 0.49 while the tracker says the
  // score is 2.49 — the factors changed underneath it. Only global_premodel is
  // sticky: it records the score before the model was ever applied, so the very
  // first annotation wins and later passes leave it alone.
  const prior = text.match(/^[ \t]*global_premodel:\s*([\d.]+)/m);
  const premodel = prior ? prior[1] : m[2];
  if (prior) refreshed++; else touched++;

  // drop any previous model_* lines so they cannot accumulate
  text = text.replace(/^[ \t]*(global_premodel|model_base|model_comp_factor|model_pref_factor|model_arrangement):[^\n]*\n/gm, '');
  const block = [
    `${m[1]}global: ${x.to.toFixed(2)}`,
    `${m[1]}global_premodel: ${premodel}   # pre-model, ${TODAY}`,
    `${m[1]}model_base: ${x.base.toFixed(2)}`,
    `${m[1]}model_comp_factor: ${x.cf.toFixed(3)}`,
    `${m[1]}model_pref_factor: ${x.pf.toFixed(3)}`,
    `${m[1]}model_arrangement: ${x.arr}`,
  ].join('\n');
  writeFileSync(x.path, text.replace(m[0], block), 'utf-8');
}
console.log(`  reports annotated: ${touched} new, ${refreshed} refreshed`);
