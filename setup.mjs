#!/usr/bin/env node
/**
 * setup.mjs: first-install configuration. Captures who you are and what you are looking
 * for, and writes the User Layer files every tool reads:
 *
 *   config/profile.yml      identity, target roles, comp floor, company preferences
 *   config/location.json    where you can work (from a location preset)
 *   config/lane-vocab.json  what counts as in-lane (from a lane preset)
 *   portals.yml             the companies to scan and your title filter
 *   modes/_profile.md       archetypes and framing the evaluation prompts read
 *   cv.md                   only when you point it at an existing markdown CV
 *
 * Usage:
 *   node setup.mjs                          interactive
 *   node setup.mjs --answers answers.json   unattended (an agent can drive onboarding)
 *   node setup.mjs --example-answers        print an answers file to start from
 *   node setup.mjs --list-presets           show the lane and location presets
 *   node setup.mjs ... --dry-run            show what would be written, write nothing
 *   node setup.mjs ... --force              overwrite existing files (each backed up to .bak)
 *   node setup.mjs ... --target DIR         write into DIR instead of this checkout
 *
 * It never overwrites a file you already have unless --force is given, because every file
 * it writes is yours; it writes only what is missing, so it can be re-run to finish an
 * install. Presets live in presets/; nothing here encodes a fact about anyone.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_PRESETS = join(HERE, 'presets', 'lanes');
const LOCATION_PRESETS = join(HERE, 'presets', 'locations');

// Arguments are this script's only when it is the script being run. Imported as a module
// (the tests import roleStem and kwPattern), process.argv belongs to the importer, and
// reading it here killed the importing process on its own flags.
// Compared as REAL paths: through a symlinked or junctioned checkout argv[1] keeps the
// link while import.meta.url is the resolved file, and setup silently did nothing.
const invokedDirectly = (() => {
  try {
    return !!process.argv[1]
      && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
const argv = invokedDirectly ? process.argv.slice(2) : [];
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const KNOWN = new Set(['--answers', '--example-answers', '--list-presets', '--dry-run',
  '--force', '--target', '--help', '-h']);
for (let i = 0; i < argv.length; i++) {
  if (!KNOWN.has(argv[i])) { die(`unknown argument: ${argv[i]} (see --help)`, 2); }
  if (argv[i] === '--answers' || argv[i] === '--target') i++;
}

function die(msg, code = 1) { console.error(`setup: ${msg}`); process.exit(code); }

// ---- presets -----------------------------------------------------------------------

function listPresets(dir, ext) {
  return readdirSync(dir).filter((f) => f.endsWith(ext) && !f.startsWith('_'))
    .map((f) => f.slice(0, -ext.length));
}
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
function lanePreset(name) {
  const p = join(LANE_PRESETS, `${name}.json`);
  if (!existsSync(p)) die(`no lane preset "${name}" (have: ${listPresets(LANE_PRESETS, '.json').join(', ')})`);
  return readJSON(p);
}
function locationPreset(name) {
  const p = join(LOCATION_PRESETS, `${name}.json`);
  if (!existsSync(p)) die(`no location preset "${name}" (have: ${listPresets(LOCATION_PRESETS, '.json').join(', ')})`);
  return readJSON(p);
}

// ---- answers -----------------------------------------------------------------------

export const EXAMPLE_ANSWERS = {
  full_name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '',
  linkedin: 'linkedin.com/in/janesmith',
  portfolio_url: '',
  github: '',
  headline: 'Backend engineer who builds billing platforms',
  exit_story: 'Seven years building payments infrastructure; looking for platform work at a product company.',
  target_roles: ['Senior Backend Engineer', 'Staff Platform Engineer'],
  past_employers: ['Acme Corp'],
  compensation: { currency: 'USD', minimum: 'USD 150K', target_range: 'USD 170K-220K' },
  company_preference: { Stripe: 1.0, Figma: 0.6 },
  lanes: {
    preset: 'general',
    target_keywords: ['Backend Engineer', 'Platform Engineer', 'Infrastructure Engineer'],
    avoid_keywords: ['Sales', 'Recruiter', 'Intern'],
  },
  location: {
    preset: 'custom',
    home_state_code: 'TX',
    home_state_name: 'Texas',
    commute_label: 'Austin',
    commute_cities: ['Austin', 'Round Rock', 'Cedar Park', 'Georgetown'],
    same_state_out: ['Houston', 'Dallas', 'San Antonio'],
    same_state_out_label: 'other Texas metros',
    onsite_outside_commute: 'fail',
  },
  cv_path: '',
};

// A comp FIGURE, read the same way in setup.mjs, scripts/eval-prep.py and score-model.mjs:
// digits with optional thousands commas and one optional decimal part, then an optional K
// or M. A bare number under 10,000 is a level, a year fragment or a footnote, never
// dollars, and is skipped. Three readers once took three different figures from
// "L5 USD 180K" (5K, 180K, 180K) and "$150,000..." crashed one of them.
const FIG = /(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?/g;
/** Dollar figures in a comp string, read the way scripts/eval-prep.py reads them. */
export function compFigures(s) {
  const out = [];
  for (const [, num, suf] of String(s ?? '').matchAll(FIG)) {
    let v = parseFloat(num.replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    const u = (suf || '').toLowerCase();
    if (u === 'k') v *= 1000; else if (u === 'm') v *= 1e6; else if (v < 10000) continue;
    out.push(Math.round(v));
  }
  return out;
}

/** Problems with an answers object, as a list of messages; empty means usable. */
export function validateAnswers(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return ['answers must be an object'];
  if (checkFullName(a.full_name)) errs.push('full_name is required');
  const lanes = a.lanes || {};
  if (!lanes.preset) errs.push('lanes.preset is required (see --list-presets)');
  else if (checkLanePreset(lanes.preset)) errs.push(`lanes.preset "${lanes.preset}" does not exist`);
  const loc = a.location || {};
  if (!loc.preset) errs.push('location.preset is required: a preset name or "custom"');
  else if (checkLocationPreset(loc.preset)) errs.push(`location.preset "${loc.preset}" does not exist`);
  // A list may be an array or one ";"-separated string, the interactive spelling; anything
  // else used to crash with a TypeError that named no key.
  for (const [path, v] of [['target_roles', a.target_roles], ['past_employers', a.past_employers],
    ['lanes.target_keywords', lanes.target_keywords], ['lanes.avoid_keywords', lanes.avoid_keywords],
    ['location.commute_cities', loc.commute_cities], ['location.same_state_out', loc.same_state_out],
    ['location.hard_out_metro', loc.hard_out_metro]]) {
    if (v != null && !Array.isArray(v) && typeof v !== 'string') errs.push(`${path} must be a list`);
  }
  if (loc.preset === 'custom') {
    if (checkHomeStateCode(loc.home_state_code, true)) {
      errs.push(`location.home_state_code "${loc.home_state_code || ''}" is not a US state code (e.g. TX)`);
    }
    if (loc.onsite_outside_commute && checkOnsiteOutsideCommute(loc.onsite_outside_commute)) {
      errs.push('location.onsite_outside_commute must be "fail" or "unknown"');
    }
  }
  if (isStateCode(loc.home_state_code) && loc.home_state_name && checkHomeStateName(loc.home_state_name, loc.home_state_code)) {
    errs.push(`location.home_state_name "${loc.home_state_name}" is not the name of `
      + `${loc.home_state_code.trim().toUpperCase()} (${stateName(loc.home_state_code)}); leave it blank to use that`);
  }
  for (const [path, v] of [['lanes.target_keywords', lanes.target_keywords], ['lanes.avoid_keywords', lanes.avoid_keywords]]) {
    const bad = checkKeywordList(v);
    if (bad) errs.push(`${path} entry ${bad}`);
  }
  if (loc.preset !== 'custom' && loc.home_state_code && checkHomeStateCode(loc.home_state_code, false)) {
    errs.push(`location.home_state_code "${loc.home_state_code}" is not a US state code (e.g. TX)`);
  }
  const comp = a.compensation || {};
  if (comp.minimum || comp.target_range) {
    const floor = compFigures(comp.minimum)[0];
    // A target is optional: with none, the floor is the target too.
    const target = Math.max(...compFigures(comp.target_range || comp.minimum), -Infinity);
    if (!floor) errs.push(`compensation.minimum "${comp.minimum}" holds no readable figure (write e.g. "USD 150K")`);
    if (comp.target_range && !compFigures(comp.target_range).length) {
      errs.push(`compensation.target_range "${comp.target_range}" holds no readable figure`);
    }
    // The same bounds eval-prep's comp_targets() enforces, or setup writes a floor it refuses.
    if (floor && Number.isFinite(target) && !compPairPlausible(floor, target)) {
      errs.push(`compensation: floor ${floor} and target ${target} are not a plausible pair`);
    }
  }
  for (const [co, v] of Object.entries(a.company_preference || {})) {
    if (!(typeof v === 'number' && v >= 0 && v <= 1)) errs.push(`company_preference.${co} must be 0..1`);
  }
  const cvErr = a.cv_path ? cvProblem(resolve(a.cv_path)) : null;
  if (cvErr) errs.push(`cv_path ${a.cv_path}: ${cvErr}`);
  return errs;
}

/**
 * Why a file cannot be used as the markdown CV, or null. A PDF or DOCX copied in as text is
 * mojibake that every tailored CV would then be built from, and doctor would report the
 * install as ready.
 */
export function cvProblem(p) {
  if (!existsSync(p)) return 'does not exist';
  if (!statSync(p).isFile()) return 'is not a file';
  if (!/\.(md|markdown|txt)$/i.test(p)) return 'must be a markdown or text file (.md, .markdown, .txt); convert a PDF or DOCX first';
  const head = readFileSync(p).subarray(0, 4096);
  if (head.includes(0) || head.subarray(0, 4).toString('latin1') === '%PDF' || head.subarray(0, 2).toString('latin1') === 'PK') {
    return 'looks binary, not text';
  }
  return null;
}

/** US state names and codes, from the shared base vocabulary. */
const BASE_US = readJSON(join(LOCATION_PRESETS, '_base-us.json'));
const STATE_WORDS = new Set(BASE_US.us_state_signals.map((x) => x.trim().toLowerCase()));
const STATES_BY_CODE = BASE_US.states_by_code || {};
export const isStateCode = (c) => typeof c === 'string' && Object.hasOwn(STATES_BY_CODE, c.trim().toUpperCase());
export const stateName = (c) => STATES_BY_CODE[String(c || '').trim().toUpperCase()] || '';
/** A commute entry that is only a state ("TX", "Texas") would match every place in it. */
const isBareState = (x) => STATE_WORDS.has(String(x).trim().toLowerCase().replace(/\./g, ''));

/**
 * Shared answer checks: each returns an error message, or null when the value is fine.
 * validateAnswers calls the same function to gate an unattended run, and the interactive
 * askValid/askListValid prompts call it to re-ask at a terminal, so the two paths cannot
 * drift into checking different things. Exported so a test can call them without a TTY.
 */
export const checkFullName = (v) => (String(v || '').trim() ? null : 'full name is required');
export const checkLanePreset = (v) => (existsSync(join(LANE_PRESETS, `${v}.json`)) ? null : `no lane preset "${v}"`);
export const checkLocationPreset = (v) => (v === 'custom' || existsSync(join(LOCATION_PRESETS, `${v}.json`))
  ? null : `no location preset "${v}"`);
export const checkHomeStateCode = (v, required) => (isStateCode(v) || (!v && !required)
  ? null : `"${v || ''}" is not a US state code (e.g. TX)`);
export const checkHomeStateName = (v, code) => (!v || v.trim().toLowerCase() === stateName(code).toLowerCase()
  ? null : `"${v}" is not the name of ${code} (${stateName(code)})`);
export const checkOnsiteOutsideCommute = (v) => (['fail', 'unknown'].includes(String(v).trim().toLowerCase())
  ? null : 'must be "fail" or "unknown"');
/** The comp bounds eval-prep's comp_targets() enforces, or setup writes a floor it refuses. */
export const compPairPlausible = (floor, target) => Number.isFinite(floor) && Number.isFinite(target)
  && 20000 <= floor && floor <= 2e6 && floor <= target && target <= 5e6;
export const checkCompFloor = (v) => {
  if (!v) return null;
  const floor = compFigures(v)[0];
  return floor && compPairPlausible(floor, floor) ? null : 'no plausible figure (20K to 2M); write e.g. USD 150K';
};
export const checkCompTarget = (v, min) => (compPairPlausible(compFigures(min)[0], Math.max(...compFigures(v), -Infinity))
  ? null : `no figure between the floor ${min} and 5M; write e.g. USD 170K-220K`);
/** A keyword list entry with no letters or digits would match every title as a substring. */
export const checkKeywordList = (list) => {
  const bad = cleanList(list).find((k) => !/[A-Za-z0-9]/.test(k));
  return bad ? `"${bad}" has no letters or digits and would match every title` : null;
};

// Entries that name a CITY but spell a state: kept as written they either match the whole
// state ("New York" admits Buffalo; "Washington" admits Seattle) or nothing at all ("DC").
// Each is rewritten to the city's own spellings, and the rewrite is reported. Keys are
// looked up with dots already stripped, so "D.C", "D.C." and "DC" all land on the same
// entry; only the bare "washington" key is withheld below, for a Washington-STATE home,
// where the word means the home state itself and not the district on the other coast.
const CITY_STATE_REWRITES = {
  'washington': ['Washington, DC'], 'dc': ['Washington, DC'],
  'washington dc': ['Washington, DC'], 'district of columbia': ['Washington, DC'],
  'new york': ['New York City', 'NYC', 'Manhattan', 'New York, NY'],
};
/**
 * A commute or same-state-out list as the policy should hold it: bare states dropped,
 * city-states rewritten ("LA" is Los Angeles only for a California home). Returns the
 * entries and a note for each change.
 */
export function placeEntries(list, homeCode) {
  const out = [], notes = [];
  const home = String(homeCode || '').trim().toUpperCase();
  for (const x of cleanList(list)) {
    // Dots are stripped before the lookup: "L.A.", "L.A" and "LA" must all read the same,
    // or a stray or missing trailing dot sent "L.A." down the generic bare-state path with
    // a note naming the wrong state (Louisiana, not "outside California it is...").
    const k = x.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
    const rw = (k === 'washington' && home === 'WA') ? null
      : CITY_STATE_REWRITES[k] || (k === 'la' ? (home === 'CA' ? ['Los Angeles'] : []) : null);
    if (rw) {
      notes.push(rw.length ? `"${x}" was written as ${rw.map((r) => `"${r}"`).join(', ')}, the city's own spellings`
        : `"${x}" was dropped: outside California it is Louisiana, not Los Angeles`);
      out.push(...rw);
    } else if (isBareState(x)) {
      notes.push(`"${x}" was dropped: it is a whole state, not a place`);
    } else {
      out.push(x);
    }
  }
  return { signals: [...new Set(out)], notes };
}
const SENIORITY = /(?<![A-Za-z0-9])(?:(?:entry|mid|senior|junior)[\s-]+level|senior|sr\.?|staff|principal|lead|junior|jr\.?|mid|entry|head of|iv|i{1,3})(?![A-Za-z0-9])/gi;
/**
 * A role title with its seniority words removed: the stem a title filter should match.
 * Only the seniority tokens go; hyphens, commas and parentheses stay, because the filter
 * and kwPattern match them literally ("Front-End" is not "Front End"). A stem that is a
 * single word, or that no longer matches the title it came from, is not a stem: the title
 * itself is kept.
 */
export const roleStem = (t) => {
  const src = String(t).trim();
  const stem = src.replace(SENIORITY, ' ').replace(/\s+/g, ' ')
    .replace(/\s+([,)])/g, '$1').replace(/^[\s,.:;/\u2013\u2014-]+|[\s,.:;/\u2013\u2014-]+$/g, '').trim();
  if (!stem || stem.split(/\s+/).length < 2) return src;
  // A leftover level word ("Level Software Engineer") is a fragment, not a stem, and
  // neither is one left holding a dangling function word: stripping "Staff" out of
  // "Chief of Staff" leaves "Chief of", which reads nothing like a title on its own.
  if (/^(?:level|grade)\b|\b(?:level|grade)$/i.test(stem)) return src;
  if (/\b(?:of|for|and|or|to|nor|but|the|a|an|in|on|at|by|with|as)$/i.test(stem)) return src;
  return new RegExp(kwPattern(stem), 'i').test(src) ? stem : src;
};

