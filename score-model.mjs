#!/usr/bin/env node
/**
 * score-model.mjs — the single source of truth for the scoring rubric.
 *
 * Adopted 2026-07-27. Five models were each tuned in isolation over this session;
 * this wires them into one formula so the board is computed one way everywhere.
 * They interact, so applying them piecemeal gives a different board than applying
 * them together — that is why they land in a single re-score.
 *
 *     base   = average(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj
 *     final  = min(5, base * compFactor * prefFactor * arrFactor)
 *
 * 1. base — unchanged from the documented rubric, and still the whole score when
 *    no modifier applies. Recomputed from the four dimensions rather than trusted
 *    from the stated global, because the 2026-07-20 double-count fix corrected by
 *    delta instead of re-deriving and left the two disagreeing across the board.
 *
 * 2. compFactor — a gate, not a dimension. Sub-floor pay scales the whole score by
 *    (achievable/floor)^K so the penalty tracks HOW FAR under the floor a role is.
 *    At/above floor it is exactly 1, so comp's upside still lives in the average:
 *    an earlier version that moved comp out of the average and used it only as a
 *    multiplier destroyed the reward for roles paying 3-4x the floor.
 *
 * 3. prefFactor — 1 + (preference * STEP), preference 0.0-1.0 in 0.1 steps from
 *    config/profile.yml. Preference is how much the candidate wants to work somewhere, which
 *    no dimension measures. It is NOT culture: cultural_signals already tracks
 *    cited Glassdoor at r=0.77, so a second culture lever would double-count.
 *
 * 4. role-type gate — a company multiplier cannot tell an AI/ML engineering req
 *    from a DevRel req at the same company. De-prioritised customer-facing titles
 *    keep only DAMP of their company preference.
 *
 * 5. arrFactor — remote outranks hybrid, expressed by damping hybrid rather than
 *    boosting remote. Identical relative gap; boosting remote would lift 96 of 142
 *    rows and just lower the effective cutoff. Onsite stays at 1.0: arrangement is
 *    a proxy for commute, and a 14-mile onsite beats a 35-mile hybrid.
 *
 * PREFERENCE IS NOT A GATE. None of these rescue a role that fails a hard
 * constraint (no-relocation, liveness). They reorder roles that already clear them.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// --- the candidate, from config/profile.yml ----------------------------------
//
// The floor used to be a literal here, beside a comment calling it "the
// config/profile.yml minimum" while nothing read that file. A floor is a household
// constraint, not a model parameter, so it lives with the candidate's other facts.
//
// Only the TOP-LEVEL `compensation.minimum` counts. Profiles carry per-track
// `alternate_ranges` with their own `minimum:` one level deeper, and reading those would
// gate every req against another track's number.
//
// The profile is read with a YAML parser. It used to be read with regexes over the text,
// and a name with an apostrophe, a colon or a "#" came back empty, while a preferred
// company such as "O'Reilly Media" or "Acme: Labs" was dropped without a word. A profile
// that is not valid YAML is an error, loudly, because reading half of it is how a floor
// or a preference silently goes missing.
// A comp FIGURE, read the same way in setup.mjs, scripts/eval-prep.py and score-model.mjs:
// digits with optional thousands commas and one optional decimal part, then an optional K
// or M. A bare number under 10,000 is a level, a year fragment or a footnote, never
// dollars, and is skipped. Three readers once took three different figures from
// "L5 USD 180K" (5K, 180K, 180K) and "$150,000..." crashed one of them.
const toKFig = (raw) => {
  for (const m of String(raw).replace(/#.*/, '').matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?/g)) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v) || v <= 0) continue;
    const s = (m[2] || '').toLowerCase();
    if (s === 'k') return v;
    if (s === 'm') return v * 1000;
    if (v < 10000) continue;
    return v / 1000;
  }
  return null;
};
// Where configuration lives. CAREER_OPS_CONFIG_DIR overrides it, which is how the test
// suite runs against no configuration at all regardless of whose files are installed.
// Beside this file, not relative to the working directory: run from anywhere else, a
// cwd-relative 'config' silently found no profile and scored with no comp gate.
export const CONFIG_DIR = process.env.CAREER_OPS_CONFIG_DIR
  || join(dirname(fileURLToPath(import.meta.url)), 'config');
