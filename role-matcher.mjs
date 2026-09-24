/**
 * role-matcher.mjs - Shared fuzzy role-title matching for tracker scripts.
 *
 * Both `merge-tracker.mjs` and `dedup-tracker.mjs` decide whether two
 * same-company tracker rows describe the same opening. Keeping this logic in
 * one module prevents the merge path from preserving rows that the later dedup
 * path would silently delete with weaker matching rules.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { REQ_ID, canonId } from './req-id-core.mjs';

// Tokens that almost every role shares must not count as strong matching
// signal. This set covers seniority, work mode, contract shape, locations, and
// other words that frequently appear in titles without identifying the opening.
export const ROLE_STOPWORDS = new Set([
  // seniority / level
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  // contract / mode
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'intern', 'internship',
  // generic job words
  'role', 'position', 'opportunity', 'team', 'based',
  // very common locations
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  // regions / countries
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  // prepositions leaking through the length filter
  'with', 'from', 'into', 'over', 'this', 'that',
]);

// Short specialty acronyms that are discriminating despite their length.
// Broad two-letter buckets such as AI/ML are intentionally excluded because
// they appear across many unrelated roles.
export const SHORT_SPECIALTY = new Set([
  'api', 'sre', 'sdk', 'cli', 'gpu', 'cpu',
  'ios', 'qa', 'ux', 'ui', 'ar', 'vr',
  'ocr', 'crm', 'erp',
]);

// Generic role-level descriptors. Two titles whose only overlap is in this set
// are not the same opening; they are merely written at the same role altitude.
export const BASELINE_TOKENS = new Set([
  'software', 'engineer', 'developer', 'manager', 'architect',
  'analyst', 'designer', 'consultant', 'specialist',
  'platform', 'systems', 'services',
  'backend', 'frontend', 'full', 'stack', 'fullstack',
]);

/**
 * Convert a role title into content tokens used for fuzzy matching.
 *
 * The tokenizer keeps long descriptive words and a narrow set of short
 * specialty acronyms, while dropping common stopwords. Baseline tokens are kept
 * in the result so they can contribute to the similarity ratio, but they cannot
 * be the only reason two titles match.
 *
 * @param {string} role - Raw role title from the tracker or TSV addition.
 * @returns {string[]} Ordered role-title tokens.
 */
export function roleTokens(role) {
  const text = typeof role === 'string' ? role : String(role ?? '');
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => (w.length > 3 || SHORT_SPECIALTY.has(w)) && !ROLE_STOPWORDS.has(w));
}

/**
 * Decide whether two role titles are likely the same opening.
 *
 * Matching requires at least two shared tokens, at least one shared token that
 * is not merely baseline job vocabulary, and a Jaccard overlap of 0.6 or more.
 * This preserves genuine reposts while keeping sibling roles such as
 * "Full Stack Engineer, Foundation" and "Full Stack Engineer, Guarded Releases"
 * as separate applications.
 *
 * @param {string} a - First role title.
 * @param {string} b - Second role title.
 * @returns {boolean} True when the titles are similar enough to deduplicate.
 */
export function roleFuzzyMatch(a, b) {
  const wordsA = [...new Set(roleTokens(a))];
  const wordsB = [...new Set(roleTokens(b))];
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w));
  if (overlap.length < 2) return false;

  // Require at least one non-baseline token in the overlap. Roles that share
  // only generic descriptors like [software, engineer] or [full, stack,
  // engineer] are not the same opening.
  const discriminating = overlap.filter(w => !BASELINE_TOKENS.has(w));
  if (discriminating.length === 0) return false;

  // Use a true set-based Jaccard ratio. Dividing by the smaller title inflates
  // matches for roles that share a long generic prefix but differ in specialty.
  const union = new Set([...wordsA, ...wordsB]).size;
  return overlap.length / union >= 0.6;
}

/**
 * Extract a stable job-posting identity from an ATS URL.
 *
 * Fuzzy title matching cannot reliably separate sibling roles at the same
 * company that share a technical domain but differ in specialty or seniority
 * ("Principal ML Engineer, Agentic AI" vs "Senior ML Engineer"). The posting
 * URL, however, carries an unambiguous requisition id. This extracts that id as
 * a namespaced token so two rows can be compared for true posting identity,
 * independent of how their titles are worded.
 *
 * Recognizes Greenhouse (gh_jid / /jobs/N), Lever & Ashby (UUID), Workday
 * (`_JR…`, `_P…`, `_R…`, or a bare `JR…`/`REQ-…` token), and Riot / Netflix /
 * generic `/job(s)/N` numeric ids. Returns null when no id can be found, which
 * signals callers to fall back to fuzzy title matching.
 *
 * @param {string} url - Raw posting URL (typically from a report's `**URL:**`).
 * @returns {string|null} Namespaced job id (e.g. `gh:4223404714`, `wd:jr2357552`) or null.
 */
/**
 * Normalise a Workday requisition token to a comparable key.
 *
 * Workday appends a "-<n>" facet suffix to some slugs (P711740-2), which must go,
 * but the same shape is how Sony writes the id itself (JR-119345). Stripping
 * blindly turned that id into the bare prefix "jr", which would collide with every
 * other Sony req. So only strip the trailing group when something with a digit in
 * it survives.
 */
