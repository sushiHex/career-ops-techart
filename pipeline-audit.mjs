#!/usr/bin/env node
/**
 * pipeline-audit.mjs — find out what is actually pending in the inbox.
 *
 * data/pipeline.md is append-only in practice: scan.mjs adds rows and nothing
 * removes them, so the unchecked list grows without bound and stops being a queue.
 * Two distinct problems hide in there, and they need different fixes:
 *
 *   1. DUPLICATES. The same req arrives under different URL spellings, most often
 *      Greenhouse's `/jobs/<id>?gh_jid=<id>` versus `/jobs/?gh_jid=<id>`. A raw URL
 *      comparison treats those as two jobs. Dedup has to key on the ATS job id,
 *      the same lesson as the tracker's job-id dedup.
 *   2. ALREADY EVALUATED. Rows whose req is already in data/applications.md are
 *      done, not pending. They should not keep appearing as work.
 *
 * Default is read-only. --prune rewrites pipeline.md, marking resolved rows [x]
 * with a reason, and always writes a .bak first.
 *
 * Run:
 *   node pipeline-audit.mjs               # report only
 *   node pipeline-audit.mjs --prune       # mark duplicates + evaluated as done
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { REQ_ID_SRC, REQ_ID, canonId, reqIdGlobal } from './req-id-core.mjs';

// WHAT this ranker rewards and penalises is DATA: config/lane-vocab.json, written by
// `node setup.mjs` from a preset in presets/lanes/, and read by scripts/_lane.py too. With
// no config it falls back to presets/lanes/general.json, which has no opinion.
//
// Neither language can import the other, so the shared part is data both read, and that is
// not tidiness. It used to be a hand port with a comment asking both files to be edited
// together, and they were not: _lane.py penalised `solutions? (architect|engineer)` while
// the copy here matched only the PLURAL, so "Deep Learning Solution Architect - Agentic
// Performance" sat at the very top of triage on the +6 for the word Agent.
//
// The shared anti-lane FAMILIES carry one weight per scorer, because a penalty has to be
// sized against the bonus it answers (+6 here, +4 there). The `_ranker` section holds what
// only this scorer reads: its lanes, the de-prioritised and managerial penalties, the
// outright out-of-lane list, and the IC-director exemption.
const HERE = dirname(fileURLToPath(import.meta.url));
// Where configuration lives. CAREER_OPS_CONFIG_DIR overrides it, which is how the test
// suite runs against no configuration at all regardless of whose files are installed.
export const CONFIG_DIR = process.env.CAREER_OPS_CONFIG_DIR || join(HERE, 'config');
const VOCAB_PATH = join(CONFIG_DIR, 'lane-vocab.json');
export const LANE_PRESETS = join(HERE, 'presets', 'lanes');
export function loadLaneVocab(path) {
  const p = path ?? (existsSync(VOCAB_PATH) ? VOCAB_PATH : join(LANE_PRESETS, 'general.json'));
  return JSON.parse(readFileSync(p, 'utf8'));
}
export let LANE_VOCAB;
let FAMILIES, RANKED, PENALTIES, LANES, DEPRI, OUT_OF_LANE, MANAGERIAL, IC_DIRECTOR, EARLY_CAREER;
const vocab = (family) => (LANE_VOCAB[family]?.patterns ?? []).map((p) => new RegExp(p, 'i'));
const rx = (p) => (p ? new RegExp(p, 'i') : null);

/** Can any title score above zero? Without that a positive --rank floor empties the list,
 *  which reads as "nothing matched" when nothing could. */
export const hasPositiveLanes = () => LANES.some((l) => l.terms.some(([, w]) => w > 0));
/** --rank's default floor: 6 is where the obvious lane matches sit, and it is unreachable
 *  without positive vocabulary, so there the floor is 0: unranked, but nothing penalised. */
export const defaultRankMin = () => (hasPositiveLanes() ? 6 : 0);

/** Build the ranker's tables from a vocabulary. Called at import with the configured one;
 *  --selftest calls it again with the preset its cases are written against. */
export function configureRanker(v) {
  LANE_VOCAB = v;
  FAMILIES = Object.keys(v).filter((k) => !k.startsWith('_'));
  const r = v._ranker ?? {};
  LANES = (r.lanes ?? []).map((l) => ({ tag: l.tag, terms: l.terms.map(([p, w]) => [rx(p), w]) }));
  DEPRI = r.deprioritised ? { re: rx(r.deprioritised.pattern), weight: r.deprioritised.weight,
    tag: r.deprioritised.tag ?? 'deprioritised' } : null;
  MANAGERIAL = r.managerial ? { re: rx(r.managerial.pattern), weight: r.managerial.weight,
    tag: r.managerial.tag ?? 'managerial' } : null;
  OUT_OF_LANE = rx(r.out_of_lane);
  // In games, VFX and animation a "Technical Director" is a senior INDIVIDUAL CONTRIBUTOR,
  // not a people manager; the managerial penalty cancelled the lane match exactly and sank
  // every such req. The exemption pattern names those IC director titles.
  IC_DIRECTOR = rx(r.ic_director);
  // A family with no `ranker` weight must be handled some other way, which the selftest
  // insists on: early_career is an outright disqualifier, read by name below.
  RANKED = FAMILIES.filter((f) => typeof v[f].weight?.ranker === 'number');
  PENALTIES = RANKED.map((f) => [v[f].tag ?? f, vocab(f), v[f].weight.ranker]);
  // Treated like OUT_OF_LANE rather than as a penalty, because no amount of lane match
  // makes an internship applicable. That mechanism is this ranker's; the phrases are shared.
  EARLY_CAREER = vocab('early_career');
}
// A selftest never reads the user's vocabulary, not even at import.
configureRanker(loadLaneVocab(process.argv.includes('--selftest')
  ? join(LANE_PRESETS, 'general.json') : undefined));

const args = new Set(process.argv.slice(2));
// Where this run reads its vocabulary from, and which preset that is. The rest of the
// file runs on import, so a test asks here rather than importing the module.
if (args.has('--print-config')) {
  console.log(`${CONFIG_DIR}\n${LANE_VOCAB._preset?.name ?? ''}`);
  process.exit(0);
}
if (args.has('--help') || args.has('-h')) {
  console.log(`pipeline-audit.mjs — report what is genuinely pending in data/pipeline.md

  (no flags)   report only, writes nothing
  --prune      mark duplicate and already-evaluated rows as [x] (backs up first)
  --verbose    list every duplicate group and evaluated match`);
  process.exit(0);
}
const PRUNE = args.has('--prune');
const VERBOSE = args.has('--verbose');
const RANK = args.has('--rank');

/**
 * Rank a pending row by title alone, because a title is all the inbox carries.
 *
 * This is triage, not evaluation: it decides what is worth spending a JD read on
 * when 660 rows are pending and reading them all is not possible. It is
 * deliberately generous on Lane B vocabulary, because the last title filter
 * rejected 224 of 392 evaluated roles, the best-scoring among them, by
 * having no agentic or eval vocabulary at all.
 */
