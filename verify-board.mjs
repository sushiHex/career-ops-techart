#!/usr/bin/env node
/**
 * verify-board.mjs — guard the numbers the apply decision is made on.
 *
 * The board ranks on the score column and the 4.0 line drives whether the candidate applies.
 * So the failure that matters is not a crash, it is a row sitting at the top of
 * the list on a number nothing can reproduce. Two real examples this file exists
 * to catch, both found 2026-07-27:
 *
 *   - One row showed 4.5, the highest score on the board, from a prose "Score:"
 *     line in a report that predates the machine-readable format. No dimensions,
 *     so the model cannot verify it, re-derive it, or apply any modifier to it.
 *   - Another carried red_flags_adj: 3.4 — a penalty field holding a positive
 *     number, which computed a global of 6.475 on a 0-5 scale.
 *
 * Exit 1 on any ACTIONABLE row (>= 4.0) that cannot be verified, because that is
 * the set the candidate acts on. Unverifiable rows below the line are reported, not fatal.
 *
 * Usage:
 *   node verify-board.mjs
 *   node verify-board.mjs --all     # list every unverifiable row, not just actionable
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Sibling modules resolve beside this file, so it runs from any directory; the
// data it reads (data/, reports/) stays relative to where it is run.
const here = (f) => new URL(f, import.meta.url).href;
const { parseScores, computeGlobal } = await import(here('audit-scores.mjs'));

const ALL = process.argv.includes('--all');
const TRACKER = join('data', 'applications.md');
const DEAD = new Set(['Rejected', 'Discarded', 'SKIP']);
const ACTIONABLE = 4.0;

// No tracker is not agreement, and exiting 0 here read as a pass to any script or CI
// step checking this gate's exit code. score-audit.mjs, its sibling gate, hits the same
// state and prints NOT CHECKED with exit 2 rather than a silent green; do the same here,
// since "no tracker" and "a tracker that agrees" are different answers.
if (!existsSync(TRACKER)) {
  console.log(`NOT CHECKED: ${TRACKER} does not exist yet (onboarding required).`);
  process.exit(2);
}

const bad = [];
let live = 0, ok = 0;

for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const c = line.split('|').map((x) => x.trim());
  if (c.length < 8 || !/^\d+$/.test(c[1] || '')) continue;
  if (DEAD.has(c[6])) continue;
  live++;

  const shown = parseFloat(String(c[5]).replace('/5', ''));
  const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  const p = rm ? join('reports', rm[1].split('/').pop()) : null;

  let why = null;
  if (!Number.isFinite(shown)) why = `score cell is not a number ("${c[5]}")`;
  else if (shown < 0 || shown > 5) why = `score ${shown} is outside 0-5`;
  else if (!rm) why = 'no report link';
  else if (!existsSync(p)) why = `report file missing (${p})`;
  else {
    const s = parseScores(readFileSync(p, 'utf-8'));
    if (!s) why = 'no machine-readable score block';
    else if ((s.red_flags_adj ?? 0) > 0) why = `red_flags_adj is +${s.red_flags_adj} (a penalty cannot be positive)`;
    else {
      const g = computeGlobal(s);
      if (g === null) why = 'score block is missing a dimension';
      else if (g < 0 || g > 5) why = `dimensions compute to ${g.toFixed(2)}, outside 0-5`;
      else ok++;
    }
  }
  if (why) bad.push({ num: c[1], co: c[3], role: c[4], shown, why, actionable: shown >= ACTIONABLE });
}

const act = bad.filter((b) => b.actionable);
bad.sort((a, b) => (b.shown || 0) - (a.shown || 0));

console.log('board verification — can every score be reproduced from its report?');
console.log('');
console.log(`  live rows          : ${live}`);
console.log(`  verifiable         : ${ok}`);
console.log(`  NOT verifiable     : ${bad.length}`);
console.log(`  ...and actionable  : ${act.length}`);
console.log('');

if (act.length) {
  console.log('  ACTIONABLE but unverifiable — these drive apply decisions:');
  for (const b of act) {
    console.log(`    ${String(b.shown).padEnd(5)} #${b.num.padEnd(4)} ${b.co.slice(0, 24).padEnd(24)} ${b.role.slice(0, 34)}`);
    console.log(`          ${b.why}`);
  }
  console.log('');
}

if (ALL && bad.length > act.length) {
  console.log('  unverifiable, below the line (not fatal):');
  for (const b of bad.filter((x) => !x.actionable)) {
    console.log(`    ${String(b.shown).padEnd(5)} #${b.num.padEnd(4)} ${b.co.slice(0, 24).padEnd(24)} ${b.why}`);
  }
  console.log('');
}

if (act.length) {
  console.log(`🔴 ${act.length} actionable row(s) rank on a number that cannot be reproduced.`);
  console.log('   Re-evaluate them, or add a Machine Summary score block to their reports.');
  process.exit(1);
}
console.log(bad.length
  ? `🟡 every actionable row is verifiable. ${bad.length} below-the-line row(s) are not — run with --all to list them.`
  : '🟢 every live row is verifiable.');
