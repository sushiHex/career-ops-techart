// @ts-check
// Shared location policy. Imported by scan.mjs, _locaudit.mjs and _claimprobe.mjs
// so the scanner, the auditors and the tests can never drift apart.
//
// WHY THIS EXISTS
// The previous filter classified a single flattened string. That failed three
// ways, all verified against real scan output:
//
//   1. Workday reports multi-site reqs as "5 Locations" — a string with no
//      geography — which fell through to an ambiguity-pass and accepted
//      everything. 53 of 365 history rows were in that state.
//   2. Flattening lost the association between signals, so
//      "Remote, Washington, USA; Santa Clara, CA" read as remote + US + CA and
//      passed, though neither option is workable from Southern California.
//   3. Rejection was driven by a hand-maintained blocked_geo enumeration, so
//      any unlisted foreign city (Noida, Buenos Aires, Dublin) passed.
//
// THE MODEL
// A posting has one or more location OPTIONS. Each is classified independently
// as accept / reject / unknown, then combined existentially: a posting is
// workable if ANY option is workable. A posting is rejected only when every
// option is known and every one fails. Anything else is UNKNOWN, which is
// reported rather than guessed — a false accept costs a line of triage, a
// false reject can hide a job permanently.

// isMain tells an import apart from a direct run for the --selftest guard at the
// bottom of the file, through a symlinked or junctioned checkout too.
import { fileURLToPath } from 'url';
import { isMain } from './cli-guard.mjs';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

// WHERE THE CANDIDATE CAN WORK IS DATA. config/location.json (written by setup.mjs from
// presets/locations/) names the home state, the commute area and the metros that are out,
// and presets/locations/california-socal.json is the worked example the cases pin. An
// older portals.yml may still say `california_signals` / `socal_signals`; buildSignals
// reads them as the home state and the commute area.

/**
 * Separators between distinct options.
 *
 * Comma is NOT one: "US, CA, Remote" is a single place, not three. The word "or" is NOT
 * one either: alternatives inside an option are read by the engine below, after every
 * state code has become a token, so Oregon's "OR" can never be taken for the word.
 */
const OPTION_SPLIT_RE = /\s*(?:;|\||\u00b7|\u2022|\n)\s*/;

/**
 * Fold a location to a stable comparison form.
 *
 * Diacritics are stripped, which also fixes a real bug: matching used
 * `[^a-z0-9]` as a word boundary, so "Montréal" split into "montré" + "al"
 * and matched the Alabama state code, manufacturing a US signal that
 * overrode the Canada block.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeLocation(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Split a location string into independent options.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLocationOptions(text) {
  return String(text ?? '')
    .split(OPTION_SPLIT_RE)
    .map(s => s.trim())
    .filter(Boolean);
}

// ── The shared grammar ──────────────────────────────────────────────
// HOW A LOCATION IS READ is written down once, in presets/README.md, and implemented
// twice: here and in scripts/_location.py. The two used to be two different algorithms
// patched toward each other finding by finding, and every round of patches produced new
// disagreements. Now they are the same algorithm, step for step: every pattern that reads
// the meaning of location text is DATA in presets/locations/_base-us.json ("grammar"),
// compiled by both, and the tokeniser's own mechanics are written the same way in each.
// The functions below keep the names and the order of their Python counterparts.
const GRAMMAR_DIR = dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(readFileSync(join(GRAMMAR_DIR, 'presets', 'locations', '_base-us.json'), 'utf8'));
const G = BASE.grammar;
const NAME_BY_CODE = { ...BASE.states_by_code, ...(BASE.territories_by_code || {}) };
const STATE_CODES = new Set(Object.keys(NAME_BY_CODE));
const STATE_ABBR = Object.fromEntries(Object.entries(NAME_BY_CODE).map(([c, n]) => [n.toLowerCase(), c]));
const SPELLED_STATES = Object.keys(STATE_ABBR).sort((a, b) => b.length - a.length);
const ST = '<[A-Z]{2}>';
const LIST = `${ST}(?:${G.list_sep}${ST})*`;
const expand = (p) => p.replaceAll('{LIST}', LIST).replaceAll('{ST}', ST)
  .replaceAll('{US}', G.us).replaceAll('{R}', G.remote);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A grammar key compiled the way _location.py compiles it; `g` for the global form. */
function compile(key, g = '') {
  const flags = (G.case_sensitive.includes(key) ? '' : 'i') + g;
  const v = G[key];
  return Array.isArray(v) ? v.map((p) => new RegExp(expand(p), flags)) : new RegExp(expand(v), flags);
}
const KEYS = ['remote', 'remote_friendly', 'remote_hybrid', 'us', 'city_suffix', 'time_zone_words', 'time_zone_abbrev',
  'time_zone_us_paren', 'placeholder', 'nationwide', 'exclusion_lead', 'exclusion_trail', 'weak_context', 'scope_shapes',
  'metro_scope', 'chunk_split', 'sentence_break', 'place_split', 'place_donor',
  'undetermined', 'travel_phrase', 'preference_after', 'context_before', 'negation_before'];
const RX = Object.fromEntries(KEYS.map((k) => [k, compile(k)]));
const RXG = Object.fromEntries(KEYS.map((k) => [k, compile(k, 'g')]));
const CITY_SUFFIX = new RegExp(`^(?:${expand(G.city_suffix)})`, 'i');
const FOLDS = G.folds.map(([p, r]) => [new RegExp(p, 'gi'), r]);
const PLACE_BREAK = [new RegExp(G.place_break[0], 'gi'), G.place_break[1]];
/** An unresolved "N Locations" style placeholder; providers/workday.mjs enriches these. */
export const PLACEHOLDER_RE = RX.placeholder;
const TOKEN = /<([A-Z]{2})>/g;
const ALT_SPLIT_RE = /\s+or\s+|\s*\/\s*/i;
const NAMES = new RegExp(`(?<![A-Za-z])(${SPELLED_STATES.map(esc).join('|')})(?![A-Za-z])`, 'gi');
const CODE = /(?<![A-Za-z0-9<])([A-Z]{2})(?![A-Za-z0-9>])/g;
const RUN = /(?<![A-Za-z0-9<])[A-Z]{2}(?:\s*(?:,|\/|&|\s(?:or|and)\s)\s*[A-Z]{2})+(?![A-Za-z0-9>])/g;
const CODE_BEFORE = new RegExp(G.code_before, 'i');
const CODE_AFTER = new RegExp(`^(?:${G.code_after})`, 'i');
const CODE_RE = /^[a-z]{2}$/i;
/** A signal's state field in capitals, so a hand-typed "ontario, ca" still meets "Ontario, <CA>". */
const signalCase = (k) => String(k).replace(/,\s*([a-z]{2})\s*$/i, (_, c) => `, ${c.toUpperCase()}`);
const AMBIGUOUS = G.ambiguous_codes;
const TZ_CODES = new Set(G.time_zone_codes);
const COUNTRY_LIKE = new Set(G.country_like_codes);