/** Usable but probably not what was meant: said out loud, never silently accepted. */
export function warnAnswers(a) {
  const w = [];
  const loc = a.location || {};
  // A preset with no home state (remote-us) accepts nationwide remote, but every
  // state-scoped remote offer, including the user's own state's, can only be a question.
  if (loc.preset && loc.preset !== 'custom' && existsSync(join(LOCATION_PRESETS, `${loc.preset}.json`))
      && !locationPreset(loc.preset).home_state && !loc.home_state_code) {
    w.push(`location preset "${loc.preset}" names no home state, so "US, <your state>, Remote" `
      + 'offers will read as unknown. Give location.home_state_code and home_state_name to judge them.');
  }
  if (loc.preset === 'custom' && !cleanList(loc.commute_cities).length) {
    w.push('no commute cities were given, so every onsite or hybrid role will '
      + (loc.onsite_outside_commute === 'unknown' ? 'come to you as a question' : 'fail the location gate')
      + '. Add cities to commute.signals in config/location.json if you can work onsite anywhere.');
  }
  if (loc.preset === 'custom') {
    for (const key of ['commute_cities', 'same_state_out']) {
      for (const n of placeEntries(loc[key], loc.home_state_code).notes) w.push(`location.${key}: ${n}.`);
    }
  }
  // A comma list typed where ";" separates entries becomes ONE entry that matches nothing.
  // "Austin, TX" and "Washington, D.C." are one place (a comma then a state); "Austin, Round
  // Rock" is two. "Senior Engineer, Platform" is one title; "Backend Engineer, Platform
  // Engineer" is two, because a role noun ENDS more than one of the parts: "Engineering
  // Manager, Developer Productivity" is one title even though "Developer" also matches the
  // noun list mid-phrase, because only its first part ends with one. "Acme, Inc." is one
  // company. A keyword, unlike a title, is matched as one literal phrase by the scanner and
  // the ranker, so any comma inside one is almost always a join, never a real distinction.
  const ROLE_NOUN_END = /\b(engineer|developer|scientist|artist|designer|manager|architect|analyst|director|researcher|specialist|programmer|producer|technician|administrator|consultant|animator|lead|writer|strategist)s?[).:;]*$/i;
  const CORP = /^(inc|llc|ltd|co|corp|corporation|company|gmbh|plc|sa|ag|bv|limited|incorporated|pbc|lp|llp)\.?$/i;
  const commaJoined = (x, kind) => {
    const parts = String(x).split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return false;
    if (kind === 'place') return parts.length > 2 || !STATE_WORDS.has(parts[1].toLowerCase().replace(/\./g, ''));
    if (kind === 'title') return parts.filter((p) => ROLE_NOUN_END.test(p)).length >= 2;
    if (kind === 'keyword') return true;
    return parts.slice(1).some((p) => !CORP.test(p));   // company
  };
  for (const [key, list, kind] of [['location.commute_cities', loc.commute_cities, 'place'],
    ['location.same_state_out', loc.same_state_out, 'place'], ['target_roles', a.target_roles, 'title'],
    ['lanes.target_keywords', a.lanes?.target_keywords, 'keyword'],
    ['lanes.avoid_keywords', a.lanes?.avoid_keywords, 'keyword'],
    ['company_preference', Object.keys(a.company_preference || {}), 'company']]) {
    const joined = cleanList(list).filter((x) => commaJoined(x, kind));
    if (joined.length) {
      w.push(`${key} entry "${joined[0]}" looks like several entries joined by commas; it is kept `
        + 'as ONE entry and will match almost nothing. Separate entries with ";".');
    }
  }
  if (!a.compensation?.minimum) w.push('no comp floor: the scoring model will apply no comp gate.');
  if (a.compensation?.minimum && !a.compensation?.target_range) {
    w.push('no comp target given: the floor is used as the target too.');
  }
  const want = cleanList(a.lanes?.target_keywords);
  if (a.lanes?.preset === 'general' && want.length && want.every((k) => roleStem(k) !== k.trim())) {
    w.push('every title keyword carries a seniority word, and with the general preset they are the '
      + 'only positives, so the scan will admit only those exact phrases. Consider the stems: '
      + want.map(roleStem).join('; '));
  }
  return w;
}

