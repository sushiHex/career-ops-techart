// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Google careers provider: reads the public results page, which is client-rendered but
// embeds the page's job list as JSON in an `AF_initDataCallback({key: 'ds:1', ...})` block,
// the same mechanism scripts/req-resolve.py `google_record()` reads one posting through
// (`ds:0` on a detail page). No browser, no API key.
//
// The list block is `[records | null, null, total, pageSize]`: `total` is the size of the
// whole result set for the query and `pageSize` is 20. A page past the end carries
// `records: null` with the same total. Each record is an array:
//   [0] job id   [1] title   [3] responsibilities   [4] qualifications   [7] company
//   ("Google", "DeepMind", "YouTube")   [9] locations, each
//   [display, [address], city, zip, region, countryCode]   [10] about the job
//   [16] 1 when the posting is remote-eligible   [18] a note naming which of the locations
//   are "In-office locations" and which are "Remote location(s)".
//
// Google has tens of thousands of postings worldwide, so the provider runs SEARCHES rather
// than walking the board: every query in `google_queries` against the OR of every place in
// `google_locations`, plus (when `google_remote` is not false) the same query restricted
// to US remote-eligible postings. Measured 2026-10-29: three locations in one metro held
// 127 postings (7 pages) and US remote 41 (3 pages), so the default empty query reads the
// whole reachable board in about ten requests, and a narrower query list only removes rows
// the scan's title filter would have judged anyway.
//
// Location is never decided here. Every location is folded in as its own option, with
// " - Remote" appended to the ones the posting names as remote, and scan.mjs's shared gate
// decides. Two spellings are repaired on the way, because the gate reads them wrongly:
// Google writes a Canadian province's remote option as "Ontario, CA", which the gate reads
// as Ontario, California, a SoCal city; a non-US option whose last piece is its own
// two-letter country code gets the country's name instead.
//
// Failure is never silence. A page that answers but carries no readable list block is
// UNREADABLE, not empty; a walk that stops short of `total` (page bound, unreadable page,
// a server that serves fewer rows than it counts) marks the result `truncated`, which
// scan.mjs prints as an incomplete board; and if no search could be read at all the fetch
// throws rather than reporting Google as having nothing.

const RESULTS_URL = 'https://www.google.com/about/careers/applications/jobs/results/';
const PAGE_SIZE = 20;
// 25 pages is 500 results per search, four times the largest reachable search measured.
// A search that still has rows past it says TRUNCATED rather than passing for complete.
const MAX_PAGES = 25;
// A results page is about 1.3MB, so the default 10s timeout is tight on a slow link.
const TIMEOUT_MS = 30_000;
const PAUSE_MS = 400;
const RETRY_DELAYS_MS = [2000, 6000];

export const DEFAULT_QUERIES = [''];
// No onsite places by default: where a candidate can commute is the entry's to say
// (portals.yml `google_locations`), so an entry without it searches US remote only.
export const DEFAULT_LOCATIONS = [];
// The remote pass is scoped to the US: unscoped, it returns Brazil, Canada and so on.
const REMOTE_SCOPE = 'United States';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every AF_initDataCallback data payload on the page, parsed; unparseable ones skipped. */
function dataBlocks(html) {
  const out = [];
  const re = /AF_initDataCallback\(\{key:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(html))) {
    const d = html.indexOf('data:', m.index);
    if (d < 0) continue;
    const start = d + 'data:'.length;
    const end = html.indexOf(', sideChannel', start);
    if (end < 0) continue;
    try {
      out.push({ key: m[1], data: JSON.parse(html.slice(start, end)) });
    } catch {
      // not this block
    }
  }
  return out;
}

/** Is `d` the results-list shape `[records|null, *, total, pageSize]`? */
function isResultsBlock(d) {
  if (!Array.isArray(d) || d.length < 4) return false;
  if (!Number.isInteger(d[2]) || !Number.isInteger(d[3])) return false;
  if (d[0] === null) return true;
  return Array.isArray(d[0]) && d[0].every((r) => Array.isArray(r) && /^\d{6,}$/.test(String(r[0])));
}

/**
 * The job list on one results page, or null when the page carries no readable list.
 * Found by SHAPE rather than by the `ds:1` key, since the key numbering is the page's
 * internal order and the detail page already uses `ds:0` for something else.
 * Exported for offline testing.
 * `slugs` maps a job id to the slug of the page's own link to it, so a row's URL is the one
 * Google writes rather than a reconstruction (its slugs join "AI/ML" as "aiml").
 * @param {string} html
 * @returns {{records: any[], total: number, pageSize: number, slugs: Map<string, string>} | null}
 */
export function parseResultsPage(html) {
  const text = String(html || '');
  const blocks = dataBlocks(text).filter((b) => isResultsBlock(b.data));
  if (blocks.length !== 1) return null; // none, or two candidates we cannot choose between
  const d = blocks[0].data;
  const slugs = new Map();
  for (const m of text.matchAll(/href="jobs\/results\/(\d{6,})-([a-z0-9-]+)[?"]/g)) {
    if (!slugs.has(m[1])) slugs.set(m[1], m[2]);
  }
  return { records: d[0] || [], total: d[2], pageSize: d[3], slugs };
}

