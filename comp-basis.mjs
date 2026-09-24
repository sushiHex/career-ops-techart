#!/usr/bin/env node
/**
 * comp-basis.mjs — emit, per tracked row, whether its comp figure is BASE or TOTAL.
 *
 * The floor the model scores against is TOTAL compensation, but most postings publish a base
 * band. The board showed one number with no indication which it was, so a base-only band
 * at an employer with no IC cash bonus (equity closes the gap) looked the same as a genuine
 * total. That is the difference between a role that straddles the
 * floor and one that clears it.
 *
 * Derived from score-model.mjs — compBand() already classifies basis and compVerdict()
 * already decides the floor status. This deliberately adds NO second classifier: a
 * hand-rolled duplicate of an existing parser is what produced the drifted scores on
 * 2026-07-30. Output is a generated sidecar, not a copy written into 140 reports, so it
 * cannot go stale against the reports it describes.
 *
 * Writes data/comp-basis.json: { "<num>": {basis, status, lo, hi} }
 * Usage: node comp-basis.mjs [--quiet]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const QUIET = process.argv.includes('--quiet');
// Sibling modules resolve beside this file, so it runs from any directory; the
// data it reads (data/, reports/) stays relative to where it is run.
const here = (f) => new URL(f, import.meta.url).href;
const { compBand, compVerdict } = await import(here('score-model.mjs'));

const TRACKER = join('data', 'applications.md');
if (!existsSync(TRACKER)) { console.log('no tracker'); process.exit(0); }

const out = {};
const tally = { base: 0, total: 0, unknown: 0, 'no-figure': 0 };

for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const c = line.split('|').map((x) => x.trim());
  if (c.length < 8 || !/^\d+$/.test(c[1] || '')) continue;

  const rm = line.match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  if (!rm) continue;
  const p = join('reports', rm[1].split('/').pop());
  if (!existsSync(p)) continue;

  let text;
  try { text = readFileSync(p, 'utf-8'); } catch { continue; }

  const band = compBand(text);
  const v = compVerdict(band);

  // compBand short-circuits on a `comp_total_est:` field, so its basis can describe a
  // DIFFERENT figure than the posted band the board displays -- which once labelled a
  // posted base band as "total" off the report's own total-comp estimate. Re-run
  // with that field stripped to get the basis OF THE POSTED BAND, and publish its lo/hi
  // so the consumer can confirm it is describing the number it is about to label.
  const posted = compBand(text.replace(/^[ \t]*comp_total_est(?:imate)?:.*$/gim, ''));

  const basis = band ? band.basis : 'no-figure';
  out[c[1]] = {
    basis, status: v.status,
    lo: band ? band.lo : null, hi: band ? band.hi : null,
    posted_basis: posted ? posted.basis : 'no-figure',
    posted_lo: posted ? posted.lo : null, posted_hi: posted ? posted.hi : null,
  };
  tally[basis] = (tally[basis] || 0) + 1;
}

writeFileSync(join('data', 'comp-basis.json'), JSON.stringify(out, null, 1), 'utf-8');
if (!QUIET) {
  console.log('comp basis per row (from score-model.mjs):');
  for (const [k, n] of Object.entries(tally)) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log(`comp-basis: ${Object.keys(out).length} rows -> data/comp-basis.json`);
process.exit(0);
