#!/usr/bin/env node
/**
 * eval-write.mjs — turn a filled eval-prep packet into a report and a tracker TSV.
 *
 * Every evaluation this session was emitted by a throwaway script that re-typed the
 * report header, the Machine Summary schema and the nine TSV columns. That is how a
 * fabricated URL and a mis-ordered column get in. This writes both from the packet,
 * so the URL is the one the resolver returned and the schema is identical each time.
 *
 * Scores come from score-model.mjs, never from arithmetic here, so the board stays
 * computed one way everywhere.
 *
 * Run:
 *   node eval-write.mjs batch/eval-queue/<packet>.json --date=YYYY-MM-DD
 *   node eval-write.mjs batch/eval-queue/*.json --date=YYYY-MM-DD
 *   node eval-write.mjs <packet> --date=YYYY-MM-DD --dry-run
 *   node eval-write.mjs <packet> --date=YYYY-MM-DD --rescore
 *
 * --rescore rewrites the report this req ALREADY has, in place (same number, same
 * file), and updates its tracker row's score, note and, for a row not yet past
 * Evaluated, its status. Without it a second packet for a tracked req is refused (rule
 * 3, one report per req), so a ruling that changes how a role type is judged had no
 * way back into the reports it had already shaped. The old report is copied to
 * batch/rescore-backup/<date>/ first, since reports/ is not under version control. A
 * report with no machine `url:` (hand-written, pre-2026-08) cannot be found by
 * requisition identity; name it in the packet as `rescore_report: "<file>.md"`.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, copyFileSync } from 'fs';
import { basename, join } from 'path';
import { trackerPath, columnsOf, trackerRows, setCell, reportFileOf, normalizeStatus } from './tracker-rows.mjs';
import { applyModel, loadPrefs, normaliseArrangement } from './score-model.mjs';
import { parseScores } from './audit-scores.mjs';
import { reqLabel } from './req-id-core.mjs';
import { extractJobId, companyKey } from './role-matcher.mjs';
import { guardArgs } from './cli-guard.mjs';

const args = guardArgs({
  name: 'eval-write.mjs',
  summary: 'turn filled eval-prep packets into reports and tracker TSVs',
  positional: '<packet.json>...',
  flags: [
    ['--date <YYYY-MM-DD>', 'report date (required; never taken from the clock)'],
    ['--dry-run', 'print what would be written, write nothing'],
    ['--rescore', "rewrite each packet's existing report in place and update its tracker row"],
  ],
  notes: 'Writes reports/ and batch/tracker-additions/ unless --dry-run is given.',
});
const DRY = args.has('--dry-run');
const RESCORE = args.has('--rescore');
const files = args.positional;
if (!files.length) {
  console.log('usage: node eval-write.mjs <packet.json> [...] --date=YYYY-MM-DD [--dry-run]');
  process.exit(1);
}
const DATE = args.value('--date');
if (!DATE) {
  console.error('--date=YYYY-MM-DD is required. The date is not derived here on purpose:\n' +
    'a report dated by the machine clock silently disagrees with the tracker row when a\n' +
    'run crosses midnight, which has already happened once in this project.');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error('bad --date'); process.exit(1); }

const prefs = loadPrefs();
// `num` is deliberately NOT required. eval-prep initialises it to null and this
// writer allocates it; see claimNum below.
// arrangement is required because a null one was DERIVED from the location string, so
// an evaluator who meant "unknown" and forgot to write it got Cary, NC read as onsite and
// a lower final, which every later audit then replayed as self-consistent (Codex, PR 14).
// A gate-closed packet is never scored and does not need it.
const REQUIRED = ['company', 'status', 'match_w_cv', 'north_star', 'comp_score',
                  'cultural_signals', 'body', 'gate', 'recommendation', 'arrangement'];

const DIMS = ['match_w_cv', 'north_star', 'comp_score', 'cultural_signals'];
const blank = v => v === null || v === undefined || v === '';

/**
 * A req closed by a HARD CONSTRAINT before scoring, and the record it still needs.
 *
 * Such a role is never scored: the four dimensions stay null, because a zero would
 * read as a real judgement of fit and culture that nobody made. Before this path
 * existed, REQUIRED demanded all four, so a packet whose location gate failed after
 * prep could not be written at all. Four in one day (2026-10-15) were moved into
 * batch/eval-queue/done/ by hand instead, which left the tracker with no row, and the
 * next sweep re-surfaced every one of them as new work.
 *
 * Closed means `location_verdict: fail` from eval-prep's gate, or an explicit
 * `in_bounds: false` from the evaluator for any other hard constraint (a location
 * the resolver could not read, a posted total under the floor). The explicit form
 * must say what closed it in `gate`, since "no location returned" is not a reason.
 *
 * A closed packet with FILLED dimensions is refused, not warned about. That shape
 * has been written before, a location fail scored 4.69, and it put a 4.7 on the
 * tracker for a role the location policy rules out. If the
 * gate is wrong, correct `location_verdict` and score it; if it is right, clear the
 * dimensions. Either is a decision, and silently picking one is not.
 */
