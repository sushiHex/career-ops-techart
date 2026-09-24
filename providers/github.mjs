// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// GitHub (Microsoft) provider — www.github.careers exposes a plain JSON jobs API.
//
// GitHub sat in the websearch handoff bucket for months while this endpoint was public and
// free. req-resolve.py already had an adapter for single postings, but scan.mjs resolves
// providers from providers/*.mjs, so the scan could never poll it. That gap is the whole
// reason this file exists: an adapter in one tool is not coverage in the other.
//
// The payload nests differently from every other provider here: each element of `jobs` is
// a wrapper whose real fields live under `.data`, and location arrives as `full_location`
// plus a separate `location_type` that carries the remote signal.

const API = 'https://www.github.careers/api/jobs';
const ALLOWED_HOSTS = new Set(['www.github.careers', 'github.careers']);
const PAGE_LIMIT = 50;
const MAX_PAGES = 12;   // 600 postings; GitHub's board has never approached this

/** @param {string} url */
function assertGithubUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`github: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`github: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`github: untrusted hostname "${parsed.hostname}"`);
  return url;
}

// NaN-safe: `|| undefined` would also discard a legitimate epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Each `jobs[]` element wraps the real record under `.data` on this API. */
function unwrap(entry) {
  return entry && typeof entry === 'object' && entry.data ? entry.data : entry;
}

/**
 * Normalise one API page into scan rows. Exported so the behaviour that actually bites
 * (the `.data` wrapper, the location_type that lives outside full_location, and dedup by
 * req_id) is testable without network.
 *
 * @param {any} json  one decoded /api/jobs response
 * @param {string} companyName
 * @param {Set<string>} [seen]  dedup keys carried across pages
 */
export function parseGithubJobs(json, companyName, seen = new Set()) {
  const rows = Array.isArray(json?.jobs) ? json.jobs : [];
  const out = [];
  for (const raw of rows) {
    const j = unwrap(raw);
    if (!j?.title) continue;
    const key = String(j.req_id || j.slug || j.title);
    if (seen.has(key)) continue;
    seen.add(key);

    const bits = [j.full_location, j.location_name, j.country]
      .filter((x) => typeof x === 'string' && x.trim());
    // location_type carries "Remote"/"Hybrid" and is NOT part of full_location, so a
    // remote-eligible role looks purely like its country string without it. This is the
    // same secondary-location class that has bitten every other adapter here.
    if (typeof j.location_type === 'string' && j.location_type.trim()) {
      bits.push(j.location_type.trim());
    }

    out.push({
      title: j.title,
      url: j.apply_url || `https://www.github.careers/careers-home/jobs/${j.slug || j.req_id}`,
      company: companyName,
      location: [...new Set(bits)].join(' | '),
      postedAt: toEpochMs(j.posted_date || j.create_date),
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'github',

  detect(entry) {
    const url = entry.careers_url || '';
    return /(^|\/\/|\.)github\.careers(\/|$)/i.test(url) ? { url: API } : null;
  },

  async fetch(entry, ctx) {
    /** @type {any[]} */
    const out = [];
    // Carried across pages: the API has been observed returning an overlapping window
    // rather than clean pages, so req_id dedup has to span the whole walk.
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${API}?page=${page}&limit=${PAGE_LIMIT}`;
      assertGithubUrl(url);
      const json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error' }));
      const rows = Array.isArray(json?.jobs) ? json.jobs : [];
      if (rows.length === 0) break;
      out.push(...parseGithubJobs(json, entry.name, seen));
      // A short page is the end of the board. Note this tests the RAW row count, not the
      // parsed count: a full page of duplicates still means the board continues.
      if (rows.length < PAGE_LIMIT) break;
    }
    return out;
  },
};
