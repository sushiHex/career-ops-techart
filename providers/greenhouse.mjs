// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

import { isMain } from '../cli-guard.mjs';

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {string} url */
function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ── secondary locations ───────────────────────────────────────────────────────
//
// Reading only `location.name` is the failure every other adapter here has
// already been fixed for, and it fails closed: a role reachable ONLY via its
// secondary location is discarded with no error and nothing printed. Greenhouse
// is the last one, and it is the awkward one, because Greenhouse has no
// standard secondary-locations field at all. Each board defines its own custom
// metadata, so the fold has to be driven by what a key MEANS.
//
// Measured 2026-08-25 across all 55 greenhouse boards in portals.yml, 10,454
// jobs, all fetched successfully:
//
//   * `metadata` ships on the PLAIN list endpoint. `?content=true` adds the JD
//     body, `departments` and `offices`, but not one metadata field, and no
//     per-job request is needed. The fold is free for a zero-token scan.
//   * A single hardcoded key does not work. "Location Type" exists on exactly
//     one board (Anthropic). The real losses are per-board custom keys:
//     Sony/Naughty Dog/Insomniac write "Career Page - Office Location", Riot
//     writes "Additional Location", Scopely writes "Location" plus "Work
//     Arrangement", Crunchyroll writes "Job Location".
//   * 5 Sony reqs read "United States, San Mateo, CA" (a Bay Area hard out)
//     while their office-location metadata says "United States, Remote".
//
// THREE KEY-NAME TRAPS, all live on real boards right now. Every one of them
// contains a geography word and none of them is a location:
//
//   1. Riot's "Location Range 1".."Location Range 4" and "Location Range -
//      International" are SALARY strings, up to 227 characters, that happen to
//      open "(Los Angeles Only) Base salary range between $224,800.00...".
//      Folding one fabricates a Los Angeles location onto a Mercer Island req.
//      MongoDB's "Job Post Range (United States)" is the same shape.
//   2. "Relocation Package" ("Gold", "No Relocation") and "Relocation
//      Eligible?" are benefits tiers. Note that "Relocation" CONTAINS the
//      substring "location", so an unanchored key match reads them as places.
//   3. "Bungie Geo Pay" on the Sony boards is a pay banding field.
//
// So money and relocation keys are excluded FIRST, before any whitelist runs.
//
// COARSE GEOGRAPHY IS EXCLUDED ON PURPOSE. Datadog's "Geography", MongoDB's
// "Region" and SentinelLabs' "Careers Page Region" hold "North America",
// "EMEA", "APAC". A continent can never produce an accept under a
// state-scoped constraint, so folding one cannot rescue anything; all it does
// is turn a clean foreign reject into `unknown`, and `unknown` means "a human
// must look at this". Across those three boards that is 1,074 postings of
// invented triage. Sony's "Country" ("United States of America") is excluded
// for the same reason: it would demote every foreign Sony reject to a question.
//
// AN ARRANGEMENT IS NOT A PLACE, AND NEVER STANDS ALONE. `decideLocations`
// combines options existentially and classifies a bare "Remote" with no
// geography left over as accept-anywhere. So emitting "Remote" as its own
// option would make "Sydney, Australia" plus a "Remote-Friendly" flag read as
// a workable role. Instead a remote-affirmative arrangement only QUALIFIES the
// places the metadata itself named, producing "United States, Remote" from
// Scopely's Location=["United States"] + Work Arrangement=["Remote"].
//
// THE PRIMARY IS NEVER REWRITTEN. Qualifying `location.name` was tried and is
// wrong twice over. It is the exact Sydney case above, and on Scopely it reads
// worse still: their primary "CA - Canada" plus ", Remote" hits the
// remote-and-California branch of the gate ahead of the blocked-geo check,
// because bare "CA" is both the California abbreviation and the Canada country
// code. A Canadian req would have come back as an accept. Only metadata places
// are qualified, so a board that supplies no place field is left exactly as it
// was found.
//
// The output is a STRUCTURED array on `locations`, the shape workday.mjs and
// lever.mjs already emit and scan.mjs already prefers, rather than one
// concatenated string. That keeps each option separately classifiable, so the
// three-way gate can still answer pass / unknown / reject per option instead of
// blurring them into a single line of text.

/**
 * Keys that are about money or relocation benefits despite carrying a
 * geography word. Tested before every whitelist so a salary blob can never
 * reach a location string. The short tokens are boundary-guarded because bare
 * "comp" matches "Company Assignment" and bare "band" matches a city name;
 * "reloc" is left unanchored since it is distinctive on its own.
 */
