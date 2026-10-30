// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public CXS jobs endpoint (POST, paginated).
// Auto-detects from careers_url pattern
// `https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>`,
// e.g. https://23andme.wd5.myworkdayjobs.com/23 →
//      POST https://23andme.wd5.myworkdayjobs.com/wday/cxs/23andme/23/jobs
//
// Workday only exposes a relative "postedOn" label ("Posted Today",
// "Posted 5 Days Ago", "Posted 30+ Days Ago"); postedAt is derived from it
// and omitted for the unbounded "30+ Days Ago" form.

import { PLACEHOLDER_RE } from '../location-core.mjs';

const PAGE_SIZE = 20;
// Safety cap on the walk. NVIDIA's board is about 2000 postings (measured 2026-09-20),
// so the old 50-page cap returned half of it as if it were the whole board, silently.
// 150 clears the largest tenant known; a walk that still hits it says TRUNCATED.
const MAX_PAGES = 150;
// Detail lookups add roughly one request per multi-location posting, which on a
// large tenant is a ~40% increase in traffic — enough to earn a 429 from
// Autodesk at concurrency 4. Two at a time with a short pause and one backoff
// retry keeps the enrichment well inside what these hosts tolerate.
const DETAIL_CONCURRENCY = 2;
const DETAIL_PAUSE_MS = 120;
// A pause between LIST pages too: the facet-partitioned NVIDIA walk is ~240 requests back
// to back, and one 429 anywhere in it used to fail the whole board for the run (2026-10-20).
const LIST_PAUSE_MS = 100;
// Escalating waits, so a throttle that outlasts one short pause does not end the walk.
// A Retry-After the host sends replaces our guess, capped so a hostile value cannot stall
// the scan.
export const RETRY_DELAYS_MS = [1500, 4000, 10000, 20000];
const RETRY_AFTER_CAP_MS = 30000;
// The waits above bound ONE request; a board walk is hundreds of them, so a host that keeps
// throttling could hold the scan for hours. One budget per board caps the total sleep, and a
// throttle past it fails the board the way it always did (Codex review, 2026-10-20).
const BOARD_RETRY_BUDGET_MS = 120000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One fetch with backoff retries on throttling or transient unavailability. The list
 * endpoint earns the same 429 the detail endpoint does (Snap's tenant, 2026-10-15, on the
 * first page of the walk; NVIDIA mid-walk, 2026-10-20), and a throttled page fails the
 * whole board for the run.
 */
export async function fetchJsonBackoff(ctx, url, opts, delays = RETRY_DELAYS_MS, budget = { ms: Infinity }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.fetchJson(url, opts);
    } catch (err) {
      // Any other status is a real miss and propagates to the caller.
      if ((err?.status !== 429 && err?.status !== 503) || attempt >= delays.length) throw err;
      const wait = Math.min(err.retryAfterMs ?? delays[attempt], RETRY_AFTER_CAP_MS);
      if (wait > budget.ms) throw err;
      budget.ms -= wait;
      await sleep(wait);
    }
  }
}

function resolveEndpoint(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  if (!m) return null;
  const [, host, instance, site] = m;
  const origin = `https://${host}.${instance}.myworkdayjobs.com`;
  // A hostname cannot carry an underscore, so Workday writes a tenant's underscores as
  // hyphens in the host; the CXS path wants the real name (A10: host osv-a10networks,
  // tenant osv_a10networks; the hyphenated path answers 422). Same rule as cxs_base() in
  // scripts/req-resolve.py.
  const tenant = host.replace(/-/g, '_');
  return {
    api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    // externalPath is relative to the site, not the host root — without the
    // site segment the URL 404s.
    jobBase: `${origin}/${site}`,
    // Same CXS prefix as the list endpoint; appending externalPath returns the
    // single-posting record carrying the full structured location set.
    detailBase: `${origin}/wday/cxs/${tenant}/${site}`,
  };
}

/**
 * Resolve "N Locations" placeholders into a real option list.
 *
 * Workday's list API reports any multi-site posting as `locationsText: "5
 * Locations"` — a string with no geography in it. Filtering on that string is
 * not possible, and guessing from the URL slug does not work either: the slug
 * carries only the PRIMARY location, and the same primary can front either a
 * workable posting or an unworkable one (NVIDIA JR2391853 is Santa Clara plus
 * US-CA-Remote; JR2134145 is Santa Clara plus four other onsite metros).
 * The sibling locations are the deciding evidence, so fetch them.
 *
 * Failures are left alone deliberately: the posting keeps its placeholder and
 * the policy reports `unknown`, which routes it to human review rather than
 * inventing an answer.
 *
 * @param {Array<object>} jobs - Jobs carrying a private `_externalPath`.
 * @param {{detailBase: string}} ep
 * @param {{fetchJson: Function}} ctx
 */