// ---- builders ----------------------------------------------------------------------

const cleanList = (xs) => [...new Set((typeof xs === 'string' ? xs.split(';') : Array.isArray(xs) ? xs : [])
  .map((x) => String(x).trim()).filter(Boolean))];
/**
 * A keyword as a literal pattern valid in both JavaScript and Python, bounded so "Sales"
 * does not match inside "Wholesales". `\b` only bounds a word character, so a keyword that
 * starts or ends with a symbol ("C++", "Engine (Runtime)", ".NET") takes a non-word
 * character check at that edge instead; with `\b` there it could never match at all.
 */
export const kwPattern = (k) => {
  // A trailing "*" is the title filter's stem syntax ("Agent*" admits "Agentic"), so it is
  // a stem here too; escaped, it demanded a literal asterisk and the scorers never matched
  // what the scanner admitted.
  const stem = /\*$/.test(k.trim());
  const s = k.trim().replace(/\*+$/, '');
  const body = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // A one-character lookbehind is fixed-width, so Python accepts it as JavaScript does.
  const head = /^\w/.test(s) ? '\\b' : '(?<![A-Za-z0-9])';
  const tail = stem ? '\\w*' : /\w$/.test(s) ? '\\b' : '(?![A-Za-z0-9])';
  return head + body + tail;
};

