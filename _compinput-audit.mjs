#!/usr/bin/env node
/**
 * _compinput-audit.mjs: one-off diagnostic (2026-10-29), read-only.
 *
 * apply-model.mjs hands score-model the WHOLE report text, so compBand() can arm the comp
 * gate from a pay range an evaluator wrote in prose. eval-write.mjs and score-audit.mjs
 * hand it only comp_total_est (or a total-basis posted band). The two passes therefore
 * disagree on some rows, and alternating them churned five rows on 2026-10-29. This
 * replays every tracker row both ways and prints the rows whose final differs, so the
 * size of the change is known before either pass is altered.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { columnsOf, reportFileOf, trackerRows } from './tracker-rows.mjs';
import { applyModel, loadPrefs, persistedArrangement } from './score-model.mjs';

const field = (t, k) => {
  const m = t.match(new RegExp('^\\s*' + k + ':\\s*"?([^"\\n]+)', 'm'));
  return m ? m[1].trim().replace(/"$/, '') : null;
};
const num = (t, k) => { const v = field(t, k); return v === null ? null : Number(v); };

const prefs = loadPrefs('config');
const lines = readFileSync('data/applications.md', 'utf-8').split('\n');
const diffs = [];
let n = 0;
for (const row of trackerRows(lines, columnsOf(lines))) {
  const f = reportFileOf(row.raw);
  const p = f ? join('reports', f) : null;
  if (!p || !existsSync(p)) continue;
  const t = readFileSync(p, 'utf-8');
  const dims = ['match_w_cv', 'north_star', 'comp', 'cultural_signals'].map(k => num(t, k));
  if (dims.some(v => v === null || Number.isNaN(v))) continue;
  const base = dims.reduce((a, b) => a + b, 0) / 4 + (num(t, 'red_flags_adj') || 0);
  let arrangement;
  try { arrangement = persistedArrangement(t); } catch { continue; }
  const est = field(t, 'comp_total_est');
  const basis = String(field(t, 'comp_basis') || '').toLowerCase();
  const posted = field(t, 'comp_posted');
  const compLine = est !== null ? est
    : (!posted || posted === 'not published' || basis === 'base' || basis === 'unknown') ? '' : posted;
  const loc = (field(t, 'location_final') || '').split(/\s+--\s+/)[0];
  let full, narrow;
  try {
    full = applyModel(base, { text: t, company: row.company, role: row.role, prefs, arrangement }).final;
    narrow = applyModel(base, { text: `comp_total_est: "${compLine}"\nlocation: "${loc}"\n`,
      company: row.company, role: row.role, prefs, arrangement }).final;
  } catch { continue; }
  n++;
  if (Math.abs(full - narrow) >= 0.05) diffs.push({ num: row.num, status: row.status, co: row.company, role: row.role, full, narrow });
}
diffs.sort((a, b) => Math.max(b.full, b.narrow) - Math.max(a.full, a.narrow));
console.log(`${n} rows replayed; ${diffs.length} differ by >= 0.05 between whole-report and comp-field-only input`);
const line = d => `  #${d.num} ${d.status.padEnd(10)} whole ${d.full.toFixed(2)}  fields ${d.narrow.toFixed(2)}  ${d.co.slice(0, 22)} | ${d.role.slice(0, 50)}`;
const live = diffs.filter(d => !/discarded|skip|rejected/i.test(d.status));
console.log(`  of which not Discarded/SKIP/Rejected: ${live.length}; crossing 3.95 either way: ${diffs.filter(d => (d.full >= 3.95) !== (d.narrow >= 3.95)).length}`);
for (const d of diffs.slice(0, 40)) console.log(line(d));
