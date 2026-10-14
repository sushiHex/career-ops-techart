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
import { REQ_ID, canonId, reqIdGlobal } from './req-id-core.mjs';

// Tokens that almost every role shares must not count as strong matching
// signal. This set covers seniority, work mode, contract shape, locations, and
// other words that frequently appear in titles without identifying the opening.
export const ROLE_STOPWORDS = new Set([
  // seniority / level
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'entry', 'level',
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
 * A company name as a comparable key: lowercase letters and digits only, so
 * "Riot Games" and "riot-games" are one employer.
 *
 * @param {string} name
 * @returns {string}
 */
export function companyKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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
  // Host-anchored forms FIRST: a rule that owns its host knows that host's id better
  // than any generic rule below, and running it last let the generic `/jobs/N` and
  // `/<7+ digits>` rules claim some spellings first, so one Google posting keyed as
  // `id:` without its title slug and `google:` with it.
  const hosted = hostedId(pathOnly);
  if (hosted) return hosted;
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
  // the id guard reported nothing, merge-tracker and dedup-tracker lost the
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
  // REQ-0850786 anywhere in the path. JR forms come only from the shared pattern
  // above: four digits after JR is also the DATE in a report filename slug.
  if ((m = pathOnly.match(/\b(req-?\d{4,})\b/i))) return `wd:${m[1].toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  // Riot / Netflix / generic ATS: /j/1194374, /job/1194374, /jobs/1194374
  if ((m = pathOnly.match(/\/j(?:ob)?s?\/(\d{5,})/i))) return `id:${m[1]}`;
  // Fallback: a long standalone numeric id segment in the path
  if ((m = pathOnly.match(/\/(\d{7,})(?:\/|$)/))) return `id:${m[1]}`;
  return workdayBareId(u);
}

/**
 * Company-hosted boards whose ids the generic rules cannot see, found on 2026-10-08
 * when dedup-tracker proposed deleting one team's Staff req as a duplicate of its Senior
 * req: github.careers writes a FOUR-digit id, the generic
 * `/jobs/N` rule wants five, both rows came back null, and the fuzzy title match
 * decided alone. 102 tracker rows had no identity that day, clustered exactly where one
 * employer posts many similar titles: Apple 13, GitHub 12, Google 6, EA 5.
 *
 * Each rule is anchored at its own HOST, the rule req-resolve.py applies to every
 * adapter, because an id here is not only a guard against merging: two rows with EQUAL
 * ids merge, so a loose rule that hands two postings one id does the very damage the
 * guard exists to prevent. That is also why the four-digit floor is allowed only where
 * the host fixes the position, never in the generic rule, where four digits is a year.
 *
 * github.careers and atlassian.com are front ends over iCIMS, and their page id IS the
 * iCIMS requisition id (GitHub's API `apply_url` and Atlassian's listing `portalUrl` both
 * point at <portal>.icims.com/jobs/<same id>). So all three spellings share one `icims:`
 * key, and the key drops the portal, because one employer serves several (GitHub has
 * careers-githubinc and globalcareers-githubinc). That is safe only because every
 * consumer compares ids within ONE company: merge-tracker and dedup-tracker filter by
 * company first, and eval-write keys its index on id plus company.
 */
const HOSTED_ID = [
  [/^(?:https?:\/\/)?jobs\.apple\.com\/[^?#]*?\/details\/(\d{6,})/i, 'apple'],
  [/^(?:https?:\/\/)?(?:(?:www\.)?google\.com\/about\/careers\/[^?#]*?|careers\.google\.com)\/jobs\/results\/(\d{6,})/i, 'google'],
  [/^(?:https?:\/\/)?(?:www\.)?github\.careers\/careers-home\/jobs\/(\d{3,})(?:[/?#]|$)/i, 'icims'],
  [/^(?:https?:\/\/)?[\w-]+\.icims\.com\/jobs\/(\d{3,})(?:[/?#]|$)/i, 'icims'],
  [/^(?:https?:\/\/)?(?:www\.)?atlassian\.com\/company\/careers\/details\/(\d{3,})(?:[/?#]|$)/i, 'icims'],
  [/^(?:https?:\/\/)?jobs\.ea\.com\/[^?#]*?\/JobDetail\/[^/?#]+\/(\d{4,})(?:[/?#]|$)/i, 'ea'],
  [/^(?:https?:\/\/)?[\w-]+\.breezy\.hr\/p\/([0-9a-f]{8,})/i, 'breezy'],
];

function hostedId(pathOnly) {
  for (const [re, ns] of HOSTED_ID) {
    const m = pathOnly.match(re);
    if (m) return `${ns}:${m[1].toLowerCase()}`;
  }
  return null;
}

/**
 * BARE numeric Workday ids, Disney's form: ..._10000101, or ..._10000101-1 with the facet
 * suffix. The shared pattern excludes bare numbers on purpose, since a bare number is
 * ambiguous anywhere else. On a myworkdayjobs host the POSITION is fixed by the posting
 * path, so the number after the slug's last underscore is the requisition, and it is
 * namespaced by tenant because Workday counters are tenant-local. It is a consumer-side
 * fallback, tried after the shared pattern, never a loosening of it. Without it both sides
 * of a comparison returned null, two nulls never conflict, and the fuzzy title fallback
 * decided alone: it merged two different requisitions of one tenant whose titles were
 * merely similar.
 *
 * Two properties, both from review. It runs LAST, so it can only turn a null into an id
 * and never re-keys a URL that already had one; a re-keyed URL would silently stop
 * matching its own tracker row. And the tenant is read from the PARSED host, never
 * searched for along the string, so a wrapper carrying a Workday address in its path is
 * not mistaken for the posting (the same anchoring rule req-resolve applies).
 */
function workdayBareId(u) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); } catch { return null; }
  const host = url.hostname.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i);
  const id = host && url.pathname.match(/\/job\/.*_(\d{5,})(?:-\d+)?\/?$/);
  return id ? `wd:${host[1].toLowerCase()}:${id[1]}` : null;
}

function reportUrlLine(reportField, trackerDir, cache) {
  const m = String(reportField ?? '').match(/\]\(([^)]+)\)/);
  if (!m) return null;
  const p = resolve(trackerDir, m[1]);
  if (!cache.has(p)) {
    // The WHOLE URL line is cached, not its first token. Older reports write the
    // requisition beside a bare careers host, "**URL:** https://<tenant>.wd5.
    // myworkdayjobs.com/<site> (<req id>)", and reading only
    // `(\S+)` threw the id away. With no id that row conflicted with nothing, so on
    // 2026-10-08 merge-tracker's fuzzy fallback folded a different requisition into it and
    // overwrote a different requisition's row. `[ \t]*` rather than `\s*`, so an
    // empty URL line can never borrow the line below it.
    let line = null;
    try {
      const txt = readFileSync(p, 'utf-8');
      const um = txt.match(/^[ \t]*\*\*URL:\*\*[ \t]*(.*)$/im) || txt.match(/\bURL:[ \t]*(.*)$/im);
      line = um ? um[1].trim() || null : null;
    } catch {
      line = null;
    }
    cache.set(p, line);
  }
  return cache.get(p);
}

/** Every shared requisition id in free text, in extractJobId's `wd:` namespace so an id
 *  read here compares equal to the same id read from a posting URL. */
function reqIdsIn(text) {
  return [...String(text ?? '').matchAll(reqIdGlobal())]
    .map(m => `wd:${canonId(m[1]).toLowerCase()}`);
}

/**
 * The identity of a tracker ROW: the SET of every requisition id its own records state.
 *
 * That is the id in the report's URL, any shared requisition id elsewhere on the URL
 * line, and any in the row's role cell, where eval-write and most hand-written rows
 * record it ("Senior Machine Learning Engineer (<req id>)"). A set rather than one id
 * with a fixed priority, because the sources are different numbering systems for one
 * posting: one row can carry an Eightfold id in its URL and a JR id in
 * its role cell, and a row that recorded only the JR must still be recognised as the
 * same posting. A single id chosen by priority made those two rows CONFLICT.
 *
 * @param {{report?: string, role?: string}} row - A tracker row or TSV addition.
 * @returns {Set<string>} possibly empty
 */
function rowJobIds(row, trackerDir, cache) {
  const ids = new Set();
  const line = reportUrlLine(row?.report, trackerDir, cache);
  if (line) {
    const fromUrl = extractJobId(line.split(/\s+/)[0]);
    if (fromUrl) ids.add(fromUrl);
    for (const id of reqIdsIn(line)) ids.add(id);
  }
  for (const id of reqIdsIn(row?.role)) ids.add(id);
  return ids;
}

/**
 * A reader of row identities for one tracker, shared by merge-tracker and dedup-tracker.
 *
 * It owns the report-line cache, so callers keep no cache of their own, and it memoises
 * each row's set by the TEXT that determines it (report link plus role cell), so the
 * pairwise loops do not rebuild a set per comparison and an edited row cannot return a
 * stale identity.
 *
 * @param {string} trackerDir - The directory report links are relative to.
 * @returns {(row: {report?: string, role?: string}) => Set<string>}
 */
export function rowIdReader(trackerDir) {
  const lines = new Map();
  const sets = new Map();
  return (row) => {
    const key = `${row?.report ?? ''}\u0000${row?.role ?? ''}`;
    if (!sets.has(key)) sets.set(key, rowJobIds(row, trackerDir, lines));
    return sets.get(key);
  };
}

/** Two rows are the same posting when their identity sets share an id. */
export function idSetsOverlap(a, b) {
  for (const id of a) if (b.has(id)) return true;
  return false;
}

/** Two rows are PROVABLY distinct only when both have ids and share none. An empty set
 *  is inconclusive, as a null id always was. */
export function idSetsConflict(a, b) {
  return a.size > 0 && b.size > 0 && !idSetsOverlap(a, b);
}
