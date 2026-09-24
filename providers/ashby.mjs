// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Ashby provider — hits the public posting-api endpoint.
// Auto-detects from careers_url pattern `https://jobs.ashbyhq.com/<slug>`.
//
// Ashby's public posting-api carries a ~10s+ server-side latency floor
// (response time is independent of board size) and rate-limits repeated
// unauthenticated hits. The global default timeout (10s, providers/_http.mjs)
// sits right on that floor, so requests race the timeout and abort. We give
// Ashby a longer timeout plus a backoff+jitter retry (the backoff spaces
// requests out to dodge rate-limiting).
// See .planning/codebase/ashby-scan-abort-diagnosis.md.
const ASHBY_TIMEOUT_MS = 30_000;
const ASHBY_RETRIES = 2;

// Annualization multipliers for different compensation intervals
const INTERVAL_MULTIPLIERS = {
  '1 HOUR': 2080,
  '1 DAY': 260,
  '1 WEEK': 52,
  '2 WEEK': 26,
  '0.5 MONTH': 24,
  '1 MONTH': 12,
  '2 MONTH': 6,
  '3 MONTH': 4,
  '6 MONTH': 2,
  '1 YEAR': 1,
};

/**
 * Parse compensation data from Ashby job object.
 * Returns structured salary object with min, max, and currency,
 * or null if no valid compensation data exists.
 * @param {any} job - Ashby job object
 * @returns {{min: number, max: number, currency: string}|null}
 */
export function parseCompensation(job) {
  const comp = job?.compensation;
  if (!comp) return null;

  const interval = /** @type {keyof typeof INTERVAL_MULTIPLIERS} */ (comp.interval || '1 YEAR');
  const multiplier = INTERVAL_MULTIPLIERS[interval];
  if (!multiplier) return null;

  // Coerce and validate numeric fields — malformed API payloads must not propagate
  /** @param {any} v */
  const normalizeNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const minValue = normalizeNum(comp.minValue);
  const maxValue = normalizeNum(comp.maxValue);
  const currency = typeof comp.currency === 'string' ? comp.currency.trim() : '';

  // If neither min nor max is provided, no valid compensation
  if (minValue == null && maxValue == null) return null;

  // Annualize the values
  const min = minValue != null ? minValue * multiplier : null;
  const max = maxValue != null ? maxValue * multiplier : null;

  // Must have at least one valid annual value
  if (min == null && max == null) return null;

  // Ensure correct ordering (min <= max)
  const resolvedMin = /** @type {number} */ (min ?? max);
  const resolvedMax = /** @type {number} */ (max ?? min);
  return {
    min: Math.min(resolvedMin, resolvedMax),
    max: Math.max(resolvedMin, resolvedMax),
    currency: currency.toUpperCase(),
  };
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Build the full location string from primary + secondary locations.
// Ashby's posting-api puts extra hiring regions in `secondaryLocations[]`
// (each with a region label + a postalAddress). Using only `j.location` drops
// them, so an EU-eligible role whose PRIMARY label is e.g. "Canada" reads as
// Canada-only and gets wrongly removed by scan.mjs's location_filter. We fold
// in each secondary's region, locality, and country so the filter can match
// (e.g. "Europe", "Berlin", "Germany"). Deduped, joined with " · ".
/** @param {any} j */
function formatLocation(j) {
  const parts = [];
  if (typeof j.location === 'string' && j.location.trim()) parts.push(j.location.trim());
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.location === 'string' && s.location.trim()) parts.push(s.location.trim());
      const pa = s.address && s.address.postalAddress;
      if (pa) {
        for (const k of ['addressLocality', 'addressCountry']) {
          if (typeof pa[k] === 'string' && pa[k].trim()) parts.push(pa[k].trim());
        }
      }
    }
  }
  return [...new Set(parts)].join(' · ');
}