const gateClosed = p => p.in_bounds === false || p.location_verdict === 'fail';

/** Why a gate-closed packet cannot be written, or null when it can. */
function gateClosedProblem(p) {
  const filled = DIMS.filter(k => !blank(p[k]));
  // eval-prep seeds red_flags_adj with 0, so only a NON-zero value is a judgement.
  if (!blank(p.red_flags_adj) && Number(p.red_flags_adj) !== 0) filled.push('red_flags_adj');
  if (filled.length) {
    return `the gate closed it (${p.location_verdict === 'fail' ? 'location_verdict: fail' : 'in_bounds: false'}) ` +
      `but ${filled.join(', ')} ${filled.length > 1 ? 'are' : 'is'} filled. A gate-closed role is never scored: ` +
      'clear the dimensions to record it unscored, or correct location_verdict if the gate is wrong';
  }
  const missing = ['company', 'title', 'url', 'slug'].filter(k => blank(p[k]));
  if (blank(gateText(p))) missing.push(p.location_verdict === 'fail' ? 'gate or location_why' : 'gate');
  if (missing.length) return `unfilled: ${missing.join(', ')}`;
  if (!blank(p.status) && String(p.status).trim().toUpperCase() !== 'SKIP') {
    return `status is "${p.status}"; a role closed before scoring is recorded as SKIP`;
  }
  return null;
}

/** The evaluator's own gate text wins; eval-prep's location_why is the fallback. */
const gateText = p => !blank(p.gate) ? String(p.gate)
  : p.location_verdict === 'fail' && !blank(p.location_why) ? String(p.location_why) : '';

/** Tracker cells are a pipe-delimited table: one line, no pipes. */
const cell = (s) => String(s).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

/**
 * The req id MUST travel in the role field. merge-tracker dedupes on the job id when
 * it can find one and falls back to fuzzy title matching when it cannot, and the
 * fallback over-merges: a Disney "Senior Principal ML Engineer, Ad Platforms" was
 * silently absorbed into a tracked "Lead ML Engineer" and its row never appeared,
 * leaving a report on disk with nothing pointing at it.
 * Anchor on the separator, not \b. Workday URLs end "..._17372837" and underscore is
 * a word character, so \b never matches before the digits and the id was silently
 * dropped, which is what let the fuzzy fallback over-merge in the first place.
 * reqLabel() lives in req-id-core.mjs. Only a shared-pattern id in this cell is
 * IDENTITY to role-matcher; a bare-number label is for the reader, and scan.mjs
 * strips both (req-id-core.mjs says why the three differ).
 */
const roleCellOf = (p) => {
  const reqId = reqLabel(p.url);
  return reqId && !p.title.includes(reqId) ? `${cell(p.title)} (${reqId})` : cell(p.title);
};