const decode = (s) => String(s)
  .replace(/<[^>]+>/g, ' ')
  // &amp; last: decoding it first turned "&amp;lt;" into "<" (CodeQL, double unescaping).
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/** The place names a note lists after `label:` ("Remote location(s): A; B."). */
function noteList(note, label) {
  const m = new RegExp(`${label}\\s*:\\s*([^]*?)(?:\\.\\s*(?:<|$)|<br|$)`, 'i').exec(note);
  if (!m) return null;
  return decode(m[1]).replace(/\.$/, '').split(/\s*;\s*/).filter(Boolean);
}

let regionNames = null;
function countryName(code) {
  try {
    regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || null;
  } catch {
    return null;
  }
}

/** A location's display string, with a non-US trailing country CODE spelled out. */
function displayOf(loc) {
  const display = decode(loc[0] || '');
  const cc = typeof loc[5] === 'string' ? loc[5].toUpperCase() : '';
  if (!display || !cc || cc === 'US') return display;
  const parts = display.split(/\s*,\s*/);
  if (parts.length > 1 && parts[parts.length - 1].toUpperCase() === cc) {
    const name = countryName(cc);
    if (name) parts[parts.length - 1] = name;
  }
  return parts.join(', ');
}

/**
 * Every location of a record as a gate option, remote ones suffixed " - Remote".
 * Exported for offline testing.
 * @param {any[]} r
 * @returns {string[]}
 */
export function locationOptions(r) {
  const locs = Array.isArray(r[9]) ? r[9].filter((l) => Array.isArray(l) && l[0]) : [];
  const note = Array.isArray(r[18]) && typeof r[18][1] === 'string' ? r[18][1] : '';
  const remoteNames = noteList(note, 'Remote locations?(?:\\(s\\))?');
  const officeNames = noteList(note, 'In-office locations?(?:\\(s\\))?');
  const remoteFlag = r[16] === 1 || r[16] === true;
  const out = [];
  for (const loc of locs) {
    const raw = decode(loc[0]);
    const display = displayOf(loc);
    let remote;
    let office = true;
    if (remoteNames) {
      remote = remoteNames.includes(raw);
      office = !remote || (officeNames ? officeNames.includes(raw) : false);
    } else if (remoteFlag) {
      // Remote-eligible but the note did not say which: a place with no city part
      // ("Colorado, USA", "United States") is the remote scope, a "City, ST, USA" is an office.
      remote = raw.split(',').length < 3;
      office = !remote;
    } else {
      remote = false;
    }
    if (office) out.push(display);
    if (remote) out.push(`${display} - Remote`);
  }
  return [...new Set(out)];
}

// Fallback only, when the page carried no link for the id. Google's own slugs drop "/" and
// "-" inside a title ("AI/ML" is "aiml", "Mid-Market" is "midmarket"), matched here; the
// id alone is what every reader keys on (host-ids.json `google:`, req-resolve).
const slugify = (title) => String(title)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[/-]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * A scan row from one results record. Exported for offline testing.
 * @param {any[]} r
 * @param {string} companyName
 * @param {string} [slug] the page's own slug for this id
 */
export function toJob(r, companyName, slug) {
  const id = String(r[0]);
  const title = decode(r[1] || '');
  const locations = locationOptions(r);
  const part = (k) => (Array.isArray(r[k]) && typeof r[k][1] === 'string' ? r[k][1] : '');
  const description = decode([10, 3, 4].map(part).join(' '));
  const tail = slug || slugify(title);
  return {
    title,
    url: `${RESULTS_URL}${id}${tail ? `-${tail}` : ''}`,
    // DeepMind postings are tracked as "Google DeepMind", and the scan's requisition dedup
    // is keyed by company, so the sub-brand is kept where the tracker spells it.
    company: r[7] === 'DeepMind' ? 'Google DeepMind' : companyName,
    location: locations.join(' | '),
    locations,
    description: description || undefined,
  };
}

/** The searches an entry asks for. */
export function searchesFor(entry) {
  const list = (v, dflt) => (Array.isArray(v) ? v.map((x) => String(x ?? '')) : dflt);
  const queries = list(entry.google_queries, DEFAULT_QUERIES);
  const locations = list(entry.google_locations, DEFAULT_LOCATIONS).filter((s) => s.trim());
  const out = [];
  for (const q of queries) {
    if (locations.length) out.push({ q, locations, remote: false });
    if (entry.google_remote !== false) out.push({ q, locations: [REMOTE_SCOPE], remote: true });
  }
  return out;
}

