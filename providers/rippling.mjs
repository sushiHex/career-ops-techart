// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Rippling ATS provider. A board is public JSON at
// api.rippling.com/platform/api/ats/v1/board/{slug}/jobs, a flat array with ONE ROW PER
// (posting, location): Rippling's own board lists "Staff Software Engineer - Fintech AI"
// three times, once each for San Francisco, New York and Seattle, under one uuid.
//
// Written because portals.yml routed Layer AI (ats.rippling.com/layer) to websearch while
// this endpoint answers for it. An unknown board answers 404 RESOURCE_NOT_FOUND, and a real
// board with no openings answers 200 with [], so the two are NOT the same thing: a 404 must
// throw rather than read as a board that holds nothing. Rows sharing a uuid are folded into
// one posting whose location is every location seen, since reading only the first would
// discard a remote or Los Angeles entry the same way every other adapter here once did.

const ALLOWED_HOST = 'api.rippling.com';

/** @param {import('./_types.js').PortalEntry} entry */
function resolveSlug(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/^https:\/\/ats\.rippling\.com\/([a-z0-9][a-z0-9._-]*)/i);
  return m ? m[1] : null;
}

/**
 * Normalise a Rippling board array into scan rows, folding per-location duplicates.
 * Exported for offline testing.
 * @param {any} json
 * @param {string} companyName
 */
export function parseRipplingJobs(json, companyName) {
  const rows = Array.isArray(json) ? json : [];
  /** @type {Map<string, {title: string, url: string, locs: string[]}>} */
  const byId = new Map();
  for (const j of rows) {
    if (!j || !j.name || !j.url) continue;
    const key = String(j.uuid || j.url);
    const wl = j.workLocation;
    const loc = typeof wl === 'string' ? wl : (wl && (wl.label || wl.id)) || '';
    let rec = byId.get(key);
    if (!rec) {
      rec = { title: String(j.name).trim(), url: String(j.url), locs: [] };
      byId.set(key, rec);
    }
    if (loc && !rec.locs.includes(String(loc).trim())) rec.locs.push(String(loc).trim());
  }
  return [...byId.values()].map((r) => ({
    title: r.title,
    url: r.url,
    company: companyName,
    location: r.locs.join(' | '),
  }));
}

/** @type {Provider} */
export default {
  id: 'rippling',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://${ALLOWED_HOST}/platform/api/ats/v1/board/${slug}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`rippling: cannot derive slug for ${entry.name}`);
    const apiUrl = `https://${ALLOWED_HOST}/platform/api/ats/v1/board/${slug}/jobs`;
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    // A missing board is an error object, never an array. Do not read it as an empty board.
    if (!Array.isArray(json)) throw new Error(`rippling: ${slug} did not return a job array`);
    return parseRipplingJobs(json, entry.name);
  },
};