function rankTitle(role) {
  if (OUT_OF_LANE?.test(role)) return { score: -99, tags: ['out-of-lane'] };
  if (EARLY_CAREER.some((re) => re.test(role))) return { score: -99, tags: ['early-career'] };
  let s = 0; const tags = [];
  for (const lane of LANES) {
    for (const [re, w] of lane.terms) if (re.test(role)) { s += w; tags.push(lane.tag); }
  }
  // Applied per matching PATTERN, not per family, the way _lane.py sums LANE_DOWN: a title
  // that is both a support noun and a qualifier form ("Customer Experience Agent, High
  // Value") takes both hits, which is what keeps the worst offenders furthest from the top.
  for (const [tag, pats, w] of PENALTIES) {
    for (const re of pats) if (re.test(role)) { s += w; tags.push(tag); }
  }
  if (DEPRI?.re.test(role)) { s += DEPRI.weight; tags.push(DEPRI.tag); }
  if (MANAGERIAL?.re.test(role) && !IC_DIRECTOR?.test(role)) {
    s += MANAGERIAL.weight; tags.push(MANAGERIAL.tag);
  }
  return { score: s, tags: [...new Set(tags)] };
}

/** Regression cases. A keyword edit that silently re-buries a lane is the failure
 *  this tool exists to prevent, so the expectations are asserted, not assumed. */
export const RANK_CASES = [
  ['Technical Director, Content Platform', 4, null],
  ['Pipeline Technical Director', 7, null],
  // Effects TD scores on the TD alone: "effects" is deliberately NOT a Lane-A term,
  // because FX is not this profile's discipline even though it is a craft title.
  ['Effects Technical Director (Project Hire) - ILM San Francisco', 4, null],
  ['Senior Software Engineer, AI Developer Tools', 3, null],
  // Legitimately stacks: neural graphics (4) + developer tools (3) + graphics (3).
  ['Software Engineer, Neural Graphics Developer Tools', 10, null],
  ['Senior Machine Learning/MLOps Engineer', 4, null],
  ['Senior Software Engineer - AI Tooling & Automation', 3, null],
  ['Senior Tools & Build Engineer, Games', 3, null],
  ['Senior Technical Marketing Engineer', -8, 'deprioritised'],
  ['Senior Test & Evaluation Engineer, Titan', 0, 'hw-test'],
  ['Engineering Manager, AI Platform', null, 'managerial'],
  ['Propulsion Engineer', -99, 'out-of-lane'],
  // Early-career reqs score well on lane keywords and must be excluded outright.
  ['NVIDIA 2027 Internships: Ph.D. Research Graphics and Simulation', -99, 'early-career'],
  ['Software Engineer Intern, Agentic AI', -99, 'early-career'],
  ['New Grad Machine Learning Engineer', -99, 'early-career'],
  // ...without catching a senior req that merely mentions a research residency topic.
  ['Senior Research Engineer, Agent Evaluation', 11, null],
  // Human support agents. Every one of these was tied at 6 with the real agentic reqs and
  // filled 11 of the 19 triage rows, because +6 fired on the word "agent" alone. Each is
  // agent (+6) minus the support penalty (-12).
  ['Customer Experience Agent', -6, 'support-agent'],
  ['Customer Experience Agent (Japanese Speaking)', -6, 'support-agent'],
  ['Trust & Safety Agent', -6, 'support-agent'],
  ['Trust & Risk Agent, Japan', -6, 'support-agent'],
  ['Fraud Agent', -6, 'support-agent'],
  ['Warehouse Agent - FTC', -6, 'support-agent'],
  // Isolates the qualifier form: no support noun here, so only the second pattern fires.
  ['Sales Agent, Bilingual', -6, 'support-agent'],
  // Both patterns fire, as they do in _lane.py: 6 - 12 - 12.
  ['Customer Experience Agent, High Value', -18, 'support-agent'],
  // The early-career gate returns before any scoring, so this spelling is -99 here while
  // _lane.py scores it -12. Pinned so the difference reads as intended, not as drift.
  ['Customer Experience Agent, 2026 New Grad', -99, 'early-career'],
  // The counter-check that matters most: the penalty must not touch real agentic AI. If a
  // future support noun is written loosely enough to fire on these, the suite says so.
  ['ML and Agentic Systems Engineer', 6, null],
  ['Senior Software Engineer, CoPilot Agent Platform', 6, null],
  ['LLM Platform Engineer', 5, null],

  // ── The drift the shared vocabulary closed, 2026-09-20 ──
  // Every one of these led the top twenty of a 593-req triage on the +6 for the word
  // Agent, and every one was ALREADY penalised in _lane.py. The hand port is what failed,
  // not the judgement, so they are pinned here against the file both scorers now read.
  //
  // NVIDIA writes "Solution Architect" singular and this ranker matched only the plural.
  ['Deep Learning Solution Architect - Agentic Performance', -2, 'customer-facing'],
  ['Solution Architect - Agentic AI - CSP', -2, 'customer-facing'],
  // ...and the plural spelling must keep working.
  ['Solutions Architect, Agentic AI', -2, 'customer-facing'],
  // `new ?grad` does not match "New College Grad", the spelling NVIDIA uses.
  ['Software Engineer, Coding Agent Harness Engineering - New College Grad 2026', -99,
    'early-career'],
  // This ranker knew only product manager; _lane.py had programme manager all along.
  ['Technical Program Manager - Local AI Agents', -2, 'product-mgr'],
  ['Project Manager, Agent Platform', -2, 'product-mgr'],

  // ── Families neither scorer had, added from the same backlog ──
  // "Agentic identity" is an infosec specialty and the word agent carried it to the top.
  ['Principal Cyber Security Engineer - Agentic Identity and Security', -10,
    'security_identity'],
  ['Staff Security Engineer - PAM and Agentic Identity', -10, 'security_identity'],
  ['Staff Security Software Engineer, Agentic Security Engineering', -2, 'security_identity'],
  // AI safety is a wanted lane, so the family is matched on security NOUNS and
  // must never fire on the word "safety" alone. A security-automation req is the standing proof that a
  // security-flavoured title can hide real agentic work: its body took it from 0 to 4.64.
  ['Research Engineer, AI Safety Evaluations', 5, null],
  ['AI Automation Engineer, Security', 0, null],
  // Lighter on purpose: tooling for an ops team is still tooling.
  ['Senior AI Tools Engineer, SRE Operations - GeForce NOW', 1, 'reliability_ops'],
  // MLOps is untouched.
  ['Senior Machine Learning/MLOps Engineer', 4, null],
  ['Agentic Operations Consultant', -2, 'consulting'],
  ['Agent Standards Specialist, Global Affairs', -2, 'policy_affairs'],
  // GPU kernel and chip work, a hard anti-lane, which this ranker scored POSITIVELY
  // while _lane.py had penalised it all along.
  ['Senior System Software Engineer, Agentic Kernel Development', 0, 'low-level-systems'],
  ['Principal ASIC Physical Design Engineer', -8, 'low-level-systems'],
  // ...and `inference` must NOT be caught by it. The two scorers disagree about inference
  // on purpose, and the ranker's positive reading is the one that stands here.
  ['Senior Software Engineer, Inference Platform', 3, null],
  // ...while standards work on OpenUSD is squarely in lane and must survive.
  ['Senior Engineer, OpenUSD Standards and Tooling', 6, null],
];