/** Word-bounded alternation; `flags` '' for a case-sensitive list. */
function alternation(words, flags = 'i') {
  const items = [...new Set((words || []).filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim()))]
    .sort((a, b) => b.length - a.length);
  if (!items.length) return /(?!x)x/;
  return new RegExp(`(?<![A-Za-z0-9])(?:${items.map(esc).join('|')})(?![A-Za-z0-9])`, flags);
}
const BLOCKED_CODES = alternation(BASE.blocked_codes, '');
const spansOf = (re, t) => [...t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))]
  .map((m) => [m.index, m.index + m[0].length]);

/**
 * Diacritics stripped, and the DC and New York City spellings folded to one form each
 * (grammar "folds"). scripts/_location.py fold() is the same function.
 */
export function foldOption(option) {
  // Every combining mark, as Python's category "Mn", and whitespace JavaScript's \s does
  // not know made plain.
  let t = String(option ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[\x1c-\x1f\x85]/g, ' ');
  for (const [re, rep] of FOLDS) t = t.replace(re, rep);
  t = t.trim();
  return { raw: t, text: t.toLowerCase() };
}

/**
 * The option with every state it names replaced by a token like <TX> (presets/README.md,
 * "Reading the states"). After this no pattern can mistake a code for a word or a word
 * for a code: "Portland, OR" is "Portland, <OR>" and the word "or" is never Oregon.
 */
export function tokenize(text, home = null, blockedRe = alternation(BASE.blocked_geo), usPlace = false) {
  let t = foldOption(text).raw;
  // `usPlace` reads a policy's own entry, which is always a US place: "Dublin, CA" in a
  // California policy is Dublin, California, whatever Dublin means in a posting.
  const blocked = !usPlace && (blockedRe.test(t) || BLOCKED_CODES.test(t));
  // Names, unless part of a city name: "New York City", "Kansas City", "Washington, PA".
  let out = '', last = 0;
  for (const m of t.matchAll(NAMES)) {
    const after = t.slice(m.index + m[0].length);
    if (CITY_SUFFIX.test(after)) continue;
    const city = /^\s*,\s*([A-Z]{2})(?![A-Za-z])/.exec(after);
    if (city && STATE_CODES.has(city[1])) continue;
    out += t.slice(last, m.index) + `<${STATE_ABBR[m[1].toLowerCase()]}>`;
    last = m.index + m[0].length;
  }
  t = out + t.slice(last);
  // Codes, only in a field position or a run of codes.
  const tz = RX.time_zone_words.test(t) || RX.time_zone_abbrev.test(t);
  const tzSpans = spansOf(RX.time_zone_us_paren, t);
  const runs = new Set();
  for (const m of t.matchAll(RUN)) {
    const toks = [...m[0].matchAll(/[A-Z]{2}/g)].map((x) => [x.index + m.index, x[0]]);
    if (toks.every(([, c]) => STATE_CODES.has(c))) toks.forEach(([s]) => runs.add(s));
  }
  out = ''; last = 0;
  for (const m of t.matchAll(CODE)) {
    const c = m[1], s = m.index, e = s + 2;
    if (!STATE_CODES.has(c)) continue;
    const inRun = runs.has(s);
    if (!inRun && !(CODE_BEFORE.test(t.slice(0, s)) && CODE_AFTER.test(t.slice(e)))) continue;
    if (COUNTRY_LIKE.has(c) && blocked) continue;               // "Toronto, CA" is Canada
    if (c !== home && AMBIGUOUS[c]) {
      const [lo, hi] = AMBIGUOUS[c];
      const zip = /^\s*(\d{5})/.exec(t.slice(e));
      if (!(inRun || /,\s*$/.test(t.slice(0, s)))
          || (zip && !(lo <= Number(zip[1].slice(0, 3)) && Number(zip[1].slice(0, 3)) <= hi))) continue;
    }
    // A time zone is a time zone even for someone who lives in Montana.
    if (TZ_CODES.has(c) && (tz || tzSpans.some(([a, b]) => a <= s && s < b))) continue;
    out += t.slice(last, s) + `<${c}>`;
    last = e;
  }
  return out + t.slice(last);
}

const tokens = (n) => new Set([...String(n ?? '').matchAll(TOKEN)].map((m) => m[1]));

/** [codes, text]: states an eligibility exclusion names, and the text without the clause. */
function exclusions(n) {
  const codes = new Set(), spans = [];
  for (const re of [RXG.exclusion_lead, RXG.exclusion_trail]) {
    for (const m of n.matchAll(re)) {
      const got = tokens(m[1]);
      if (got.size) { got.forEach((c) => codes.add(c)); spans.push([m.index, m.index + m[0].length]); }
    }
  }
  for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) n = `${n.slice(0, s)} ${n.slice(e)}`;
  return [codes, n];
}

/** States named in a SCOPE POSITION. */
function scopeOf(n) {
  const found = new Set();
  for (const re of RXG.scope_shapes) {
    for (const m of n.matchAll(re)) {
      if (RX.negation_before.test(n.slice(0, m.index))) continue;   // "not required to reside in TX"
      tokens(m[1]).forEach((c) => found.add(c));
    }
  }
  return found;
}

/** The text without its travel phrases: where someone travels is not where the job is. */
const noTravel = (n) => n.replace(RXG.travel_phrase, ' ');

/** States named outside a scope position, minus preference and travel mentions. */
function weakStates(n) {
  for (const re of RXG.weak_context) n = n.replace(re, ' ');
  return tokens(n);
}

