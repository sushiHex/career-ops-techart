// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Amazon careers provider: reads amazon.jobs' own public search endpoint,
// `/en/search.json`, the same one the site's results page calls. No browser, no API key.
//
// Measured 2026-11-04, and each of these cost a real req its place on the board:
//
// * `loc_query` and `city[]` are IGNORED. Every query that used them answered `hits: 10000`,
//   which is the engine's cap and means "unfiltered". The filter that works is
//   `normalized_location[]=<City, State, USA>`: Culver City answers 205 hits.
// * `hits` is the size of the whole result set and is trustworthy only below 10000. At 10000
//   the search is unfiltered or capped, so the walk reports itself TRUNCATED.
// * `result_limit` tops out at 100; 200 answers a null `jobs`.
// * A posting carries EVERY location it is open in, in `locations` (JSON strings with
//   `normalizedLocation` and `type`), while `normalized_location` and `city` name only the
//   primary. "Senior MLE, CreativeFlux" read as New York from the primary and was never seen,
//   though Culver City was a listed location. The `normalized_location[]` filter matches the
//   secondary locations too (46 of 100 Culver City rows were primary elsewhere).
// * The old route here was `scan_method: websearch`, which produced nothing for Amazon, and
//   `scripts/req-resolve.py` reports amazon.jobs as bot-blocked, which the search endpoint is not.
//
// Location is never decided here. Each location of a posting is its own gate option, with
// " - Remote" added when Amazon types it as remote or virtual, and scan.mjs's shared gate decides.
//
// Failure is never silence: a response with no `jobs` array is UNREADABLE, a walk that stops
// short of `hits` (or meets the 10000 cap) marks the result `truncated`, and if no search
// could be read the fetch throws.

const SEARCH_URL = 'https://www.amazon.jobs/en/search.json';
const BASE_URL = 'https://www.amazon.jobs';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const CAP = 10000;
const PAUSE_MS = 400;

export const DEFAULT_QUERIES = [''];
// No default places: where a candidate can commute is the entry's to say (portals.yml
// `amazon_locations`). An entry with none searches nothing, and says so.
export const DEFAULT_LOCATIONS = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Every location of a posting as a gate option. Exported for offline testing.
 * @param {any} j one record of `jobs`
 * @returns {string[]}
 */
