// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Eightfold (PCS) provider: lists every posting on an Eightfold careers board.
//
// Two list APIs exist and a tenant answers exactly one of them (probed 2026-10-29):
//   v2    GET https://<host>/api/apply/v2/jobs?domain=<domain>&start=N&num=10
//         { positions: [...], count, facets: { Teams: [[name, n]], ... } }   Netflix
//   pcsx  GET https://<host>/api/pcsx/search?domain=<domain>&query=&location=&start=N
//         { status: 200, error: {message}, data: { positions: [...], count } } Microsoft
// Microsoft answers v2 with HTTP 403 "Not authorized for PCSX", and Netflix answers pcsx
// with 403, so the variant is recorded per host where known and otherwise found by trying
// v2 first. Both serve 10 postings a page whatever `num` asks for (num=100 still returned
// 10), so the page size is read from the first page, never assumed.
//
// The tenant `domain` parameter is NOT derivable from the hostname: Netflix is host
// explore.jobs.netflix.NET and domain netflix.COM, mercadolibre.eightfold.ai publishes
// mercadolibre.com, anywhere.eightfold.ai publishes volkscience.com. A wrong domain does
// not fail loudly; it reads another tenant's board, or none. So the domain is DECLARED,
// either as `?domain=` on the entry's careers_url or in HOSTS below (a host somebody
// verified), and an entry offering neither is refused rather than guessed at. Same rule
// as EIGHTFOLD_DOMAINS in scripts/req-resolve.py; add a host here only once its list API
// has been seen to answer.

import { fetchJsonBackoff, RETRY_DELAYS_MS } from './workday.mjs';

/** host -> { domain, api }, every pair verified against the live list API. */
export const HOSTS = {
  'explore.jobs.netflix.net': { domain: 'netflix.com', api: 'v2' },      // 2026-10-29, 404 postings
  'apply.careers.microsoft.com': { domain: 'microsoft.com', api: 'pcsx', session: true }, // 2026-10-29
};

/**
 * One visitor-session cookie for a host that throttles cookie-less clients as a crowd.
 * Measured on Microsoft, 2026-10-29, both runs at 1000ms pacing: without a cookie, 429s
 * came in runs (seven in a row; a provider walk died on five consecutive, 36s of backoff),
 * while the same walk carrying the `_vs` session cookie the API sets never drew two in a
 * row and read the whole 363-posting slice. ctx.fetchJson exposes no response headers, so
 * the cookie is taken by one direct request here and then sent on every ctx request. A
 * failure to get one is not an error: the walk proceeds without it, as it would have.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function primeSession(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.3)', accept: 'application/json' } });
      await res.arrayBuffer().catch(() => null);
      const jar = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter(Boolean).join('; ');
      if (jar) return jar;
    } catch { /* fall through to the next attempt */ }
    await sleep(1500);
  }
  return '';
}

// Microsoft's whole board is about 2400 postings at 10 a page, so ~240 pages. 400 clears
// it with room; a walk that still hits the bound says TRUNCATED rather than passing for a
// board.
const MAX_PAGES = 400;
// Eightfold throttles per client, hard: Microsoft answered HTTP 429 ("Please try again
// later", no Retry-After) to 115 of 358 requests in a walk paced at 500ms, and still to 12
// of 45 at 1000ms, each of which a retry 1.5s later answered (2026-10-29). Netflix did not
// throttle at all. Pacing and the shared backoff keep a walk inside the budget below.
const PAGE_PAUSE_MS = 1000;
const BOARD_RETRY_BUDGET_MS = 180000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `filter_*` parameters on the careers_url, passed to the list API unchanged. They are the
 * entry's DECLARATION of which slice of the board it polls, e.g. Microsoft's
 * `filter_work_site=0 days / week in-office – remote` (363 of ~2400 postings, 2026-10-29).
 * @param {URL} u
 */
function declaredFilters(u) {
  return [...u.searchParams.entries()].filter(([k]) => /^filter_\w+$/.test(k));
}

/**
 * True when some declared filter admits ONLY remote postings: every value it carries says
 * remote. Microsoft's list payload calls every posting `onsite` whatever its work site, so
 * without this a fully remote role reads as an onsite one in its listed metro.
 * @param {Array<[string, string]>} filters
 */
export function filtersDeclareRemote(filters) {
  const byKey = new Map();
  for (const [k, v] of filters) byKey.set(k, [...(byKey.get(k) || []), v]);
  return [...byKey.values()].some((vals) => vals.every((v) => /\bremote\b/i.test(v)));
}

/**
 * The board an entry names: { origin, domain, api, filters, remoteOnly } or null. `api` is
 * null when the host is not recorded and the variant must be found by asking.
 * @param {{careers_url?: string}} entry
 */