/**
 * A remote OFFER. "Remote-friendly" and "hybrid remote" are not: both are hybrid
 * policies with recurring office days, so they are read as onsite at the place named.
 */
const isRemote = (n) => RX.remote.test(n.replace(RXG.remote_friendly, ' ').replace(RXG.remote_hybrid, ' '));

/** Nothing but country names: "United States", "United States, Canada". */
function pureCountry(n, s) {
  const rest = n.replace(RXG.us, ' ').replace(new RegExp(s.blocked.source, 'gi'), ' ')
    .replace(new RegExp(BLOCKED_CODES.source, 'g'), ' ');
  return RX.us.test(n) && !rest.replace(/[^A-Za-z0-9]+/g, '');
}

function bareRemote(n) {
  const rest = n.replace(RXG.remote, ' ').replace(/\b(?:anywhere|fully)\b/gi, ' ');
  return !rest.replace(/[^A-Za-z0-9]+/g, '');
}

/** A signal list as word-bounded matchers; a short all-capitals signal matches only in capitals. */
function matcher(signals) {
  const cs = signals.filter((s) => s.length <= 3 && s === s.toUpperCase() && /[A-Z]/.test(s));
  const ci = signals.filter((s) => !cs.includes(s));
  const a = alternation(ci), b = alternation(cs, '');
  return {
    test: (t) => a.test(t) || b.test(t),
    spans: (t) => [...spansOf(a, t), ...spansOf(b, t)],
  };
}

/**
 * Precompile a location block (policy plus any portals.yml override) into the object
 * every classifier reads. scripts/_location.py Policy.__init__ is the same step.
 *
 * @param {object} locationFilter
 * @returns {object}
 */
export function buildSignals(locationFilter = {}) {
  const list = (key) => (Array.isArray(locationFilter[key]) ? locationFilter[key]
    : locationFilter[key] ? [locationFilter[key]] : []);
  // The generic key and the California-era key both feed one slot, so a portals.yml
  // written before the rename keeps working.
  const homeKeys = [...list('home_state_signals'), ...list('california_signals')].map((k) => String(k).trim());
  const codeKey = homeKeys.find((k) => /^[a-z]{2}$/i.test(k));
  const home = codeKey ? codeKey.toUpperCase()
    : homeKeys.map((k) => STATE_ABBR[foldOption(k).text]).find(Boolean) || null;
  const blocked = alternation(locationFilter.blocked_geo ? list('blocked_geo') : BASE.blocked_geo);
  // An entry is read both as a posting would read it and as the US place it is, since a
  // posting's "Dublin, CA" may keep its CA as Canada while "Dublin, California" never does.
  const sig = (xs) => [...new Set(xs.flatMap((k) => [false, true].map((us) => tokenize(signalCase(k), home, blocked, us))))];
  const commute = sig([...list('commute_signals'), ...list('socal_signals')]);
  const far = sig(list('hard_out_metro'));
  const commuteStates = new Set(commute.flatMap((c) => [...tokens(c)]).filter((c) => c !== home));
  // "Arlington, VA" also meets "US, VA, Arlington" and "Arlington or Richmond, VA": the
  // city alone, wherever the place's own or inherited state is that state.
  const commuteCities = commute.map((c) => /^(.*\S),\s*<([A-Z]{2})>$/.exec(c))
    .filter((m) => m && !/<[A-Z]{2}>/.test(m[1])).map((m) => [matcher([m[1]]), m[2]]);
  // A place list that names only "New York" means the city (grammar state_as_city).
  const stateAsCity = Object.fromEntries(Object.entries(G.state_as_city).map(([c, v]) => [c, tokenize(v, home, blocked)]));
  return {
    home,
    hasHome: !!home,
    homeName: NAME_BY_CODE[home] || homeKeys.find((k) => !/^[a-z]{2}$/i.test(k)) || home,
    commute: matcher(commute),
    commuteCities,
    stateAsCity,
    far: matcher(far),
    commuteStates,
    reachable: new Set([...(home ? [home] : []), ...commuteStates]),
    commuteLabel: locationFilter.commute_label || 'Commute',
    // 'fail' is the no-relocation default; 'unknown' asks a human instead.
    onsiteElsewhere: locationFilter.onsite_outside_commute === 'unknown' ? 'unknown' : 'fail',
    blocked,
    reviewMetroCompanies: (locationFilter.review_metro_companies || []).map((c) => normalizeLocation(c)),
  };
}

/**
 * 'pass' when some place in the option is a commute place (presets/README.md, "Commute
 * places"); 'ambiguous' when the only thing against one is a state it INHERITED from a
 * later "City, ST" ("Los Angeles or Austin, TX" reads Los Angeles as Texan, and the text
 * cannot settle that); otherwise null. _location.py Policy._commute_in is the same.
 */
function commuteIn(n, s) {
  const onsite = !isRemote(n);
  let ambiguous = false;
  const chunked = n.replace(RXG.sentence_break, '$1\n').replace(PLACE_BREAK[0], PLACE_BREAK[1]);
  const overlaps = (x, ys) => ys.some(([c, d]) => x[0] < d && c < x[1]);
  for (const chunk of chunked.split(RX.chunk_split)) {
    const pieces = chunk.split(RX.place_split);
    // A place with no state takes the state of the next "City, ST" place in the same
    // list, never of a remote alternative or a bare state name.
    const states = []; let carry = new Set();
    for (let i = pieces.length - 1; i >= 0; i--) {
      const own = tokens(pieces[i]);
      if (own.size) {
        carry = RX.place_donor.test(pieces[i]) && !isRemote(pieces[i]) ? own : new Set();
        states.unshift([own, true]);
      } else states.unshift([carry, false]);
    }
    for (let i = 0; i < pieces.length; i++) {
      const [st, owned] = states[i];
      let probe = pieces[i];
      // A place that is nothing but "New York" is the city, in a list of places.
      const bare = /^<([A-Z]{2})>$/.exec(probe.trim());
      if (onsite && bare && s.stateAsCity[bare[1]]) probe = s.stateAsCity[bare[1]];
      const hits = s.commute.spans(probe);
      let clash = false;
      for (const [m, code] of s.commuteCities) {
        const found = m.spans(probe);
        if (found.length && (!st.size || st.has(code))) hits.push(...found);
        else if (found.length) clash = true;          // "Carson or Austin, TX" against "Carson, CA"
      }
      if (!hits.length) { ambiguous = ambiguous || (clash && !owned); continue; }
      // A far metro over the match voids it ("Walnut" inside "Walnut Creek").
      const outs = s.far.spans(probe);
      if (hits.every((h) => overlaps(h, outs))) continue;
      // So does a foreign place BESIDE it when no US state is named: "Dublin, Ireland" is
      // not the Dublin in an Ohio commute list. The match itself may be a foreign name
      // too ("Dublin" alone), which settles nothing.
      const trips = spansOf(RX.travel_phrase, probe);
      const abroad = [...spansOf(s.blocked, probe), ...spansOf(BLOCKED_CODES, probe)]
        .filter(([c]) => !trips.some(([a, b]) => a <= c && c < b));
      if (!tokens(probe).size && !RX.us.test(probe) && abroad.some((x) => !overlaps(x, hits))) continue;
      if ([...st].some((c) => !s.reachable.has(c))) { ambiguous = ambiguous || !owned; continue; }
      return 'pass';
    }
  }
  return ambiguous ? 'ambiguous' : null;
}

