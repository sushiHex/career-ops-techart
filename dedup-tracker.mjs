#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company. Within a company two rows are one posting when
 * they share a report or row number, or when their roles fuzzy-match, their
 * requisition-id sets do not conflict and neither has reached Applied. A shared id
 * alone never merges here, unlike in merge-tracker: this script deletes rows, so it
 * asks for more. Keeps the row with the highest score and promotes the most
 * advanced status onto it.
 *
 * Run: node career-ops/dedup-tracker.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { companyKey, roleFuzzyMatch, rowIdReader, idSetsConflict } from './role-matcher.mjs';
import { columnsOf, parseScore, rebuildRow, reportNumOf, trackerPath, trackerRows } from './tracker-rows.mjs';
import { guardArgs } from './cli-guard.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_TRACKER lets tests point the script at an isolated fixture.
const APPS_FILE = trackerPath(CAREER_OPS);
// Argument handling comes FIRST and is strict, because the default action of
// this script is a destructive rewrite of the tracker. `node dedup-tracker.mjs
// --help` previously fell through to the real run and deleted rows (2026-08-12);
// any unrecognised flag now stops the script instead of being ignored.
const DRY_RUN = guardArgs({
  name: 'dedup-tracker.mjs',
  summary: 'remove duplicate rows from the applications tracker; with no flags it REWRITES the tracker',
  flags: [['--dry-run', 'report what would change, write nothing']],
  notes: 'Rows are grouped by company. Requisition ids from the report URL and the role cell are\n'
    + 'authoritative and keep two distinct reqs that share a title apart. A backup is written\n'
    + 'to applications.md.bak.',
}).has('--dry-run');
const TRACKER_DIR = dirname(APPS_FILE);

// Ensure the target tracker directory exists in both normal and fixture mode.
mkdirSync(TRACKER_DIR, { recursive: true });

// A row's identity SET (role-matcher.mjs rowIdReader), memoised for this run. Two
// same-company rows whose sets are both non-empty and share nothing are different
// postings and must not be deduplicated, however alike their titles read.
const jobIdsForRow = rowIdReader(TRACKER_DIR);

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
};

/**
 * Normalize tracker status text before ranking or comparing it.
 *
 * Existing trackers can contain bold Markdown wrappers or legacy dates appended
 * to the status cell. Dedup needs the canonical status word only, in lowercase,
 * so advanced-state protection works the same for old and new tracker rows.
 *
 * @param {string} status - Raw status cell from applications.md.
 * @returns {string} Lowercase status key with Markdown/date noise removed.
 */
