#!/usr/bin/env node
/**
 * comp-scaled.mjs — model compensation as a SCALED MULTIPLIER instead of a flat dimension.
 *
 * Today `comp` is one of four equally-averaged 0-5 dimensions, so a role paying 68% of
 * the floor and one paying 95% of it can land within a point of each other, and a great
 * fit can outrank affordability. That is a static penalty, not a proportional one.
 *
 * This models the alternative:
 *
 *     fit    = average(match_w_cv, north_star, cultural_signals)
 *     factor = 1                       when achievable >= floor
 *            = (achievable / floor)^K  when achievable <  floor
 *     global = fit * factor + red_flags_adj
 *
 * So the penalty scales with HOW FAR under the floor a role is. At the default K=1.5 a
 * role at 90% of floor keeps 85% of its score, at 75% keeps 65%, at 50% keeps 35%.
 *
 * NOTE ON K: on the current board the curve is almost inert. Only one live role is both
 * sub-floor and near the 4.0 line, so K=2 through K=1 all yield the same 17 actionable
 * and the same single drop. K governs how sub-floor roles rank AMONG THEMSELVES and how
 * future ones land, not the present shortlist.
 *
 * `achievable` is a point in the posted band, not its top: a strong senior candidate
 * negotiates into the upper half but rarely to the ceiling. Default 0.75 of the way up.
 *
 * Writes nothing. Comparison only.
 *
 * Usage:
 *   node comp-scaled.mjs
 *   node comp-scaled.mjs --k 1.5 --band 0.8 --floor 190
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const { parseScores, computeGlobal } = await import(
  new URL('./audit-scores.mjs', import.meta.url).href
);

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : parseFloat(args[i + 1]); };
const K = val('--k', 1.5);   // softened 2026-07-27: quadratic was harsher than intended below floor
const BAND = val('--band', 0.75);

// The band extractor and the floor rule live in score-model.mjs, which is the
// adopted implementation. This file kept private copies until 2026-07-27, and
// they had already drifted: the copy here lacked the guard against reading a
// figure the report cites for a DIFFERENT role, and lacked the base-vs-total
// floor distinction, so it reported one row at x0.49 while the live model
// said 1.00. One implementation, imported, is the only way that stays true.
const { compBand, compVerdict, MODEL } = await import(
  new URL('./score-model.mjs', import.meta.url).href
);
// The floor is the candidate's, from config/profile.yml via score-model. --floor sweeps it.
const FLOOR = val('--floor', MODEL.COMP_FLOOR);
if (!(FLOOR > 0)) {
  console.log('No comp floor: set compensation.minimum in config/profile.yml or pass --floor.');
  process.exit(0);
}

const DEAD = new Set(['Rejected', 'Discarded', 'SKIP']);
const rows = [];
for (const line of readFileSync(join('data', 'applications.md'), 'utf-8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const c = line.split('|').map((x) => x.trim());
  if (c.length < 8 || !/^\d+$/.test(c[1] || '')) continue;
  if (DEAD.has(c[6])) continue;
  const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  if (!rm) continue;
  const p = join('reports', rm[1].split('/').pop());
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf-8');
  const s = parseScores(text);
  const cur = s ? computeGlobal(s) : null;
  if (cur === null || cur > 5 || cur < 0) continue;
  const band = compBand(text);
  const fit = (s.match_w_cv + s.north_star + s.cultural_signals) / 3;
  let achievable = null, factor = null, scaled = null;
  if (band) {
    achievable = band.lo + (band.hi - band.lo) * BAND;
    // Sub-floor pay is a GATE that scales with the shortfall, applied to the existing
    // four-dimension score. Dropping comp out of the average and using it only as a
    // multiplier also destroyed its upside: roles paying 3-4x the floor lost the reward
    // their comp score was giving them and fell below the line. Keeping comp in the
    // average preserves that, while the gate still sinks unaffordable roles in
    // proportion to how far under they are.
    // The gate only fires on evidence about TOTAL comp — see score-model.compVerdict.
    // At default settings defer to the shared verdict; a custom --floor/--k sweeps
    // the curve, still only on total-comp evidence.
    factor = (FLOOR === MODEL.COMP_FLOOR && K === 1.5)
      ? compVerdict(band).factor
      : (band.basis === 'total' && achievable < FLOOR ? Math.pow(achievable / FLOOR, K) : 1);
    scaled = (cur) * factor;
  }
  rows.push({ num: c[1], co: c[3], role: c[4], cur, fit, band, achievable, factor, scaled });
}

const scored = rows.filter((r) => r.scaled !== null);
console.log(`comp as a scaled multiplier   K=${K}  band-point=${BAND}  floor=$${FLOOR}K`);
console.log('');
console.log(`  live rows                 : ${rows.length}`);
console.log(`  with an extractable band  : ${scored.length}`);
console.log(`  no band, cannot scale     : ${rows.length - scored.length}`);
console.log('');
const cnt = (f, t) => scored.filter(f).length + '/' + scored.length;
console.log(`  actionable >= 4.0  current model : ${scored.filter((r) => r.cur >= 4).length}`);
console.log(`  actionable >= 4.0  scaled  model : ${scored.filter((r) => r.scaled >= 4).length}`);
console.log('');

const drops = scored.filter((r) => r.cur >= 4 && r.scaled < 4).sort((a, b) => a.scaled - b.scaled);
const gains = scored.filter((r) => r.cur < 4 && r.scaled >= 4).sort((a, b) => b.scaled - a.scaled);

console.log(`  DROPPED by affordability (${drops.length}) — fit was carrying an unaffordable role:`);
for (const r of drops.slice(0, 10)) {
  console.log(`    ${r.cur.toFixed(2)} -> ${r.scaled.toFixed(2)}   $${Math.round(r.achievable)}K = ${Math.round(100 * r.achievable / FLOOR)}% of floor  x${r.factor.toFixed(2)}   #${r.num.padEnd(4)} ${r.co.slice(0, 26)}`);
}
console.log('');
console.log(`  PROMOTED (${gains.length}) — comp was dragging down a role that actually pays:`);
for (const r of gains.slice(0, 10)) {
  console.log(`    ${r.cur.toFixed(2)} -> ${r.scaled.toFixed(2)}   $${Math.round(r.achievable)}K = ${Math.round(100 * r.achievable / FLOOR)}% of floor  x${r.factor.toFixed(2)}   #${r.num.padEnd(4)} ${r.co.slice(0, 26)}`);
}
console.log('');
console.log('  curve, share of fit score retained:');
for (const pct of [1.0, 0.95, 0.9, 0.8, 0.75, 0.6, 0.5]) {
  console.log(`    pay at ${String(Math.round(pct * 100)).padStart(3)}% of floor -> keeps ${Math.round(100 * Math.pow(Math.min(1, pct), K))}%`);
}