/** Quote a value for a double-quoted YAML scalar on one line. */
const q = s => String(s).replace(/\s+/g, ' ').replace(/"/g, "'").trim();

/**
 * The report and the tracker TSV for a gate-closed packet.
 *
 * The shape is the one audit-scores.mjs already accepts as "closed by a hard
 * constraint before scoring": `in_bounds: false` and every dimension null. It writes
 * no `global`, no `model_base` and no `final`, because there is no number, and the
 * tracker score cell is `N/A`, the spelling tracker-rows.mjs SCORE_CELL and
 * verify-pipeline already accept for exactly that. The five 2026-09-19 reports wrote
 * 0.0 in all three places, which reads as a score of zero.
 */
/**
 * How the packet's liveness and body were obtained, stated as they were and not upgraded.
 * Every report used to read "LIVE (verified) - resolved via scripts/req-resolve.py ... API"
 * whatever the packet said, including packets whose `live` was null, and a LinkedIn page
 * captured in the browser (ats `linkedin`, 2026-10-28) would have been described as a
 * resolver API read dated the day the report was written (Codex review).
 */
function provenance(p, DATE) {
  const state = p.live === true ? 'LIVE (verified)' : p.live === false ? 'CLOSED' : 'liveness unknown';
  if (p.ats === 'linkedin') {
    const on = p.captured_on || 'date not recorded';
    return {
      legit: `${state} - read from the LinkedIn listing in the browser (no ATS behind it), ${on}`,
      verif: `${on}, LinkedIn page capture. Depth: ${p.verification_depth}.`,
      verified: `${on} LinkedIn page capture`,
    };
  }
  return {
    legit: `${state} - resolved via scripts/req-resolve.py (${p.ats}), ${DATE}`,
    verif: `${DATE}, ${p.ats} API. Depth: ${p.verification_depth}.`,
    verified: `${DATE} ${p.ats} API`,
  };
}

function renderGateClosed(p, N, file, DATE) {
  const pv = provenance(p, DATE);
  const why = q(gateText(p));
  const byLocation = p.location_verdict === 'fail';
  const closedBy = byLocation ? 'the location gate' : 'a hard constraint';
  const rec = blank(p.recommendation) ? `SKIP, not scored. Closed by ${closedBy}: ${why}`
    : String(p.recommendation);
  const body = blank(p.body) ? 'Not evaluated. See the verdict for the gate that closed it.'
    : String(p.body);
  const verdict = `Closed by ${closedBy} before scoring: ${why.replace(/\.$/, '')}. ` +
    'No dimension was judged and no score exists.' +
    (blank(p.recommendation) ? '' : `\n\n${p.recommendation}`);
  const md = `# ${N} - ${p.company} - ${p.title}

**Company:** ${p.company}
**Role:** ${p.title}
**Score:** N/A (not scored, closed by ${closedBy})
**URL:** ${p.url}
**Legitimacy:** ${pv.legit}
**PDF:** ❌
**Date:** ${DATE}
**Verification:** ${pv.verif}

## Analysis

${body}

## Verdict

${verdict}

## Machine Summary

\`\`\`yaml
num: ${N}
writer: eval-write
company: "${q(p.company)}"
role: "${q(p.title)}"
slug: ${p.slug}
url: ${p.url}
date: ${DATE}
track: ${p.track || 'ai-ml'}
live: true
location_final: "${q(p.location || '')}${LOC_SEP}${q(p.location_why || '')}"
in_bounds: false
legitimacy: "LIVE (verified)"
verification_depth: ${p.verification_depth}
scores:
  match_w_cv: null
  north_star: null
  comp: null
  cultural_signals: null
  red_flags_adj: null
location_verdict: ${p.location_verdict}
comp_posted: "${q(p.comp?.posted || 'not published')}"
gate: "${why}"
recommendation: "${q(rec)}"
verified: "${pv.verified}"
\`\`\`
`;
  const tsv = [N, DATE, cell(p.company), roleCellOf(p), 'SKIP', 'N/A', '❌',
    `[${N}](${file})`, cell(`Not scored. Closed by ${closedBy}: ${why}`).slice(0, 235)].join('\t');
  return { md, tsv };
}

/**
 * Does audit-scores.mjs read this report as gate-closed? Asked of the reader itself,
 * not of a copy of its rule. parseScores keeps the MOST COMPLETE of several parses,
 * one of them a loose prose scan, so free text such as "comp floor of $175K" in the
 * analysis reads as a comp score of 175, the report then counts as a post-baseline
 * report with a missing score block, and the audit fails the run.
 */
function auditReadsAsClosed(md) {
  const s = parseScores(md);
  if (!/^[ \t]*in_bounds:\s*false\b/m.test(md)) return 'no in_bounds: false line';
  const read = s ? ['match_w_cv', 'north_star', 'comp', 'cultural_signals']
    .filter(k => s[k] !== null && s[k] !== undefined) : [];
  return read.length
    ? `audit-scores would read ${read.map(k => `${k}=${s[k]}`).join(', ')} out of the text ` +
      `(${s.form} parse); reword the body or recommendation so no dimension name sits next to a number`
    : null;
}

/** Three digits, zero-padded, because every existing report filename is. It is a
 *  MINIMUM width, so the corpus passing 999 widens rather than wrapping. */
const pad = n => String(n).padStart(3, '0');
const sentinelOf = n => join('reports', `${pad(n)}-RESERVED.md`);

// A report number is taken two different ways and they are not interchangeable.
// A finished report OWNS its number for good. A "NNN-RESERVED.md" sentinel is a
// claim reserve-report-num.mjs planted for some process, which an allocation
// must step over but which an explicitly supplied number must be allowed to
// consume: reserve-then-write is exactly the documented flow, and treating a
// sentinel as a collision would reject every number that script hands out.
// Matched on "^(\d{3,})-" rather than parseInt: three is the floor, not the
// ceiling, and a parseInt of "superseded" or a stray name is not a number here.
const numOf = (f) => { const m = f.match(/^(\d{3,})-/); return m ? Number(m[1]) : null; };
const entries = readdirSync('reports');
const taken = new Set(entries.filter(f => !f.endsWith('-RESERVED.md'))
  .map(numOf).filter(n => n !== null));
const reserved = new Set(entries.filter(f => f.endsWith('-RESERVED.md'))
  .map(numOf).filter(n => n !== null));

/**
 * Claim the next free report number, for real.
 *
 * CLAUDE.md states the rule as "sequential three-digit, max existing + 1,
 * eval-write picks it". It did not pick it. eval-prep initialises num to null,
 * num was REQUIRED, and this file only ever REJECTED a collision, so the
 * documented prep-to-write flow stopped dead at a manual numbering step every
 * time.
 *
 * Reading the directory is not reserving anything, and automatic max+1 is what
 * makes that matter. Two windows that both see 603 as the highest now both
 * CHOOSE 604 by themselves, where two people picking numbers by hand at least
 * had a chance of picking differently; the loser's write lands on the winner's
 * slug or silently overwrites it. So this claims the slot the same way
 * reserve-report-num.mjs does: 'wx' is open(O_CREAT|O_EXCL), exactly one
 * process creates the file, and the loser sees EEXIST and moves on. The
 * sentinel is released once the real report is written, and verify-pipeline
 * garbage-collects any that a crash leaves behind.
 */
const claimNum = () => {
  let n = Math.max(0, ...taken, ...reserved);
  for (let tries = 0; tries < 500; tries++) {
    n++;
    if (taken.has(n) || reserved.has(n)) continue;
    // A dry run must leave nothing on disk, so it reserves in memory only. That
    // is enough for its one job: showing two packets taking two numbers.
    if (DRY) { reserved.add(n); return n; }
    try {
      writeFileSync(sentinelOf(n), '', { flag: 'wx' });
      reserved.add(n);
      return n;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      reserved.add(n);   // another process got there first
    }
  }
  return null;
};

/**
 * What separates the location from the reason in `location_final`.
 *
 * This was an em dash, so every report this writer has ever produced violated
 * the repository's absolute rule against that character, however clean the
 * packet was. The separator is a CONTRACT: score-audit.mjs splits the field on
 * it to replay the model, and hundreds of reports already on disk still carry
 * the old one, so that reader parses both forms and this writer emits only
 * this one.
 */
const LOC_SEP = ' -- ';

/** Two spellings of one posting URL are one req.
 *  SCHEME and HOST are folded; path, query and fragment are NOT. Lowercasing the whole
 *  URL conflates postings that differ only by case, and this comparison decides whether a
 *  report already exists, so getting it wrong writes a second report or suppresses a
 *  needed one. scripts/eval-blockers.py norm_url() was changed in the same commit and
 *  each file carries a case for the property, because a comment saying two functions
 *  mirror each other is not a mechanism. */
const normUrl = (u) => {
  const s = String(u).trim().replace(/\/+$/, '');
  const m = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(s);
  return m ? m[1].toLowerCase() + m[2].toLowerCase() + m[3] : s.toLowerCase();
};

/**
 * Does this already-written report describe the same REQ as the packet in hand?
 *
 * Read off the Machine Summary rather than the filename. The filename carries
 * only the title slug and the date, and a title is not an identity: nvidia-sweep.py
 * records NVIDIA JR2620896 and JR2301525 as one word apart with opposite
 * location verdicts, and two unrelated employers posting "AI Engineer" is the
 * commoner shape.
 *
 * The URL decides when both sides have one, because it names the requisition.
 * Older and hand-authored reports have no machine-readable `url:`, so those fall
 * back to the company, which still separates the two employers this exists to
 * tell apart. Anchored on `^\s*url:` so it reads the YAML line and not the
 * report header's `**URL:**`.
 */
const machineUrl = (t) => (t.match(/^[ \t]*url:[ \t]*["']?(\S+?)["']?[ \t]*$/m) || [])[1] || '';
const machineCo = (t) => (t.match(/^[ \t]*company:[ \t]*["']?(.+?)["']?[ \t]*$/m) || [])[1] || '';

function sameReq(path, p) {
  let t = '';
  try { t = readFileSync(path, 'utf8'); } catch { return false; }
  const theirUrl = machineUrl(t), theirCo = machineCo(t);
  if (theirUrl && p.url) return normUrl(theirUrl) === normUrl(p.url);
  return !!theirCo && companyKey(theirCo) === companyKey(p.company);
}

/**
 * Every report on disk, indexed by REQUISITION identity. Built once per run.
 *
 * The search used to be prefiltered to reports whose filename ended
 * `-<slug>-<DATE>.md`, and both halves of that key are mutable. A req retried on
 * a different day, or whose ATS title changed between the two packets, was never
 * compared against its own existing report even though the machine summary
 * carried an IDENTICAL url, so a second report and a second tracker row were
 * written for one req, against pipeline rule 3. dedup-tracker then deletes the
 * extra rows, which is how that mistake is normally paid for.
 *
 * Two keys, and the difference between them is deliberate:
 *
 *   byUrl    the normalised posting URL. An identity on its own, so it is
 *            searched across every report regardless of title or date.
 *   byReqCo  the extracted job id, SCOPED BY COMPANY. This catches the case the
 *            URL key cannot: Workday re-slugs a live req, so one requisition has
 *            two different URLs. It is scoped because a bare Workday "R#####"
 *            is not unique across tenants (CrowdStrike R26710 and Workiva R11095
 *            come from independent counters), and a false hit here is a SKIP,
 *            which means a real req silently gets no report. The company is what
 *            pins the number down, the same way jobKey() uses the tenant.
 *
 * Reports written during this run are added as they land, so a rerun inside one
 * invocation cannot mint a second report for a req this run already wrote.
 *
 * COST, measured rather than assumed: one pass over reports/ reading every file
 * is 46 to 53ms for the 588 reports on disk (258 of which carry a machine url:,
 * 235 of which yield a job id), once per run. That is a fraction of one Windows
 * process spawn and it happens once against a run that resolves and writes. The
 * same pass also reports ZERO key collisions on the live corpus, 258 url keys
 * from 258 urls and 235 req+company keys from 235, so the widened search adds no
 * false skip today. If reports/ ever grows past what one pass can afford, make
 * the index incremental; do not re-narrow the search.
 */
let REPORT_INDEX = null;

function indexReport(file, url, company) {
  if (!REPORT_INDEX || !url) return;
  const u = normUrl(url);
  if (!REPORT_INDEX.byUrl.has(u)) REPORT_INDEX.byUrl.set(u, file);
  const id = extractJobId(url);
  if (!id || !company) return;
  const k = `${id}|${companyKey(company)}`;
  if (!REPORT_INDEX.byReqCo.has(k)) REPORT_INDEX.byReqCo.set(k, file);
}

function reportIndex() {
  if (REPORT_INDEX) return REPORT_INDEX;
  REPORT_INDEX = { byUrl: new Map(), byReqCo: new Map() };
  for (const f of readdirSync('reports')) {
    if (!f.endsWith('.md')) continue;
    let t = '';
    try { t = readFileSync(join('reports', f), 'utf8'); } catch { continue; }
    indexReport(f, machineUrl(t), machineCo(t));
  }
  return REPORT_INDEX;
}

/**
 * The report already written for this packet's req, or undefined.
 *
 * Requisition identity first, across ALL reports. The same-slug-same-date scan
 * survives only as the fallback for reports too old to carry a machine-readable
 * `url:`, where the COMPANY is the only signal left. Company alone is not an
 * identity (every NVIDIA report would match every NVIDIA packet), so that arm
 * keeps the narrow filename scope it always had.
 */
function priorReport(p) {
  return priorReportById(p) || readdirSync('reports')
    .filter(x => x.endsWith(`-${p.slug}-${DATE}.md`))
    .find(x => sameReq(join('reports', x), p));
}

/** The prior report found by REQUISITION identity alone (url, then id plus company). */
function priorReportById(p) {
  if (!p.url) return undefined;
  const ix = reportIndex();
  const byUrl = ix.byUrl.get(normUrl(p.url));
  if (byUrl) return byUrl;
  const id = extractJobId(p.url);
  return id && p.company ? ix.byReqCo.get(`${id}|${companyKey(p.company)}`) : undefined;
}

/** Does a report's machine company, else its header company, match the packet's? */
function sameCompany(path, p) {
  let t = '';
  try { t = readFileSync(path, 'utf8'); } catch { return false; }
  const co = machineCo(t) || (t.match(/^\*\*Company:\*\*\s*(.+)$/m) || [])[1] || '';
  return !!co && companyKey(co) === companyKey(p.company);
}

/** The report and the tracker TSV for a scored packet. Scores come from score-model.mjs. */
function renderScored(p, N, file) {
  const pv = provenance(p, DATE);
  const base = (p.match_w_cv + p.north_star + p.comp_score + p.cultural_signals) / 4
    + (p.red_flags_adj || 0);
  // The only comp figure the model is allowed to GATE on, and nothing else.
  //
  // This line read `comp_total_est: "${p.comp.posted}"` for ANY posted range,
  // which labels a base-only band as total compensation. score-model.mjs treats
  // comp_total_est as verified TOTAL comp deliberately: compBand's own note calls
  // that field the only way a report can arm the gate, and compVerdict then
  // scales the WHOLE score by (achievable/floor)^K when a total band misses the
  // floor. Most postings print base. So a base range of $150K to $180K,
  // which says nothing about total once bonus and equity are counted, was sinking
  // the entire score, and that is the exact harm eval-prep.py's comp_verdict()
  // was changed to prevent upstream: it records `basis` as total, base or unknown
  // and gates only on total, because the base-to-total ratio is not a constant
  // (a studio pays base plus ten percent, big tech pays RSUs worth double it).
  //
  // The invariant: a range whose basis is not verified TOTAL must never trigger
  // the sub-floor comp penalty. It is expressed by WITHHOLDING the field rather
  // than by branching inside score-model, because withholding is exactly
  // equivalent to the rule as score-model already parses it. No band yields
  // factor 1, and a non-total band that clears the floor yields factor 1 too, so
  // the only case whose behaviour changes is the one that must change. Nothing is
  // hidden from the reader either: comp_posted and comp_basis below still print
  // the band and say what it measures.
  //
  // A missing basis reads as `unknown`, not as total. An older packet that never
  // recorded one has not established anything about total comp, and guessing in
  // the direction that penalises is the failure being fixed.
  //
  // comp_basis in the Machine Summary below used to read "posted" or "none",
  // which answers whether a figure exists rather than what it measures, so the
  // report could not state the thing the gate turns on. It now carries the
  // packet's real basis. And compText is echoed into the report when, and only
  // when, it is a total: apply-model.mjs replays the model over the whole report
  // TEXT, so a gate that eval-write applied here and the report did not record
  // would be silently undone on the next recomputation pass.
  const compBasis = p.comp?.posted ? (p.comp.basis || 'unknown') : 'none';
  // An evaluator who reasons to a total-comp judgement records it as the packet's
  // comp_total_est (it is the only field that can arm the comp gate). This
  // path did not exist, so every such judgement had to be hand-edited into the report
  // after the fact or was lost. A posted figure whose basis is total still wins.
  const judged = p.comp_total_est;
  const compText = compBasis === 'total' ? `comp_total_est: "${p.comp.posted}"`
    : judged != null && judged !== ''
      ? `comp_total_est: ${typeof judged === 'number' ? judged : `"${String(judged).replace(/"/g, "'")}"`}`
      : '';
  // A known arrangement (stated in the JD or established for the org) is passed through
  // rather than re-derived from the location string, which reads "unknown" (x1) for an
  // office address and so overstated every onsite role it could not parse.
  const m = applyModel(Math.round(base * 1000) / 1000, {
    text: `${compText}\nlocation: "${p.location || ''}"\n`,
    company: p.company, role: p.title, prefs, arrangement: p.arrangement,
  });

  const md = `# ${N} - ${p.company} - ${p.title}

**Company:** ${p.company}
**Role:** ${p.title}
**Score:** ${m.final.toFixed(1)}/5
**URL:** ${p.url}
**Legitimacy:** ${pv.legit}
**PDF:** ❌
**Date:** ${DATE}
**Verification:** ${pv.verif}

## Analysis

${p.body}

## Verdict

| | |
|---|---|
| match_w_cv | ${p.match_w_cv.toFixed(1)} |
| north_star | ${p.north_star.toFixed(1)} |
| comp | ${p.comp_score.toFixed(1)} |
| cultural_signals | ${p.cultural_signals.toFixed(1)} |
| red_flags_adj | ${(p.red_flags_adj || 0).toFixed(1)} |
| base | ${m.base.toFixed(2)} |
| compFactor | ×${m.compFactor.toFixed(3)} |
| prefFactor | ×${m.prefFactor.toFixed(3)}${m.damped ? ' (title de-prioritised)' : ''} |
| arrFactor (${m.arrangement}) | ×${m.arrFactor.toFixed(3)} |
| **final** | **${m.final.toFixed(2)}** |

${p.recommendation}

## Machine Summary

\`\`\`yaml
num: ${N}
writer: eval-write
company: "${p.company}"
role: "${p.title}"
slug: ${p.slug}
url: ${p.url}
date: ${DATE}
track: ${p.track || 'ai-ml'}
live: true
location_final: "${(p.location || '').replace(/"/g, "'")}${LOC_SEP}${p.location_why}"
in_bounds: ${p.location_verdict === 'pass'}
legitimacy: "LIVE (verified)"
verification_depth: ${p.verification_depth}
scores:
  match_w_cv: ${p.match_w_cv}
  north_star: ${p.north_star}
  comp: ${p.comp_score}
  cultural_signals: ${p.cultural_signals}
  red_flags_adj: ${p.red_flags_adj || 0}
  global: ${m.base.toFixed(2)}
  model_base: ${m.base.toFixed(2)}
final: ${m.final.toFixed(2)}
location_verdict: ${p.location_verdict}
arrangement: ${m.arrangement}
comp_posted: "${p.comp?.posted || 'not published'}"
comp_basis: ${compBasis}${p.comp?.basis_why ? `\ncomp_basis_why: "${String(p.comp.basis_why).replace(/"/g, "'")}"` : ''}${compText ? `\n${compText}` : ''}
gate: "${p.gate.replace(/"/g, "'")}"
recommendation: "${p.recommendation.replace(/\s+/g, ' ').replace(/"/g, "'")}"
verified: "${pv.verified}"
\`\`\`
`;

  // Nine columns, status BEFORE score; merge-tracker swaps them for the tracker.
  // EVERY field is pipe-stripped, not just the note. The tracker is a pipe-delimited
  // markdown table, and a posting titled "Staff Software Engineer (Internal Tooling)
  // | United States | Remote" split into extra columns and pushed the status and
  // score fields sideways, which verify-pipeline then reported as a non-canonical
  // status of "Remote". cell() and roleCellOf() are shared with the gate-closed path.
  const note = cell(p.recommendation).slice(0, 235);
  const tsv = [N, DATE, cell(p.company), roleCellOf(p), p.status,
    `${m.final.toFixed(1)}/5`, '❌',
    `[${N}](${file})`, note].join('\t');
  return { md, tsv, shown: m.final.toFixed(2) };
}