export function locationOptions(j) {
  const out = [];
  for (const raw of Array.isArray(j.locations) ? j.locations : []) {
    let l;
    try { l = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    const name = clean(l && (l.normalizedLocation || l.location));
    if (!name) continue;
    out.push(name);
    if (/remote|virtual/i.test(String(l.type || ''))) out.push(`${name} - Remote`);
  }
  // A record with no parseable locations still has its primary.
  if (!out.length && j.normalized_location) out.push(clean(j.normalized_location));
  return [...new Set(out)];
}

/**
 * A scan row from one search record. Exported for offline testing.
 * @param {any} j
 * @param {string} companyName
 */
export function toJob(j, companyName) {
  const locations = locationOptions(j);
  const description = clean([j.description, j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join(' '));
  return {
    title: clean(j.title),
    url: j.job_path ? `${BASE_URL}${j.job_path}` : '',
    company: companyName,
    location: locations.join(' | '),
    locations,
    description: description || undefined,
  };
}

/** The searches an entry asks for: every query against every location. */
export function searchesFor(entry) {
  const list = (v, dflt) => (Array.isArray(v) ? v.map((x) => String(x ?? '')) : dflt);
  const queries = list(entry.amazon_queries, DEFAULT_QUERIES);
  const locations = list(entry.amazon_locations, DEFAULT_LOCATIONS).filter((s) => s.trim());
  const out = [];
  for (const q of queries) for (const l of locations) out.push({ q, location: l });
  return out;
}

export function searchUrl({ q, location }, offset) {
  const p = new URLSearchParams();
  p.append('base_query', q);
  p.append('normalized_location[]', location);
  p.append('result_limit', String(PAGE_SIZE));
  p.append('offset', String(offset));
  return `${SEARCH_URL}?${p.toString()}`;
}

const label = (s) => `"${s.q}" @ ${s.location}`;

/**
 * Walk one search to its end. Returns its records and, when the walk stopped short of the
 * count the first page announced, why. Exported for offline testing.
 */
export async function walkSearch(ctx, search, { maxPages = MAX_PAGES, pauseMs = PAUSE_MS } = {}) {
  const records = [];
  const ids = new Set();
  let hits = null;
  let truncated = null;
  let rateLimited = false;
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      truncated = `TRUNCATED at ${maxPages} pages: ${records.length} of ${hits}`;
      break;
    }
    if (page > 0 && pauseMs) await sleep(pauseMs);
    let json;
    try {
      json = await ctx.fetchJson(searchUrl(search, page * PAGE_SIZE), { redirect: 'error' });
    } catch (err) {
      if (page === 0) throw err;
      rateLimited = /** @type {any} */ (err)?.status === 429;
      truncated = `page ${page + 1} failed (${/** @type {any} */ (err).message}): ${records.length} of ${hits}`;
      break;
    }
    if (!json || !Array.isArray(json.jobs) || !Number.isInteger(json.hits)) {
      if (page === 0) throw new Error('search response carries no jobs array (blocked, or the endpoint changed shape)');
      truncated = `page ${page + 1} unreadable: ${records.length} of ${hits}`;
      break;
    }
    // Latched from the FIRST page, as for every other board walker here.
    if (hits === null) {
      hits = json.hits;
      if (hits >= CAP) {
        truncated = `hits is ${hits}, the engine cap: the location filter did not apply, so this is not a filtered read`;
        break;
      }
    }
    let fresh = 0;
    for (const j of json.jobs) {
      const id = String(j.id_icims || j.id || j.job_path || '');
      if (!id || ids.has(id)) continue;
      ids.add(id);
      records.push(j);
      fresh++;
    }
    if (records.length >= hits) break;
    if (json.jobs.length === 0) {
      truncated = `served ${records.length} of ${hits}`;
      break;
    }
    if (fresh === 0) {
      truncated = `page ${page + 1} repeated earlier rows: ${records.length} of ${hits}`;
      break;
    }
  }
  return { records, hits, truncated, rateLimited };
}

/** @type {Provider} */
export default {
  id: 'amazon',

  detect(entry) {
    const url = entry.careers_url || '';
    return /^https?:\/\/(?:www\.)?amazon\.jobs\/?(?:en\/search)?(?:[?#]|$)/.test(url) ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const searches = searchesFor(entry);
    if (!searches.length) throw new Error('amazon: the entry names no `amazon_locations`, so there is nothing to search');
    const byId = new Map();
    const problems = [];
    let read = 0;
    let firstError = null;
    const pauseMs = Number.isFinite(entry.amazon_pause_ms) ? Number(entry.amazon_pause_ms) : PAUSE_MS;
    for (const [i, s] of searches.entries()) {
      if (i > 0 && pauseMs) await sleep(pauseMs);
      try {
        const { records, hits, truncated, rateLimited } = await walkSearch(ctx, s, { pauseMs });
        read++;
        for (const r of records) {
          const id = String(r.id_icims || r.id || r.job_path || '');
          if (id && !byId.has(id)) byId.set(id, r);
        }
        if (truncated) problems.push(`${label(s)} ${truncated}`);
        if (process.env.AMAZON_PROVIDER_DEBUG) console.error(`amazon: ${label(s)} ${records.length}/${hits}`);
        if (rateLimited) {
          problems.push(`stopped after a 429; ${searches.length - i - 1} search(es) not run`);
          break;
        }
      } catch (err) {
        firstError ||= err;
        problems.push(`${label(s)} UNREADABLE: ${/** @type {any} */ (err).message}`);
        if (/** @type {any} */ (err)?.status === 429) {
          problems.push(`stopped after a 429; ${searches.length - i - 1} search(es) not run`);
          break;
        }
      }
    }
    if (read === 0) throw firstError || new Error('amazon: no search could be read');
    const jobs = /** @type {any[] & {truncated?: string}} */ (
      [...byId.values()].map((r) => toJob(r, entry.name)).filter((j) => j.title && j.url));
    if (problems.length) {
      jobs.truncated = problems.join('; ');
      console.error(`amazon: ${entry.name} ${jobs.truncated}`);
    }
    return jobs;
  },
};
