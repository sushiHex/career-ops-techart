#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks:
 * 1. All statuses are canonical, with no bold and no dates
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files; 3b. live rows carry an apply link
 * 4. Scores read N.N/5, N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 * 7. No bold in scores
 * 8. Stale report-number sentinels are collected
 *
 * Run: node career-ops/verify-pipeline.mjs
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CANONICAL_STATUSES, columnsOf, isSeparatorRow, normalizeStatus, SCORE_CELL, trackerPath, trackerRows } from './tracker-rows.mjs';
import { companyKey, idSetsProvablyDistinct, rowIdReader } from './role-matcher.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original).
// CAREER_OPS_TRACKER overrides the path (used by tests and non-standard layouts).
const APPS_FILE = trackerPath(CAREER_OPS);
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read applications.md ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Columns are mapped by header name (tracker-rows.mjs), so a tracker with an
// extra Location column is checked as correctly as the original 9-column one.
const COLMAP = columnsOf(lines);
const MAX_IDX = Math.max(...Object.values(COLMAP));
const entries = trackerRows(lines, COLMAP);

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  if (!CANONICAL_STATUSES.includes(normalizeStatus(e.status))) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates ---
// Markdown links resolve relative to the file that contains them, so report
// links, and the row identities read through them, resolve against the tracker's directory.
const TRACKER_DIR = dirname(APPS_FILE);
const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  const key = companyKey(e.company) + '::' +
    e.role.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
// Same company and title is not the same posting: employers reuse titles across reqs
// (Zillow P732510 and P711740, 2026-10-20). Two rows are provably distinct only when their
// ids are disjoint AND comparable: a Greenhouse `gh:1234567` and a company-hosted
// `id:1234567` can name one posting, so disjoint ids from different namespaces still warn.
const idsOf = rowIdReader(TRACKER_DIR);
const provablyDistinct = idSetsProvablyDistinct;
for (const group of companyRoleMap.values()) {
  if (group.length < 2) continue;
  const suspect = group.filter((e, i) =>
    group.some((o, j) => j !== i && !provablyDistinct(idsOf(e), idsOf(o))));
  if (suspect.length > 1) {
    warn(`Possible duplicates: ${suspect.map(e => `#${e.num}`).join(', ')} (${group[0].company}, ${group[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
// Markdown links resolve relative to the file that contains them, so report
// links must resolve against the tracker's own directory (see #760). For the
// transition we also accept legacy root-relative links: try the tracker dir
// first, then fall back to the repo root before flagging a link broken.
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const link = match[1];
  if (!existsSync(join(TRACKER_DIR, link)) && !existsSync(join(CAREER_OPS, link))) {
    error(`#${e.num}: Report not found: ${link}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 3b: Apply links ---
// CLAUDE.md requires every report to carry `**URL:**`, and the pipeline assumed
// it. Nothing enforced it, so twelve live rows had a location string, an ATS
// name, or a comp note sitting where the link belongs, including a 4.5. Those
// rows cannot be liveness-checked and cannot be applied to from the board, so a
// missing link quietly removes a role from the search while it still looks
// present. Dead rows are exempt: they are already out.
// Warning rather than error: this is a pre-existing backlog, and a permanently
// red suite is one nobody reads. It still names every affected row.
const DEAD_FOR_URL = new Set(['Rejected', 'Discarded', 'SKIP']);
let badUrls = 0;
for (const e of entries) {
  if (DEAD_FOR_URL.has(e.status)) continue;
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const link = match[1];
  const path = [join(TRACKER_DIR, link), join(CAREER_OPS, link)].find((p) => existsSync(p));
  if (!path) continue;
  const m = readFileSync(path, 'utf-8').match(/^\*\*URL:\*\*[ \t]*(.*)$/m);
  const value = m ? m[1].trim() : '';
  // `none — <reason>` is an explicit, deliberate record that no permalink
  // exists (email-only application, custom ATS, a retired req whose ATS 302s to
  // a landing page). That is different from a missing field or a company name
  // sitting where the link belongs, which is what this check is for. Without
  // this, unfixable rows warn forever and the real problems hide in the noise.
  if (/^none\b\s*[—-]/.test(value)) continue;
  if (!/^https?:\/\//.test(value)) {
    warn(`#${e.num} ${e.company}: **URL:** is not a link${value ? ` ("${value.slice(0, 42)}")` : ' (missing)'}`);
    badUrls++;
  }
}
if (badUrls === 0) ok('All live rows have an apply link');

// --- Check 4: Score format ---
let badScores = 0;
for (const e of entries) {
  const s = e.score.replace(/\*\*/g, '').trim();
  if (!SCORE_CELL.test(s)) {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (isSeparatorRow(line)) continue;
  const parts = line.split('|');
  if (parts.length <= MAX_IDX) {
    error(`Row with too few columns (need ${MAX_IDX} data cols): ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

// --- Check 8: Stale report-number sentinels (GC) ---
// reserve-report-num.mjs drops NNN-RESERVED.md files in reports/ when a
// number is claimed.  If the process crashed before writing the real report
// and deleting the sentinel it will linger.  Sentinels older than 4 h are
// stale; remove them here so they don't skew the next slot allocation.
const SENTINEL_MAX_AGE_MS = 4 * 60 * 60 * 1000;
let staleSentinels = 0;
if (existsSync(REPORTS_DIR)) {
  const now = Date.now();
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('-RESERVED.md')) continue;
    const full = join(REPORTS_DIR, name);
    try {
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs > SENTINEL_MAX_AGE_MS) {
        unlinkSync(full);
        warn(`Removed stale reservation sentinel: ${name}`);
        staleSentinels++;
      }
    } catch {
      // Already gone between readdir and stat — fine.
    }
  }
}
if (staleSentinels === 0) ok('No stale reservation sentinels');

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