const hasAny = (set, pred) => [...set].some(pred);

/**
 * A far metro named as a place, not as a preference, an office or a trip ("Bay Area
 * preferred", "HQ in San Francisco"). _location.py Policy._far_here is the same.
 */
const farHere = (n, s) => s.far.spans(n).some(([a, b]) =>
  !RX.preference_after.test(n.slice(b)) && !RX.context_before.test(n.slice(0, a)));

/**
 * {v, why, kind} for one tokenised option: v is pass / fail / unknown.
 * scripts/_location.py Policy.classify() is the same function, step for step.
 */
function classifyNormalised(n, s, excluded = new Set(), whole = true) {
  const home = s.home;
  const remote = isRemote(n);
  const friendly = RX.remote_friendly.test(n);
  const [codes, rest] = exclusions(n);
  n = rest;
  if (remote) excluded.forEach((c) => codes.add(c));
  const homeOut = remote && !!home && codes.has(home);
  const named = tokens(n);
  const us = RX.us.test(n);
  const stay = noTravel(n);
  const foreign = (s.blocked.test(stay) || BLOCKED_CODES.test(stay)) && !named.size && !us;
  if (remote && !homeOut && !foreign && RX.nationwide.test(n)) return { v: 'pass', why: 'remote, open nationwide', kind: 'remote' };
  if (remote && whole) {
    const alts = n.split(ALT_SPLIT_RE);
    if (alts.length > 1) {
      for (const a of alts) {
        if (!isRemote(a)) continue;
        const r = classifyNormalised(a, s, codes, false);
        if (r.v === 'pass') return r;
      }
    }
  }
  const commute = commuteIn(n, s);
  if (commute === 'pass') return { v: 'pass', why: `${s.commuteLabel}, inside the commute ceiling`, kind: 'commute' };
  if (remote && !homeOut) {
    if (foreign) return { v: 'fail', why: 'remote, but only from outside the US', kind: 'foreign' };
    const scope = scopeOf(n);
    const metro = RX.metro_scope.exec(n);
    if (metro) {
      const st = [...tokens(metro[1])][0];
      const qual = metro[2];
      if (st === home && /\bmetro\b/i.test(qual)) {
        if (commuteIn(qual, s) === 'pass') return { v: 'pass', why: `remote within a ${s.commuteLabel} metro`, kind: 'remote' };
        if (s.far.test(qual)) {
          const label = qual.replace(/^[\s–—-]+|[\s–—-]+$/g, '').replace(/\s*\bmetro\b.*$/i, '');
          return { v: 'fail', why: `remote only within the ${label} metro, outside the commute`, kind: 'scoped' };
        }
        return { v: 'unknown', why: `remote within a ${s.homeName} metro the policy does not list; check whether it is inside the commute area`, kind: 'metro' };
      }
      scope.add(st);
    }
    if (scope.size) {
      const list = [...scope].sort().join(', ');
      if (hasAny(scope, (c) => s.reachable.has(c))) {
        if (farHere(n, s)) return { v: 'unknown', why: `remote in ${list}, naming a metro outside the commute; check whether the offer is limited to that metro`, kind: 'metro' };
        return { v: 'pass', why: `remote-US (scoped to ${list})`, kind: 'remote' };
      }
      if (!home) return { v: 'unknown', why: `remote is scoped to specific states (${list}) and no home state is configured in config/location.json to judge them`, kind: 'scoped' };
      return { v: 'fail', why: `remote is scoped to states the candidate cannot use (${list}), no ${s.homeName} entry`, kind: 'scoped' };
    }
    const mentioned = [...weakStates(n)].sort();
    const weak = mentioned.filter((c) => !s.reachable.has(c));
    if (weak.length) return { v: 'unknown', why: `remote, and it names ${weak.join(', ')} in a way that does not settle the scope`, kind: 'weak' };
    // Every state it names is one the candidate reaches, so whether that is the scope or
    // an office, the offer is open to them; unless the place is a far metro, which may
    // mean remote from within that metro only.
    if (mentioned.length) {
      if (farHere(n, s)) return { v: 'unknown', why: 'remote, naming a metro outside the commute; check whether the offer is limited to that metro', kind: 'metro' };
      return { v: 'pass', why: `remote, naming only ${mentioned.join(', ')}`, kind: 'remote' };
    }
    if (us || bareRemote(n)) return { v: 'pass', why: 'remote-US', kind: 'remote' };
    return { v: 'unknown', why: 'remote, but the region is not recognised', kind: 'unrecognised' };
  }
  if (homeOut) return { v: 'fail', why: `remote everywhere except ${s.homeName}`, kind: 'excluded' };
  if (RX.undetermined.test(n)) return { v: 'unknown', why: 'the posting has not settled the location', kind: 'undetermined' };
  if (foreign) return { v: 'fail', why: 'non-US country or city', kind: 'foreign' };
  if (commute === 'ambiguous') return { v: 'unknown', why: `names a ${s.commuteLabel} commute place, but the list may give it another state's; check which city is meant`, kind: 'ambiguous' };
  if (s.far.test(n)) return { v: s.onsiteElsewhere, why: `a metro outside the ${s.commuteLabel} commute`, kind: 'far' };
  if (hasAny(named, (c) => !s.reachable.has(c))) return { v: s.onsiteElsewhere, why: `US, outside the ${s.commuteLabel} commute ceiling and not remote`, kind: 'elsewhere' };
  if (named.size) return { v: 'unknown', why: `a place in ${s.homeName} the commute list does not name`, kind: 'unlisted' };
  if (friendly) return { v: 'unknown', why: `remote-friendly means recurring days at a named hub and none of them is inside the ${s.commuteLabel} ceiling; read the posting's in-office clause before judging`, kind: 'remote_friendly' };
  if (pureCountry(n, s)) return { v: 'unknown', why: 'a country, not a place', kind: 'country' };
  return { v: 'unknown', why: 'location not recognised', kind: 'unrecognised' };
}