/**
 * --rescore's tracker half: the row that LINKS to `prior` (never the row whose number
 * matches, rule 8) takes the new score and note, and the new status only while it is
 * still Evaluated, SKIP or Discarded. A row already applied to keeps its status; a
 * rescore is a judgement about the posting, not news about the application. Edits
 * stay in memory until the run ends, and return null when no row links the report.
 */
let TRACKER = null;
const PRE_APPLY = new Set(['evaluated', 'skip', 'discarded']);

function rescoreRow(prior, [, , company, role, status, score, , , note]) {
  if (!TRACKER) {
    const path = trackerPath('.');
    const lines = readFileSync(path, 'utf8').split('\n');
    TRACKER = { path, lines, colmap: columnsOf(lines), dirty: false };
  }
  const { lines, colmap } = TRACKER;
  const row = trackerRows(lines, colmap).find(r => reportFileOf(r.raw) === prior);
  if (!row) return null;
  let line = setCell(lines[row.line], colmap, 'score', score);
  // Company and role are model inputs too: apply-model replays the ROW's company and role,
  // so a title the ATS has since changed would undo this rescore on the next pass if the
  // row kept the old one (Codex, 2026-10-29).
  line = setCell(line, colmap, 'company', company);
  line = setCell(line, colmap, 'role', role);
  const keepStatus = !PRE_APPLY.has(normalizeStatus(row.status));
  if (!keepStatus) line = setCell(line, colmap, 'status', status);
  if (colmap.notes != null) line = setCell(line, colmap, 'notes', cell(`Rescored ${DATE}: ${note}`).slice(0, 250));
  lines[row.line] = line;
  TRACKER.dirty = true;
  return { num: row.num, before: `${row.score} ${row.status}`,
    after: `${score} ${keepStatus ? row.status : status}` };
}