/** Orderings, asserted as orderings rather than as numbers that happen to differ, the same
 *  way scripts/_lane.py asserts its own. A support title outranking real AI work is the
 *  specific failure this rule exists to prevent, and a pair of absolute scores can both
 *  drift in the same direction without the comparison ever being checked. */
const ORDER_CASES = [
  ['a support agent ranks below a genuine agentic-AI req',
    () => rankTitle('Customer Experience Agent').score
        < rankTitle('Senior Research Engineer, Agent Evaluation').score],
  ['a trust & safety agent ranks below an agentic systems req',
    () => rankTitle('Trust & Safety Agent').score
        < rankTitle('ML and Agentic Systems Engineer').score],
  // The exact inversion observed in the inbox: Whatnot's own LLM Platform Engineer sat at
  // 5, one point under eleven of its support reqs, so the only in-lane role on that board
  // was the one row the triage cutoff hid.
  ['a support agent ranks below the same board\'s LLM Platform Engineer',
    () => rankTitle('Trust & Risk Agent').score < rankTitle('LLM Platform Engineer').score],
  // --rank keeps score >= 6 by default, so falling below that cutoff is what actually
  // removes these from the printed list. Ordering alone would not prove they are gone.
  ['every support-agent spelling falls under the default --min=6 cutoff',
    () => ['Customer Experience Agent', 'Trust & Safety Agent', 'Fraud Agent',
           'Warehouse Agent - FTC', 'Customer Experience Agent, Seller',
           'Trust & Risk Agent (French Speaking)']
      .every(t => rankTitle(t).score < 6)],
  // The same for the families added on 2026-09-20, because falling below the cutoff is
  // what actually removes a row from the printed list and an ordering alone would not
  // prove it. Every one of these led the top twenty of a 593-req triage.
  ['every newly-answered family falls under the default --min=6 cutoff',
    () => ['Deep Learning Solution Architect - Agentic Performance',
           'Solution Architect - Agentic AI - CSP',
           'Technical Program Manager - Local AI Agents',
           'Principal Cyber Security Engineer - Agentic Identity and Security',
           'Staff Security Engineer - PAM and Agentic Identity',
           'Agentic Operations Consultant',
           'Agent Standards Specialist, Global Affairs',
           'Software Engineer, Coding Agent Harness Engineering - New College Grad 2026']
      .every(t => rankTitle(t).score < 6)],
  // ...while the in-lane reqs that sat beside them stay above it.
  ['the in-lane reqs beside them stay above the cutoff',
    () => ['ML and Agentic Systems Engineer', 'Principal Engineer, Duo Agent Platform',
           'Senior Staff Software Engineer - Agentic Automation']
      .every(t => rankTitle(t).score >= 6)],
  // config/lane-vocab.json is the SOURCE. Drift is not prevented by a comment asking two
  // files to agree, which is what was here before and what failed; it is prevented by
  // there being one copy and a check that every consumer reads all of it. So: this file
  // holds no literal copy of a shared pattern, and every family the file defines reaches
  // this ranker, or a family added for _lane.py would silently do nothing here.
  ['no shared pattern is also written out literally in this file',
    () => !Object.entries(LANE_VOCAB)
      .filter(([k]) => !k.startsWith('_'))
      .flatMap(([, v]) => v.patterns)
      .some(p => readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(p))],
  // A family reaches this ranker one of two ways: it declares a `ranker` weight and the
  // table above builds itself from it, or it is read by NAME for some other treatment,
  // like early_career's outright disqualification. Anything else is a family that loaded
  // and did nothing, which is the silent half of drift.
  // The ranker's own lane terms are the preset's too, and a copy written back here
  // would be a second source that drifts.
  ['no ranker lane term is written out literally in this file',
    () => !LANES.flatMap((l) => l.terms.map(([re]) => re.source))
      .filter((p) => p.length > 8)
      .some(p => readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(p))],
  ['every family in the preset reaches this ranker',
    () => {
      const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      const named = new Set([...src.matchAll(/vocab\('([a-z_]+)'\)/g)].map(m => m[1]));
      // Keyed on the FAMILY, never on the display tag: kernel_compiler and
      // silicon_design share the tag low-level-systems, so a tag-keyed check would let
      // one of them lose its weight while the other kept the tag alive.
      const weighted = new Set(RANKED);
      return FAMILIES.every(k => named.has(k) || weighted.has(k));
    }],
  // And the calibration is READ, never restated. A weight typed back into this file puts
  // half the preference in the System Layer again, which is the shape found in review:
  // the phrases had moved to a data file and the numbers had not.
  ['no anti-lane weight is hard-coded in this file',
    () => {
      const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      return FAMILIES.every(k => !src.includes(`'${k}',`) && !src.includes(`"${k}",`));
    }],
];

/** The title stem, with one trailing vertical or language qualifier removed.
 *  "Software Engineer, Agent - Healthcare" and "Software Engineer, Agent
 *  (Spanish speaking)" both reduce to "Software Engineer, Agent". */
export const stemOf = role => String(role)
  .replace(/\s*\([^()]*\)\s*$/, '')
  .replace(/\s+[-–—]\s+[^-–—]+$/, '')
  .trim();

/** Fold a company's repeated title stem into one row.
 *
 *  Sierra posts "Software Engineer, Agent" and "Strategist, Agent Development"
 *  once per vertical (Healthcare, Travel, Retail, Public Sector, Tech Media and
 *  Telecom) and once per language; Decagon does the same. No single-title scorer
 *  can see this, because each title is individually in-lane and genuinely
 *  engineering-adjacent, so the support-agent penalty never fires. The signal
 *  lives ACROSS titles: one source repeating a stem under different qualifiers.
 *  Measured at 13 of 31 triage rows on 2026-08-27 and 15 of 56 on 2026-09-19,
 *  and carried in CLAUDE.md as a known-open issue until now.
 *
 *  Three is the threshold because two similar titles at one company are usually
 *  two real roles. The fold is COUNTED and returned, never silent: a triage list
 *  that quietly drops rows reads as "nothing else matched" when it is not.
 *  Input order is preserved and the first row of each group survives, so the
 *  highest-ranked member represents the set. */
export function collapseVerticalSplits(rows, at = 3) {
  // Group by source, then by stem. A nested map is used deliberately instead of a
  // composite `source + SEP + stem` string: ANY literal separator is a guess about
  // what cannot occur in a company name, and the first version guessed U+0000, which
  // put a raw NUL in this file and made the whole source read as binary to grep and
  // to git's diff heuristics. Nesting removes the guess rather than improving it.
  const bySource = new Map();
  for (const r of rows) {
    const stem = stemOf(r.role);
    if (!bySource.has(r.source)) bySource.set(r.source, new Map());
    const byStem = bySource.get(r.source);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(r);
  }
  const groupOf = r => bySource.get(r.source).get(stemOf(r.role));
  let folded = 0;
  const shown = [];
  for (const r of rows) {
    const g = groupOf(r);
    if (g.length < at) { shown.push(r); continue; }
    if (g[0] !== r) { folded++; continue; }
    shown.push({ ...r, role: `${stemOf(r.role)}  (${g.length} vertical/language variants)` });
  }
  const collapsed = [...bySource.values()]
    .flatMap(byStem => [...byStem.values()])
    .filter(g => g.length >= at).length;
  return { shown, folded, collapsed };
}