function normaliseReqId(tok) {
  let s = String(tok);
  const stripped = s.replace(/-\d+$/, '');
  if (/\d/.test(stripped)) s = stripped;
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractJobId(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  // Path-only view (host + path, no query string / fragment) for the
  // patterns below that aren't explicitly anchored to a query parameter.
  // Query strings routinely carry tracking/session/campaign UUIDs and
  // arbitrary long numeric ids (utm/session/ref tokens) that are NOT the
  // job's identity — matching against the full URL risks extracting one of
  // those instead, which would make the same posting resolve to a different
  // "job id" on every visit and silently defeat dedup. Only the Greenhouse
  // gh_jid check below intentionally reads the query string, since that's
  // where Greenhouse actually puts it.
  const pathOnly = u.split(/[?#]/)[0];
  let m;
  // Greenhouse: ?gh_jid=1194374 or /jobs/1194374 on a greenhouse host
  if ((m = u.match(/[?&]gh_jid=(\d{4,})/i))) return `gh:${m[1]}`;
  if ((m = pathOnly.match(/greenhouse\.io\/[^/]*?\/jobs\/(\d{4,})/i))) return `gh:${m[1]}`;
  // Lever / Ashby: canonical UUID, as a full path segment (bounded by `/` on
  // both sides) so an incidental UUID-shaped tracking param in the query
  // string can never match here.
  if ((m = pathOnly.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i))) return `uuid:${m[1].toLowerCase()}`;
  // The SHARED Workday requisition pattern, first of the Workday rules.
  //
  // This file used to spell its own, and the spelling it had omitted Autodesk's
  // year-prefixed form entirely: _26WD161146 and _26WD91231-1 both returned
  // null, because the rule below requires a LETTER immediately after the
  // underscore and 26WD starts with digits. A null id is not a conflict, so
  // jobIdsConflict() reported nothing, merge-tracker and dedup-tracker lost the
  // job-id guard for every Autodesk row, and the fuzzy title fallback they fall
  // back to can merge two distinct requisitions or duplicate one.
  //
  // Composed, not redefined: the two rules below stay because they cover forms
  // the shared pattern deliberately does not (Zillow's _P711740-2 and
  // REQ-0850786), and they run after it so the vetted pattern wins wherever both
  // could match. Both orders agree on every form they share: _JR-119345,
  // _R427109 and _R23555-1 canonicalise identically either way.
  if ((m = pathOnly.match(REQ_ID))) return `wd:${canonId(m[1]).toLowerCase()}`;
  // Workday requisition id after the last path underscore: _P711740-2, _R427109.
  // Strip a trailing "-<n>" facet suffix Workday appends to some slugs.
  // The separator after the letter prefix is optional: NVIDIA writes _JR2357552,
  // Sony writes _JR-119345. Requiring digits immediately after the prefix returned
  // NO id at all for the Sony form, which is worse than a wrong id: with both sides
  // null there is no conflict to detect, so dedup fell through to fuzzy title
  // matching and proposed merging JR-119345 (Staff) into JR-105215 (Senior), two
  // genuinely different reqs that differ only by level.
  if ((m = pathOnly.match(/_([A-Za-z]{1,3}[-_]?\d{3,}[A-Za-z0-9-]*?)(?:\/|$)/))) return `wd:${normaliseReqId(m[1])}`;
  // REQ-0850786 anywhere in the path. The JR alternative that used to sit beside
  // it here is gone: it was a second, looser copy of the shared pattern above
  // (four digits after JR, where four digits is also the DATE in a report
  // filename slug), and a copy that merely agrees on today's examples is exactly
  // the drift this round exists to remove.
  if ((m = pathOnly.match(/\b(req-?\d{4,})\b/i))) return `wd:${m[1].toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  // Riot / Netflix / generic ATS: /j/1194374, /job/1194374, /jobs/1194374
  if ((m = pathOnly.match(/\/j(?:ob)?s?\/(\d{5,})/i))) return `id:${m[1]}`;
  // Fallback: a long standalone numeric id segment in the path
  if ((m = pathOnly.match(/\/(\d{7,})(?:\/|$)/))) return `id:${m[1]}`;
  return null;
}

/**
 * Report whether two job ids prove two rows are distinct postings.
 *
 * Two rows are provably distinct only when BOTH carry a resolvable job id and
 * those ids differ. A null id (URL missing or unparsed) is inconclusive, not a
 * conflict, so callers fall back to fuzzy title matching for legacy rows.
 *
 * @param {string|null} a - First job id from {@link extractJobId}.
 * @param {string|null} b - Second job id.
 * @returns {boolean} True only when both ids exist and differ.
 */
export function jobIdsConflict(a, b) {
  return a != null && b != null && a !== b;
}

/**
 * Resolve the authoritative job id for a tracker row/addition via its linked
 * report file's `**URL:**` header line.
 *
 * Shared by `merge-tracker.mjs` and `dedup-tracker.mjs` so the report-read +
 * URL-extraction + job-id logic lives in exactly one place — the two callers
 * previously carried independent, near-identical copies of this that risked
 * drifting apart.
 *
 * @param {string} reportField - Markdown report cell, e.g. `[123](../reports/…md)`.
 * @param {string} trackerDir - Directory the report link is relative to (the
 *   tracker file's own directory).
 * @param {Map<string, string|null>} cache - Caller-owned cache of resolved
 *   report path → posting URL, so repeated lookups for the same report during
 *   one run only read the file once. Callers keep their own Map instance.
 * @returns {string|null} Namespaced job id, or null when it cannot be resolved.
 */
export function jobIdFromReportField(reportField, trackerDir, cache) {
  const m = String(reportField ?? '').match(/\]\(([^)]+)\)/);
  if (!m) return null;
  const p = resolve(trackerDir, m[1]);
  if (!cache.has(p)) {
    let url = null;
    try {
      const txt = readFileSync(p, 'utf-8');
      const um = txt.match(/^\s*\*\*URL:\*\*\s*(\S+)/im) || txt.match(/\bURL:\s*(\S+)/i);
      url = um ? um[1].trim() : null;
    } catch {
      url = null;
    }
    cache.set(p, url);
  }
  return extractJobId(cache.get(p));
}