const TO_API = { pass: 'accept', fail: 'reject', unknown: 'unknown' };

/**
 * Classify ONE location option: 'accept', 'reject' or 'unknown'.
 *
 * @param {string} option
 * @param {object} signals - from buildSignals()
 * @returns {'accept'|'reject'|'unknown'}
 */
export function classifyLocationOption(option, signals) {
  return TO_API[classifyNormalised(tokenize(option, signals.home, signals.blocked), signals).v];
}

/**
 * Is this option a remote offer scoped to somewhere unreachable? Used only by the
 * review-metro override, which exists for HQ-anchor metros and must not reach an
 * explicit eligibility statement.
 */
function isScopedRemote(option, signals) {
  const r = classifyNormalised(tokenize(option, signals.home, signals.blocked), signals);
  return r.kind === 'scoped';
}

/**
 * Decide a posting from its location options: any workable option wins.
 * scripts/_location.py Policy.decide() is the same function.
 *
 * @param {string|string[]} input - One string, or a structured option list.
 * @param {object} signals
 * @param {{company?: string, enrichmentFailed?: boolean}} [meta]
 * @returns {{verdict:'accept'|'reject'|'unknown', reason:string, options:string[]}}
 */
export function decideLocations(input, signals, meta = {}) {
  const raw = Array.isArray(input) ? input : [input];
  const all = raw.flatMap((item) => splitLocationOptions(String(item ?? '')));
  const options = all.filter((o) => !RX.placeholder.test(foldOption(o).raw));
  if (options.length === 0) {
    // Either an empty location or an unresolved "N Locations" placeholder. Both
    // mean "we do not know", and a placeholder specifically means the real
    // options were never fetched. Never guess here.
    const why = all.length ? 'unresolved multi-location placeholder' : 'no location given';
    return { verdict: 'unknown', reason: why, options: [] };
  }
  const norm = options.map((o) => tokenize(o, signals.home, signals.blocked));
  // An exclusion in an option of its own applies to the posting's remote options.
  const dangling = new Set(), kept = [];
  norm.forEach((n, i) => {
    if (!isRemote(n)) {
      const [got, rest] = exclusions(n);
      if (got.size && !rest.replace(/[^A-Za-z0-9]+/g, '')) { got.forEach((c) => dangling.add(c)); return; }
    }
    kept.push([options[i], n]);
  });
  const company = normalizeLocation(meta.company || '');
  const metroIsReviewable = signals.reviewMetroCompanies.some((c) => c && company.includes(c));
  const results = kept.map(([option, n]) => {
    const r = classifyNormalised(n, signals, new Set(dangling));
    // Some employers post a metro as the org's anchor while the team runs distributed
    // (confirmed at NVIDIA). For those, a hard-out metro is a question, not an answer.
    // It stops at a metro: a state-scoped REMOTE option is the employer stating who may
    // work the job, not an anchor. Scanner-only; see presets/README.md.
    if (r.v === 'fail' && metroIsReviewable && r.kind !== 'foreign' && r.kind !== 'scoped'
        && !isScopedRemote(option, signals)) {
      return { ...r, v: 'unknown', why: `${r.why} (a review-metro employer)` };
    }
    return r;
  });
  // A bare "Remote" beside options that are all foreign could be that country's.
  const bare = kept.map(([, n], i) => (isRemote(n) && bareRemote(n) ? i : -1)).filter((i) => i >= 0);
  const others = results.filter((_, i) => !bare.includes(i));
  if (bare.length && others.length && others.every((r) => r.kind === 'foreign')) {
    bare.forEach((i) => { results[i] = { v: 'unknown', why: 'a bare remote entry next to a non-US place; confirm which country the remote option covers before judging', kind: 'ambiguous' }; });
  }
  for (const want of ['pass', 'unknown', 'fail']) {
    const r = results.find((x) => x.v === want);
    if (r) return { verdict: TO_API[r.v], reason: r.why, kind: r.kind, options };
  }
  return { verdict: 'unknown', reason: 'no option could be read', options };
}

// ── Location policy ─────────────────────────────────────────────────
// config/location.json is the candidate's; presets/locations/ holds the templates. A
// missing config falls back to remote-us.json, which knows no home and no commute area:
// it accepts nationwide remote, asks about state-scoped remote, and rejects onsite.

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOCATION_PRESETS = join(HERE, 'presets', 'locations');
/** Where configuration lives: CAREER_OPS_CONFIG_DIR, else config/ beside this file. */
export const CONFIG_DIR = process.env.CAREER_OPS_CONFIG_DIR || join(HERE, 'config');