export function resolveBoard(entry) {
  let u;
  try { u = new URL(String(entry?.careers_url || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const known = HOSTS[host];
  const declared = (u.searchParams.get('domain') || '').trim().toLowerCase();
  if (declared && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(declared)) return null;
  // An undeclared host is claimed only on Eightfold's own PCS path, so a random careers
  // page that happens to carry a `domain` parameter is not read as an Eightfold board.
  if (!known && !(declared && /^\/careers(\/|$)/.test(u.pathname))) return null;
  const domain = declared || known.domain;
  const filters = declaredFilters(u);
  const verified = !!known && known.domain === domain;
  return {
    origin: `https://${host}`, domain,
    api: verified ? known.api : null,
    session: verified && !!known.session,
    filters, remoteOnly: filtersDeclareRemote(filters),
  };
}

/** The list URL for one page. */
export function pageUrl(board, api, start) {
  const d = encodeURIComponent(board.domain);
  const f = (board.filters || []).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
  return api === 'pcsx'
    ? `${board.origin}/api/pcsx/search?domain=${d}&query=&location=&start=${start}${f}`
    : `${board.origin}/api/apply/v2/jobs?domain=${d}&start=${start}&num=10${f}`;
}

/**
 * One list page as { positions, count, facetMin }, or throws. A 200 whose body carries no
 * positions array is a WAF page or an error object, not an empty board, and reading it as
 * empty would report every posting on the board closed.
 * @param {any} body
 * @param {'v2'|'pcsx'} api
 */
export function parsePage(body, api) {
  const root = api === 'pcsx' ? body?.data : body;
  if (api === 'pcsx' && body && (body.status !== 200 || (body.error && body.error.message))) {
    throw new Error(`eightfold: pcsx answered status ${body.status} ${JSON.stringify(body.error?.message || '')}`);
  }
  if (!root || !Array.isArray(root.positions)) {
    throw new Error(`eightfold: ${api} page is unreadable (no positions array)`);
  }
  const count = Number.isFinite(root.count) ? root.count : null;
  return { positions: root.positions, count, facetMin: facetMin(root.facets) };
}

/** The smallest per-facet sum of a v2 page's facets, or 0. `locations` is skipped: it is
 *  multi-valued and carries a 999999 sentinel for "Remote". Used only to spot a count
 *  that is a search cap (a facet summing past it), never to lower anything. */
export function facetMin(facets) {
  const sums = [];
  for (const [name, vals] of Object.entries(facets || {})) {
    if (name === 'locations' || !Array.isArray(vals) || !vals.length) continue;
    sums.push(vals.reduce((s, v) => s + (Array.isArray(v) ? Number(v[1]) || 0 : 0), 0));
  }
  return sums.length ? Math.min(...sums) : 0;
}

/**
 * Every location a posting names, with any remote signal folded in. Every secondary
 * location is kept, since the gate passes a posting on any one workable option. A remote
 * signal never becomes a bare "Remote" option, which passes the gate on its own and would
 * read a London remote role as remote-US.
 *
 * Two signals, read differently:
 *  - the posting's own flag (`work_location_option: remote_local`, Netflix) is QUALIFIED
 *    by each place, "Los Gatos,... (Remote)", because "local" scopes it to that place and
 *    the gate then asks a person rather than passing it;
 *  - a declared remote-only filter (`remoteOnly`, Microsoft's "0 days / week in-office –
 *    remote") is the employer stating the role is fully remote, so a place in the United
 *    States adds "Remote, United States". Qualifying by place instead turned a remote role
 *    listed under Redmond into a Washington-only one and REJECTED it (gate run 2026-10-29).
 *    A place outside the US is still qualified by itself, and stays foreign.
 * A place that already says remote is left alone.
 * @param {any} p
 * @param {{remoteOnly?: boolean}} [opts]
 * @returns {string[]}
 */
export function postingLocations(p, { remoteOnly = false } = {}) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const places = [...new Set([str(p.location), ...(Array.isArray(p.locations) ? p.locations.map(str) : [])].filter(Boolean))];
  const flag = str(p.work_location_option ?? p.workLocationOption).toLowerCase();
  if (remoteOnly) {
    const out = [...places];
    for (const l of places) {
      if (/\bremote\b/i.test(l)) continue;
      out.push(/\bUnited States\b|\bUSA\b/i.test(l) ? 'Remote, United States' : `${l} (Remote)`);
    }
    return [...new Set(out)];
  }
  if (!flag.startsWith('remote')) return places;
  return places.map((l) => (/\bremote\b/i.test(l) ? l : `${l} (Remote)`));
}

/**
 * A posting as a scan Job, or null when it carries no id or title.
 * @param {any} p
 * @param {{origin: string, remoteOnly?: boolean}} board
 * @param {string} company
 */
export function toJob(p, board, company) {
  const title = String(p?.name || p?.posting_name || '').trim();
  const id = p?.id;
  if (!title || id === undefined || id === null || !/^\d+$/.test(String(id))) return null;
  // Netflix gives an absolute canonicalPositionUrl, Microsoft a relative positionUrl; both
  // are /careers/job/<id> on the board host, which is also what req-resolve.py reads.
  const url = `${board.origin}/careers/job/${id}`;
  const locations = postingLocations(p, { remoteOnly: !!board.remoteOnly });
  const ts = Number(p.t_create ?? p.postedTs ?? p.creationTs);
  return {
    title,
    url,
    company,
    location: locations.join(' | '),
    locations,
    ...(Number.isFinite(ts) && ts > 0 ? { postedAt: ts * 1000 } : {}),
  };
}

/** @type {Provider} */
export default {
  id: 'eightfold',

  detect(entry) {
    const b = resolveBoard(entry);
    return b ? { url: pageUrl(b, b.api || 'v2', 0) } : null;
  },

  async fetch(entry, ctx) {
    const board = resolveBoard(entry);
    if (!board) {
      throw new Error(`eightfold: ${entry.name} names no declared tenant domain (add ?domain= to careers_url, or a verified host to HOSTS)`);
    }
    const budget = { ms: BOARD_RETRY_BUDGET_MS };
    const cookie = board.session ? await primeSession(pageUrl(board, board.api || 'v2', 0)) : '';
    if (board.session) await sleep(PAGE_PAUSE_MS);
    const get = (api, start) => fetchJsonBackoff(ctx, pageUrl(board, api, start), {
      headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
    }, RETRY_DELAYS_MS, budget);

    // First page, finding the API variant when the host is not recorded. Only a 403 or 404
    // moves on to the other variant; anything else is a real failure and propagates.
    let api = board.api, first;
    for (const tryApi of api ? [api] : ['v2', 'pcsx']) {
      try {
        first = parsePage(await get(tryApi, 0), /** @type {any} */ (tryApi));
        api = tryApi;
        break;
      } catch (err) {
        if (board.api || tryApi === 'pcsx' || (err?.status !== 403 && err?.status !== 404)) throw err;
      }
    }
    if (!first || !api) throw new Error(`eightfold: ${entry.name} answered neither list API`);

    // `count` is latched from the FIRST page (the Workday lesson: a later page's total is
    // not to be trusted). The walk itself runs until a short or empty page.
    const firstCount = first.count;
    const pageSize = first.positions.length;
    const byId = new Map();
    let lastCount = first.count, truncated = null;
    const walk = async (page) => {
      for (let start = 0, pages = 1; ; pages++) {
        for (const p of page.positions) {
          const job = toJob(p, board, entry.name);
          if (job && !byId.has(job.url)) byId.set(job.url, job);
        }
        if (page.positions.length === 0 || page.positions.length < pageSize) return;
        if (pages >= MAX_PAGES) {
          truncated = `TRUNCATED at ${MAX_PAGES} pages${firstCount !== null ? ` of ${Math.ceil(firstCount / pageSize)}` : ''}; raise MAX_PAGES`;
          return;
        }
        start += page.positions.length;
        await sleep(PAGE_PAUSE_MS);
        page = parsePage(await get(api, start), /** @type {any} */ (api));
        if (page.count !== null && page.count > 0) lastCount = page.count;
      }
    };
    // Offset paging over a live board: a posting removed mid-walk shifts every later one up
    // a slot and one is skipped without trace (Netflix read 402 of 403 once, then 403 of 403,
    // 2026-10-29; Microsoft's whole board 2383 of 2413). The board's own count is the only
    // witness, so a shortfall against it, and against the count the walk ended on, earns ONE
    // second walk unioned with the first, and is reported if it survives that.
    const short = () => firstCount !== null && byId.size < firstCount
      && !(lastCount !== null && lastCount > 0 && byId.size >= lastCount);
    await walk(first);
    if (!truncated && short()) {
      await sleep(PAGE_PAUSE_MS);
      const again = parsePage(await get(api, 0), /** @type {any} */ (api));
      if (again.count !== null && again.count > 0) lastCount = again.count;
      await walk(again);
    }

    const jobs = [...byId.values()];
    if (!truncated && short()) {
      truncated = `TRUNCATED: read ${jobs.length} of ${firstCount} postings in two walks`;
    }
    if (!truncated && firstCount !== null && first.facetMin > firstCount) {
      truncated = `TRUNCATED: count ${firstCount} is below the facet total ${first.facetMin}, so the search is capped`;
    }
    if (truncated) {
      /** @type {any} */ (jobs).truncated = truncated;
      console.error(`eightfold: ${entry.name} ${truncated}`);
    }
    return jobs;
  },
};
