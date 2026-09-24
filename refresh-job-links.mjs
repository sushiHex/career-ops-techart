#!/usr/bin/env node
/**
 * refresh-job-links.mjs — keep the apply links on the board from going stale.
 *
 * Why this exists: NVIDIA reposts a req under a NEW externalPath suffix (`-1`, `-2`, ...),
 * so a URL captured at evaluation time silently stops resolving even while the job is
 * still open. Worse, a Workday path with a slightly wrong slug or a missing `/en-US/`
 * returns 403/404 rather than redirecting, which reads as a closure when it is not.
 * Observed 2026-07-30: 6 of 14 live NVIDIA reqs had a drifted stored link.
 *
 * So: resolve the CURRENT canonical path per JR from the CXS search index (authoritative),
 * rewrite `**URL:**` when it has drifted, and annotate reports whose req has left the index.
 *
 * Deliberately does NOT change tracker status. A closed POSTING is not a closed
 * APPLICATION — a req left the index while its application was still Active in
 * Workday. Conflating those would throw away a live thread. Closures are reported for a
 * human to judge.
 *
 * Runs from the board-rebuild hook, so it is time-budgeted and cached: a JR is not
 * re-checked more than once per TTL, and each run makes at most MAX_CHECKS requests.
 * Anything skipped is picked up on the next rebuild. Always exits 0 — a network failure
 * must never block a rebuild, and an inconclusive check must never be recorded as closed.
 *
 * Usage:
 *   node refresh-job-links.mjs              # fix what is stale (default)
 *   node refresh-job-links.mjs --dry-run    # report only
 *   node refresh-job-links.mjs --force      # ignore the TTL cache
 *   node refresh-job-links.mjs --quiet      # summary line only
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { guardArgs } from './cli-guard.mjs';

const args = guardArgs({
  name: 'refresh-job-links.mjs',
  summary: 'repair report apply-links whose posting URL has drifted',
  flags: [
    ['--dry-run', 'report what would change, write nothing'],
    ['--force', 'ignore the per-req TTL and recheck everything'],
    ['--quiet', 'print only the summary line'],
  ],
  notes: 'Without --dry-run this REWRITES the **URL:** line of report files under reports/.',
});
const DRY = args.has('--dry-run');
const FORCE = args.has('--force');
const QUIET = args.has('--quiet');

const TTL_HOURS = 12;
const MAX_CHECKS = 25;         // per run; the rest roll to the next rebuild
const TIME_BUDGET_MS = 35000;  // hook timeout is 90s; stay well inside it
const GAP_MS = 400;            // NVIDIA CXS rate-limits an unspaced burst

const CXS = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite';
const SITE = 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite';
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
};
const STATE = join('data', 'link-refresh-state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf-8')); } catch { return {}; }
}
function saveState(s) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(s, null, 1), 'utf-8');
  } catch { /* state is a cache; losing it only costs a re-check */ }
}

// --- collect NVIDIA reports carrying a JR ----------------------------------
function targets() {
  if (!existsSync('reports')) return [];
  const out = [];
  for (const f of readdirSync('reports').filter((x) => x.endsWith('.md'))) {
    const p = join('reports', f);
    let t;
    try { t = readFileSync(p, 'utf-8'); } catch { continue; }
    if (!/^\*\*Company:\*\*\s*NVIDIA/im.test(t)) continue;
    const jr = (t.match(/JR(\d{7})/) || [])[1];
    if (!jr) continue;
    const um = t.match(/^\*\*URL:\*\*[ \t]*(\S*)/m);
    out.push({ file: p, jr, stored: um ? um[1] : '', alreadyClosed: /^\*\*Posting status:\*\* CLOSED/m.test(t) });
  }
  return out;
}

/** Resolve a JR to {state, canonical}. state is 'live' | 'closed' | 'inconclusive'. */
async function resolve(jr) {
  try {
    const r = await fetch(`${CXS}/jobs`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: 'JR' + jr }),
    });
    if (!r.ok) return { state: 'inconclusive', why: `HTTP ${r.status}` };
    const d = await r.json();
    const p = (d.jobPostings || [])[0];
    if (!d.total || !p) return { state: 'closed' };
    const path = String(p.externalPath || '').replace(/^\/en-US\/NVIDIAExternalCareerSite/, '');
    if (!path) return { state: 'inconclusive', why: 'no externalPath' };
    return { state: 'live', canonical: SITE + path };
  } catch (e) {
    return { state: 'inconclusive', why: e.message };
  }
}

const state = loadState();
const all = targets();
const due = FORCE ? all : all.filter((t) => {
  const c = state[t.jr];
  return !c || !c.checked || (now - Date.parse(c.checked)) > TTL_HOURS * 3600e3;
});

const fixed = [], closed = [], inconclusive = [];
let checks = 0;
const t0 = Date.now();

for (const t of due) {
  if (checks >= MAX_CHECKS || Date.now() - t0 > TIME_BUDGET_MS) break;
  const res = await resolve(t.jr);
  checks++;

  if (res.state === 'inconclusive') {
    inconclusive.push({ ...t, why: res.why });   // NOT recorded — never cache a non-answer
    await sleep(GAP_MS);
    continue;
  }

  state[t.jr] = { checked: new Date(now).toISOString(), state: res.state, canonical: res.canonical || null };

  let text;
  try { text = readFileSync(t.file, 'utf-8'); } catch { await sleep(GAP_MS); continue; }

  if (res.state === 'live') {
    if (res.canonical && t.stored.split('?')[0] !== res.canonical) {
      fixed.push({ ...t, canonical: res.canonical });
      if (!DRY) {
        const next = /^\*\*URL:\*\*/m.test(text)
          ? text.replace(/^(\*\*URL:\*\*[ \t]*)\S*/m, `$1${res.canonical}`)
          : text;
        writeFileSync(t.file, next, 'utf-8');
      }
    }
  } else if (!t.alreadyClosed) {
    closed.push(t);
    if (!DRY && /^\*\*URL:\*\*.*$/m.test(text)) {
      const stamp = new Date(now).toISOString().slice(0, 10);
      writeFileSync(t.file, text.replace(/^(\*\*URL:\*\*.*)$/m,
        `$1\n**Posting status:** CLOSED as of ${stamp} — JR${t.jr} is no longer in the NVIDIA search index, so the URL above does not resolve. Verified per-JR. NOTE: a closed posting does not mean a closed application; check Workday Candidate Home before discarding.`), 'utf-8');
    }
  }
  await sleep(GAP_MS);
}

if (!DRY) saveState(state);

const pending = Math.max(0, due.length - checks);
if (!QUIET) {
  console.log(`link refresh — ${all.length} NVIDIA reqs tracked, ${due.length} due, ${checks} checked`);
  for (const f of fixed) console.log(`  FIXED   JR${f.jr}  ${f.file.split(/[\\/]/).pop()}\n            -> ${f.canonical}`);
  for (const c of closed) console.log(`  CLOSED  JR${c.jr}  ${c.file.split(/[\\/]/).pop()} (annotated; tracker status left alone)`);
  for (const i of inconclusive) console.log(`  ?       JR${i.jr}  ${i.why} — not recorded, will retry`);
  if (pending) console.log(`  ${pending} still due; picked up on the next rebuild`);
  if (DRY) console.log('  dry run — no files written');
}
console.log(`links: ${fixed.length} fixed, ${closed.length} newly closed, ${inconclusive.length} inconclusive, ${pending} pending`);
process.exit(0);