export function searchUrl({ q, locations, remote }, page) {
  const p = new URLSearchParams();
  p.append('q', q);
  for (const l of locations) p.append('location', l);
  if (remote) p.append('has_remote', 'true');
  p.append('page', String(page));
  return `${RESULTS_URL}?${p.toString()}`;
}

const label = (s) => `"${s.q}"${s.remote ? ' remote-US' : ` @ ${s.locations.length} location(s)`}`;

async function fetchPage(ctx, url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.fetchText(url, { timeoutMs: TIMEOUT_MS, headers: { 'accept-language': 'en-US,en;q=0.9' } });
    } catch (err) {
      const st = /** @type {any} */ (err)?.status;
      if ((st !== 429 && st !== 503) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(Math.min(/** @type {any} */ (err).retryAfterMs ?? RETRY_DELAYS_MS[attempt], 30_000));
    }
  }
}

/**
 * Walk one search to its end. Returns its records and, when the walk stopped short of the
 * total the first page announced, why.
 */
export async function walkSearch(ctx, search, { maxPages = MAX_PAGES, pauseMs = PAUSE_MS } = {}) {
  const records = [];
  const ids = new Set();
  const slugs = new Map();
  let total = null;
  let truncated = null;
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      truncated = `TRUNCATED at ${maxPages} pages: ${records.length} of ${total}`;
      break;
    }
    if (page > 1 && pauseMs) await sleep(pauseMs);
    let parsed;
    try {
      parsed = parseResultsPage(await fetchPage(ctx, searchUrl(search, page)));
    } catch (err) {
      if (page === 1) throw err;
      truncated = `page ${page} failed (${/** @type {any} */ (err).message}): ${records.length} of ${total}`;
      break;
    }
    if (!parsed) {
      if (page === 1) throw new Error('results page carries no readable job list (consent page, or the page changed shape)');
      truncated = `page ${page} unreadable: ${records.length} of ${total}`;
      break;
    }
    // Latched from the FIRST page: a total re-read per page is the CrowdStrike trap.
    if (total === null) total = parsed.total;
    for (const [id, s] of parsed.slugs) if (!slugs.has(id)) slugs.set(id, s);
    let fresh = 0;
    for (const r of parsed.records) {
      const id = String(r[0]);
      if (ids.has(id)) continue;
      ids.add(id);
      records.push(r);
      fresh++;
    }
    if (records.length >= total) break;
    if (parsed.records.length === 0) {
      // The server ran out of rows before its own count did.
      truncated = `served ${records.length} of ${total}`;
      break;
    }
    if (fresh === 0) {
      // A page that repeats the last one means the page parameter is being ignored.
      truncated = `page ${page} repeated earlier rows: ${records.length} of ${total}`;
      break;
    }
  }
  return { records, total, truncated, slugs };
}

/** @type {Provider} */
export default {
  id: 'google',

  detect(entry) {
    const url = entry.careers_url || '';
    return /^https?:\/\/(?:www\.)?google\.com\/about\/careers\/applications\/jobs\/results\/?(?:[?#]|$)/.test(url)
      ? { url: RESULTS_URL }
      : null;
  },

  async fetch(entry, ctx) {
    const searches = searchesFor(entry);
    if (!searches.length) throw new Error('google: the entry asks for no searches');
    const byId = new Map();
    const slugs = new Map();
    const problems = [];
    let read = 0;
    let firstError = null;
    // `google_pause_ms` tunes the spacing between requests (tests pass 0).
    const pauseMs = Number.isFinite(entry.google_pause_ms) ? Number(entry.google_pause_ms) : PAUSE_MS;
    for (const [i, s] of searches.entries()) {
      if (i > 0 && pauseMs) await sleep(pauseMs);
      try {
        const { records, total, truncated, slugs: found } = await walkSearch(ctx, s, { pauseMs });
        read++;
        for (const r of records) if (!byId.has(String(r[0]))) byId.set(String(r[0]), r);
        for (const [id, sl] of found) if (!slugs.has(id)) slugs.set(id, sl);
        if (truncated) problems.push(`${label(s)} ${truncated}`);
        if (process.env.GOOGLE_PROVIDER_DEBUG) console.error(`google: ${label(s)} ${records.length}/${total}`);
      } catch (err) {
        firstError ||= err;
        problems.push(`${label(s)} UNREADABLE: ${/** @type {any} */ (err).message}`);
        // Throttled after retries: stop rather than spend the rest of the list on 429s.
        if (/** @type {any} */ (err)?.status === 429) {
          problems.push(`stopped after a 429; ${searches.length - i - 1} search(es) not run`);
          break;
        }
      }
    }
    if (read === 0) throw firstError || new Error('google: no search could be read');
    const jobs = /** @type {any[] & {truncated?: string}} */ (
      [...byId.entries()].map(([id, r]) => toJob(r, entry.name, slugs.get(id))).filter((j) => j.title));
    if (problems.length) {
      jobs.truncated = problems.join('; ');
      console.error(`google: ${entry.name} ${jobs.truncated}`);
    }
    return jobs;
  },
};
