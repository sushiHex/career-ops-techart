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
const MAX_PAGES = 50; // safety cap — at most 1000 postings per site
// Detail lookups add roughly one request per multi-location posting, which on a
// large tenant is a ~40% increase in traffic — enough to earn a 429 from
// Autodesk at concurrency 4. Two at a time with a short pause and one backoff
// retry keeps the enrichment well inside what these hosts tolerate.
const DETAIL_CONCURRENCY = 2;
const DETAIL_PAUSE_MS = 120;
const DETAIL_RETRY_MS = 1500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function resolveEndpoint(entry) {
  const url = entry.careers_url || '';
  const m = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  if (!m) return null;
  const [, tenant, instance, site] = m;
  const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
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
        let detail;
        try {
          detail = await ctx.fetchJson(ep.detailBase + job._externalPath, {
            headers: { accept: 'application/json' },
          });
        } catch (err) {
          // Back off once on throttling / transient unavailability. Any other
          // status is a real miss and falls through to the outer catch.
          if (err?.status !== 429 && err?.status !== 503) throw err;
          await sleep(DETAIL_RETRY_MS);
          detail = await ctx.fetchJson(ep.detailBase + job._externalPath, {
            headers: { accept: 'application/json' },
          });
        }
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

    const jobs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = JSON.stringify({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        searchText: '',
        appliedFacets: {},
      });
      const json = await ctx.fetchJson(ep.api, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      });
      const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      for (const j of postings) {
        if (!j.externalPath) continue;
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
    }

    await resolveMultiLocationPostings(jobs, ep, ctx);
    for (const job of jobs) delete job._externalPath;
    return jobs;
  },
};