function normalizeStatus(status) {
  return String(status ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Convert a tracker status into its pipeline-advancement rank.
 *
 * Higher ranks represent states that carry more user intent and should not be
 * casually overwritten or removed. Unknown statuses rank as 0 so malformed data
 * is treated conservatively rather than promoted.
 *
 * @param {string} status - Raw or normalized status value.
 * @returns {number} Numeric rank from STATUS_RANK, or 0 for unknown statuses.
 */
function statusRank(status) {
  return STATUS_RANK[normalizeStatus(status)] || 0;
}

/**
 * Check whether a status represents a real application already in motion.
 *
 * Rows at Applied or later have user-visible history that dedup must preserve
 * unless the duplicate relationship is exact. This guard prevents fuzzy title
 * matches from silently deleting an active application record.
 *
 * @param {string} status - Raw status value from the tracker row.
 * @returns {boolean} True when the row is Applied, Responded, Interview, or Offer.
 */
function isAdvancedStatus(status) {
  return statusRank(status) >= STATUS_RANK.applied;
}

/**
 * Determine whether two tracker rows point to the same exact report identity.
 *
 * Exact identity is stronger than fuzzy role matching. If two rows share the
 * same tracker number or bracketed report number, dedup may treat them as the
 * same record even when an advanced status is present.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {boolean} True when both rows represent the same report identity.
 */
function sameReportIdentity(a, b) {
  if (a.num === b.num) return true;
  const reportA = reportNumOf(a.report);
  const reportB = reportNumOf(b.report);
  return reportA !== null && reportA === reportB;
}

/**
 * Build a stable key for logging one protected fuzzy pair only once.
 *
 * The nested dedup loop can encounter a protected pair during cluster building.
 * Sorting the row numbers produces the same key regardless of comparison order,
 * which keeps the warning output readable and avoids repeated noise.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {string} Stable pair key in ascending tracker-number order.
 */
function pairKey(a, b) {
  return [a.num, b.num].sort((x, y) => x - y).join(':');
}

const protectedFuzzyPairs = new Set();

/**
 * Decide whether two same-company tracker rows should be deduplicated.
 *
 * The function first accepts exact report identity, then applies the shared
 * fuzzy role matcher. If either row is already Applied or later, fuzzy matching
 * alone is not enough; dedup keeps both rows and warns because deleting one
 * would lose application status, report link, and notes for a potentially
 * distinct opening.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {boolean} True when dedup may cluster the two rows as duplicates.
 */
function roleMatch(a, b) {
  if (sameReportIdentity(a, b)) return true;
  if (!roleFuzzyMatch(a.role, b.role)) return false;

  // Authoritative posting identity overrides fuzzy title similarity: when both
  // rows resolve to a job id from their report URL and those ids differ, they
  // are distinct openings and must never be deduplicated, however similar their
  // titles read (e.g. "Modeling & Simulation Engineer, Space" vs "SWE, Modeling
  // & Simulation" at the same company).
  if (idSetsConflict(jobIdsForRow(a), jobIdsForRow(b))) return false;

  // Fuzzy title matches are intentionally conservative once either row has
  // entered the real application pipeline. A user may already have applied to
  // one sibling role, so deleting that row because a higher-scored sibling has
  // similar wording would lose status, report, and notes. Keep both unless the
  // rows point to the exact same report identity.
  if (isAdvancedStatus(a.status) || isAdvancedStatus(b.status)) {
    const key = pairKey(a, b);
    if (!protectedFuzzyPairs.has(key)) {
      protectedFuzzyPairs.add(key);
      console.warn(`⚠️  Keep #${a.num} and #${b.num}: fuzzy role match but advanced status requires exact report identity`);
    }
    return false;
  }

  return true;
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');
const colmap = columnsOf(lines);

// Every row keeps its physical line index (row.line), so updates and removals
// never depend on tracker numbers being globally unique. Row #0 is never an
// application.
const entries = trackerRows(lines, colmap).filter(app => app.num > 0);

console.log(`📊 ${entries.length} entries loaded`);

// Group by company, keyed exactly as merge-tracker keys it, so the two never
// disagree about whether "Riot Games" and "RiotGames" are one employer.
const groups = new Map();
for (const entry of entries) {
  const key = companyKey(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

// Find duplicates
let removed = 0;
const linesToRemove = new Set();

for (const companyEntries of groups.values()) {
  if (companyEntries.length < 2) continue;

  // Within same company, find role matches
  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (roleMatch(companyEntries[i], companyEntries[j])) {
        cluster.push(companyEntries[j]);
        processed.add(j);
      }
    }

    if (cluster.length < 2) continue;

    // Keep the one with highest score
    cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    const keeper = cluster[0];

    // The first row with the most advanced status; promote it onto the keeper.
    const best = cluster.reduce((b, e) => (statusRank(e.status) > statusRank(b.status) ? e : b));
    if (best !== keeper) {
      const parts = lines[keeper.line].split('|').map(s => s.trim());
      parts[colmap.status] = best.status;
      lines[keeper.line] = rebuildRow(parts);
      console.log(`  📝 #${keeper.num}: status promoted to "${best.status}" (from #${best.num})`);
    }

    // Remove duplicates
    for (const dup of cluster.slice(1)) {
      linesToRemove.add(dup.line);
      removed++;
      console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
    }
  }
}

// Remove lines (in reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed`);

if (!DRY_RUN && removed > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
