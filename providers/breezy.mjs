// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Breezy HR provider — every board is a flat JSON array at {org}.breezy.hr/json.
//
// Written because AGBO (the Russo brothers' interactive studio) sat in the websearch
// handoff bucket while this endpoint served 21 live postings, several of them Los Angeles
// craft roles. find-ats.py could see the board; scan.mjs had no adapter, so the scan never
// polled it. An adapter in one tool is not coverage in the other.
//
// IMPORTANT: Breezy answers HTTP 200 with an empty array for ANY subdomain, including ones
// that do not exist. That is why find-ats.py deliberately excludes Breezy from the set of
// providers whose empty board counts as evidence; probing it once manufactured "boards"
// for meta-careers and amazon. Here it only matters that an empty array yields no rows.

const ALLOWED_HOST_SUFFIX = '.breezy.hr';

/** @param {import('./_types.js').PortalEntry} entry */
function resolveSlug(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/https:\/\/([a-z0-9-]+)\.breezy\.hr/i);
  return m ? m[1] : null;
}

/** @param {string} url */
function assertBreezyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`breezy: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`breezy: URL must use HTTPS: ${url}`);
  if (!parsed.hostname.endsWith(ALLOWED_HOST_SUFFIX))
    throw new Error(`breezy: untrusted hostname "${parsed.hostname}"`);
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** "Los Angeles, California" from Breezy's nested location object. */
function oneLocation(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return loc.trim();
  const city = typeof loc.city === 'string' ? loc.city.trim() : '';
  const stateRaw = loc.state;
  const state = typeof stateRaw === 'string'
    ? stateRaw.trim()
    : (stateRaw && typeof stateRaw.name === 'string' ? stateRaw.name.trim() : '');
  const countryRaw = loc.country;
  const country = typeof countryRaw === 'string'
    ? countryRaw.trim()
    : (countryRaw && typeof countryRaw.name === 'string' ? countryRaw.name.trim() : '');
  return [city, state, country].filter(Boolean).join(', ');
}

/**
 * Normalise a Breezy board array into scan rows. Exported for offline testing.
 * @param {any} json
 * @param {string} companyName
 */
export function parseBreezyJobs(json, companyName) {
  const rows = Array.isArray(json) ? json : [];
  return rows
    .filter((j) => j && j.name && j.url)
    .map((j) => {
      // `locations` (plural) is Breezy's secondary-location field and it disagrees with
      // the singular `location` often enough to matter. Reading only the primary is the
      // same class of silent discard that has cost reachable roles in every other adapter
      // here, so fold both, plus the is_remote flag, which is the only remote signal on
      // boards that leave it out of the location text entirely.
      const parts = [oneLocation(j.location)];
      for (const extra of Array.isArray(j.locations) ? j.locations : []) {
        parts.push(oneLocation(extra));
      }
      if (j.is_remote === true) parts.push('Remote');
      return {
        title: String(j.name),
        url: String(j.url),
        company: companyName,
        location: [...new Set(parts.filter(Boolean))].join(' | '),
        salary: typeof j.salary === 'string' && j.salary.trim() ? j.salary.trim() : undefined,
        postedAt: toEpochMs(j.published_date),
      };
    });
}

/** @type {Provider} */
export default {
  id: 'breezy',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://${slug}.breezy.hr/json` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`breezy: cannot derive slug for ${entry.name}`);
    const apiUrl = `https://${slug}.breezy.hr/json`;
    assertBreezyUrl(apiUrl);
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    return parseBreezyJobs(json, entry.name);
  },
};
