#!/usr/bin/env node
/**
 * dream-multiplier.mjs — parameter sweep for the company-preference multiplier.
 *
 * The multiplier itself was ADOPTED on 2026-07-27 and now lives in
 * score-model.mjs, applied by apply-model.mjs. This file survives as the tool for
 * asking "what would a different step / damp / arrangement rule do to the board?"
 * without writing anything.
 *
 * It imports every piece of scoring logic from score-model.mjs. It used to keep
 * private copies of the preference loader, the arrangement classifier and the
 * de-prioritised-title list, and those copies had already drifted from the live
 * model — which is exactly how a comparison tool starts quietly reporting numbers
 * that disagree with the board it is meant to explain.
 *
 * Writes nothing. Comparison only.
 *
 * Usage:
 *   node dream-multiplier.mjs --gate-roletype --damp-hybrid   # the adopted settings
 *   node dream-multiplier.mjs --step 0.1                      # sweep the step
 *   node dream-multiplier.mjs --list                          # show the scale
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Sibling modules resolve beside this file, so it runs from any directory; the
// data it reads (data/, reports/) stays relative to where it is run.
const here = (f) => new URL(f, import.meta.url).href;
const { parseScores, computeGlobal } = await import(here('audit-scores.mjs'));
const { arrangement, locationText, DEPRIORITISED, loadPrefs, preference, MODEL } =
  await import(here('score-model.mjs'));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : parseFloat(args[i + 1]); };
const STEP = val('--step', MODEL.PREF_STEP);
const GATE = args.includes('--gate-roletype');
const DAMP = val('--damp', MODEL.ROLE_DAMP);
const REMOTE_BOOST = val('--remote-boost', 0.03);
const NO_ARR = args.includes('--no-remote-boost');
const DAMP_HYBRID = args.includes('--damp-hybrid');

const PREFS = loadPrefs();
if (!PREFS.length) {
  console.error('No company_preference block in config/profile.yml.');
  process.exit(1);
}

if (args.includes('--list')) {
  console.log(`company preference scale (config/profile.yml, step ${STEP} per 1.0)`);
  console.log('');
  // Match order is longest-name-first so short names cannot shadow long ones;
  // display order is by preference, which is what a reader wants to see.
  for (const [re, v] of [...PREFS].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))) {
    const label = String(re).replace(/^\/\^?|\$?\/i?$/g, '').replace(/\\/g, '');
    console.log(`  ${v.toFixed(1)}  x${(1 + v * STEP).toFixed(3)}   ${label}`);
  }
  console.log('');
  console.log(`  ${PREFS.length} companies on the scale`);
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
  const g = s ? computeGlobal(s) : null;
  if (g === null || g > 5 || g < 0) continue;

  let pref = preference(c[3], PREFS);
  const damped = GATE && pref > 0 && !!DEPRIORITISED && DEPRIORITISED.test(c[4] || '');
  if (damped) pref = Math.round(pref * DAMP * 10) / 10;

  const arr = arrangement(locationText(text));
  // Two ways to make remote outrank hybrid, identical in relative ordering:
  //   boost remote  — remote is the large majority of rows, so lifting it lifts
  //                   the board and the 4.0 line effectively drops.
  //   damp hybrid   — same gap, board level unchanged, far fewer rows move.
  // The adopted model damps hybrid. Onsite stays 1.0 either way.
  let arrMult = 1;
  if (!NO_ARR) {
    if (DAMP_HYBRID) arrMult = arr === 'hybrid' ? 1 / (1 + REMOTE_BOOST) : 1;
    else arrMult = arr === 'remote' ? 1 + REMOTE_BOOST : 1;
  }

  const mult = (1 + pref * STEP) * arrMult;
  rows.push({ num: c[1], co: c[3], role: c[4], pref, mult, cur: g, boosted: Math.min(5, g * mult), damped, arr });
}

const cur4 = rows.filter((r) => r.cur >= 4).length;
const new4 = rows.filter((r) => r.boosted >= 4).length;
const gained = rows.filter((r) => r.cur < 4 && r.boosted >= 4);
const byArr = (k) => rows.filter((r) => r.arr === k).length;

console.log(`company preference sweep   step=${STEP} per 1.0 preference`);
console.log(GATE ? `role-type gate ON: de-prioritised titles keep ${DAMP} of their preference`
  : 'role-type gate OFF (pass --gate-roletype to damp DevRel/GTM titles)');
console.log(NO_ARR ? 'arrangement OFF'
  : DAMP_HYBRID ? `hybrid damp ON: x${(1 / (1 + REMOTE_BOOST)).toFixed(3)} for hybrid, x1.00 otherwise`
    : `remote boost ON: x${(1 + REMOTE_BOOST).toFixed(2)} for remote, x1.00 otherwise`);
console.log('');
console.log(`  live rows                     : ${rows.length}`);
console.log(`  with a non-zero preference    : ${rows.filter((r) => r.pref > 0).length}`);
if (GATE) console.log(`  damped as de-prioritised      : ${rows.filter((r) => r.damped).length}`);
console.log(`  arrangement                   : ${byArr('remote')} remote, ${byArr('hybrid')} hybrid, ${byArr('onsite')} onsite, ${byArr('unknown')} unclassified`);
console.log('');
console.log(`  NOTE: this sweep applies preference + arrangement to the BASE score only.`);
console.log(`  It does not apply the comp gate, so its counts differ from the live board.`);
console.log('');
console.log(`  base >= 4.0                   : ${cur4}`);
console.log(`  with these settings           : ${new4}`);
console.log('');
console.log(`  crosses the line (${gained.length}):`);
for (const r of gained.sort((a, b) => b.boosted - a.boosted)) {
  console.log(`    ${r.cur.toFixed(2)} -> ${r.boosted.toFixed(2)}   pref ${r.pref.toFixed(1)} ${r.arr.padEnd(7)} x${r.mult.toFixed(3)}   #${r.num.padEnd(4)} ${r.co.slice(0, 20).padEnd(20)} ${r.role.slice(0, 34)}`);
}
console.log('');
console.log('  every boosted row, before and after:');
for (const r of rows.filter((x) => x.mult !== 1).sort((a, b) => b.boosted - a.boosted)) {
  const flag = r.boosted >= 4 && r.cur < 4 ? '  <- promoted' : '';
  console.log(`    ${r.cur.toFixed(2)} -> ${r.boosted.toFixed(2)}  pref ${r.pref.toFixed(1)} ${r.arr.padEnd(7)} ${r.co.slice(0, 20).padEnd(20)} ${r.role.slice(0, 30)}${flag}`);
}