export function buildLocation(a) {
  const loc = a.location;
  if (loc.preset !== 'custom') {
    const p = locationPreset(loc.preset);
    // A preset with no home state (remote-us) takes the user's, so their own state's
    // scoped remote offers pass instead of always being a question.
    if (!p.home_state && loc.home_state_code) {
      const code = String(loc.home_state_code).trim().toUpperCase();
      p.home_state = { code, name: loc.home_state_name || stateName(code) || code };
    }
    return p;
  }
  const base = locationPreset('remote-us');
  const code = String(loc.home_state_code).trim().toUpperCase();
  return {
    _README: base._README,
    name: `custom-${code.toLowerCase()}`,
    description: `Written by setup.mjs for a candidate in ${loc.home_state_name || stateName(code) || code}.`,
    // A blank name is the state's name, never the code: with name == code the scanner has
    // no spelled-out home state, and "Austin, Texas" read as some OTHER state.
    home_state: { code, name: loc.home_state_name || stateName(code) || code },
    commute: { label: loc.commute_label || 'Commute', signals: placeEntries(loc.commute_cities, code).signals },
    same_state_out: { label: loc.same_state_out_label || null, signals: placeEntries(loc.same_state_out, code).signals },
    hard_out_metro: cleanList(loc.hard_out_metro),
    onsite_outside_commute: loc.onsite_outside_commute || 'fail',
    review_metro_companies: [],
  };
}