/** Vertical-split cases, asserted on the real shapes seen in the inbox. */
const SPLIT_CASES = [
  ['a trailing vertical is stripped from the stem',
    () => stemOf('Software Engineer, Agent - Healthcare') === 'Software Engineer, Agent'],
  ['a trailing language qualifier is stripped from the stem',
    () => stemOf('Strategist, Agent Development (Spanish speaking)')
        === 'Strategist, Agent Development'],
  ['an unqualified title is its own stem',
    () => stemOf('ML and Agentic Systems Engineer') === 'ML and Agentic Systems Engineer'],
  // The exact Sierra shape: one stem, several verticals, one company.
  ['three or more variants at one source fold to a single row',
    () => {
      const rows = ['- Healthcare', '- Retail', '- Public Sector', '(Spanish speaking)']
        .map(v => ({ source: 'Sierra', role: `Software Engineer, Agent ${v}` }));
      const { shown, folded } = collapseVerticalSplits(rows);
      return shown.length === 1 && folded === 3 && /4 vertical\/language variants/.test(shown[0].role);
    }],
  // Two is not a pattern. Collapsing a pair would hide a genuinely distinct role.
  // These deliberately SHARE a stem, so the case exercises the threshold itself:
  // an earlier version used two different Decagon titles, which were never
  // candidates for folding at any threshold, and a mutation to at=2 did not turn
  // it red. A case that cannot fail is not a case.
  ['two variants sharing a stem are both kept',
    () => {
      const rows = [
        { source: 'Decagon', role: 'Software Engineer, Agent - Retail' },
        { source: 'Decagon', role: 'Software Engineer, Agent - Travel' },
      ];
      const { shown, folded } = collapseVerticalSplits(rows);
      return shown.length === 2 && folded === 0;
    }],
  // Distinct titles at one source are distinct roles, whatever the threshold.
  ['two distinct titles at one source are both kept',
    () => collapseVerticalSplits([
      { source: 'Decagon', role: 'Agent Education Manager' },
      { source: 'Decagon', role: 'Agent Experience Designer' },
    ]).shown.length === 2],
  // The same stem at DIFFERENT companies is two real roles, not a split.
  ['the same stem at different sources never folds',
    () => collapseVerticalSplits([
      { source: 'Sierra', role: 'Software Engineer, Agent - Retail' },
      { source: 'Decagon', role: 'Software Engineer, Agent - Retail' },
      { source: 'Cresta', role: 'Software Engineer, Agent - Retail' },
    ]).folded === 0],
];

// --- keys --------------------------------------------------------------------

/**
 * The Workday requisition pattern now lives in req-id-core.mjs.
 *
 * It had been written out FOUR times in four spellings, and each divergence was
 * a silent miss rather than an error: this file had no branch for Autodesk's
 * year-prefixed 26WD form, role-matcher.mjs had none either and returned null
 * (a null id is not a conflict, so dedup fell through to fuzzy titles and could
 * merge two distinct Autodesk requisitions), and eval-write.mjs kept a
 * four-digit floor after JR, which is the exact bug removed from here because
 * four digits also matches the DATE in a report filename slug.
 *
 * The previous round unified two of the four and asserted they were equal. A
 * test that DETECTS drift is weaker than a structure in which drift cannot
 * happen, and three of the four are Node, so they now import one source.
 * Re-exported from here because this file was the documented home and because
 * KEY_CASES below still asserts the Python hand port in
 * scripts/workday-sweep.py is character-for-character equal to it.
 */
export { REQ_ID_SRC, REQ_ID, canonId } from './req-id-core.mjs';

/**
 * A bare Workday "R#####" does not identify a req on its own.
 *
 * Tenants number from independent counters. CrowdStrike is issuing R25523 to
 * R20496 right now while Calix issues R-11295 and Workiva R11095, so two
 * tenants landing on the same number is a matter of time, and 124 of the 401
 * Workday rows in the inbox carry this form. Every consumer of a key here is
 * DESTRUCTIVE in the same direction: a duplicate group is pruned, a matched
 * disposition marks a row [x], a tracker hit retires it. This file already
 * states the asymmetry that settles it, one line up from tokenMatch: a false
 * positive marks a real lead done and it is never seen again.
 *
 * So an ambiguous id is only ever a key when something else in the URL pins it
 * down, and the Workday tenant is exactly that. A JR id keeps its bare key:
 * that is pre-existing behaviour, and the ranges in use are long and
 * tenant-distinctive (NVIDIA JR20xxxxx, Netflix JR4xxxx, Sony JR-11xxxx).
 */
