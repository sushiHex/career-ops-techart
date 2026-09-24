#!/usr/bin/env node
/**
 * score-model-tests.mjs — regression tests for the scoring model.
 *
 * Every case here is a bug that actually reached the board, or an invariant whose
 * violation would silently mis-rank roles. The scoring model decides which jobs
 * the candidate sees, so a silent error here is expensive in a way a crash never is: a
 * crash gets noticed, a wrong multiplier just quietly hides a good role.
 *
 * Run: node score-model-tests.mjs
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// No installed configuration may reach these tests, not even the model's import-time read
// of the profile: a malformed profile would otherwise fail the suite that checks the rules.
process.env.CAREER_OPS_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'score-model-noconfig-'));
const M = await import(new URL('./score-model.mjs', import.meta.url).href);
const { compBand, arrangement, locationText, MODEL } = M;

// Every floor-dependent call runs against FX, a PINNED fixture model. The real floor
// comes from config/profile.yml, so a test reading it would pass or fail depending on
// whose profile is installed; these tests used to lean on one person's number without
// saying so. 200 is a fixture value, nothing more.
//
// The role gate is pinned the same way: to the techart-ai-tooling preset these cases were
// written against, never to whichever vocabulary the user has configured.
const FX = { ...MODEL, COMP_FLOOR: 200,
  ROLE_GATE: M.loadRoleGate(fileURLToPath(new URL('./presets/lanes/techart-ai-tooling.json', import.meta.url))) };
const DEPRIORITISED = FX.ROLE_GATE;
const prefFactor = (c, r, p, o = FX) => M.prefFactor(c, r, p, o);
const compVerdict = (b, o = FX) => M.compVerdict(b, o);
const compFactor = (b, o = FX) => M.compFactor(b, o);
const applyModel = (base, ctx, o = FX) => M.applyModel(base, ctx, o);

let pass = 0;
const fails = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r === true) { pass++; return; }
    fails.push(`${name}\n      ${r}`);
  } catch (e) {
    fails.push(`${name}\n      threw: ${e.message}`);
  }
}
const eq = (a, b, msg) => (a === b ? true : `${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const close = (a, b, tol, msg) => (Math.abs(a - b) <= (tol ?? 0.005) ? true : `${msg || ''} expected ~${b}, got ${a}`);

// ---------------------------------------------------------------- comp basis

// The floor is TOTAL comp, so the gate may only fire on evidence about TOTAL
// comp. An earlier version multiplied the floor by a fixed 0.85 to compare base
// figures against it — a guess, since the base/total ratio ranges from +10% at a
// studio to +100% at big tech. These pin the replacement rule.

t('comp: a base band UNDER the floor is unverified, never penalised', () => {
  const v = compVerdict({ lo: 150, hi: 185, basis: 'base' });
  return v.status === 'unverified' && v.factor === 1
    ? true : `status=${v.status} factor=${v.factor}`;
});

t('comp: an unlabelled band under the floor is also unverified', () => {
  const v = compVerdict({ lo: 150, hi: 185, basis: 'unknown' });
  return v.status === 'unverified' && v.factor === 1
    ? true : `status=${v.status} factor=${v.factor}`;
});

t('comp: a TOTAL band under the floor IS gated', () => {
  const v = compVerdict({ lo: 150, hi: 185, basis: 'total' });
  return v.status === 'gated' && v.factor < 1
    ? true : `status=${v.status} factor=${v.factor}`;
});

t('comp: base is a lower bound — base over the floor clears', () => {
  const v = compVerdict({ lo: 250, hi: 300, basis: 'base' });
  return v.status === 'clears' && v.factor === 1
    ? true : `status=${v.status} factor=${v.factor}`;
});

t('comp: no figure is unverified, not a penalty', () => {
  const v = compVerdict(null);
  return v.status === 'no-figure' && v.factor === 1
    ? true : `status=${v.status} factor=${v.factor}`;
});

t('comp: an explicit comp_total_est arms the gate', () => {
  const b = compBand(['comp_total_est: "$120K-$150K"', 'other: x'].join('\n'));
  return b && b.basis === 'total' && compVerdict(b).status === 'gated'
    ? true : `band=${JSON.stringify(b)}`;
});

t('comp: comp_total_est is preferred over a base figure in the prose', () => {
  const b = compBand(['comp_total_est: "$300K-$400K"', 'Base salary range $150,000-$185,000.'].join('\n'));
  return b.lo === 300 && b.basis === 'total' ? true : `got ${JSON.stringify(b)}`;
});

// Contamination guard: the candidate's own threshold read as the employer's offer.
// A report can say "TOTAL comp clears the $300K bar", and an earlier measurement
// counted that as the role paying $300K.
t("comp: the candidate's own threshold is not read as the role's total", () => {
  const b = compBand('TOTAL comp clears the $300K bar for their target track.');
  return b === null || b.basis !== 'total'
    ? true : `read the candidate's bar as the role total: ${JSON.stringify(b)}`;
});

t('comp: total wins when a line states both base and total', () => {
  const b = compBand('Base $150K-$185K, total compensation $250K-$300K.');
  return eq(b.basis, 'total');
});

// The bug that gated one row at x0.49 off another role's pay.
t('comp: a figure cited as a COMPARABLE is not read as this role pay', () => {
  const txt = 'A related remote tools variant lists ~$82,000-$130,000 base (likely under-indexed for this seat).';
  return eq(compBand(txt), null, 'comparable should be skipped;');
});

t('comp: a levels.fyi median is not read as this role pay', () => {
  return eq(compBand('levels.fyi reports the median total comp band $140,000-$200,000 for this level.'), null);
});

t("comp: the candidate's own target is never read as the role pay", () => {
  return eq(compBand('vs their target of $200,000-$250,000 total.'), null);
});

t('comp: no extractable band means NO penalty (fails safe)', () => close(compFactor(null), 1));

t('comp: at/above floor is exactly 1, never a bonus', () => {
  const b = { lo: 300, hi: 400, basis: 'total' };
  return close(compFactor(b), 1);
});

t('comp: a far-above-floor band does not exceed 1', () => {
  const b = { lo: 700, hi: 900, basis: 'total' };
  return compFactor(b) <= 1 ? true : `got ${compFactor(b)}`;
});

t('comp: sub-floor penalty scales with the shortfall', () => {
  const near = compFactor({ lo: 170, hi: 180, basis: 'total' });
  const far = compFactor({ lo: 90, hi: 100, basis: 'total' });
  return far < near && near < 1 ? true : `near=${near} far=${far}`;
});

t('comp: the band point is 75% up, not the ceiling', () => {
  const b = { lo: 100, hi: 200, basis: 'total' };
  // achievable = 175, fixture floor 200 -> (175/200)^1.5
  return close(compFactor(b), Math.pow(175 / 200, 1.5));
});

// -------------------------------------------------------------- arrangement

t('arrangement: plain remote', () => eq(arrangement('Remote - US'), 'remote'));

// The bug that misfiled three employers' remote-friendly postings as hybrid.
t('arrangement: OPTIONAL hybrid stays remote', () =>
  eq(arrangement('Remote - US (optional hybrid Tue-Thu in SF, not mandatory)'), 'remote'));

t('arrangement: hybrid offered as an alternative stays remote', () =>
  eq(arrangement('Remote (US) available; also hybrid New York City'), 'remote'));

t('arrangement: occasional office travel stays remote', () =>
  eq(arrangement('Remote US-based, with periodic onsite in Laurel, MD every 6 weeks'), 'remote'));

t('arrangement: a mandatory cadence is hybrid', () =>
  eq(arrangement('Hybrid, 3 days per week onsite in Irvine, CA'), 'hybrid'));

t('arrangement: hybrid as the leading framing is hybrid', () =>
  eq(arrangement('Hybrid - 2 days remote, 3 in office'), 'hybrid'));

t('arrangement: a bare city reads as onsite', () => eq(arrangement('Costa Mesa, CA'), 'onsite'));

t('arrangement: empty is unknown, not onsite', () => eq(arrangement(''), 'unknown'));

// The ranking (2026-07-30): remote > hybrid > onsite. Asserted as a strict ORDERING
// rather than against the constants, so the test still means something if the damps are
// retuned -- an assertion like `arrFactor('onsite') === MODEL.ONSITE_DAMP` is a tautology
// that survives setting ONSITE_DAMP to 1.0.
t('arrangement: remote beats hybrid beats onsite', () => {
  const f = (a) => M.arrFactor(a);
  if (!(f('remote') > f('hybrid'))) return `remote ${f('remote')} !> hybrid ${f('hybrid')}`;
  if (!(f('hybrid') > f('onsite'))) return `hybrid ${f('hybrid')} !> onsite ${f('onsite')}`;
  return true;
});

t('arrangement: remote is the neutral 1.0, so the ranking never inflates a score', () =>
  M.arrFactor('remote') === 1 ? true : `remote ${M.arrFactor('remote')}`);

t('arrangement: unknown is never penalised (absence of evidence is not onsite)', () =>
  M.arrFactor('unknown') === 1 ? true : `unknown ${M.arrFactor('unknown')}`);

// Regression: "onsites?" in the travel cue matched the bare word "onsite", so a location
// reading simply "Onsite role." fell through to unknown and dodged the onsite damp.
t('arrangement: a plain "Onsite role." classifies as onsite, not unknown', () =>
  eq(arrangement('Onsite role.'), 'onsite'));

t('arrangement: a bare city+state still classifies as onsite', () =>
  eq(arrangement('Santa Clara, CA'), 'onsite'));

// This assertion previously expected 'remote' and was WRONG -- it locked in the bug it was
// meant to guard. One employer's JD says verbatim "Location-based hybrid policy: ... we expect
// all staff to be in one of our offices at least 25% of the time", so a mandated office
// share is hybrid no matter how the location string leads. It is still not ONSITE, which is
// the part the original test got right.
t('arrangement: travel-required with a mandated office share is hybrid, not remote', () =>
  eq(arrangement('Remote-Friendly (Travel-Required) | San Francisco, CA'), 'hybrid'));

// One tracked row classified REMOTE despite saying "hybrid" three times: the remote branch
// only conceded to hybrid when the string STARTED with it, and the word "remote" appeared
// inside a negation quoted as evidence. A declarative hybrid must win from any position.
t('arrangement: hybrid declared mid-string is hybrid, not remote', () =>
  eq(arrangement('Irvine, CA - hybrid. This role is a hybrid work position, with some work on-site and some work-from-home.'), 'hybrid'));

t('arrangement: an incidental negated "remote" mention does not beat a declared hybrid', () =>
  eq(arrangement('Irvine, CA - hybrid work position. No jobLocationType: REMOTE, no second office.'), 'hybrid'));

t('arrangement: "the position is hybrid" phrasing classifies hybrid', () =>
  eq(arrangement('Santa Monica, CA. The position is hybrid with time split between home and studio.'), 'hybrid'));

// Guard the fix against over-reach: hybrid offered as an OPTION on a remote role stays remote.
t('arrangement: optional hybrid on a remote role stays remote', () =>
  eq(arrangement('Remote - US. Optional hybrid schedule available if you prefer an office.'), 'remote'));

t('arrangement: a stated office percentage makes it hybrid even when it reads Remote-Friendly', () =>
  eq(arrangement('Remote-Friendly (US-eligible) with ~25% office travel to SF/NYC'), 'hybrid'));

t('arrangement: genuinely unqualified remote stays remote', () =>
  eq(arrangement('US, Remote'), 'remote'));

t('arrangement: remote with merely occasional travel is still remote', () =>
  eq(arrangement('Remote - US, with occasional travel for team offsites'), 'remote'));

t('locationText: reads the machine-summary field', () =>
  eq(locationText('location: Remote - US\nother: x'), 'Remote - US'));

// ------------------------------------------------------------------- prefs

const PREFS = [[/^Acme/i, 1.0], [/^Globex/i, 1.0], [/^Initech Games/i, 0.6], [/^Initech/i, 0.3]]
  .sort((a, b) => String(b[0]).length - String(a[0]).length);

t('pref: an unlisted company gets exactly 1.0', () =>
  close(prefFactor('Some Unlisted Co', 'Engineer', PREFS).factor, 1));

// Behaviour, not restatement: `1 + pref*PREF_STEP` survives PREF_STEP being 0.
t('pref: a listed company scores strictly ABOVE an unlisted one', () => {
  const listed = prefFactor('Acme Studios', 'Software Engineer', PREFS).factor;
  const un = prefFactor('Some Unlisted Co', 'Software Engineer', PREFS).factor;
  return listed > un ? true : `listed ${listed} is not above unlisted ${un}`;
});

t('pref: a higher preference scores strictly above a lower one', () => {
  const hi = prefFactor('Acme Studios', 'Engineer', PREFS).factor;       // 1.0
  const lo = prefFactor('Initech', 'Engineer', PREFS).factor;          // 0.3
  return hi > lo ? true : `pref 1.0 gave ${hi}, pref 0.3 gave ${lo}`;
});

t('pref: a longer name is not shadowed by a shorter prefix', () =>
  eq(prefFactor('Initech Games', 'Engineer', PREFS).pref, 0.6));

// The ordering guarantee lives in loadPrefs, so test loadPrefs itself, with the
// short name deliberately listed FIRST so an unsorted implementation fails.
t('loadPrefs: sorts longest-first so a short key cannot shadow a long one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copref-'));
  writeFileSync(join(dir, 'profile.yml'),
    'company_preference:\n  Initech: 0.3\n  Initech Games: 0.6\n\nother_key: 1\n', 'utf-8');
  const prefs = M.loadPrefs(dir);
  const games = M.preference('Initech Games', prefs);
  const plain = M.preference('Initech', prefs);
  return games === 0.6 && plain === 0.3 ? true : `Initech Games -> ${games}, Initech -> ${plain}`;
});

t('loadPrefs: tier comments and blank lines do not truncate the block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copref2-'));
  writeFileSync(join(dir, 'profile.yml'),
    'company_preference:\n  # tier one\n  Alpha: 1.0\n\n  # tier two\n  Beta: 0.5\n\nnext_key: x\n', 'utf-8');
  const prefs = M.loadPrefs(dir);
  return prefs.length === 2 && M.preference('Beta', prefs) === 0.5
    ? true : `parsed ${prefs.length} entries, Beta -> ${M.preference('Beta', prefs)}`;
});

t('loadPrefs: a following top-level key is not swallowed into the block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copref3-'));
  writeFileSync(join(dir, 'profile.yml'),
    'company_preference:\n  Alpha: 1.0\n\nauto_pdf_score_threshold: 4.0\n', 'utf-8');
  const prefs = M.loadPrefs(dir);
  return prefs.length === 1 ? true : `parsed ${prefs.length} entries, expected 1`;
});

t('pref: a de-prioritised title scores strictly BETWEEN unlisted and undamped', () => {
  const damped = prefFactor('Globex', 'Developer Advocate, Agentic AI', PREFS);
  const full = prefFactor('Globex', 'Senior Software Engineer', PREFS);
  if (!damped.damped) return 'title was not flagged as damped';
  return damped.factor > 1 && damped.factor < full.factor
    ? true
    : `damped ${damped.factor} must sit strictly between 1 and undamped ${full.factor}`;
});

t('pref: damping an unlisted company is a no-op, never a penalty', () => {
  const r = prefFactor('Unlisted Co', 'Developer Advocate', PREFS);
  // The factor is 1 either way (0 preference x anything is 0), but `damped` is
  // reported in the tracker/report output, so a company with no preference must
  // never be LABELLED as damped — that would read as a penalty that never happened.
  if (r.damped) return 'an unlisted company was flagged as damped';
  return close(r.factor, 1);
});

t('pref: engineering titles are not damped', () =>
  eq(prefFactor('Globex', 'Senior Software Engineer, Agentic AI', PREFS).damped, false));

t('with no role gate configured, no title is ever damped', () =>
  eq(M.prefFactor('Acme Studios', 'Developer Advocate', PREFS, { ...FX, ROLE_GATE: null }).damped,
     false));

t('the general preset configures no role gate', () =>
  eq(M.loadRoleGate(fileURLToPath(new URL('./presets/lanes/general.json', import.meta.url))), null));

t('DEPRIORITISED matches the GTM titles it is meant to', () => {
  const hits = ['Developer Advocate', 'Developer Relations Engineer', 'Solutions Engineer',
    'Forward Deployed Engineer', 'Senior Technical Marketing Engineer', 'Developer Experience Manager'];
  const miss = ['Senior Software Engineer', 'Research Engineer, Model Evaluation',
    'Principal AI Engineer', 'Senior Technical Artist', 'Machine Learning Engineer'];
  for (const h of hits) if (!DEPRIORITISED.test(h)) return `should match: ${h}`;
  for (const m of miss) if (DEPRIORITISED.test(m)) return `should NOT match: ${m}`;
  return true;
});

// ---------------------------------------------------------------- combined

t('model: with no modifiers the final equals the base', () => {
  const r = applyModel(4.0, { text: 'no money here', company: 'Nobody', role: 'Engineer', prefs: PREFS });
  return close(r.final, 4.0);
});

t('model: the final is capped at 5', () => {
  const r = applyModel(4.95, { text: '', company: 'Acme Studios', role: 'Engineer', prefs: PREFS });
  return r.final <= 5 ? true : `got ${r.final}`;
});

t('model: factors compose multiplicatively', () => {
  const text = 'Base salary range $100,000 - $120,000. location: Hybrid, 3 days per week onsite';
  const r = applyModel(4.0, { text, company: 'Acme Studios', role: 'Engineer', prefs: PREFS });
  const want = Math.min(5, 4.0 * r.compFactor * r.prefFactor * r.arrFactor);
  return close(r.final, Math.round(want * 100) / 100);
});

t('model: a null base stays null rather than becoming 0', () =>
  eq(applyModel(null, { text: '', company: 'X', role: 'Y', prefs: PREFS }), null));

t('model: no modifier can turn a sub-4.0 base into an actionable score by itself', () => {
  // The strongest possible positive is prefFactor at preference 1.0.
  const maxBoost = 1 + 1.0 * MODEL.PREF_STEP;
  return 3.5 * maxBoost < 4.0 ? true
    : `a 3.5 base reaches ${(3.5 * maxBoost).toFixed(2)} — preference alone should not clear 4.0 from 3.5`;
});

t('a persisted arrangement is trusted over re-deriving it from prose', () => {
  // The bug this guards. eval-write computes the arrangement from the packet's clean
  // location ("Los Angeles, California" -> onsite) and persists `arrangement: onsite`,
  // but then writes a location_final that is prose. Re-deriving from that prose finds no
  // "City, State" pattern, returns 'unknown', and 'unknown' carries factor 1. So every
  // later recomputation silently RAISED every onsite and hybrid row. It moved 11 rows
  // the day it was found, all upward, all of them already correct.
  const prose = 'location_final: "Los Angeles is the lead location. Santa Monica area, '
              + 'inside the SoCal commute ceiling."\n';
  const derived = applyModel(3.65, { text: prose, company: 'Vertex', role: 'X', prefs: [] });
  const trusted = applyModel(3.65, { text: prose, company: 'Vertex', role: 'X', prefs: [],
                                     arrangement: 'onsite' });
  if (derived.arrangement !== 'unknown') {
    return `prose location should derive as unknown, got ${derived.arrangement}`;
  }
  if (trusted.arrangement !== 'onsite') {
    return `a persisted arrangement must win, got ${trusted.arrangement}`;
  }
  if (!(trusted.final < derived.final)) {
    return `trusting onsite must lower the score: ${trusted.final} vs ${derived.final}`;
  }
  return true;
});

t('an unknown persisted arrangement does not block re-derivation', () => {
  // 'unknown' is the absence of a decision, not a decision. Treating it as authoritative
  // would freeze every row written before the arrangement key existed.
  const clean = 'location: "Los Angeles, California"\n';
  const r = applyModel(3.65, { text: clean, company: 'Vertex', role: 'X', prefs: [],
                               arrangement: 'unknown' });
  return r.arrangement === 'onsite' ? true
    : `should fall back to deriving onsite, got ${r.arrangement}`;
});

// ---------------------------------------------------------------- the candidate, from config

// The floor is the TOP-LEVEL compensation.minimum and nothing else. Profiles carry
// per-track alternate_ranges with their own `minimum:` one level deeper; reading the
// first `minimum:` in the block would gate every req against another track's number.
const profileDir = (yml) => {
  const d = mkdtempSync(join(tmpdir(), 'cand-'));
  writeFileSync(join(d, 'profile.yml'), yml);
  return d;
};

t('config: the comp floor is the TOP-LEVEL compensation.minimum', () => {
  const d = profileDir('candidate:\n  full_name: "Jane Smith"\ncompensation:\n'
    + '  target_range: "USD 200K-250K"\n  minimum: "USD 200K"\n  alternate_ranges:\n'
    + '    - track: "other"\n      minimum: "USD 260K"\n');
  return eq(M.loadCandidate(d).compFloorK, 200);
});

t('config: a NESTED per-track minimum is never read as the floor', () => {
  const d = profileDir('compensation:\n  alternate_ranges:\n'
    + '    - track: "other"\n      minimum: "USD 260K"\n');
  return eq(M.loadCandidate(d).compFloorK, null);
});

t('config: no profile means no floor and NO gate, not a gate at a default', () => {
  const c = M.loadCandidate(mkdtempSync(join(tmpdir(), 'cand-')));
  const v = M.compVerdict({ lo: 100, hi: 120, basis: 'total' }, { ...MODEL, COMP_FLOOR: c.compFloorK });
  return c.compFloorK === null && v.status === 'no-floor' && v.factor === 1
    ? true : `candidate=${JSON.stringify(c)} verdict=${JSON.stringify(v)}`;
});

t('config: full-dollar and K spellings of the floor both read as $K', () => {
  const a = M.loadCandidate(profileDir('compensation:\n  minimum: "$200,000"\n')).compFloorK;
  const b = M.loadCandidate(profileDir('compensation:\n  minimum: USD 200K  # walk-away\n')).compFloorK;
  return a === 200 && b === 200 ? true : `a=${a} b=${b}`;
});

t('config: past employers are read, so their figures read as biography', () => {
  const d = profileDir('candidate:\n  full_name: "Jane Smith"\n  past_employers:\n'
    + '    - "Studio One"\n    - Studio Two  # note\n');
  const c = M.loadCandidate(d);
  return c.firstName === 'Jane' && c.pastEmployers.join('|') === 'Studio One|Studio Two'
    ? true : JSON.stringify(c);
});

// The profile is YAML and is read as YAML. The regex reader it replaced returned an empty
// first name for any name holding an apostrophe, a colon or a "#", and dropped a
// preferred company such as "O'Reilly Media" or "Acme: Labs" without a word.
t('config: names with apostrophes, colons and # survive, in people and companies', () => {
  const d = profileDir('candidate:\n  full_name: "Zoë O\'Brien: Senior # Engineer"\n'
    + '  past_employers:\n    - McDonald\'s Games\n    - "Studio: Two"\n'
    + 'company_preference:\n  O\'Reilly Media: 1\n  "Acme: Labs": 0.6\n');
  const c = M.loadCandidate(d);
  const prefs = M.loadPrefs(d);
  const ok = c.firstName === 'Zoë' && c.pastEmployers.join('|') === "McDonald's Games|Studio: Two"
    && M.preference("O'Reilly Media", prefs) === 1 && M.preference('Acme: Labs', prefs) === 0.6;
  return ok ? true : `candidate=${JSON.stringify(c)} prefs=${prefs.map(([r, v]) => r.source + '=' + v)}`;
});

t('config: a profile that is not valid YAML is an error, not a silently partial read', () => {
  const d = profileDir('candidate:\n  full_name: "unterminated\ncompensation:\n  minimum: 200K\n');
  try { M.loadCandidate(d); return 'invalid YAML was read without complaint'; }
  catch (e) { return /not valid YAML/.test(e.message) ? true : `wrong error: ${e.message}`; }
});

// -------------------------------------------------------------------- report

console.log(`score-model tests: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('');
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
