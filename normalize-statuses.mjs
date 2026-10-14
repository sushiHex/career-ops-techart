#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in applications.md
 *
 * Maps all non-canonical statuses to canonical ones per templates/states.yml:
 *   Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP
 * (the upstream Spanish labels are accepted as aliases).
 *
 * Also strips markdown bold (**) and dates from the status field,
 * moving DUPLICADO info to the notes column.
 *
 * Run: node career-ops/normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { guardArgs } from './cli-guard.mjs';
import { columnsOf, rebuildRow, trackerPath, trackerRows } from './tracker-rows.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_TRACKER lets tests point the script at an isolated fixture.
const APPS_FILE = trackerPath(CAREER_OPS);
const args = guardArgs({
  name: 'normalize-statuses.mjs',
  summary: 'rewrite non-canonical status values in the applications tracker',
  flags: [['--dry-run', 'report what would change, write nothing']],
  notes: 'Without --dry-run this REWRITES data/applications.md. A backup is written to applications.md.bak.',
});
const DRY_RUN = args.has('--dry-run');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

// Canonical status mapping
function normalizeStatus(raw) {
  // Strip markdown bold
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  // DUPLICADO variants → Discarded
  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }

  // CERRADA / Cancelada / Descartada → Discarded
  if (/^cerrada$/i.test(s)) return { status: 'Discarded' };
  if (/^cancelada/i.test(s)) return { status: 'Discarded' };
  if (/^descartada$/i.test(s)) return { status: 'Discarded' };
  if (/^descartado$/i.test(s)) return { status: 'Discarded' };

  // Rechazada / Rechazado → Rejected
  if (/^rechazada?$/i.test(s)) return { status: 'Rejected' };
  if (/^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };

  // Aplicado with date → Applied (strip date)
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };

  // CONDICIONAL / HOLD / EVALUAR / Verificar → Evaluated
  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: 'Evaluated' };

  // MONITOR → SKIP
  if (/^monitor$/i.test(s)) return { status: 'SKIP' };

  // GEO BLOCKER → SKIP
  if (/geo.?blocker/i.test(s)) return { status: 'SKIP' };

  // Repost #NNN → Discarded
  if (/^repost/i.test(s)) return { status: 'Discarded', moveToNotes: raw.trim() };

  // "—" (em dash, no status) → Discarded
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  // Already canonical (English, per states.yml) — just fix casing/bold
  const canonical = [
    'Evaluated', 'Applied', 'Responded', 'Interview',
    'Offer', 'Rejected', 'Discarded', 'SKIP',
  ];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  // Spanish aliases → English canonicals
  if (['evaluada'].includes(lower)) return { status: 'Evaluated' };
  if (['aplicado', 'enviada', 'aplicada', 'applied', 'sent'].includes(lower)) return { status: 'Applied' };
  if (['respondido'].includes(lower)) return { status: 'Responded' };
  if (['entrevista'].includes(lower)) return { status: 'Interview' };
  if (['oferta'].includes(lower)) return { status: 'Offer' };
  if (['cerrada', 'descartada'].includes(lower)) return { status: 'Discarded' };
  if (['no aplicar', 'no_aplicar', 'skip'].includes(lower)) return { status: 'SKIP' };

  // Unknown — flag it
  return { status: null, unknown: true };
}

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to normalize.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

let changes = 0;
const unknowns = [];

const colmap = columnsOf(lines);
for (const row of trackerRows(lines, colmap)) {
  const { num, status: rawStatus } = row;
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ num, rawStatus, line: row.line + 1 });
    continue;
  }

  if (result.status === rawStatus) continue; // Already canonical

  const parts = row.raw.split('|').map(s => s.trim());
  parts[colmap.status] = result.status;

  // Move DUPLICADO info to notes if needed
  const moved = result.moveToNotes;
  if (moved && colmap.notes != null && !row.notes.includes(moved)) {
    parts[colmap.notes] = row.notes ? `${moved}. ${row.notes}` : moved;
  }

  // Also strip bold from score field
  if (row.score) {
    parts[colmap.score] = row.score.replace(/\*\*/g, '');
  }

  lines[row.line] = rebuildRow(parts);
  changes++;

  console.log(`#${num}: "${rawStatus}" → "${result.status}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) {
    console.log(`  #${u.num} (line ${u.line}): "${u.rawStatus}"`);
  }
}

console.log(`\n📊 ${changes} statuses normalized`);

if (!DRY_RUN && changes > 0) {
  // Backup first
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No changes needed');
}