async function resolveMultiLocationPostings(jobs, ep, ctx) {
  const pending = jobs.filter(j => PLACEHOLDER_RE.test(j.location || ''));
  if (pending.length === 0) return;

  let cursor = 0;
  const workerCount = Math.min(DETAIL_CONCURRENCY, pending.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < pending.length) {
      const job = pending[cursor++];
      try {
        const detail = await fetchJsonBackoff(ctx, ep.detailBase + job._externalPath, {
          headers: { accept: 'application/json' },
        }, RETRY_DELAYS_MS, ep.retryBudget);
        const info = detail?.jobPostingInfo || {};
        const options = [
          info.location,
          ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : []),
          // Some postings leave additionalLocations null and carry the useful
          // descriptor here instead.
          detail?.jobRequisitionLocation?.descriptor,
        ].map(s => String(s || '').trim()).filter(Boolean);
        if (options.length > 0) job.locations = [...new Set(options)];
      } catch {
        // Intentionally silent: an unresolved posting is `unknown`, not a drop.
      }
      if (cursor < pending.length) await sleep(DETAIL_PAUSE_MS);
    }
  }));
}

function parsePostedOn(label) {
  if (!label) return undefined;
  if (/posted\s+today/i.test(label)) return Date.now();
  if (/posted\s+yesterday/i.test(label)) return Date.now() - 86_400_000;
  const m = label.match(/posted\s+(\d+)(\+?)\s*day/i);
  if (!m || m[2] === '+') return undefined; // "30+ Days Ago" — unbounded, no usable date
  return Date.now() - Number(m[1]) * 86_400_000;
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const ep = resolveEndpoint(entry);
    return ep ? { url: ep.api } : null;
  },

  async fetch(entry, ctx) {
    const ep = resolveEndpoint(entry);
    if (!ep) throw new Error(`workday: cannot derive CXS endpoint for ${entry.name}`);
    // resolveEndpoint builds a fresh object per call, so this budget is per board, per scan.
    ep.retryBudget = { ms: BOARD_RETRY_BUDGET_MS };

    // Workday's search CAPS what it hands over: NVIDIA answers total 2000 and serves 2000
    // postings while its facet counts sum to 2734 (2026-10-18), so one walk read 73% of the
    // board and ended cleanly, as if whole. When the facets say the board is bigger, it is
    // walked once per value of a facet that partitions it under the cap, and the pieces are
    // unioned. Same rule as scripts/workday-sweep.py enumerate_board().
    // A `workday_facets` entry reads one SLICE of a board too big to walk daily (CVS Health
    // serves 19,799 postings, 12,739 of them retail pharmacy), e.g. {"jobFamilyGroup":
    // ["<id>", ...]}. A facet is Workday's own partition, so the slice is exact where a
    // keyword search is fuzzy; the cap and partition rules below then apply inside it.
    const scope = sliceOf(entry);
    const first = await walk(ep, ctx, entry, scope);
    // A scoped facet is excluded from both the size estimate and the partition: Workday may
    // report its counts board-wide, and partitioning on it REPLACED the slice's value list,
    // walking values outside the slice (Codex, 2026-10-29).
    const scoped = new Set(Object.keys(scope));
    const shown = first.total ?? 0, real = facetTotal(first.firstPage, scoped);
    let jobs = first.jobs;
    if (real && shown < real && !first.jobs.truncated) {
      const part = partitionFacet(first.firstPage, shown, scoped);
      if (!part) {
        jobs.truncated = `TRUNCATED: Workday serves ${shown} of ${real} postings and no facet splits the board under that cap`;
      } else {
        const merged = new Map();
        let truncated = null, unlinked = 0;
        for (const id of part.ids) {
          const piece = await walk(ep, ctx, entry, { ...scope, [part.param]: [id] });
          unlinked += piece.unlinked;
          if (piece.jobs.truncated) truncated = piece.jobs.truncated;
          // A piece that reaches the cap is itself capped (same rule as workday-sweep.py).
          else if (piece.jobs.length + piece.unlinked >= shown) truncated = `TRUNCATED: the ${part.param} piece ${id} reached the ${shown}-result cap`;
          for (const j of piece.jobs) if (!merged.has(j._externalPath)) merged.set(j._externalPath, j);
        }
        jobs = [...merged.values()];
        // A served row with no externalPath was READ but cannot be listed. NVIDIA serves a
        // few such rows TRANSIENTLY (5 in three pieces, then 1 in a fourth, 2026-10-23), so
        // walk() re-reads a page that holds one, and what still lacks a path is counted
        // here rather than read as missing, which had printed TRUNCATED on every scan. It
        // is still printed, since those postings never reach the pipeline this run.
        if (truncated || jobs.length + unlinked < real) {
          jobs.truncated = truncated || `TRUNCATED: ${jobs.length + unlinked} of ${real} postings across ${part.ids.length} ${part.param} pieces`;
        }
        if (unlinked) console.error(`workday: ${entry.name} ${unlinked} posting(s) served with no link, not listed this scan`);
      }
      if (jobs.truncated) console.error(`workday: ${entry.name} ${jobs.truncated}`);
    }

    await resolveMultiLocationPostings(jobs, ep, ctx);
    for (const job of jobs) delete job._externalPath;
    return jobs;
  },
};