export function buildLaneVocab(a) {
  const v = lanePreset(a.lanes.preset);
  const want = cleanList(a.lanes.target_keywords);
  const avoid = cleanList(a.lanes.avoid_keywords);
  if (!want.length && !avoid.length) return v;
  // Keywords given at setup are layered onto the preset: the target words become a lane
  // every scorer rewards and the title filter's positives, the avoid words a penalty and
  // a triage gate. A preset's own tuning is kept; a general preset gets its only signal here.
  const out = structuredClone(v);
  for (const k of ['_ranker', '_lane', '_board', '_triage', '_title_filter']) out[k] = out[k] || {};
  if (want.length) {
    out._ranker.lanes = [...(out._ranker.lanes || []),
      { tag: 'yours', terms: want.map((k) => [kwPattern(k), 6]) }];
    out._lane.title_up = [...(out._lane.title_up || []), ...want.map((k) => [kwPattern(k), 4])];
    // Word-bounded patterns, not raw substrings: "AI" as a substring captured
    // "Maintenance" and "Retail". The lane goes AFTER the preset's own lanes, so a keyword
    // never takes a title away from a tuned lane, and it suggests the fallback CV.
    out._board.lanes = [...(out._board.lanes || []),
      { name: 'Target', button: 'Target', cv: out._board.fallback?.cv || '', words: [],
        patterns: want.map(kwPattern) }];
    out._assist = out._assist || {};
    out._assist.lane = [...(out._assist.lane || []), ...want.map((k) => [k, kwPattern(k), 2])];
    out._title_filter.positive = cleanList([...(out._title_filter.positive || []), ...want]);
  }
  if (avoid.length) {
    const pat = avoid.map(kwPattern).join('|');
    out._ranker.deprioritised = out._ranker.deprioritised
      ? { ...out._ranker.deprioritised, pattern: `${out._ranker.deprioritised.pattern}|${pat}` }
      : { pattern: pat, weight: -8, tag: 'avoided' };
    out._lane.title_down = [...(out._lane.title_down || []), ...avoid.map((k) => [kwPattern(k), -6])];
    // Title-only: eval-assist scores its lists against the whole JD body, where "Manager"
    // or "Recruiter" appears in the boilerplate of nearly every posting.
    out._triage.gates = [...(out._triage.gates || []), ['avoided title', pat]];
    out._title_filter.negative = cleanList([...(out._title_filter.negative || []), ...avoid]);
  }
  return out;
}