const AMBIGUOUS_ID = /^R\d/;
const WORKDAY_TENANT = /^https?:\/\/([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com/i;

/** The ambiguous id in a URL, or null. The tracker has no tenant to scope one
 *  with, so the already-evaluated check joins on this plus the company. */
export function ambiguousId(url) {
  const m = String(url).trim().replace(/[?#].*$/, '').match(REQ_ID);
  if (!m) return null;
  const id = canonId(m[1]);
  return AMBIGUOUS_ID.test(id) ? id : null;
}

/**
 * Canonical key for a posting URL. Falls back to the whole URL when no ATS id is
 * recognisable, which fails safe: an unrecognised URL is only ever equal to
 * itself, so nothing is merged that should not be.
 *
 * REQ_ID runs LAST of the recognisers, and against the PATH rather than the
 * whole URL. Every rule above it names a board; REQ_ID names none and will
 * happily read an id out of somebody else's slug or query string, and
 * "?ref=r13733" on two unrelated postings was enough to make them one another's
 * duplicate. Ordering it last and cutting the query first is what keeps a Lever
 * posting, or a referral parameter, from being re-keyed as a Workday req.
 */
export function jobKey(url) {
  const u = String(url).trim();
  const path = u.replace(/[?#].*$/, '');
  let m;
  if ((m = u.match(/[?&]gh_jid=(\d+)/i))) return `gh:${m[1]}`;
  if ((m = u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/i))) return `gh:${m[1]}`;
  if ((m = u.match(/ashbyhq\.com\/[^/]+\/([0-9a-f-]{16,})/i))) return `ashby:${m[1].toLowerCase()}`;
  if ((m = u.match(/lever\.co\/[^/]+\/([0-9a-f-]{16,})/i))) return `lever:${m[1].toLowerCase()}`;
  if ((m = u.match(/jobs\.gem\.com\/[^/]+\/([\w-]{10,})/i))) return `gem:${m[1]}`;
  if ((m = u.match(/explore\.jobs\.netflix\.net\/careers\/job\/(\d+)/i))) return `nf:${m[1]}`;
  if ((m = u.match(/builtin(?:la)?\.com\/job\/[^/]*\/(\d+)/i))) return `builtin:${m[1]}`;
  if ((m = path.match(REQ_ID))) {
    const id = canonId(m[1]);
    if (!AMBIGUOUS_ID.test(id)) return `wd:${id}`;
    const tenant = (u.match(WORKDAY_TENANT) || [])[1];
    // No tenant means nothing pins the number down, so it is not a key at all
    // and the URL identity below stands. "Not checked" beats a wrong merge.
    if (tenant) return `wd:${tenant.toLowerCase()}:${id}`;
  }
  return path.replace(/\/+$/, '').toLowerCase();
}

const norm = (s) => String(s).toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(senior|sr|staff|principal|lead|the|a|an|of|and|for)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Company names never match across the two files without this.
 *  The inbox calls it "ThirdLaw"; the tracker calls it "ThirdLaw, Inc.". Same for
 *  Games / Entertainment / Studios / Labs / AI suffixes. Before this, the
 *  already-evaluated check matched almost nothing and every tracked req kept
 *  reappearing as pending work. */
const CO_SUFFIX = new RegExp(
  '\\b(inc|llc|ltd|limited|corp|corporation|co|company|holdings|group|technologies|' +
  'technology|labs|lab|studios|studio|games|gaming|entertainment|interactive|' +
  'industries|systems|software|ai|io)\\b', 'g');
const normCo = (s) => norm(String(s).split('(')[0])
  .replace(CO_SUFFIX, ' ')
  .replace(/\s+/g, ' ').trim();

/** The em dash the inbox uses to append a note to a company name. Built by code
 *  point rather than typed, because nothing in this repository may contain that
 *  character literally, including this file. */
const EM_DASH = String.fromCharCode(0x2014);

/** The company as the INBOX spells it. A source reads "CrowdStrike <dash>
 *  Applied / Agentic AI (Remote / LA)" or "SentinelOne (...) \[REMOTE-US\]", and
 *  only the head of it is the name. Both dashes are cut, because this repository
 *  is migrating its own generated text off the em dash onto " -- ", and a source
 *  whose annotation survives normalisation reads as a different company from the
 *  tracker's, which fails the join silently. */
const srcCo = (source) =>
  normCo(String(source).split(EM_DASH)[0].split(' -- ')[0].split('|')[0]
    .replace(/\\?\[.*?\\?\]/g, ''));

/**
 * What this employer's PREVIOUS evaluations came to: {n, best, skips}, or null for one
 * never looked at.
 *
 * Triage ranked a title and said nothing about the employer behind it, so five new leads
 * read as five open questions when four of them were companies already evaluated several
 * times. Working a shortlist by hand, that history WAS the answer: one employer's sibling
 * req had already been scored low on comp and the new one posted the identical pay zones,
 * another had five prior rows in a narrow low band, a third sat in a documented gap area.
 * Exactly one of the five was a new proposition.
 *
 * A prior score is CONTEXT, never a verdict. A company that scored 3.4 on a ranking role
 * can post a bullseye next week, which is why this annotates and never filters.
 *
 * Lazy because the selftest runs before the tracker is read further down, and because a
 * plain `--prune` has no use for it.
 */
const TRACKER = 'data/applications.md';

/**
 * Tracker lines to employer history. PURE, and that is the point rather than a style
 * preference: this is a System Layer file and `data/applications.md` is User Layer, so a
 * selftest that reached for the real tracker both crashed when it was absent and asserted
 * a fact about one candidate's history. The parse is what needs testing; the file read
 * does not.
 */
export function parsePrior(lines) {
  const m = new Map();
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 7) continue;
    const score = parseFloat(c[5]);
    const key = normCo(c[3]);
    if (!Number.isFinite(score) || !key) continue;
    const e = m.get(key) || { n: 0, best: 0, skips: 0 };
    e.n += 1;
    e.best = Math.max(e.best, score);
    if (/SKIP|Discarded/i.test(c[6])) e.skips += 1;
    m.set(key, e);
  }
  return m;
}

let _priorCache = null;
function priorByCompany() {
  if (!_priorCache) {
    // A missing tracker is not an error on this path. The annotation is a convenience on
    // a triage line, and refusing to load without it would make `--selftest` depend on a
    // file the System Layer has no business requiring.
    _priorCache = existsSync(TRACKER)
      ? parsePrior(readFileSync(TRACKER, 'utf8').split('\n'))
      : new Map();
  }
  return _priorCache;
}

/** The prior record for a triage row's SOURCE label, joined with srcCo() because the inbox
 *  decorates a company name and the tracker does not. Anything looser matched the wrong
 *  employer; anything stricter matched nothing and read as "never evaluated".
 *  `table` is injectable so the join can be tested against a fixture. */
function priorFor(source, table) {
  const src = srcCo(source);
  if (!src) return null;
  return (table || priorByCompany()).get(src) || null;
}

/** Req-id keying, asserted on the real URL shapes in the inbox. */
const KEY_CASES = [
  // Employer history on a triage row. The join is the whole value: a decorated inbox
  // source ("Sourcegraph -- Software/Dev Tools (Remote)") has to reach the tracker's bare
  // "Sourcegraph", and a join that silently matches nothing would print no history at all,
  // which reads exactly like an employer never evaluated.
  // Against a FIXTURE, never the real tracker. This is a System Layer file and
  // data/applications.md is User Layer: reaching for it crashed --selftest when the file
  // was absent and asserted a fact about one candidate's history when it was present.
  ['employer history survives inbox decoration on the source label',
    () => {
      const t = parsePrior([
        '| 1 | 2026-01-01 | Acme Studios | Senior Tools Engineer | 4.8/5 | Evaluated | x | y | z |',
        '| 2 | 2026-01-02 | Acme | Pipeline TD | 3.1/5 | SKIP | x | y | z |',
      ]);
      const bare = priorFor('Acme', t);
      return bare && bare.n === 2 && bare.best === 4.8 && bare.skips === 1
        && priorFor(`Acme ${EM_DASH} Agentic AI (Remote) \\[REMOTE\\]`, t) === bare;
    }],
  ['an employer with no rows has no history rather than someone else\'s',
    () => {
      const t = parsePrior([
        '| 1 | 2026-01-01 | Acme | Senior Tools Engineer | 4.8/5 | Evaluated | x | y | z |',
      ]);
      return priorFor('No Such Company Has Ever Existed', t) === null;
    }],
  ['a row with no parseable score contributes nothing',
    () => parsePrior([
      '| 1 | 2026-01-01 | Acme | Role | n/a | Evaluated | x | y | z |',
      '| 2 | 2026-01-02 | Acme | Role | 3.4/5 | Evaluated | x | y | z |',
    ]).get('acme').n === 1],
  // The exact failure. This URL keyed as itself before the anchors changed.
  ['an underscore-prefixed Workday req id is extracted',
    () => jobKey('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/'
      + 'job/US-CA-Santa-Clara/Senior-Software-Engineer--Agentic-Engineering_JR2508244')
      === 'wd:JR2508244'],
  ['two spellings of one Workday req share a key',
    () => jobKey('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/'
      + 'US-CA-Santa-Clara/Senior-Software-Engineer--Agentic-Engineering_JR2508244')
      === jobKey('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/'
      + 'job/Remote/Senior-SWE--Agentic-Engineering_JR2508244?source=jobboard')],
  // The two spellings a JR\d{6,} floor would have read as absent.
  ['a hyphenated Sony req id keys the same as its bare form',
    () => jobKey('https://sonyglobal.wd1.myworkdayjobs.com/SonyGlobalCareers/job/'
      + 'San-Mateo/Sr-Software-Engineer--AI-Native_JR-103209') === 'wd:JR103209'],
  ['a five-digit Netflix req id is extracted',
    () => jobKey('https://netflix.wd1.myworkdayjobs.com/Netflix/job/USA---Remote/'
      + 'Member-of-Technical-Staff--Agentic-Systems---Games_JR48085') === 'wd:JR48085'],
  // Autodesk's year-prefixed form. This file had no branch for it at all while
  // scripts/workday-sweep.py did, so every 26WD row keyed as its own URL and two
  // spellings of one req counted as two pending jobs.
  ['an Autodesk year-prefixed req id is extracted',
    () => jobKey('https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/'
      + 'Principal-MCP-AI-Developer_26WD161146') === 'wd:26WD161146'],
  ['an Autodesk req id keys the same with and without its trailing sub-number',
    () => jobKey('https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/'
      + 'Principal-MCP-AI-Developer_26WD91231-1')
      === jobKey('https://autodesk.wd1.myworkdayjobs.com/Ext/job/Remote/'
      + 'Principal-MCP-AI-Dev_26WD91231')],
  // The two files cannot import one another, so nothing but this case notices
  // when one of them learns a tenant's spelling and the other does not. That is
  // not hypothetical: it is exactly how Node lost \d{2}WD and Python lost
  // JR\d{5}. Compared as SOURCE TEXT, because two patterns that merely agree on
  // today's examples are the drift this is meant to catch.
  ['the Node and Python requisition patterns are the same pattern',
    () => {
      const py = readFileSync('scripts/workday-sweep.py', 'utf8');
      const m = py.match(/REQ_ID = re\.compile\(\s*r"([^"]+)"\s*\)/);
      return !!m && m[1] === REQ_ID_SRC;
    }],
  // The same hand-port hazard one rule down. scripts/workday-sweep.py compared a swept
  // req id against a set built from the WHOLE tracker with no company on either side, so
  // one employer's R number marked another's live posting as already tracked and dropped
  // it out of the actionable results. It now scopes the bare R form the way jobKey does,
  // and which ids are bare has to stay the same question in both files: widening this
  // here alone would leave Python scoping a form Node keys bare, and the two would
  // disagree about the same requisition without either of them failing.
  ['the Node and Python ambiguous-id patterns are the same pattern',
    () => {
      const py = readFileSync('scripts/workday-sweep.py', 'utf8');
      const m = py.match(/AMBIGUOUS_REQ = re\.compile\(\s*r"([^"]+)"\s*\)/);
      return !!m && m[1] === AMBIGUOUS_ID.source;
    }],
  // R-family: 124 of the 401 Workday rows in the inbox carry this form, and the
  // tenant is part of the key because the number alone is not unique.
  ['a bare Workday R id is keyed with its tenant',
    () => jobKey('https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/'
      + 'USA---Remote-CA/Sr-Data-Pipeline-Engineer--Remote-_R21873')
      === 'wd:crowdstrike:R21873'],
  ['a hyphenated R id keys the same as its bare form',
    () => jobKey('https://calix.wd1.myworkdayjobs.com/Calix/job/Remote-US/'
      + 'Staff-Software-Engineer--AI-ML_R-11295') === 'wd:calix:R11295'],
  // The destructive case. Both URLs carry R11095; they are different jobs, and
  // every consumer of a key here prunes, marks or retires on a match. The
  // assertion names both keys rather than merely comparing them, because two
  // distinct fallback URLs are unequal even when id extraction is deleted
  // outright, and a case that cannot fail is not a case.
  ['two tenants sharing an R number get different keys',
    () => jobKey('https://workiva.wd1.myworkdayjobs.com/Workiva/job/Remote/'
            + 'Senior-Staff-ML-Engineer_R11095') === 'wd:workiva:R11095'
       && jobKey('https://calix.wd1.myworkdayjobs.com/Calix/job/Remote/'
            + 'Staff-Software-Engineer_R11095') === 'wd:calix:R11095'],
  // No tenant to pin the number down, so it is not a key: the URL identity
  // stands and the row is only ever equal to itself.
  ['an ambiguous id with no Workday tenant is not used as a key',
    () => jobKey('https://careers.example.invalid/job/Engineer_R11095')
      === 'https://careers.example.invalid/job/engineer_r11095'],
  ['the ambiguous id is still reported for the company-scoped tracker join',
    () => ambiguousId('https://calix.wd1.myworkdayjobs.com/Calix/job/X_R-11295') === 'R11295'
       && ambiguousId('https://nvidia.wd5.myworkdayjobs.com/X/job/Y_JR2508244') === null],
  // Four digits is the DATE in a report filename slug, not a requisition.
  ['a date in a report filename slug is not read as a req id',
    () => !REQ_ID.test('268-nvidia-senior-software-engineer-agentic-systems-jr-2026-07-07.md')],
  // REQ_ID names no board, so it must lose to every rule that does. With it
  // ordered third, as it was, this URL keyed as wd:R13733.
  ['a board-specific rule beats the req id',
    () => jobKey('https://jobs.lever.co/acme-r13733/0c50e5c7-a665-bb4b-4d79-3e7c3a9f0349')
      .startsWith('lever:')],
  // The query is cut before the id is looked for. A tracking parameter made two
  // unrelated postings one another's duplicate, which --prune then resolves.
  // Written with a JR id on purpose: the R family is already held back by the
  // tenant rule above, so only a JR id can show that the query itself is cut.
  ['a req id in the query string is not a key',
    () => jobKey('https://careers.example.invalid/a?utm_campaign=JR48085')
      === 'https://careers.example.invalid/a'
       && jobKey('https://careers.example.invalid/b?utm_campaign=JR48085')
      === 'https://careers.example.invalid/b'],
  ['a URL with no recognisable id is only equal to itself',
    () => jobKey('https://example.invalid/careers/engineer')
      === 'https://example.invalid/careers/engineer'],
  // The real inbox spellings, which are what the two sides have to agree on.
  ['the inbox spelling of a company reduces to the tracker spelling',
    () => srcCo(`CrowdStrike ${EM_DASH} Applied / Agentic AI (Remote / LA)`) === 'crowdstrike'
       && srcCo('CrowdStrike -- Applied / Agentic AI') === 'crowdstrike'
       && srcCo('SentinelOne (AI Developer Experience) \\[REMOTE-US\\]') === 'sentinelone'
       && srcCo('Blizzard Entertainment') === 'blizzard'],
];

// With --json the only thing on stdout may be the JSON, or it cannot be piped.
const say = (...a) => { if (!args.has('--json')) console.log(...a); };

if (args.has('--selftest')) {
  // The cases are the techart-ai-tooling preset's regression suite: run them on that
  // preset, never on the user's config, so they test the rules and not the config.
  configureRanker(loadLaneVocab(join(LANE_PRESETS, 'techart-ai-tooling.json')));
  let bad = 0;
  for (const [title, wantScore, wantTag] of RANK_CASES) {
    const r = rankTitle(title);
    const okScore = wantScore === null || r.score === wantScore;
    const okTag = !wantTag || r.tags.includes(wantTag);
    if (!okScore || !okTag) {
      bad++;
      console.log(`FAIL  "${title}"\n      got score ${r.score} tags [${r.tags}], ` +
        `wanted ${wantScore === null ? 'any' : wantScore}` + (wantTag ? ` + tag ${wantTag}` : ''));
    }
  }
  for (const [label, fn] of ORDER_CASES) {
    if (!fn()) { bad++; console.log(`FAIL ordering: ${label}`); }
  }
  for (const [label, fn] of SPLIT_CASES) {
    if (!fn()) { bad++; console.log(`FAIL vertical-split: ${label}`); }
  }
  for (const [label, fn] of KEY_CASES) {
    if (!fn()) { bad++; console.log(`FAIL req-id key: ${label}`); }
  }
  // --rank's default floor follows the vocabulary. A fixed 6 printed an empty triage list
  // under the general preset, where no title can score above 0.
  const floorOk = hasPositiveLanes() && defaultRankMin() === 6;
  configureRanker(loadLaneVocab(join(LANE_PRESETS, 'general.json')));
  const generalOk = !hasPositiveLanes() && defaultRankMin() === 0
    && rankTitle('Senior Backend Engineer').score >= defaultRankMin();
  configureRanker(loadLaneVocab(join(LANE_PRESETS, 'techart-ai-tooling.json')));
  if (!floorOk || !generalOk) {
    bad++;
    console.log(`FAIL rank floor: techart ${floorOk}, general ${generalOk}`);
  }
  const total = RANK_CASES.length + ORDER_CASES.length + SPLIT_CASES.length + KEY_CASES.length + 1;
  console.log(bad ? `\n${bad} of ${total} cases failed`
                  : `all ${RANK_CASES.length} ranker cases, ` +
                    `${ORDER_CASES.length} orderings, ` +
                    `${SPLIT_CASES.length} vertical-split and ` +
                    `${KEY_CASES.length} req-id key cases pass`);
  process.exit(bad ? 1 : 0);
}

const PIPE = 'data/pipeline.md';
const APPS = TRACKER;
for (const f of [PIPE, APPS]) {
  if (!existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
}

// --- what is already evaluated ---------------------------------------------
const appLines = readFileSync(APPS, 'utf8').split('\n').filter(l => l.startsWith('|'));
const evaluatedKeys = new Set();
/** "<id>@<company>" for ids that need a company to mean anything. See AMBIGUOUS_ID. */
const evaluatedAmbig = new Set();
const evaluatedTitles = new Set();
// Same req, different wording. The inbox can carry "Senior Technical Artist,
// Pipeline / Unannounced Project / Anytown, ST" while the tracker carries
// "Senior Technical Artist, Pipeline (Unannounced Project) (R000001)". Exact
// string equality never matches those, so tracked reqs kept reappearing as
// pending work.
// Compared as token sets INSIDE a single company, which keeps a loose threshold safe.
const evaluatedByCo = new Map();
const tokens = (s) => new Set(norm(s).split(' ').filter(t => t.length > 2));

/**
 * Loose title similarity. REPORT ONLY: this must never retire a row.
 *
 * Containment scoring matched "Senior Machine Learning Engineer - ESPN" against a
 * tracked "Lead Machine Learning Engineer", because the shorter tracked title sits
 * entirely inside the longer one. Those are different reqs. The costs are not
 * symmetric: a false positive marks a real lead as done and it is never seen
 * again, while a false negative only costs a second look. So similarity suggests,
 * and only a matching req id retires.
 */
function tokenMatch(co, role) {
  const a = tokens(role);
  if (a.size < 3) return false;
  for (const b of evaluatedByCo.get(co) || []) {
    if (b.size < 3) continue;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    if (inter / union >= 0.75) return true;
  }
  return false;
}
for (const l of appLines) {
  const cells = l.split('|').map(s => s.trim());
  if (cells.length < 5) continue;
  const [, , , company, role] = cells;
  if (!company || company === 'Company') continue;
  // The whole line is scanned on purpose: the req id lives in the role cell for
  // some rows and in the report-link slug for others. A tracker row names no
  // Workday tenant, so an ambiguous id is joined on the COMPANY instead, which
  // is the only disambiguator this side has.
  for (const m of l.matchAll(reqIdGlobal())) {
    const id = canonId(m[1]);
    if (AMBIGUOUS_ID.test(id)) evaluatedAmbig.add(`${id}@${normCo(company)}`);
    else evaluatedKeys.add(`wd:${id}`);
  }
  evaluatedTitles.add(`${normCo(company)}::${norm(role)}`);
  evaluatedByCo.set(normCo(company),
    [...(evaluatedByCo.get(normCo(company)) || []), tokens(role)]);
}

// --- read the inbox ---------------------------------------------------------
const raw = readFileSync(PIPE, 'utf8');
const lines = raw.split('\n');
const rows = [];
lines.forEach((line, i) => {
  const m = line.match(/^-\s*\[( |x)\]\s*(\S+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*$/);
  if (!m) return;
  rows.push({ i, done: m[1] === 'x', url: m[2], source: m[3], role: m[4],
              key: jobKey(m[2]), ambigId: ambiguousId(m[2]) });
});
const pending = rows.filter(r => !r.done);
say(`inbox: ${rows.length} rows, ${pending.length} unchecked\n`);

// --- duplicates -------------------------------------------------------------
const byKey = new Map();
for (const r of pending) {
  if (!byKey.has(r.key)) byKey.set(r.key, []);
  byKey.get(r.key).push(r);
}
const dupGroups = [...byKey.values()].filter(g => g.length > 1);
const dupRows = dupGroups.reduce((n, g) => n + g.length - 1, 0);
say(`duplicates: ${dupRows} redundant rows across ${dupGroups.length} reqs`);
if (VERBOSE) {
  for (const g of dupGroups.slice(0, 25)) {
    say(`  ${g[0].key}  x${g.length}  ${g[0].role.slice(0, 70)}`);
    for (const r of g) console.log(`      line ${r.i + 1}  ${r.url.slice(0, 96)}`);
  }
}

// --- already evaluated ------------------------------------------------------
const survivors = [...byKey.values()].map(g => g[0]);
const done = [];
const similar = [];   // looks tracked, but not retired without a matching req id
for (const r of survivors) {
  const src = srcCo(r.source);
  if (evaluatedKeys.has(r.key)) { done.push([r, 'req id already in tracker']); continue; }
  // The inbox key for an ambiguous id carries the Workday TENANT and the
  // tracker only knows the COMPANY, so the two sides join on the id plus the
  // company rather than on the key. Disagreeing company spellings only cost a
  // second look here; a bare id match would cost a lost lead.
  if (r.ambigId && evaluatedAmbig.has(`${r.ambigId}@${src}`)) {
    done.push([r, 'req id already in tracker']); continue;
  }
  if (evaluatedTitles.has(`${src}::${norm(r.role)}`)) { done.push([r, 'company+role already in tracker']); continue; }
  if (tokenMatch(src, r.role)) similar.push(r);   // reported, never retired
}
say(`already evaluated: ${done.length} reqs are in applications.md already`);
say(`similar to a tracked req (NOT retired, review manually): ${similar.length}`);
if (VERBOSE) for (const [r, why] of done.slice(0, 25)) {
  say(`  ${why}: ${r.source.slice(0, 40)} | ${r.role.slice(0, 60)}`);
}
// The `similar` bucket was counted and then never printed, even under --verbose, so
// the one thing it exists for could not be done: it is the "review manually" pile, and
// a pile you cannot see is not a pile you can review. These are reqs whose company and
// role look tracked but whose requisition id does NOT match anything on the tracker,
// which is exactly the shape of a repost under a new number. Snap reposted Generative
// ML L5 as H226SWEGML5 against the tracked R0231298-1, and that is a genuinely new
// requisition rather than a duplicate.
if (VERBOSE && similar.length) {
  say(`\n  reqs to review by hand (${similar.length}), new req id but a familiar role:`);
  for (const r of similar.slice(0, 25)) {
    say(`    ${r.source.split('—')[0].split('|')[0].trim().slice(0, 26).padEnd(26)} ${r.role.slice(0, 52)}`);
    say(`      ${r.url.slice(0, 108)}`);
  }
  if (similar.length > 25) say(`    ...and ${similar.length - 25} more`);
}

const genuine = survivors.length - done.length;
say(`\ngenuinely pending: ${genuine} reqs ` +
  `(down from ${pending.length} raw rows, a ${Math.round((1 - genuine / pending.length) * 100)}% reduction)`);

/**
 * What this company's PREVIOUS evaluations came to: {n, best, skips}.
 *
 * Triage ranked a title and said nothing about the employer behind it, so five new leads
 * read as five open questions when four of them were companies already evaluated several
 * times. Working a shortlist by hand, the history was the whole answer: a sibling req
 * already scored low on comp with identical pay zones, a narrow low band of prior rows, a
 * documented gap area. Exactly one of the five was a genuinely new proposition.
 *
 * A prior score is CONTEXT, never a verdict: a company that scored 3.4 on a ranking role
 * can post a bullseye next week, which is why this annotates and does not filter.
 */
if (RANK) {
  const doneSet = new Set(done.map(([r]) => r.i));
  const ranked = survivors.filter(r => !doneSet.has(r.i))
    .map(r => ({ ...r, ...rankTitle(r.role) }))
    .sort((a, b) => b.score - a.score);
  // Threshold is a knob, not a truth. 6 is where the obvious lane matches sit;
  // lowering it trades precision for recall, which is the right trade once the
  // top tier is worked. --max lets a tier be worked without re-doing the one above.
  const argOf = (flag, dflt) => {
    const a = process.argv.find(x => x.startsWith(flag + '='));
    return a ? Number(a.split('=')[1]) : dflt;
  };
  const MIN = argOf('--min', defaultRankMin()), MAX = argOf('--max', Infinity);
  const worth = ranked.filter(r => r.score >= MIN && r.score < MAX);
  if (args.has('--json')) {
    console.log(JSON.stringify(worth.map(r => ({
      score: r.score, tags: r.tags, url: r.url, key: r.key,
      source: r.source.replace(/\\?\[.*?\\?\]/g, '').trim(), role: r.role,
    })), null, 1));
    process.exit(0);
  }
  // Fold one company's repeated title stem into a single row. See
  // collapseVerticalSplits above for why a single-title scorer cannot see this.
  // Printed list only: --json stays complete above, since it feeds tools that do
  // their own grouping and a machine consumer should not lose rows.
  const { shown, folded, collapsed } = collapseVerticalSplits(worth);

  if (!hasPositiveLanes()) {
    console.log('\nnote: the lane vocabulary has no positive terms, so every title scores 0 and '
      + 'this list is unranked. Add title keywords with `node setup.mjs` or a lane preset.');
  }
  console.log(`\ntriage: ${worth.length} of ${ranked.length} pending reqs score ${MIN}+ on title`);
  console.log(`  ${ranked.filter(r => r.score <= -90).length} out-of-lane, ` +
    `${ranked.filter(r => DEPRI && r.tags.includes(DEPRI.tag)).length} de-prioritised titles` +
    `${folded ? `, ${folded} folded into ${collapsed} vertical-split group(s)` : ''}\n`);
  for (const r of shown.slice(0, 45)) {
    const src = r.source.replace(/\\?\[.*?\\?\]/g, '').split(EM_DASH)[0].split(' -- ')[0].trim();
    // What happened the last time this employer was looked at. A blank means never, which
    // is its own signal and the reason this is a suffix rather than a filter.
    const p = priorFor(r.source);
    const hist = p ? `  [${p.n} prior, best ${p.best.toFixed(1)}${p.skips ? `, ${p.skips} skipped` : ''}]` : '';
    console.log(`${String(r.score).padStart(3)}  [${r.tags.join(',')}]  ${src.slice(0, 30).padEnd(30)} ${r.role.slice(0, 52).padEnd(52)}${hist}`);
  }
  process.exit(0);
}

if (!PRUNE) { console.log('\n(report only — pass --prune to mark the resolved rows [x])'); process.exit(0); }

const resolve = new Map();
for (const g of dupGroups) for (const r of g.slice(1)) resolve.set(r.i, 'duplicate');
for (const [r, why] of done) resolve.set(r.i, why);

// A row that failed the LOCATION gate is finished work, but the inbox had no way
// to record that, so every future triage resolved and rejected it again. Feeding
// dispositions back in is what stops the queue from being permanent.
// Format: [{"url": "...", "disposition": "closed | non-US | Bay Area | ..."}]
const dispArg = process.argv.find(a => a.startsWith('--dispositions='));
if (dispArg) {
  const path = dispArg.split('=').slice(1).join('=');
  if (!existsSync(path)) {
    console.error(`dispositions file not found: ${path}`);
    process.exit(1);
  }
  // A dispositions entry carries a URL and nothing else, so this match has no
  // company to fall back on and the key must be safe on its own. It is: an
  // ambiguous id is only ever a key when the URL names the Workday tenant, so
  // one tenant's disposition cannot reach another's row. An earlier draft of
  // this change keyed a bare R number and a single Workiva entry marked the
  // Calix row [x] as well.
  const byUrlKey = new Map();
  for (const r of pending) {
    if (!byUrlKey.has(r.key)) byUrlKey.set(r.key, []);
    byUrlKey.get(r.key).push(r);
  }
  let n = 0;
  for (const d of JSON.parse(readFileSync(path, 'utf8'))) {
    for (const r of byUrlKey.get(jobKey(d.url)) || []) {
      if (!resolve.has(r.i)) { resolve.set(r.i, `triaged: ${d.disposition}`); n++; }
    }
  }
  say(`dispositions applied: ${n} rows marked from ${path}`);
}
copyFileSync(PIPE, PIPE + '.bak');
const outLines = lines.map((line, i) =>
  resolve.has(i) ? line.replace(/^-\s*\[ \]/, '- [x]') + `  <!-- resolved: ${resolve.get(i)} -->` : line);
writeFileSync(PIPE, outLines.join('\n'));
console.log(`\nmarked ${resolve.size} rows resolved. backup at ${PIPE}.bak`);