function flushTracker() {
  if (DRY || !TRACKER?.dirty) return;
  writeFileSync(TRACKER.path, TRACKER.lines.join('\n'));
  TRACKER.dirty = false;
}

let wrote = 0;
for (const f of files) {
  const p = JSON.parse(readFileSync(f, 'utf8'));
  const closed = gateClosed(p);
  if (closed) {
    const problem = gateClosedProblem(p);
    if (problem) { console.log(`SKIP ${basename(f)}: ${problem}`); continue; }
    // Asked before a number is claimed, so a refusal leaves no sentinel behind.
    const unread = auditReadsAsClosed(renderGateClosed(p, '000', '', DATE).md);
    if (unread) { console.log(`SKIP ${basename(f)}: ${unread}`); continue; }
  } else {
    const missing = REQUIRED.filter(k => blank(p[k]));
    if (missing.length) {
      console.log(`SKIP ${basename(f)}: unfilled: ${missing.join(', ')}`);
      continue;
    }
    // "null" is absence to the model, and anything outside the four values throws there
    // mid-run; refuse both here, per packet, with the reason.
    let arr = null;
    try { arr = normaliseArrangement(p.arrangement); } catch { /* reported below */ }
    if (!arr) {
      console.log(`SKIP ${basename(f)}: arrangement ${JSON.stringify(p.arrangement)} is not ` +
        'remote, hybrid, onsite or unknown');
      continue;
    }
  }
  // A scored report's header reads "LIVE (verified)" (provenance() above) and its machine
  // summary writes `legitimacy: "LIVE (verified)"` outright, so this gate is the only
  // thing that makes that string true. It used to read `live === false`,
  // which let a null straight through, and null is precisely what the resolver
  // returns when it could NOT tell: an unreadable board, a bot-blocked host such
  // as amazon.jobs, an ATS it does not support. An explicit "unknown" was being
  // written up as a verified posting. Requiring the affirmative keeps the claim
  // true by construction rather than by coincidence, whatever state the resolver
  // is in on any given day. The two states are named separately because "closed"
  // and "not checked" are different answers and must not read alike.
  if (p.live !== true) {
    console.log(`SKIP ${basename(f)}: ` + (p.live === false
      ? 'resolver says the posting is closed'
      : `liveness not confirmed (live: ${JSON.stringify(p.live)})`));
    continue;
  }

  // Re-running a packet must not mint a SECOND report for the same req. While
  // the number lived in the packet, a rerun collided and skipped; now that the
  // number is allocated here, a rerun would quietly take the next free one, so
  // retrying a half-failed batch duplicated every report it had already
  // written, against pipeline rule 3, one report per req.
  //
  // The identity was slug+date and nothing else, and `slug` is derived from the
  // TITLE alone. So two employers both posting "AI Engineer" in one batch
  // resolved to one identity: the first wrote its report, and the second was
  // skipped as "already written" by a report about a different company. That
  // req then gets no report, no tracker row, and no error either, which is the
  // same silent-loss shape eval-prep's packet_name() was fixed for. It is the
  // whole reason CLAUDE.md says never to dedup reqs by title.
  //
  // So the candidate filename is only a shortlist now, and what settles it is
  // the req: the posting URL when both sides have one, and the company when the
  // existing report predates that field. Filenames are untouched, since the
  // number prefix already keeps two same-slug reports apart on disk.
  // A body holding its own "## Machine Summary" line would put a second summary in the
  // report; the replay reads only the last one, but nothing is gained by writing it.
  if (!closed && /^##\s*Machine Summary/im.test(String(p.body))) {
    console.log(`SKIP ${basename(f)}: body contains a "## Machine Summary" heading`);
    continue;
  }
  if (RESCORE) {
    // Rescore OVERWRITES, so it needs requisition identity, never the company-only
    // filename fallback priorReport() keeps for a refusal (a false hit there is only a
    // skip; here it replaces another req's report). A named rescore_report must still
    // belong to this packet's company (Codex, 2026-10-29).
    const named = !blank(p.rescore_report);
    const prior = named ? basename(String(p.rescore_report)) : priorReportById(p);
    const why = !prior ? 'no report carries this req\'s url or id (name it as rescore_report)'
      : !existsSync(join('reports', prior)) ? `rescore_report "${prior}" is not in reports/`
      : named && !sameCompany(join('reports', prior), p) ? `rescore_report "${prior}" is not a ${p.company} report`
      : null;
    if (why) { console.log(`SKIP ${basename(f)}: --rescore: ${why}`); continue; }
    const N = (prior.match(/^(\d+)-/) || [])[1];
    if (!N) { console.log(`SKIP ${basename(f)}: cannot read a report number from ${prior}`); continue; }
    const file = `reports/${prior}`;
    const { md, tsv, shown } = closed
      ? { ...renderGateClosed(p, N, file, DATE), shown: ' N/A' }
      : renderScored(p, N, file);
    const row = rescoreRow(prior, tsv.split('\t'));
    console.log(`${DRY ? 'DRY  ' : 'WROTE'} ${N}  ${shown}  rescore  ${p.company} - ` +
      `${String(p.title).slice(0, 46)}  ${row ? `(row #${row.num}: ${row.before} -> ${row.after})` : `(no tracker row links it; ${DRY ? 'a TSV would be written' : 'TSV written'})`}`);
    if (DRY) continue;
    const backup = join('batch/rescore-backup', DATE);
    mkdirSync(backup, { recursive: true });
    // The first copy of the day is the pre-rescore report; a second run must not replace it.
    if (!existsSync(join(backup, prior))) copyFileSync(file, join(backup, prior));
    writeFileSync(file, md);
    // Flushed per packet, not at the end: a later packet that throws must not leave this
    // report rewritten and its row still carrying the old score (Codex, 2026-10-29).
    if (row) flushTracker();
    else {
      mkdirSync('batch/tracker-additions', { recursive: true });
      writeFileSync(join('batch/tracker-additions', `${N}-${p.slug}.tsv`), tsv + '\n');
    }
    wrote++;
    continue;
  }
  const prior = priorReport(p);
  if (prior) {
    console.log(`SKIP ${basename(f)}: already written as ${prior}` +
      ' (pass --rescore to rewrite it in place)');
    continue;
  }

  // An explicitly supplied number must still be free; only a missing one is
  // allocated. A number must also be a whole one: Number.isFinite accepts 600.5,
  // which allocates 601.5 next, and 1e20, where adding one cannot change the
  // value and the allocation loop never terminates.
  const supplied = p.num !== null && p.num !== undefined && p.num !== '';
  const num = supplied ? Number(p.num) : claimNum();
  if (num === null) {
    console.log(`SKIP ${basename(f)}: could not claim a free report number`);
    continue;
  }
  if (!Number.isInteger(num) || num < 1 || num > 9999) {
    console.log(`SKIP ${basename(f)}: num must be a whole number 1-9999 (${JSON.stringify(p.num)})`);
    continue;
  }
  // Only a finished report blocks an explicit number. A sentinel on that number
  // is this packet's own reservation, and releasing it is what the write below does.
  if (supplied && taken.has(num)) {
    console.log(`SKIP ${basename(f)}: report #${pad(num)} already exists; pick a free number`);
    continue;
  }
  taken.add(num);
  const N = pad(num);
  const file = `reports/${N}-${p.slug}-${DATE}.md`;

  let md, tsv, shown;
  if (closed) {
    ({ md, tsv } = renderGateClosed(p, N, file, DATE));
    shown = ' N/A';
  } else {
    ({ md, tsv, shown } = renderScored(p, N, file));
  }

  console.log(`${DRY ? 'DRY  ' : 'WROTE'} ${N}  ${shown}  ` +
    `${String(closed ? 'SKIP' : p.status).padEnd(9)} ${p.company} - ${String(p.title).slice(0, 46)}`);
  if (DRY) continue;
  mkdirSync('batch/tracker-additions', { recursive: true });
  writeFileSync(file, md);
  // A report this run just wrote is a prior report for every packet after it.
  // Without this, two packets for one req inside a single batch each see an
  // index built before either existed and both write.
  indexReport(basename(file), p.url, p.company);
  writeFileSync(join('batch/tracker-additions', `${N}-${p.slug}.tsv`), tsv + '\n');
  // The reservation has served its purpose the moment the real report exists.
  // Released here rather than left for verify-pipeline's GC, which only sweeps
  // sentinels once they are hours old.
  try { unlinkSync(sentinelOf(num)); } catch { /* never reserved, or already gone */ }
  wrote++;
}
flushTracker();
if (!DRY && wrote && RESCORE) {
  console.log(`\n${wrote} report(s) rescored in place; originals in batch/rescore-backup/${DATE}/. Next:\n` +
    '  node score-audit.mjs && node verify-pipeline.mjs');
} else if (!DRY && wrote) {
  console.log(`\n${wrote} report(s) + TSV(s) written. Next:\n` +
    '  node merge-tracker.mjs --dry-run && node merge-tracker.mjs\n' +
    '  rm -f batch/tracker-additions/*.tsv && node verify-pipeline.mjs');
}