/**
 * Pull the postings object out of an Ashby board page.
 *
 * Ashby's posting API is OPT-IN per organisation. When an org has it switched off the
 * endpoint answers 404 while the board itself is perfectly live, and those two states are
 * indistinguishable from outside. That is exactly how Whatnot sat in the websearch handoff
 * bucket: portals.yml still carries the note "Ashby (slug 404'd on probe)". The slug was
 * right. The board had 131 postings, including an AI Tooling Engineer and an LLM Platform
 * Engineer that both list Los Angeles.
 *
 * The braces must be matched rather than regexed: __appData is one large JSON object with
 * nested objects and braces inside strings, so a non-greedy match to the closing </script>
 * grabs the wrong span.
 *
 * @param {string} html
 * @returns {any|null}
 */
export function extractAppData(html) {
  const anchor = /window\.__appData\s*=\s*/.exec(html || '');
  if (!anchor) return null;
  const start = html.indexOf('{', anchor.index + anchor[0].length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** First jobPostings array anywhere in the tree; the nesting is not documented. */
function findPostings(node) {
  if (Array.isArray(node)) {
    for (const v of node) {
      const got = findPostings(v);
      if (got) return got;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.jobPostings)) return node.jobPostings;
    for (const v of Object.values(node)) {
      const got = findPostings(v);
      if (got) return got;
    }
  }
  return null;
}

/**
 * Scan rows from an embedded Ashby board page. Exported for offline testing.
 * @param {string} html
 * @param {string} slug
 * @param {string} companyName
 */
export function parseEmbeddedBoard(html, slug, companyName) {
  const postings = findPostings(extractAppData(html)) || [];
  return postings
    .filter((j) => j && j.title)
    .map((j) => {
      // Fold secondaryLocations in, for the same reason every adapter here must: a
      // remote-eligible role often carries its reachable location THERE while
      // locationName holds a single foreign office.
      const locs = [j.locationName];
      for (const s of j.secondaryLocations || []) {
        locs.push(typeof s === 'string' ? s : (s?.locationName || s?.name));
      }
      if (j.workplaceType) locs.push(j.workplaceType);
      return {
        title: j.title,
        url: `https://jobs.ashbyhq.com/${slug}/${j.id || ''}`,
        company: companyName,
        location: [...new Set(locs.filter((x) => typeof x === 'string' && x.trim()))].join(' | '),
        salary: j.compensationTierSummary || undefined,
      };
    });
}

/** @type {Provider} */
export default {
  id: 'ashby',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    let lastErr;
    for (let attempt = 0; attempt <= ASHBY_RETRIES; attempt++) {
      if (attempt > 0) {
        // exponential backoff + jitter — spaces out retries to dodge Ashby rate-limiting
        const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        await sleep(backoff);
      }
      try {
        const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { timeoutMs: ASHBY_TIMEOUT_MS }));
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        return jobs.map(/** @param {any} j */ (j) => ({
          title: j.title || '',
          url: j.jobUrl || '',
          company: entry.name,
          location: formatLocation(j),
          salary: parseCompensation(j),
          postedAt: toEpochMs(j.publishedAt),
        }));
      } catch (e) {
        lastErr = e;
      }
    }
    // Every API attempt failed. Before surfacing that as an error, check the board PAGE:
    // an org with the posting API switched off answers 404 forever while its board is
    // live. Whatnot is the worked example (131 postings behind a 404).
    const slug = (entry.careers_url || '').match(/jobs\.ashbyhq\.com\/([^/?#]+)/)?.[1];
    if (slug && typeof ctx.fetchText === 'function') {
      try {
        const html = await ctx.fetchText(`https://jobs.ashbyhq.com/${slug}`,
          { timeoutMs: ASHBY_TIMEOUT_MS });
        const rows = parseEmbeddedBoard(html, slug, entry.name);
        if (rows.length) return rows;
      } catch {
        // fall through to the original API error, which is the more useful one to report
      }
    }
    throw lastErr;
  },
};