export function buildProfile(a) {
  const ex = yaml.load(readFileSync(join(HERE, 'config', 'profile.example.yml'), 'utf8'));
  const p = { ...ex };
  p.candidate = {
    full_name: a.full_name.trim(), email: a.email || '', phone: a.phone || '',
    location: a.location.preset === 'custom'
      ? (a.location.commute_label ? `${a.location.commute_label}, ${String(a.location.home_state_code).trim().toUpperCase()}` : String(a.location.home_state_code).trim().toUpperCase())
      : '',
    linkedin: a.linkedin || '', portfolio_url: a.portfolio_url || '', github: a.github || '',
    past_employers: cleanList(a.past_employers),
  };
  p.target_roles = { primary: cleanList(a.target_roles), archetypes: [] };
  p.narrative = { ...ex.narrative, headline: a.headline || '', exit_story: a.exit_story || '',
    superpowers: [], proof_points: [] };
  const comp = a.compensation || {};
  p.compensation = comp.minimum || comp.target_range
    ? { target_range: comp.target_range || comp.minimum || '', currency: comp.currency || 'USD', minimum: comp.minimum || '' }
    : { currency: comp.currency || 'USD' };
  p.location = { country: 'United States', city: a.location.commute_label || '', timezone: '', visa_status: '' };
  if (Object.keys(a.company_preference || {}).length) p.company_preference = a.company_preference;
  delete p.cover_letter;
  return '# Written by `node setup.mjs`. Every key it does not set is documented in\n'
    + '# config/profile.example.yml. Edit freely: this file is yours and never overwritten.\n'
    // lineWidth -1: never fold a long value into a `>-` block scalar, which the
    // no-PyYAML fallback reader in scripts/_candidate.py would read as the literal ">-".
    + yaml.dump(p, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

export function buildPortals(vocab) {
  const tpl = readFileSync(join(HERE, 'templates', 'portals.example.yml'), 'utf8');
  const tf = vocab._title_filter || {};
  const list = (key, xs) => (xs && xs.length
    ? `  ${key}:\n${xs.map((x) => `    - ${JSON.stringify(x)}`).join('\n')}\n` : `  ${key}: []\n`);
  const block = 'title_filter:\n' + list('positive', tf.positive) + list('negative', tf.negative)
    + list('seniority_boost', tf.seniority_boost?.length ? tf.seniority_boost : ['Senior', 'Staff', 'Principal', 'Lead']);
  const start = tpl.indexOf('\ntitle_filter:\n');
  const end = tpl.indexOf('\n\n', start + 1);
  if (start < 0 || end < 0) die('templates/portals.example.yml has no title_filter block to replace');
  return tpl.slice(0, start + 1) + block + tpl.slice(end + 1);
}

/** Replace (or insert before `beforeHeading`) one `## Heading` section of a markdown file. */
function setSection(md, heading, body, beforeHeading) {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm');
  const section = `## ${heading}\n\n${body.trim()}\n\n`;
  if (re.test(md)) return md.replace(re, section);
  const at = beforeHeading ? md.indexOf(`## ${beforeHeading}`) : -1;
  return at < 0 ? `${md.trimEnd()}\n\n${section}` : md.slice(0, at) + section + md.slice(at);
}

export function buildProfileMd(a) {
  let md = readFileSync(join(HERE, 'modes', '_profile.template.md'), 'utf8').replace(/\r\n/g, '\n');
  const presetMd = join(LANE_PRESETS, `${a.lanes.preset}.profile.md`);
  if (existsSync(presetMd)) {
    const src = readFileSync(presetMd, 'utf8').replace(/\r\n/g, '\n');
    for (const m of src.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
      md = setSection(md, m[1].trim(), m[2], 'Your Exit Narrative');
    }
  } else if (cleanList(a.target_roles).length) {
    const roles = cleanList(a.target_roles);
    md = setSection(md, 'Your Target Roles',
      '<!-- Written by setup.mjs from your target roles. Fill in the axes and what each buys. -->\n\n'
      + '| Archetype | Thematic axes | What they buy |\n|-----------|---------------|---------------|\n'
      + roles.map((r) => `| **${r}** | | |`).join('\n'));
    md = setSection(md, 'Your Adaptive Framing',
      '<!-- For each role, what to lead with and where the proof lives. -->\n\n'
      + '| If the role is... | Emphasize about you... | Proof point sources |\n'
      + '|-------------------|------------------------|---------------------|\n'
      + roles.map((r) => `| ${r} | | cv.md + article-digest.md |`).join('\n'));
  }
  return md;
}

// ---- writing -----------------------------------------------------------------------

export function plan(a, target) {
  const vocab = buildLaneVocab(a);
  const files = [
    ['config/profile.yml', buildProfile(a)],
    ['config/location.json', JSON.stringify(buildLocation(a), null, 2) + '\n'],
    ['config/lane-vocab.json', JSON.stringify(vocab, null, 2) + '\n'],
    ['portals.yml', buildPortals(vocab)],
    ['modes/_profile.md', buildProfileMd(a)],
  ];
  if (a.cv_path && resolve(a.cv_path) !== resolve(join(target, 'cv.md'))) {
    files.push(['cv.md', readFileSync(resolve(a.cv_path), 'utf8')]);
  }
  return files.map(([rel, body]) => ({ rel, path: join(target, rel), body }));
}

/** The first unused backup name: <file>.bak, then .bak.1, .bak.2 ... A second --force used
 *  to copy the first run's generated file over the only backup of the user's original. */
function freeBackup(p) {
  if (!existsSync(`${p}.bak`)) return `${p}.bak`;
  for (let i = 1; ; i++) if (!existsSync(`${p}.bak.${i}`)) return `${p}.bak.${i}`;
}

function write(files, { force, dryRun }) {
  // A file that already exists is yours and is kept; only missing files are written, so
  // setup can be re-run to finish an install without touching what you have edited.
  // --force replaces, keeping each replaced file as a numbered backup it never overwrites.
  let kept = 0;
  for (const f of files) {
    const exists = existsSync(f.path);
    if (exists && !force) {
      kept++;
      console.log(`  keep    ${f.rel} (exists; --force replaces it)`);
      continue;
    }
    const verb = exists ? 'replace' : 'create ';
    console.log(`  ${dryRun ? 'would ' : ''}${verb} ${f.rel}`);
    if (dryRun) continue;
    mkdirSync(dirname(f.path), { recursive: true });
    if (exists) copyFileSync(f.path, freeBackup(f.path));
    writeFileSync(f.path, f.body);
  }
  if (kept === files.length) console.log('  nothing to write: every file already exists.');
}

// ---- interactive -------------------------------------------------------------------

async function interview() {
  // Read lines through the async iterator, not rl.question(). question() drops any line
  // that arrives before it is called, so piped answers (a script, an agent) lost every
  // line after the first and the second prompt never resolved. The iterator buffers
  // lines from a terminal and from a pipe alike; at end of input every prompt takes its
  // default.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  let eof = false;
  const ask = async (q, d = '') => {
    process.stdout.write(`${q}${d ? ` [${d}]` : ''}: `);
    const { value, done } = await lines.next();
    eof = eof || done;
    if (!process.stdin.isTTY) process.stdout.write(`${done ? '' : value}\n`);
    return (done ? '' : String(value).trim()) || d;
  };
  // Lists split on ";", never ",": "Austin, TX" is one city and "Acme, Inc." one company,
  // and a comma split once turned "TX" into a commute city that matched the whole state.
  const askList = async (q, d = []) => cleanList((await ask(`${q} (separate with ;)`, d.join('; '))).split(';'));
  // Re-ask at a terminal until the answer is usable, so one typo does not discard the
  // whole interview. Piped input is never re-asked: the retry would consume the NEXT
  // answer and shift every one after it. Its bad answer goes through to validateAnswers,
  // which reports it and writes nothing. End of input stops re-asking too.
  const askValid = async (q, d, check) => {
    for (;;) {
      const v = await ask(q, d);
      const why = check(v);
      if (!why || !process.stdin.isTTY || eof) return v;
      console.log(`  ${why}`);
    }
  };
  // Same re-ask rule as askValid, for a semicolon-separated list rather than one line.
  const askListValid = async (q, d, check) => {
    for (;;) {
      const v = await askList(q, d);
      const why = check(v);
      if (!why || !process.stdin.isTTY || eof) return v;
      console.log(`  ${why}`);
    }
  };
  console.log('\ncareer-ops setup. Press Enter to accept a [default]. Everything can be edited later.\n');
  const a = {};
  // checkFullName is the same guard validateAnswers applies: pressing Enter here used to
  // run the whole interview on a blank name and only die at the very end.
  a.full_name = await askValid('Your full name', '', checkFullName);
  a.email = await ask('Email');
  a.linkedin = await ask('LinkedIn URL', '');
  a.portfolio_url = await ask('Portfolio / site URL', '');
  a.target_roles = await askList('Target role titles');
  a.past_employers = await askList('Past employers (helps tell your own history from a posting)');
  console.log(`\nLane presets: ${listPresets(LANE_PRESETS, '.json').map((n) => `${n} (${lanePreset(n)._preset?.description || ''})`).join('\n              ')}`);
  a.lanes = { preset: await askValid('Lane preset', 'general', checkLanePreset) };
  // checkKeywordList is the same guard validateAnswers applies: it used to accept '*' or
  // '-' here, which validateAnswers then rejects after the rest of the interview is done.
  a.lanes.target_keywords = await askListValid('Title keywords you want (added to the preset)',
    cleanList(a.target_roles.map(roleStem)), checkKeywordList);
  a.lanes.avoid_keywords = await askListValid('Title keywords to avoid', [], checkKeywordList);
  console.log(`\nLocation presets: ${listPresets(LOCATION_PRESETS, '.json').join(', ')}, or "custom".`
    + '\n  california-socal is the worked example: Southern California commute plus remote-US.');
  const lp = await askValid('Location preset', 'custom', checkLocationPreset);
  a.location = { preset: lp };
  const presetHasHome = lp !== 'custom' && !!locationPreset(lp).home_state;
  if (!presetHasHome) {
    // Required for custom; optional for a home-less preset, where Enter skips it.
    const code = (await askValid(`Home state, two-letter code (e.g. TX${lp === 'custom' ? '' : '; Enter to skip'})`, '',
      (v) => checkHomeStateCode(v, lp === 'custom'))).toUpperCase();
    if (code) {
      a.location.home_state_code = code;
      a.location.home_state_name = await askValid('Home state, full name', stateName(code),
        (v) => checkHomeStateName(v, code));
    }
  }
  if (lp === 'custom') {
    a.location.commute_label = await ask('Name for your commute area (e.g. Austin)', 'Commute');
    a.location.commute_cities = await askList('Cities within your commute (err long: a missing city is a silent discard)');
    a.location.same_state_out = await askList('Metros in your state that are too far to commute', []);
    a.location.onsite_outside_commute = (await askValid('Onsite roles outside the commute: fail (no relocation) or unknown (ask me)', 'fail',
      checkOnsiteOutsideCommute)).trim().toLowerCase();
  }
  const min = await askValid('Comp floor, total (e.g. USD 150K; blank for no comp gate)', '', checkCompFloor);
  if (min) {
    a.compensation = { currency: 'USD', minimum: min,
      target_range: await askValid('Comp target range (e.g. USD 170K-220K)', min, (v) => checkCompTarget(v, min)) };
  }
  const prefs = await askList('Companies you would most like to work at', []);
  a.company_preference = Object.fromEntries(prefs.map((c) => [c, 1.0]));
  a.cv_path = await askValid('Path to an existing markdown CV to copy in (blank to skip)', '',
    (v) => (!v ? null : cvProblem(resolve(v))));
  rl.close();
  return a;
}

// ---- main --------------------------------------------------------------------------

if (invokedDirectly) {
  if (flag('--help') || flag('-h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
    process.exit(0);
  }
  if (flag('--list-presets')) {
    console.log('lane presets (presets/lanes/):');
    for (const n of listPresets(LANE_PRESETS, '.json')) console.log(`  ${n.padEnd(22)} ${lanePreset(n)._preset?.description || ''}`);
    console.log('location presets (presets/locations/):');
    for (const n of listPresets(LOCATION_PRESETS, '.json')) console.log(`  ${n.padEnd(22)} ${locationPreset(n).description || ''}`);
    process.exit(0);
  }
  if (flag('--example-answers')) { console.log(JSON.stringify(EXAMPLE_ANSWERS, null, 2)); process.exit(0); }

  const target = resolve(opt('--target') || HERE);
  const answersPath = opt('--answers');
  const answers = answersPath ? readJSON(resolve(answersPath)) : await interview();
  const errs = validateAnswers(answers);
  if (errs.length) die('the answers are not usable:\n' + errs.map((e) => `  - ${e}`).join('\n'));
  for (const w of warnAnswers(answers)) console.log(`setup: note: ${w}`);
  const files = plan(answers, target);
  console.log(`\nsetup: ${flag('--dry-run') ? 'dry run for' : 'writing'} ${target}`);
  write(files, { force: flag('--force'), dryRun: flag('--dry-run') });
  if (!flag('--dry-run')) {
    console.log('\nNext:');
    if (!answers.cv_path) console.log('  - Create cv.md (your CV in markdown); your AI CLI can build it with you.');
    console.log('  - Replace the starter companies in portals.yml with yours; `python scripts/find-ats.py "Company"` finds a board.');
    console.log('  - Review modes/_profile.md: archetypes, framing and negotiation scripts.');
    console.log('  - Run `node doctor.mjs` to confirm, then paste a job URL into your AI CLI.');
  }
}