const MONEY_KEY_RE = /(^|[^a-z])(range|ranges|salary|salaries|pay|compensation|comp|band|bands|bonus|budget|budgeted|equity|stipend|cost|rate|rates)($|[^a-z])|reloc/i;

/**
 * Keys whose value describes HOW the work happens, not where. Checked before
 * the place whitelist because Anthropic's "Location Type" would otherwise
 * match both, and its values are "On-Site" / "Hybrid (Travel-Required)" /
 * "Remote".
 */
const ARRANGEMENT_KEY_RE = /(^|[^a-z])(remote|arrangement|arrangements|workplace\w*|work\s*model|working\s*model|location\s*type|work\s*designation)($|[^a-z])/i;

/** Continent, region and country buckets. See the note above on why these are dropped. */
const COARSE_KEY_RE = /(^|[^a-z])(region|regions|geo|geography|geographies|country|countries|continent)($|[^a-z])/i;

/**
 * Keys whose value is an actual place. The leading boundary is what stops
 * "Relocation Package" from matching on the "location" inside "Relocation".
 */
const PLACE_KEY_RE = /(^|[^a-z])(location|locations|office|offices|worksite|worksites|city|cities)($|[^a-z])/i;

/**
 * A place name is short. This is a backstop for a key name the lists above have
 * never seen, not the primary defence: Riot's salary strings run to 227
 * characters, so anything of that length is prose and not a location.
 */
const MAX_PLACE_CHARS = 120;

/**
 * Greenhouse metadata values arrive as a string, an array of strings, null, or
 * an object for the `currency_range` type. Only strings and numbers survive,
 * which is what keeps MongoDB's currency_range from stringifying itself into a
 * location as "[object Object]".
 *
 * @param {any} m
 * @returns {string[]}
 */
function metadataValues(m) {
  const raw = Array.isArray(m?.value) ? m.value : [m?.value];
  return raw
    .map((v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''))
    .filter(Boolean);
}

/**
 * Does this arrangement field actually affirm remote work?
 *
 * Two spellings occur. The value names the arrangement ("Remote",
 * "Remote-Friendly"), or the KEY asks a yes/no question ("Remote?", "Careers
 * Page Remote Eligible") and the value is only the answer.
 *
 * Only the boolean is used. The value's TEXT never reaches a location string,
 * so an employer writing "Remote (California)" cannot inject a state.
 *
 * @param {string} key
 * @param {string} value
 */
function affirmsRemote(key, value) {
  // A negation in front of the word carries the entire meaning, and the word is
  // still in there: "No Remote", "Not Remote" and "Non-Remote" all match a plain
  // search for "remote" and not one of them is remote.
  if (/(^|[^a-z])(no|not|non)[-\s]*remote/i.test(value)) return false;
  if (/(^|[^a-z])remote/i.test(value)) return true;
  // A yes/no key carries the word in its NAME and the value is only the answer.
  // The affirmative list is deliberately explicit rather than a matching list of
  // negatives, so Epic's "No" on all 162 of its reqs and Samsung's yes_no
  // "false" fall through to false without either one needing to be enumerated.
  return /^(yes|true|1|y)$/i.test(value) && /(^|[^a-z])remote/i.test(key);
}

/**
 * Build the structured option list for one Greenhouse job record.
 *
 * Returns `undefined` when the board's metadata adds nothing, which leaves the
 * row on its plain `location` display string. That is the same convention
 * lever.mjs uses for an empty `allLocations`, and it keeps every arrangement-only
 * board (Anthropic, Turtle Rock, Dataiku, Epic) behaving exactly as before.
 *
 * Options are only ever ADDED, never removed, so this cannot turn a posting the
 * gate accepts today into a reject.
 *
 * Exported for offline testing.
 *
 * @param {any} job - One element of the boards-api `jobs` array.
 * @returns {string[]|undefined}
 */
export function foldGreenhouseLocations(job) {
  const primary = typeof job?.location?.name === 'string' ? job.location.name.trim() : '';
  const metadata = Array.isArray(job?.metadata) ? job.metadata : [];

  const places = [];
  let remote = false;
  for (const m of metadata) {
    const key = typeof m?.name === 'string' ? m.name : '';
    if (!key || MONEY_KEY_RE.test(key)) continue;
    const values = metadataValues(m);
    if (values.length === 0) continue;
    if (ARRANGEMENT_KEY_RE.test(key)) {
      if (values.some((v) => affirmsRemote(key, v))) remote = true;
      continue;
    }
    if (COARSE_KEY_RE.test(key) || !PLACE_KEY_RE.test(key)) continue;
    for (const v of values) if (v.length <= MAX_PLACE_CHARS) places.push(v);
  }

  // No place field on this board. A remote flag on its own is not evidence of a
  // reachable location, so nothing is invented here.
  if (places.length === 0) return undefined;

  const options = primary ? [primary, ...places] : [...places];
  if (remote) for (const p of places) options.push(`${p}, Remote`);

  const deduped = [...new Set(options)];
  if (deduped.length <= (primary ? 1 : 0)) return undefined;
  return deduped;
}

