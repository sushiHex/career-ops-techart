// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url pattern `https://jobs.lever.co/<slug>`.

function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.lever.co/v0/postings/${match[1]}`;
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(apiUrl);
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: j.categories?.location || '',
      // Lever exposes every option in `allLocations`; `location` is only the
      // primary. Reading the primary alone is the same defect Workday had: a
      // posting whose primary is out but which also offers a workable option
      // gets rejected on evidence that was available all along. Skydance runs
      // 8 of 27 postings multi-location.
      locations: Array.isArray(j.categories?.allLocations) && j.categories.allLocations.length > 0
        ? [...new Set(j.categories.allLocations.map(s => String(s || '').trim()).filter(Boolean))]
        : undefined,
      // Lever's v0 postings list ships the full description for free (same
      // payload, no per-job request) — enables scan.mjs content_filter.
      description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