function readProfile(dir) {
  const p = join(dir, 'profile.yml');
  if (!existsSync(p)) return null;
  let doc;
  try {
    doc = yaml.load(readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new Error(`${p} is not valid YAML (${e.reason || e.message}); fix it or re-run node setup.mjs`);
  }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}
export function loadCandidate(dir = CONFIG_DIR) {
  const out = { firstName: '', pastEmployers: [], compFloorK: null };
  const doc = readProfile(dir);
  if (!doc) return out;
  const cand = doc.candidate && typeof doc.candidate === 'object' ? doc.candidate : {};
  out.firstName = String(cand.full_name ?? '').trim().split(/\s+/)[0] || '';
  out.pastEmployers = (Array.isArray(cand.past_employers) ? cand.past_employers : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  const comp = doc.compensation;
  if (comp && typeof comp === 'object' && comp.minimum != null) out.compFloorK = toKFig(comp.minimum);
  return out;
}
export const CANDIDATE = loadCandidate();

/**
 * The role-type gate: titles this search de-prioritises, from the `_role_gate` section of
 * config/lane-vocab.json (see presets/lanes/). A matching title keeps only ROLE_DAMP of
 * its company preference. No vocabulary, or no `_role_gate` in it, means no gate: a
 * preference for some titles over others is the candidate's, never a default.
 */
export function loadRoleGate(path) {
  const cfg = join(CONFIG_DIR, 'lane-vocab.json');
  const p = path ?? (existsSync(cfg) ? cfg : null);
  if (!p) return null;
  const pat = JSON.parse(readFileSync(p, 'utf-8'))._role_gate?.pattern;
  return pat ? new RegExp(pat, 'i') : null;
}

export const MODEL = {
  // $K TOTAL comp, from config/profile.yml `compensation.minimum`. null = no floor
  // configured, and then no comp gate: an absent number is not a zero.
  COMP_FLOOR: CANDIDATE.compFloorK,
  COMP_K: 1.5,       // sub-floor curve; 2.0 was harsher than intended
  COMP_BAND: 0.75,   // a strong senior negotiates into the upper band, not the ceiling
  // NOTE: there is deliberately no base-to-total ratio here. An earlier version
  // multiplied the floor by 0.85 to compare base figures against it, which was a
  // guess wearing a decimal point: the base/total ratio is not a constant, it is
  // the difference between a studio paying base+10% and a big-tech RSU package
  // worth double the base. See compVerdict for what replaced it.
  PREF_STEP: 0.08,   // preference 1.0 -> x1.08
  ROLE_DAMP: 0.25,   // de-prioritised titles keep this share of company preference
  ROLE_GATE: loadRoleGate(),  // which titles are de-prioritised; null = no gate
  // Work arrangement is ranked remote > hybrid > onsite (2026-07-30). Remote is the
  // neutral 1.0 rather than a boost, so the ranking is expressed as two damps and no
  // existing remote score shifts. Onsite takes twice the hybrid penalty: with a hard
  // no-relocation constraint, a desk requirement is a standing cost every week, where
  // hybrid is a partial one. `unknown` stays neutral — absence of evidence is not onsite.
  HYBRID_DAMP: 1 / 1.03,
  ONSITE_DAMP: 1 / 1.06,
};

// --- comp -------------------------------------------------------------------

const toK = (tok) => {
  const m = String(tok).match(/([\d,.]+)\s*([KkMm]?)/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  const s = (m[2] || '').toLowerCase();
  if (s === 'm') v *= 1000;
  else if (s !== 'k' && v >= 1000) v /= 1000;
  return v;
};

const RANGE = /\$\s*[\d,.]+\s*[KkMm]?\s*(?:-|–|—|to)\s*\$?\s*[\d,.]+\s*[KkMm]?/g;
// The candidate's own numbers must never be read as the role's pay. The generic cues
// are joined by the candidate's first name and past employers from config, since
// report prose introduces their own figures that way ("at Studio X she earned...").
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN = new RegExp(['target', 'floor', '\\bvs\\b', '\\b(?:his|her|their|my)\\b',
  'step-?down', 'current', 'prior', 'expect',
  ...[CANDIDATE.firstName, ...CANDIDATE.pastEmployers].filter(Boolean)
    .map(w => '\\b' + escRe(w) + '\\b')].join('|'), 'i');
// Nor may a figure the report cites for a DIFFERENT role. Reports routinely quote a
// comparable, a levels.fyi median or an adjacent req to argue the posted band is
// under- or over-indexed. One row was gated at x0.49 off "the visible remote
// tools comparable was $82-130K", a role the report explicitly says is not this
// seat. Needs a wider lookback than OWN: the qualifier often opens the sentence.
const OTHER_ROLE = /\b(comparable|benchmark|under-?indexed|over-?indexed|similar role|market rate|levels\.fyi|glassdoor (?:estimate|reports)|median (?:total )?comp|competing|related|variant|adjacent|previous|prior role|the closed|that role|for context)\b/i;

/**
 * Posted compensation band in $K, or null when the report states none.
 *
 * Prefers an explicit machine-readable total: `comp_total_est: $210K-$260K`.
 * That field is the ONLY way a report can arm the comp gate, because prose
 * extraction of total comp proved unreliable in both directions — it read
 * another role's comparable as this role's pay, and read the candidate's own threshold
 * ("clears the $NNNK bar") as the employer's offer. An evaluator writing the field has read the whole
 * posting including equity; a regex has not.
 */
export function compBand(text) {
  const mt = text.match(/^[ \t]*comp_total_est(?:imate)?:\s*["']?([^\n"']+)/im);
  if (mt) {
    const parts = mt[1].match(/[\d,.]+\s*[KkMm]?/g) || [];
    if (parts.length) {
      const lo = toK(parts[0]);
      const hi = parts.length > 1 ? toK(parts[parts.length - 1]) : lo;
      if (lo && hi && hi >= lo && lo > 30 && hi < 3000) return { lo, hi, basis: 'total' };
    }
  }
  const mp = text.match(/comp_(?:posted|range|estimate)[^\n]*/i);
  for (const chunk of [mp ? mp[0] : '', text]) {
    if (!chunk) continue;
    for (const m of chunk.matchAll(RANGE)) {
      if (OWN.test(chunk.slice(Math.max(0, m.index - 40), m.index))) continue;
      // No band at all yields factor 1, i.e. no penalty, so erring toward
      // skipping an ambiguous figure fails safe.
      if (OTHER_ROLE.test(chunk.slice(Math.max(0, m.index - 130), m.index))) continue;
      const parts = m[0].match(/[\d,.]+\s*[KkMm]?/g) || [];
      if (parts.length < 2) continue;
      const lo = toK(parts[0]);
      const hi = toK(parts[parts.length - 1]);
      if (lo && hi && hi >= lo && lo > 30 && hi < 2000) {
        // Is this figure base-only or total? Read the words around it. "total"
        // wins when both appear, e.g. "base $150K, total $250K".
        const near = chunk.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
        const isTotal = /\btotal (?:comp|compensation|package)\b|\bOTE\b|\ball-in\b|\bincluding (?:bonus|equity|RSU)/i.test(near);
        const isBase = /\bbase\b|\bbase salary\b|\bbase pay\b|\bsalary range\b/i.test(near);
        const basis = isTotal ? 'total' : isBase ? 'base' : 'unknown';
        return { lo, hi, basis };
      }
    }
  }
  return null;
}

/**
 * The comp gate, with its reasoning made explicit.
 *
 * The floor is TOTAL compensation. So the gate may only fire on evidence about
 * TOTAL compensation. That single rule decides every case:
 *
 *   no figure            -> unverified, factor 1. Silence is not evidence.
 *   base/unknown, clears -> clears, factor 1. Base is a LOWER BOUND on total, so
 *                           base alone over the floor means total is over it too.
 *   base/unknown, under  -> UNVERIFIED, factor 1. This is the case that matters:
 *                           a base under the floor says nothing about total,
 *                           because bonus and equity are unknown and vary from
 *                           +10% at a studio to +100% at big tech. Penalising
 *                           here is guessing, and it guessed wrong on real rows
 *                           (an NVIDIA req whose RSUs clear the floor outright
 *                           was gated at x0.90 on its base band).
 *   total, clears        -> clears, factor 1.
 *   total, under         -> GATED. Real evidence, real penalty, scaled by the
 *                           shortfall via (achievable/floor)^K.
 *
 * The cost of this is that a genuinely underpaying role which only publishes base
 * escapes the gate. That is the right trade: it stays visible and is judged on
 * its comp DIMENSION, which is scored by a human reading the whole posting,
 * rather than being sunk by a regex that cannot see the equity.
 */
export function compVerdict(band, o = MODEL) {
  if (!band) return { factor: 1, status: 'no-figure' };
  if (!(o.COMP_FLOOR > 0)) return { factor: 1, status: 'no-floor' };
  const achievable = band.lo + (band.hi - band.lo) * o.COMP_BAND;
  if (achievable >= o.COMP_FLOOR) return { factor: 1, status: 'clears', achievable };
  if (band.basis !== 'total') return { factor: 1, status: 'unverified', achievable };
  return { factor: Math.pow(achievable / o.COMP_FLOOR, o.COMP_K), status: 'gated', achievable };
}

/** Convenience wrapper: the multiplier alone. */
export function compFactor(band, o = MODEL) {
  return compVerdict(band, o).factor;
}

// --- company preference -----------------------------------------------------

export function loadPrefs(dir = CONFIG_DIR) {
  const block = readProfile(dir)?.company_preference;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
  const out = [];
  for (const [name, raw] of Object.entries(block)) {
    const v = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(v) || v < 0 || v > 1 || !String(name).trim()) continue;
    out.push([new RegExp('^' + String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), v]);
  }
  // Longest name first: "Acme Games" must not be shadowed by "Acme".
  return out.sort((a, b) => String(b[0]).length - String(a[0]).length);
}

export function preference(company, prefs) {
  for (const [re, v] of prefs) if (re.test(company)) return Math.round(v * 10) / 10;
  return 0;
}

/** The configured role-type gate (see loadRoleGate), or null when none is configured. */
export const DEPRIORITISED = MODEL.ROLE_GATE;

export function prefFactor(company, role, prefs, o = MODEL) {
  let pref = preference(company, prefs);
  const damped = pref > 0 && !!o.ROLE_GATE && o.ROLE_GATE.test(role || '');
  if (damped) pref = Math.round(pref * o.ROLE_DAMP * 10) / 10;
  return { factor: 1 + pref * o.PREF_STEP, pref, damped };
}

// --- work arrangement -------------------------------------------------------

const RE_REMOTE = /\bremote\b|\bwork from home\b|\bwfh\b|\bfully distributed\b/i;
const RE_HYBRID = /\bhybrid\b/i;
// Hybrid offered as an alternative or a perk is not a hybrid role: "Remote - US
// (optional hybrid Tue-Thu, not mandatory)" is remote. Only a mandatory in-office
// cadence, or hybrid as the leading framing, makes it hybrid.
const RE_HYB_OPT = /\b(optional|not mandatory|not required|also|or)\s+hybrid\b|\bhybrid\b[^.;]{0,40}\b(optional|not mandatory|not required|available|if (?:you )?prefer)\b/i;
// A MANDATED share of office time is hybrid even when the posting leads with "Remote".
// One employer's own string is "Remote-Friendly (Travel-Required)" and its JD says verbatim
// "Location-based hybrid policy: Currently, we expect all staff to be in one of our
// offices at least 25% of the time" -- the employer calls it hybrid. Reading only the
// leading "Remote-Friendly" put rows with this exact posture on arrFactor 1.0, purely
// because their reports happened not to quote the word "Hybrid" from the Greenhouse
// metadata the way a sibling row's report did (found 2026-07-31).
const RE_HYB_REQ = /\bhybrid\b[^.;]{0,40}\b(required|mandatory|expected)\b|\bhybrid policy\b|\btravel[- ]required\b|\b\d{1,2}\s*%[^.;]{0,30}\b(?:office|in[- ]office|on-?site)\b|\b(?:office|in[- ]office|on-?site)[^.;]{0,30}\bat least \d{1,2}\s*%|\b\d\s*days?\s*(?:a|per)\s*week\b[^.;]{0,30}\b(?:on-?site|in[- ]office)\b|\b(?:on-?site|in[- ]office)\b[^.;]{0,30}\b\d\s*days?\s*(?:a|per)\s*week\b/i;
// Hybrid stated as the role's OWN descriptor ("This role is a hybrid work position") is
// hybrid, wherever it sits in the string. The remote branch below used to require the text
// to START with "hybrid" (/^\s*hybrid/), so one tracked row -- "Irvine, CA - hybrid. Verbatim:
// This role is a hybrid work position..." -- classified REMOTE and escaped the hybrid damp.
// The word "remote" appearing anywhere was enough to win, even when it appeared inside a
// NEGATION quoted as evidence ("no jobLocationType: REMOTE"). A declarative hybrid beats an
// incidental "remote" mention (found 2026-08-03).
const RE_HYB_DECL = /\bhybrid\b\s*(?:work\s*)?(?:position|role|schedule|model|arrangement)\b|\b(?:this|the)\s+(?:role|position)\s+is\s+(?:a\s+)?hybrid\b/i;
const RE_ONSITE = /\bon-?site\b|\bin-?office\b|\bin person\b/i;
// "onsites" (plural, i.e. company gatherings) was listed here as a travel cue, but it also
// matched the bare word "onsite" and so trip-wired the onsite branch: a location reading
// simply "Onsite role." classified as UNKNOWN and escaped the onsite damp entirely
// (found 2026-07-30). It was redundant anyway — RE_ONSITE's \bon-?site\b cannot match the
// plural. Removed so onsite text classifies as onsite.
const RE_TRAVEL = /\b(travel|periodic|quarterly|occasional)\b/i;
// "City, ST" or "City ST" — the comma is optional because real reports write
// both ("Costa Mesa CA ~20mi", "Santa Clara, CA"). Requiring it left 29 reports
// with a perfectly clear office location classified `unknown`, which scores an
// onsite role as if it were remote (arrFactor 1.0 instead of the onsite damp).
//
// Loosening this is safe BECAUSE it is the last fallback: it is only consulted
// after remote, hybrid and explicit on-site signals have all failed to match, so
// a remote posting that happens to name an HQ city has already returned 'remote'
// before reaching here.
//
// A bare city with no state is still `unknown` on purpose — "Los Angeles (West
// LA HQ)" reads as onsite to a human, but inferring that from a city name alone
// would also catch a remote role that merely names where the team sits.
// The state part is a real US state-code list, not `[A-Z]{2}`. With a bare
// `[A-Z]{2}` and the comma optional, any two capitals following a capitalised
// word matched: "Los Angeles (West LA HQ)" parsed as city "West" + state "LA",
// and "Vision Products HQ" would have matched just as happily. Same class of
// bug as a bare token matching two different places.
//
// "LA" stays in the list because it IS Louisiana. In this corpus it almost
// always abbreviates Los Angeles instead — but both readings are an office, so
// the onsite verdict is correct either way.
const US_STATE_CODE = '(?:A[LKZR]|C[AOT]|DE|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])';
const RE_CITY = new RegExp(`\\b[A-Z][a-z]+(?:\\s[A-Z][a-z]+)*,?\\s+(?:${US_STATE_CODE}\\b|California|Washington|New York|Texas)`);

export function locationText(text) {
  const ms = text.match(/^\s*location(?:_final|_viable|_verdict)?:\s*["']?([^\n"']+)/im);
  const hd = text.match(/^\*\*Location:\*\*\s*([^\n]+)/im);
  return ((ms ? ms[1] : '') + ' ' + (hd ? hd[1] : '')).trim();
}

export function arrangement(text) {
  if (!text || !text.trim()) return 'unknown';
  const optional = RE_HYB_OPT.test(text);
  if (RE_HYB_REQ.test(text) && !optional) return 'hybrid';
  if (RE_HYB_DECL.test(text) && !optional) return 'hybrid';
  if (RE_REMOTE.test(text)) {
    if (RE_HYBRID.test(text) && !optional && /^\s*hybrid/i.test(text.trim())) return 'hybrid';
    return 'remote';
  }
  if (RE_HYBRID.test(text)) return 'hybrid';
  if (RE_ONSITE.test(text) && !RE_TRAVEL.test(text)) return 'onsite';
  if (RE_CITY.test(text)) return 'onsite';
  return 'unknown';
}

export function arrFactor(arr, o = MODEL) {
  if (arr === 'hybrid') return o.HYBRID_DAMP;
  if (arr === 'onsite') return o.ONSITE_DAMP;
  return 1;   // remote, and unknown (never penalise an unclassified location)
}

// --- combined ---------------------------------------------------------------

/**
 * Apply every modifier to a base score.
 * @param base  average(4 dims) + red_flags_adj, already computed
 * @param ctx   {text, company, role, prefs, arrangement}
 *
 * ctx.arrangement, when given, is TRUSTED over re-deriving it from ctx.text. That makes
 * recomputation idempotent, which it was not.
 *
 * The failure it fixes: eval-write computes the arrangement at write time from the clean
 * packet location ("Los Angeles, California" -> onsite, x0.943) but then writes a
 * location_final that is prose ("Los Angeles is the lead location. Santa Monica area,
 * inside the SoCal commute ceiling."). Re-deriving from that prose finds no "City, State"
 * pattern and returns 'unknown', whose factor is 1. So every later apply-model run
 * silently RAISED every onsite and hybrid row, on 11 rows the day this was found. Nothing
 * in either tool was wrong in isolation; the arrangement simply was never persisted, so
 * the second reader could not see what the first one decided.
 */
export function applyModel(base, ctx, o = MODEL) {
  if (base === null || !Number.isFinite(base)) return null;
  const band = compBand(ctx.text || '');
  const cv = compVerdict(band, o);
  const cf = cv.factor;
  const { factor: pf, pref, damped } = prefFactor(ctx.company || '', ctx.role || '', ctx.prefs || [], o);
  const arr = ctx.arrangement && ctx.arrangement !== 'unknown'
    ? ctx.arrangement
    : arrangement(locationText(ctx.text || ''));
  const af = arrFactor(arr, o);
  const final = Math.min(5, base * cf * pf * af);
  return {
    base, final: Math.round(final * 100) / 100,
    compFactor: cf, prefFactor: pf, arrFactor: af,
    band, pref, damped, arrangement: arr, compStatus: cv.status,
  };
}