/**
 * Normalise a boards-api payload into scan rows. Exported for offline testing.
 *
 * @param {any} json
 * @param {string} companyName
 */
export function parseGreenhouseJobs(json, companyName) {
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.filter(/** @param {any} j */ (j) => j?.absolute_url).map(/** @param {any} j */ (j) => ({
    title: j.title || '',
    url: j.absolute_url,
    company: companyName,
    // The raw display string stays exactly what the board rendered; the fold
    // lives on `locations`, which scan.mjs prefers when it is present.
    location: j.location?.name || '',
    locations: foldGreenhouseLocations(j),
    postedAt: toEpochMs(j.first_published),
  }));
}

/** @type {Provider} */
export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    return parseGreenhouseJobs(json, entry.name);
  },
};

// ── selftest ──────────────────────────────────────────────────────────────────

function selftest() {
  let passed = 0;
  const fails = [];
  const ok = (name, cond, detail = '') => {
    if (cond) { passed++; return; }
    fails.push(`${name}${detail ? `  (${detail})` : ''}`);
  };
  /** @param {string} name @param {any[]} metadata */
  const job = (name, metadata) => ({ location: { name }, metadata });
  const meta = (name, value) => ({ id: 1, name, value, value_type: 'single_select' });

  // 1. THE REPORTED BUG. Five live Sony reqs render "United States, San Mateo, CA",
  //    which the gate rejects as a Bay Area hard out, while their own metadata says
  //    the office is remote. Reading only location.name discarded all five.
  const sony = foldGreenhouseLocations(job('United States, San Mateo, CA', [
    meta('Cost Center', 'GAMES1US70-USN1950151 D2C-US-Commerce Operations'),
    meta('Career Page - Office Location', 'United States, Remote'),
    meta('Country', 'United States of America'),
  ]));
  ok('sony: the office-location metadata is folded in',
    Array.isArray(sony) && sony.includes('United States, Remote'), JSON.stringify(sony));
  ok('sony: the board\'s own primary string is kept as an option',
    Array.isArray(sony) && sony.includes('United States, San Mateo, CA'), JSON.stringify(sony));
  // A country cannot rescue anything and would demote every foreign Sony reject to
  // `unknown`, which is a human triage line each.
  ok('sony: the coarse Country field is NOT folded',
    Array.isArray(sony) && !sony.some((s) => /United States of America/.test(s)), JSON.stringify(sony));

  // 2. TRAP ONE, live on Riot's board. "Location Range 1" is a 227-character SALARY
  //    string that opens "(Los Angeles Only)". Folding it fabricates an in-lane
  //    California location onto a Mercer Island req, which is a Seattle hard out.
  const riotSalary = foldGreenhouseLocations(job('Mercer Island, USA', [
    meta('Relocation Package', 'Gold'),
    meta('Location Range 1', '(Los Angeles Only) Base salary range between $192,500.00 - $269,400.00 USD + incentive compensation + equity + 401K with company match + medical, dental, vision, and life insurance + short and long-term disability + open PTO.'),
    meta('Location Range - International', '(Seoul Only) Base salary range between ₩68,743,700.00 - ₩106,552,900.00 KRW'),
  ]));
  ok('riot: a salary string named "Location Range" is never a location',
    riotSalary === undefined, JSON.stringify(riotSalary));
  // "Relocation" contains the substring "location". An unanchored key match reads
  // this benefits tier as a place.
  ok('riot: "Relocation Package" is not read as a location',
    riotSalary === undefined || !riotSalary.some((s) => /Gold|Relocation/i.test(s)), JSON.stringify(riotSalary));

  // 3. Riot's real secondary field. A Shanghai-primary req that also runs out of Los
  //    Angeles is reachable, and a discarded reachable req is the expensive error.
  const riotReal = foldGreenhouseLocations(job('Shanghai, China', [
    meta('Additional Location', ['Los Angeles, USA']),
    meta('Location Range 2', '(Los Angeles Only) Base salary range between $185,200.00 - $258,000.00 USD + incentive compensation'),
  ]));
  ok('riot: "Additional Location" is folded in',
    Array.isArray(riotReal) && riotReal.includes('Los Angeles, USA'), JSON.stringify(riotReal));
  ok('riot: the salary string is still excluded when a real place exists',
    Array.isArray(riotReal) && !riotReal.some((s) => /salary|\$/i.test(s)), JSON.stringify(riotReal));

  // 4. Scopely writes the place and the arrangement in two separate custom keys, so
  //    neither one alone says "remote in the US". The pair does.
  const scopely = foldGreenhouseLocations(job('CA - Canada', [
    meta('Work Arrangement', ['Remote']),
    meta('Location', ['Canada', 'United States']),
    meta('Category', 'Analytics / Performance'),
  ]));
  ok('scopely: a remote arrangement qualifies each metadata place',
    Array.isArray(scopely) && scopely.includes('United States, Remote'), JSON.stringify(scopely));
  // TRAP TWO. A bare "Remote" option classifies as accept-anywhere, so emitting the
  // arrangement on its own would pass any posting that carries a remote flag.
  ok('scopely: a bare "Remote" is never emitted as its own option',
    Array.isArray(scopely) && !scopely.includes('Remote'), JSON.stringify(scopely));
  // The primary must survive untouched. "CA - Canada, Remote" would hit the
  // remote-and-California branch of the gate before the blocked-geo check, because
  // bare "CA" is both the California abbreviation and the Canada country code.
  ok('scopely: the primary is never rewritten with the arrangement',
    Array.isArray(scopely) && !scopely.includes('CA - Canada, Remote'), JSON.stringify(scopely));

  // 5. TRAP TWO in its stated form. A foreign primary plus a remote-ish flag and no
  //    place field must come back untouched, so the gate still sees only Sydney.
  const sydney = foldGreenhouseLocations(job('Sydney, Australia', [
    meta('Location Type', 'Remote-Friendly'),
  ]));
  ok('sydney: an arrangement with no place field folds nothing',
    sydney === undefined, JSON.stringify(sydney));

  // 6. The same board WITH a place field may qualify that place, but must not invent a
  //    US or California token out of the arrangement.
  const sydneyPlaces = foldGreenhouseLocations(job('Sydney, Australia', [
    meta('Location Type', 'Remote'),
    meta('Office Location', ['Australia']),
  ]));
  ok('sydney: the qualified option stays Australian',
    Array.isArray(sydneyPlaces) && sydneyPlaces.includes('Australia, Remote'), JSON.stringify(sydneyPlaces));
  ok('sydney: no US or California token is invented',
    Array.isArray(sydneyPlaces) && !sydneyPlaces.some((s) => /United States|USA|California|(^|[^a-z])CA($|[^a-z])/i.test(s)),
    JSON.stringify(sydneyPlaces));

  // 7. Epic answers "No" on all 162 of its reqs and Samsung's yes_no field serves the
  //    string "false". Either read as remote would promote a whole onsite catalogue.
  const epic = foldGreenhouseLocations(job('Cary,North Carolina,United States', [
    meta('Careers Page Remote Eligible', 'No'),
    meta('Job Location', ['Cary, NC']),
  ]));
  ok('epic: a "No" answer does not affirm remote',
    Array.isArray(epic) && !epic.some((s) => /Remote/i.test(s)), JSON.stringify(epic));
  ok('samsung: the string "false" does not affirm remote',
    affirmsRemote('Remote Work Option', 'false') === false);
  // The affirmative half of the same shape: the key carries the word, the value is
  // only the answer.
  ok('dataiku: "Remote?" = "Yes" does affirm remote', affirmsRemote('Remote?', 'Yes') === true);
  // A negated value still CONTAINS the word "remote", so a plain search for it says
  // yes. All three spellings have to lose. This case exists because the first version
  // of the guard only caught "non"/"not" and let "No Remote" through as remote.
  ok('a "Non-Remote" value does not affirm remote', affirmsRemote('Work Arrangement', 'Non-Remote') === false);
  ok('a "No Remote" value does not affirm remote', affirmsRemote('Work Arrangement', 'No Remote') === false);
  ok('a "Not Remote" value does not affirm remote', affirmsRemote('Work Arrangement', 'Not Remote') === false);
  ok('a plain "Remote" value still affirms remote', affirmsRemote('Work Arrangement', 'Remote') === true);
  // "Hybrid" and "Onsite" are arrangements too, and neither is remote.
  ok('an "Onsite" value does not affirm remote', affirmsRemote('Work Designation', 'Onsite') === false);
  ok('a "Hybrid (Travel-Required)" value does not affirm remote',
    affirmsRemote('Location Type', 'Hybrid (Travel-Required)') === false);

  // 8. Coarse geography. Folding "EMEA" or "North America" cannot rescue a posting and
  //    would turn 1,074 clean foreign rejects across three boards into review noise.
  const mongo = foldGreenhouseLocations(job('Dublin, Ireland', [
    meta('Region', 'EMEA'),
    meta('Working Model Eligibility', ['2-Flexible']),
    meta('Job Post Range (United States)', { min_value: 1, max_value: 2 }),
  ]));
  ok('mongodb: a Region bucket is not folded', mongo === undefined, JSON.stringify(mongo));
  ok('datadog: a Geography bucket is not folded',
    foldGreenhouseLocations(job('Paris, France', [meta('Geography', 'EMEA')])) === undefined);
  // A currency_range value is an object. Stringifying it yields "[object Object]".
  ok('mongodb: a currency_range object never becomes a location',
    mongo === undefined || !mongo.some((s) => /object Object/.test(s)), JSON.stringify(mongo));

  // 9. Structure, not concatenation. The three-way gate classifies each option
  //    independently, so a joined string would blur pass / unknown / reject together.
  ok('the fold returns a structured array', Array.isArray(sony));
  ok('no option is a joined multi-location blob',
    Array.isArray(sony) && !sony.some((s) => s.includes(' | ') || s.includes(' · ')), JSON.stringify(sony));

  // 10. Metadata that adds nothing leaves the row on its display string, so a board
  //     that merely restates its own primary does not gain a redundant array.
  ok('a metadata place identical to the primary adds no array',
    foldGreenhouseLocations(job('Irvine, CA', [meta('Office Location', 'Irvine, CA')])) === undefined);

  // 11. Malformed or absent payloads must not throw. A provider crash takes the whole
  //     scan down, and a board can ship a null metadata array at any time.
  ok('no metadata at all is handled', foldGreenhouseLocations(job('Irvine, CA', undefined)) === undefined);
  ok('a null job is handled', foldGreenhouseLocations(null) === undefined);
  ok('a null metadata entry is handled',
    foldGreenhouseLocations(job('Irvine, CA', [null, meta('Job Location', 'Los Angeles, CA')]))
      ?.includes('Los Angeles, CA') === true);
  ok('an empty metadata value is skipped',
    foldGreenhouseLocations(job('Irvine, CA', [meta('City', null), meta('Office Location', '')])) === undefined);

  // 12. The whole-board parser still shapes rows the way scan.mjs expects, and leaves
  //     the display string alone.
  const rows = parseGreenhouseJobs({
    jobs: [
      { title: 'Tech Artist', absolute_url: 'https://job-boards.greenhouse.io/x/1', location: { name: 'United States, San Mateo, CA' }, metadata: [meta('Career Page - Office Location', 'United States, Remote')], first_published: '2026-08-01T00:00:00Z' },
      { title: 'No URL', location: { name: 'Irvine, CA' } },
    ],
  }, 'Sony');
  ok('parseGreenhouseJobs drops a row with no absolute_url', rows.length === 1, `${rows.length}`);
  ok('parseGreenhouseJobs leaves `location` as the board\'s display string',
    rows[0]?.location === 'United States, San Mateo, CA', JSON.stringify(rows[0]?.location));
  ok('parseGreenhouseJobs exposes the fold on `locations`',
    rows[0]?.locations?.includes('United States, Remote') === true, JSON.stringify(rows[0]?.locations));
  ok('parseGreenhouseJobs still parses first_published', rows[0]?.postedAt === Date.parse('2026-08-01T00:00:00Z'));
  ok('parseGreenhouseJobs yields nothing for an empty board', parseGreenhouseJobs({ jobs: [] }, 'X').length === 0);
  ok('parseGreenhouseJobs yields nothing for a malformed payload', parseGreenhouseJobs(null, 'X').length === 0);

  console.log(`greenhouse selftest: ${passed} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  FAIL  ${f}`);
  return fails.length === 0;
}

// Guarded on being the entry point, not merely on the flag. scan.mjs imports every
// file in providers/, so a bare process.argv check would fire this selftest (and its
// process.exit) in the middle of `node scan.mjs --selftest`.
const invokedDirectly = isMain(import.meta.url);
if (invokedDirectly) {
  const extra = process.argv.slice(2).filter((a) => a !== '--selftest');
  if (extra.length) {
    console.error(`greenhouse: unknown argument(s): ${extra.join(' ')}\nusage: node providers/greenhouse.mjs --selftest`);
    process.exit(2);
  }
  process.exit(selftest() ? 0 : 1);
}