/** An entry's `workday_facets` as CXS appliedFacets ({param: [ids]}), or {} for the whole
 *  board. Anything else throws: a malformed slice silently widening to the whole board is
 *  the 19,799-posting walk the slice exists to avoid. */
export function sliceOf(entry) {
  const f = entry?.workday_facets;
  if (f == null) return {};
  const ok = typeof f === 'object' && !Array.isArray(f) && Object.keys(f).length
    && Object.values(f).every(v => Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x));
  if (!ok) throw new Error(`workday: ${entry.name} workday_facets must map a facet to a non-empty list of value ids`);
  return f;
}

/** The board's size from a first page's flat facets, or 0: the SMALLEST facet sum, since a
 *  facet listing a multi-location posting under each location overcounts (Autodesk's
 *  State_Region: 538 on a board of 308). Same rule as workday-sweep.py facet_total(). */
export function facetTotal(page, exclude = new Set()) {
  const sums = [];
  for (const f of page?.facets || []) {
    if (exclude.has(f.facetParameter)) continue;
    const vals = (f.values || []).filter((v) => v && typeof v === 'object' && 'count' in v);
    if (vals.length) sums.push(vals.reduce((s, v) => s + (Number(v.count) || 0), 0));
  }
  return sums.length ? Math.min(...sums) : 0;
}

/** A flat facet whose values each sit under `cap` and together cover the board, or null. */
export function partitionFacet(page, cap, exclude = new Set()) {
  const need = facetTotal(page, exclude);
  for (const f of page?.facets || []) {
    if (exclude.has(f.facetParameter)) continue;
    const vals = (f.values || []).filter((v) => v && typeof v === 'object' && 'count' in v);
    const counts = vals.map((v) => Number(v.count) || 0);
    if (vals.length && f.facetParameter && counts.reduce((a, b) => a + b, 0) === need
        && Math.max(...counts) < cap) {
      return { param: f.facetParameter, ids: vals.filter((v) => Number(v.count)).map((v) => v.id) };
    }
  }
  return null;
}

/** One CXS search walked page by page: { jobs, total, firstPage, unlinked }, where
 *  `unlinked` counts served rows that carry no externalPath. */
async function walk(ep, ctx, entry, facets) {
    const jobs = [];
    let unlinked = 0;
    let firstPage = null;
    // `total` is trustworthy on the FIRST page only (CrowdStrike answers 0 on every
    // later page), so it is latched once and used to end the walk.
    let total = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) await sleep(LIST_PAUSE_MS);
      const body = JSON.stringify({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        searchText: '',
        appliedFacets: facets,
      });
      const post = () => fetchJsonBackoff(ctx, ep.api, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      }, RETRY_DELAYS_MS, ep.retryBudget);
      let json = await post();
      // A row with no externalPath is transient on Workday's side; one re-read of the same
      // page usually returns it whole. Keep the re-read only if it has fewer such rows.
      const pathless = (j) => (Array.isArray(j?.jobPostings) ? j.jobPostings.filter(p => !p.externalPath).length : Infinity);
      if (pathless(json) > 0 && pathless(json) !== Infinity) {
        await sleep(LIST_PAUSE_MS);
        const again = await post();
        if (pathless(again) < pathless(json)) json = again;
      }
      // A 200 whose body carries no postings array is a WAF page or an error object,
      // not an empty board; reading it as empty closed every row on the board.
      if (!Array.isArray(json?.jobPostings)) {
        throw new Error(`workday: list page ${page} for ${entry.name} is unreadable (no jobPostings array)`);
      }
      const postings = json.jobPostings;
      if (page === 0) firstPage = json;
      if (page === 0 && Number.isFinite(json.total)) total = json.total;
      for (const j of postings) {
        if (!j.externalPath) { unlinked++; continue; }
        jobs.push({
          title: j.title || '',
          url: ep.jobBase + j.externalPath,
          company: entry.name,
          location: j.locationsText || '',
          postedAt: parsePostedOn(j.postedOn),
          _externalPath: j.externalPath,
        });
      }
      if (postings.length < PAGE_SIZE) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
      if (page === MAX_PAGES - 1) {
        // Carried ON the result as well as printed: the scans read `truncated` and list
        // the board under Errors, because a stderr line beside a normal-looking job array
        // let a partial board pass for a whole one (Codex, PR 14). The jobs read so far
        // are still returned; a partial board is worth more than none.
        jobs.truncated = `TRUNCATED at ${MAX_PAGES} pages`
          + `${total !== null ? ` of ${Math.ceil(total / PAGE_SIZE)}` : ''}; raise MAX_PAGES`;
        console.error(`workday: ${entry.name} ${jobs.truncated}`);
      }
    }
    return { jobs, total, firstPage, unlinked };
}