/** The configured location policy, or the neutral preset. */
export function loadLocationPolicy(path) {
  const cfg = join(CONFIG_DIR, 'location.json');
  const p = path ?? (existsSync(cfg) ? cfg : join(LOCATION_PRESETS, 'remote-us.json'));
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** The US-wide vocabulary every policy shares (remote words, states, foreign places). */
export function loadBaseSignals() {
  return JSON.parse(readFileSync(join(LOCATION_PRESETS, '_base-us.json'), 'utf8'));
}

/**
 * A location policy as the signal block buildSignals() reads.
 *
 * @param {object} policy - A location policy (see presets/locations/).
 * @param {object} [base] - The shared US vocabulary; loaded when omitted.
 */
export function locationFilterFromPolicy(policy, base = loadBaseSignals()) {
  const home = policy.home_state;
  // A home state written only as its code ("name": "TX", or no name at all) still has a
  // name, or "Austin, Texas" reads as some OTHER state and is rejected.
  const homeName = home && (!home.name || CODE_RE.test(home.name.trim()))
    ? base.states_by_code?.[String(home.code || home.name).toUpperCase()] ?? home.name
    : home?.name;
  return {
    remote_signals: base.remote_signals,
    us_wide_signals: base.us_wide_signals,
    us_state_signals: base.us_state_signals,
    blocked_geo: base.blocked_geo,
    home_state_signals: home ? [homeName, String(home.code || '').trim()].filter(Boolean) : [],
    states_by_code: base.states_by_code ?? {},
    commute_signals: policy.commute?.signals ?? [],
    commute_label: policy.commute?.label ?? 'Commute',
    hard_out_metro: [...(policy.same_state_out?.signals ?? []), ...(policy.hard_out_metro ?? [])],
    review_metro_companies: policy.review_metro_companies ?? [],
    onsite_outside_commute: policy.onsite_outside_commute ?? 'fail',
  };
}

/**
 * The location block the scanner should use: the policy's, with any non-empty key the
 * user set in portals.yml `location_filter` taking precedence. portals.yml no longer has
 * to carry a geofence at all; it can still override one list without restating the rest.
 */
export function effectiveLocationFilter(portalsFilter = {}, policy = loadLocationPolicy(),
  warn = (m) => console.error(m)) {
  const merged = locationFilterFromPolicy(policy);
  const ignored = [];
  for (const [k, v] of Object.entries(portalsFilter || {})) {
    // Two kinds of key are ignored rather than merged, and SAID to be ignored:
    //  - the California-era california_signals / socal_signals from an older template.
    //    Merged, they were UNIONED with the policy's home state and commute, so a Texas
    //    candidate kept California as home and Irvine as commutable.
    //  - upstream's generic allow / block / always_allow keys. Merged beside the policy's
    //    signal keys they were never consulted at all, silently.
    if (IGNORED_FILTER_KEYS.has(k)) { ignored.push(k); continue; }
    if (Array.isArray(v) ? v.length : v != null) merged[k] = v;
  }
  if (ignored.length) {
    warn(`location: portals.yml location_filter keys ${ignored.join(', ')} are ignored; `
      + 'config/location.json decides where you can work (see presets/README.md).');
  }
  return merged;
}
const IGNORED_FILTER_KEYS = new Set(['california_signals', 'socal_signals', 'allow', 'block',
  'always_allow', 'always_allow_scoped', 'block_hard']);

// ── Selftest ────────────────────────────────────────────────────────
// Run it with: node location-core.mjs --selftest
// This module is a library first, so the guard matters: an import must never
// run the cases.
//
// The config below is self-contained on purpose. portals.yml is user-layer and
// may be absent in a clean checkout, and test-all.mjs builds its own synthetic
// signal list that omits DC entirely, which is exactly why its location cases
// could not catch the bug these pin.
const SELFTEST_FILTER = {
  remote_signals: ['remote'],
  us_wide_signals: ['united states', 'usa', 'u.s.', 'us'],
  california_signals: ['california', 'ca'],
  // Kept for the shape of an older portals.yml block. The states themselves now come
  // from the shared grammar (_base-us.json states_by_code and territories_by_code), so
  // DC and the territories resolve whatever a filter lists here.
  us_state_signals: ['california', 'ca', 'georgia', 'ga', 'washington', 'wa',
    'north carolina', 'nc', 'pennsylvania', 'pa', 'massachusetts', 'ma',
    'indiana', 'in', 'wyoming', 'wy', 'new york', 'ny', 'texas', 'tx'],
  socal_signals: ['los angeles', 'irvine', 'anaheim', 'culver city', 'ontario, ca'],
  blocked_geo: ['canada', 'toronto', 'united kingdom', 'london', 'peru'],
  hard_out_metro: ['santa clara', 'san francisco', 'austin', 'washington dc', 'washington, dc'],
  review_metro_companies: ['ExampleCo'],
};

// [option, expected verdict, why this case exists]
const SELFTEST_OPTIONS = [
  // ── the bug ──
  // us_state_signals holds the 50 states and their codes and nothing else, so
  // DC raised no state signal and this shape read as plain remote-US. It is a
  // District of Columbia job and the candidate is in Southern California.
  ['US, DC, Remote', 'reject', 'DC is a scope, and it is not California'],
  // The same hole, one reordering out. This exact string is in
  // data/scan-history.tsv (CrowdStrike), inside a 49-option list that names
  // every state except California: the whole posting read as workable on the
  // strength of its DC entry alone.
  ['USA - Remote, DC', 'reject', 'the Autodesk/CrowdStrike spelling of the same scope'],
  // Territories are the same class of miss and there are five of them, which
  // is the argument for reading the slot instead of listing its values.
  ['US, PR, Remote', 'reject', 'Puerto Rico is a scope, and it is not California'],
  ['US, GU, Remote', 'reject', 'Guam'],
  ['US, VI, Remote', 'reject', 'US Virgin Islands'],
  ['US, AS, Remote', 'reject', 'American Samoa'],
  ['US, MP, Remote', 'reject', 'Northern Mariana Islands'],
  // The dotted country marker must be read as the country and not mistaken for
  // the two-letter subdivision, or "U.S., CA, Remote" would reject itself.
  ['U.S., DC, Remote', 'reject', 'dotted country marker, scoped body'],
  ['U.S., CA, Remote', 'accept', 'dotted country marker must not read as a scope'],

  // ── what must NOT move ──
  ['US, CA, Remote', 'accept', 'a California scope is the reachable one'],
  ['US, Remote', 'accept', 'unscoped nationwide remote covers California'],
  ['Remote, USA', 'accept', 'unscoped, reordered'],
  ['Remote - US', 'accept', 'unscoped, dash-separated'],
  ['Remote (US)', 'accept', 'unscoped, parenthesised'],
  ['US Remote', 'accept', 'unscoped, no punctuation at all'],
  ['Remote', 'accept', 'remote-anywhere'],
  // The documented precedence case: an incidental foreign mention must not
  // outrank an explicit US-remote offer, and a prose field is not a scope.
  ['Remote, US (occasional travel to London)', 'accept', 'prose field is not a subdivision'],
  ['Remote - US East', 'accept', 'a region blurb is not a subdivision slot'],
  ['United States, UNITED STATES, United States, Remote', 'accept', 'real corpus string, all country fields'],

  // ── multi-country remote: the false rejects a looser rule caused ──
  // These are the reason the scope read is anchored on the country marker
  // coming FIRST rather than on "any two-letter field". Every one of them
  // offers the US among several countries or regions, so a Californian can
  // take it, and every one of them was rejected by the first cut of the fix.
  // A false reject hides the job for good, which is the expensive direction.
  ['Remote: US, UK, Canada', 'accept', 'UK is an alternative country, not a US subdivision'],
  ['Remote - US, EU', 'accept', 'the remote word leads, so EU is an alternative'],
  ['Remote, US, ET', 'accept', 'a timezone in the tail is not a subdivision slot'],
  ['Remote - US (PT)', 'accept', 'Pacific-time remote-US is the ideal case, not a reject'],
  ['Remote - US/UK', 'accept', 'slash means "or", so it is never a field boundary'],

  // ── the state path that already worked, kept honest ──
  ['US, GA, Remote', 'reject', 'the shape that was already rejected'],
  ['USA - Remote, WY', 'reject', 'state code in the reordered spelling'],
  ['Pennsylvania, USA - Remote', 'reject', 'Autodesk spells the state out'],
  ['Remote Massachusetts', 'reject', 'Adobe writes it with no punctuation'],
  ['Indiana - Remote', 'reject', 'Salesforce leads with the state'],

  // ── the contract: unambiguous rejects only ──
  // A scope named in words that no list here recognises stays a question. It
  // reaches triage instead of disappearing, because a false reject hides a job
  // permanently and a false accept costs one line.
  // This used to be a scope nobody could resolve, and stayed a question. DC is now folded
  // to a name the gate knows, so it resolves: a DC-scoped role is out for a Californian.
  ['Remote - District of Columbia', 'reject', 'a DC scope resolves, and it is not California'],
  ['Ontario, CAN - Remote', 'reject', 'CAN is Canada\'s country code: a Canadian remote offer, as eval-prep reads it'],

  // ── older guards that run through the same code path ──
  ['Toronto, CA', 'reject', 'CA is Canada here, not California'],
  ['Ontario, CA', 'accept', 'Ontario, California, not the province'],
  ['US, CA, Santa Clara', 'reject', 'onsite Bay Area'],
  ['Washington, DC', 'reject', 'onsite DC via hard_out_metro'],
  ['Peru - Remote', 'reject', 'foreign-scoped remote'],
];

// [options, expected verdict, why, meta]
const SELFTEST_POSTINGS = [
  // The headline: NVIDIA's real option list, which has no California entry.
  // It came back accept on the DC option alone.
  [['US, CA, Santa Clara', 'US, GA, Remote', 'US, DC, Remote', 'US, NC, Remote', 'US, WA, Remote'],
    'reject', 'no California entry anywhere in the list'],
  // The same list plus the one option that does make it workable. If this ever
  // goes red the fix has become a blanket reject on scoped remote.
  [['US, CA, Santa Clara', 'US, GA, Remote', 'US, DC, Remote', 'US, CA, Remote'],
    'accept', 'a CA-remote sibling makes the posting workable'],
  // Nationwide plus scoped: the nationwide option still carries it.
  [['US, DC, Remote', 'US, Remote'], 'accept', 'an unscoped option covers California'],

  // ── the review-metro override, which nearly swallowed the whole fix ──
  // At a review-metro employer that rule used to downgrade EVERY non-foreign
  // reject to unknown, so the DC option came back as a question for exactly the
  // employer the bug was found on. The override is about HQ-anchor
  // metros; a state-scoped remote is an eligibility statement, not an anchor.
  [['US, GA, Remote', 'US, DC, Remote', 'US, NC, Remote', 'US, WA, Remote'],
    'reject', 'scoped remote is not an HQ anchor, even at a review-metro employer',
    { company: 'ExampleCo' }],
  // What the override IS for, and must keep doing: an employer that posts its HQ
  // metro on reqs whose team is actually distributed.
  [['US, CA, Santa Clara'], 'unknown', 'an HQ metro stays a question at a review-metro employer',
    { company: 'ExampleCo' }],
  [['US, TX, Austin'], 'unknown', 'any hard-out metro stays a question there',
    { company: 'ExampleCo' }],
  [['US, CA, Santa Clara'], 'reject', 'no review policy for other employers',
    { company: 'Roblox' }],
];

const invokedDirectly = isMain(import.meta.url);

if (invokedDirectly) {
  // Every writing script in this repo refuses an argument it does not
  // understand; a library with one flag should not be the exception.
  const flags = process.argv.slice(2);
  const unrecognised = flags.filter(f => f !== '--selftest');
  if (unrecognised.length || !flags.includes('--selftest')) {
    console.error('location-core.mjs is a library. The only supported invocation is:\n'
      + '  node location-core.mjs --selftest');
    process.exit(2);
  }

  const signals = buildSignals(SELFTEST_FILTER);
  let bad = 0;
  for (const [option, want, why] of SELFTEST_OPTIONS) {
    const got = classifyLocationOption(option, signals);
    if (got !== want) {
      bad++;
      console.log('FAIL  option ' + JSON.stringify(option)
        + '\n      got ' + got + ', want ' + want + ' (' + why + ')');
    }
  }
  for (const [options, want, why, meta] of SELFTEST_POSTINGS) {
    const got = decideLocations(options, signals, meta || {}).verdict;
    if (got !== want) {
      bad++;
      console.log('FAIL  posting [' + options.join(' + ') + ']'
        + '\n      got ' + got + ', want ' + want + ' (' + why + ')');
    }
  }
  // The same rules driven by a POLICY rather than a hand-built block: the California
  // preset through the loader, a Texas policy built the way setup.mjs builds one, and a
  // policy with no home state at all. If a branch above still assumed California, the
  // Texas cases would say so.
  const ca = buildSignals(locationFilterFromPolicy(
    loadLocationPolicy(join(LOCATION_PRESETS, 'california-socal.json'))));
  const tx = buildSignals(locationFilterFromPolicy({
    home_state: { code: 'TX', name: 'Texas' },
    commute: { signals: ['Austin', 'Round Rock'] },
    same_state_out: { signals: ['Houston'] }, hard_out_metro: ['Seattle'],
  }));
  const none = buildSignals(locationFilterFromPolicy(
    loadLocationPolicy(join(LOCATION_PRESETS, 'remote-us.json'))));
  const unsure = buildSignals({ ...locationFilterFromPolicy({
    home_state: { code: 'TX', name: 'Texas' }, commute: { signals: ['Austin'] } }),
  onsite_outside_commute: 'unknown' });
  const policy = (home, commute = []) => buildSignals(locationFilterFromPolicy({
    home_state: home, commute: { signals: commute } }));
  const POLICY_CASES = [
    [ca, 'US, CA, Remote', 'accept', 'CA preset: home-state remote'],
    [ca, 'Irvine, CA', 'accept', 'CA preset: inside the commute'],
    [ca, 'Santa Clara, CA', 'reject', 'CA preset: same-state metro outside the commute'],
    [ca, 'US, TX, Remote', 'reject', 'CA preset: another state\'s remote'],
    [tx, 'US, TX, Remote', 'accept', 'TX: home-state remote'],
    [tx, 'US, CA, Remote', 'reject', 'TX: California remote is out of reach'],
    [tx, 'Round Rock, TX', 'accept', 'TX: inside the commute'],
    [tx, 'Houston, TX', 'reject', 'TX: same-state metro outside the commute'],
    [tx, 'Irvine, California', 'reject', 'TX: onsite in another state'],
    [tx, 'Seattle', 'reject', 'TX: hard-out metro'],
    [none, 'US, GA, Remote', 'unknown', 'no home state: scoped remote is a question'],
    [none, 'US, Remote', 'accept', 'no home state: nationwide remote passes'],
    [unsure, 'Denver, CO', 'unknown', 'onsite_outside_commute: unknown asks instead'],
    // English words that are also state codes. Matched case-insensitively they made the
    // scanner drop SoCal and remote-US roles, and made OR and IN homes pass other states.
    [ca, 'Hybrid in Irvine', 'accept', '"in" is a word here, not Indiana'],
    [ca, 'Irvine or Remote', 'accept', '"or" is a word here, not Oregon'],
    [ca, 'Remote in US', 'accept', 'nationwide remote written with "in"'],
    [ca, 'US Remote or Hybrid', 'accept', 'nationwide remote written with "or"'],
    [ca, 'Irvine, CA 92618', 'accept', 'a code followed by a ZIP is still a slot'],
    [ca, 'Glendale, AZ (Onsite)', 'reject', 'a code followed by "(" is still a slot'],
    [policy({ code: 'OR', name: 'Oregon' }), 'Remote - Washington or California', 'reject',
      'an Oregon home does not make the word "or" a home match'],
    [policy({ code: 'IN', name: 'Indiana' }), 'Remote in Texas', 'reject',
      'an Indiana home does not make the word "in" a home match'],
    [policy({ code: 'OR', name: 'Oregon' }), 'US, OR, Remote', 'accept', 'the real Oregon slot'],
    // US cities that share a name with a foreign place, and New Mexico.
    [policy({ code: 'OH', name: 'Ohio' }, ['Columbus', 'Dublin']), 'Dublin, OH', 'accept',
      'Dublin, Ohio is not Ireland'],
    [policy({ code: 'NM', name: 'New Mexico' }, ['Albuquerque']), 'Albuquerque, New Mexico', 'accept',
      'New Mexico is not Mexico'],
    [ca, 'Toronto, CA', 'reject', 'CA stays ambiguous with Canada, so Toronto is still blocked'],
    // Out-of-range metros inside the home state.
    [ca, 'Walnut Creek, CA', 'reject', 'Walnut Creek is the Bay Area, not Walnut'],
    [ca, 'California - San Francisco Metro - Remote', 'reject', 'metro-scoped home remote, out of range'],
    [ca, 'California - San Diego Metro - Remote', 'reject', 'metro-scoped home remote, out of range'],
    [ca, 'California - Los Angeles Metro - Remote', 'accept', 'metro-scoped home remote, in range'],
    // DC is not Washington state.
    [policy({ code: 'WA', name: 'Washington' }, ['Seattle']), 'Remote - Washington, DC', 'reject',
      'a DC scope is not the Washington home state'],
    [policy({ code: 'WA', name: 'Washington' }, ['Seattle']), 'Washington, DC', 'reject',
      'onsite DC is another place'],
  ];
  for (const [sig, option, want, why] of POLICY_CASES) {
    const got = classifyLocationOption(option, sig);
    if (got !== want) {
      bad++;
      console.log('FAIL  policy option ' + JSON.stringify(option)
        + '\n      got ' + got + ', want ' + want + ' (' + why + ')');
    }
  }
  // effectiveLocationFilter: a portals.yml override replaces one list and keeps the rest,
  // and legacy or generic keys are ignored out loud, never unioned or silently dropped.
  const warned = [];
  const eff = effectiveLocationFilter(
    { commute_signals: ['Round Rock'], california_signals: ['California', 'CA'],
      socal_signals: ['Irvine'], allow: ['austin'] },
    { home_state: { code: 'TX', name: 'Texas' }, commute: { signals: ['Austin'] } },
    (m) => warned.push(m));
  const effSig = buildSignals(eff);
  const effChecks = [
    ['an override list replaces the policy list', eff.commute_signals.join() === 'Round Rock'],
    ['the other policy lists are kept', eff.home_state_signals.includes('Texas')],
    ['legacy California keys are not unioned into home', !('california_signals' in eff)
      && classifyLocationOption('US, CA, Remote', effSig) === 'reject'],
    ['ignored keys are reported', warned.length === 1 && /california_signals/.test(warned[0])
      && /socal_signals/.test(warned[0]) && /allow/.test(warned[0])],
  ];
  for (const [label, ok] of effChecks) {
    if (!ok) { bad++; console.log('FAIL  effectiveLocationFilter: ' + label); }
  }
  const total = SELFTEST_OPTIONS.length + SELFTEST_POSTINGS.length + POLICY_CASES.length;
  console.log(bad
    ? '\n' + bad + ' of ' + total + ' cases failed'
    : 'all ' + SELFTEST_OPTIONS.length + ' option cases, '
      + SELFTEST_POSTINGS.length + ' posting cases and ' + POLICY_CASES.length
      + ' policy cases pass');
  process.exit(bad ? 1 : 0);
}
