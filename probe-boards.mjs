#!/usr/bin/env node

/**
 * Probe websearch-only companies for public ATS job-board APIs.
 *
 * Usage:
 *   node probe-boards.mjs
 *   node probe-boards.mjs --company Unity
 *   node probe-boards.mjs --limit 10
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

import { isMain } from './cli-guard.mjs';

const PORTALS_PATH = 'portals.yml';
const RESULTS_PATH = 'data/board-probe.json';
const PATCH_PATH = 'data/board-probe-portals-patch.yml';
const CONCURRENCY = 6;
const TIMEOUT_MS = 10_000;
const HOST_DELAY_MS = 175;
const MAX_SLUGS = 8;
const SUFFIXES = new Set([
  'ai', 'corp', 'corporation', 'company', 'co', 'inc', 'incorporated', 'llc', 'ltd',
  'limited', 'studio', 'studios', 'game', 'games', 'entertainment', 'technology',
  'technologies', 'tech', 'lab', 'labs', 'group', 'interactive',
]);

const providers = [
  {
    id: 'greenhouse',
    url: slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    parse: body => arrayShape(body?.jobs),
    careers: slug => `https://job-boards.greenhouse.io/${slug}`,
  },
  {
    id: 'ashby',
    url: slug => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    parse: body => arrayShape(body?.jobs),
    careers: slug => `https://jobs.ashbyhq.com/${slug}`,
  },
  {
    id: 'lever',
    url: slug => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    parse: body => arrayShape(body),
    careers: slug => `https://jobs.lever.co/${slug}`,
  },
  {
    id: 'smartrecruiters',
    url: slug => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
    parse: body => arrayShape(body?.content),
    careers: slug => `https://jobs.smartrecruiters.com/${slug}`,
  },
  {
    id: 'workable',
    url: slug => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
    parse: body => {
      if (Array.isArray(body)) return { valid: true, count: body.length };
      for (const key of ['jobs', 'results', 'positions']) {
        if (Array.isArray(body?.[key])) return { valid: true, count: body[key].length };
      }
      return { valid: false, count: 0 };
    },
    careers: slug => `https://apply.workable.com/${slug}`,
  },
  {
    id: 'recruitee',
    url: slug => `https://${slug}.recruitee.com/api/offers/`,
    parse: body => arrayShape(body?.offers),
    careers: slug => `https://${slug}.recruitee.com`,
  },
];

// Self-serve ATS platforms ship demo boards seeded with placeholder postings,
// and those boards sit on generic slugs. Probing "google" on Recruitee returned
// a board whose single posting was "Senior Marketer (Sample)" in Amsterdam —
// reported as a confident hit for Google (2026-08-12). Titles are the reliable
// tell; a company name on a demo board is whatever the demo was seeded with.
const SAMPLE_POSTING_RE = /\(sample\)|\bsample (job|position|vacancy)\b|\bdemo (job|position)\b|\bthis is a (test|demo)\b|\blorem ipsum\b/i;

/** True when every posting looks like ATS demo seed data. */
export function looksLikeSampleBoard(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  const titleOf = j => String(j?.title ?? j?.text ?? j?.name ?? '');
  return items.every(j => SAMPLE_POSTING_RE.test(titleOf(j)));
}

function arrayShape(value) {
  if (Array.isArray(value) && looksLikeSampleBoard(value)) {
    return { valid: true, count: 0, sample: true };
  }
  return { valid: Array.isArray(value), count: Array.isArray(value) ? value.length : 0 };
}

function parseArgs(argv) {
  let company = null;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--company') {
      if (!argv[i + 1]) throw new Error('--company requires a substring');
      company = argv[++i].toLowerCase();
    } else if (argv[i] === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit requires a positive integer');
      limit = value;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node probe-boards.mjs [--company <substr>] [--limit N]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { company, limit };
}

function words(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function stripSuffixes(tokens) {
  const out = [...tokens];
  while (out.length > 1 && SUFFIXES.has(out.at(-1))) out.pop();
  return out;
}

// ATS vendor names must never become tenant slugs. A company hosted ON an ATS has
// that vendor in its careers_url hostname, so registrableName() hands back the
// vendor. ProbablyMonsters (jobs.jobvite.com) derived "jobvite" and matched
// api.lever.co/v0/postings/jobvite - Jobvite's own board - as a confident hit.
const ATS_VENDOR_SLUGS = new Set([
  'jobvite', 'greenhouse', 'boards', 'lever', 'ashby', 'ashbyhq', 'workday',
  'myworkdayjobs', 'smartrecruiters', 'workable', 'recruitee', 'breezy',
  'bamboohr', 'icims', 'taleo', 'successfactors', 'gem', 'rippling',
  'eightfold', 'phenom', 'dayforce', 'jazzhr', 'applytojob', 'paylocity',
  'oraclecloud', 'brassring', 'avature', 'teamtailor', 'personio',
  // Aggregators, accelerators and job boards are not employers. A careers_url
  // pointing at one yields that site's own tenant: Spline -> ashby/ycombinator
  // (Y Combinator's board) and Hatsu Labs -> greenhouse/builtin (Built In's).
  'ycombinator', 'workatastartup', 'builtin', 'wellfound', 'angellist',
  'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'dice', 'hired',
  'remoteok', 'otta', 'levels', 'simplyhired', 'monster',
]);

function registrableName(hostname) {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || '';
  const compound = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'com.sg']);
  const suffix = labels.slice(-2).join('.');
  return labels.at(compound.has(suffix) ? -3 : -2) || '';
}

export function deriveSlugs(entry) {
  const groups = [];
  const addGroup = value => {
    const base = words(value);
    const stripped = stripSuffixes(base);
    if (base.length) groups.push(base);
    if (stripped.join(' ') !== base.join(' ')) groups.push(stripped);
  };

  // Parenthetical and dash qualifiers describe divisions/locations more often than ATS tenants.
  addGroup(String(entry.name || '').split(/\s+(?:—|–|- )\s*|\s*\(/)[0]);
  addGroup(entry.name);

  try {
    const parsed = new URL(entry.careers_url);
    addGroup(registrableName(parsed.hostname));
    const firstPath = parsed.pathname.split('/').filter(Boolean)[0];
    if (firstPath && !['careers', 'career', 'jobs', 'job', 'company', 'en-us', 'search'].includes(firstPath.toLowerCase())) {
      addGroup(decodeURIComponent(firstPath));
    }
  } catch { /* a missing/malformed careers URL simply contributes no slugs */ }

  const candidates = [];
  const add = value => {
    if (ATS_VENDOR_SLUGS.has(String(value || '').toLowerCase())) return;
    const safe = value.replace(/^-+|-+$/g, '');
    if (safe && safe.length <= 80 && !candidates.includes(safe)) candidates.push(safe);
  };
  for (const group of groups) {
    add(group.join(''));
    add(group.join('-'));
  }
  return candidates.slice(0, MAX_SLUGS);
}

const hostReadyAt = new Map();
let hostGate = Promise.resolve();
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForHost(url) {
  const host = new URL(url).host;
  let release;
  const previousGate = hostGate;
  hostGate = new Promise(resolve => { release = resolve; });
  await previousGate;
  const wait = Math.max(0, (hostReadyAt.get(host) || 0) - Date.now());
  hostReadyAt.set(host, Date.now() + wait + HOST_DELAY_MS);
  release();
  if (wait) await sleep(wait);
}

async function requestJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'career-ops-board-probe/1.0' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return { status: response.status };
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) }; }
      catch { return { status: response.status, malformed: true }; }
    } catch (error) {
      // Fetch throws only for network/abort/redirect failures. Retry once; HTTP errors return above.
      if (attempt === 1) return { error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function probeCompany(entry) {
  const slugs = deriveSlugs(entry);
  const attempts = [];
  const empties = [];
  for (const slug of slugs) {
    for (const provider of providers) {
      const url = provider.url(slug);
      try {
        const response = await requestJson(url);
        const parsed = response?.status === 200 && !response.malformed
          ? provider.parse(response.body) : { valid: false, count: 0 };
        attempts.push({ provider: provider.id, slug, url, status: response?.status ?? null,
          payloadValid: parsed.valid, postings: parsed.count, error: response?.error || null });
        if (parsed.valid && parsed.count > 0) {
          // A board with one or two postings on a slug this company does not
          // obviously own is the shape a false positive takes (a squatted or
          // demo board). Report it as `weak` so it is confirmed by hand rather
          // than converted straight into a scanned entry.
          const verdict = parsed.count <= 2 ? 'weak' : 'hit';
          return { company: entry.name, verdict, provider: provider.id, slug, url,
            postingsSeen: parsed.count, slugs, attempts };
        }
        if (parsed.valid) empties.push({ provider: provider.id, slug, url, postingsSeen: 0 });
      } catch (error) {
        attempts.push({ provider: provider.id, slug, url, status: null,
          payloadValid: false, postings: 0, error: error.message });
      }
    }
  }
  const best = empties[0];
  // SmartRecruiters answers 200 with zero postings for ANY slug, real or invented
  // (verified against a nonsense slug), so an empty SmartRecruiters response is
  // not evidence the tenant exists. Only a non-zero posting count counts.
  const informative = best && best.provider !== 'smartrecruiters';
  return { company: entry.name, verdict: informative ? 'empty' : 'none',
    provider: best?.provider || null, slug: best?.slug || null, url: best?.url || null,
    postingsSeen: 0, slugs, emptyCandidates: empties, attempts };
}

async function mapConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index]); }
      catch (error) { results[index] = { company: items[index]?.name || '(unknown)', verdict: 'none',
        provider: null, slug: null, url: null, postingsSeen: 0, slugs: [], attempts: [], error: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function patchEntry(result) {
  const provider = providers.find(item => item.id === result.provider);
  return {
    name: result.company,
    careers_url: provider.careers(result.slug),
    provider: result.provider,
    api: result.url,
  };
}

async function atomicWrite(filename, content) {
  const temp = `${filename}.tmp-${process.pid}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, filename);
}

function printTable(results) {
  const headers = ['company', 'verdict', 'provider', 'slug', 'url', 'postings seen'];
  const rows = results.map(r => [r.company, r.verdict, r.provider || '', r.slug || '', r.url || '', String(r.postingsSeen)]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)));
  console.log([headers, ...rows].map(row => row.map((cell, i) => cell.padEnd(widths[i])).join(' | ')).join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = yaml.load(await readFile(PORTALS_PATH, 'utf8')) || {};
  let companies = (Array.isArray(config.tracked_companies) ? config.tracked_companies : [])
    .filter(entry => entry?.scan_method === 'websearch');
  if (args.company) companies = companies.filter(entry => entry.name?.toLowerCase().includes(args.company));
  companies = companies.slice(0, args.limit);
  if (!companies.length) throw new Error('no matching scan_method: websearch companies');

  const startedAt = new Date().toISOString();
  const results = await mapConcurrent(companies, probeCompany, CONCURRENCY);
  const counts = Object.fromEntries(['hit', 'weak', 'empty', 'none'].map(v => [v, results.filter(r => r.verdict === v).length]));
  const document = { generatedAt: new Date().toISOString(), startedAt, source: PORTALS_PATH,
    settings: { concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS, retryNetworkErrors: 1,
      sameHostDelayMs: HOST_DELAY_MS, maxSlugVariants: MAX_SLUGS }, counts, results };
  const hits = results.filter(result => result.verdict === 'hit').map(patchEntry);
  const patch = { generated_at: document.generatedAt, source: PORTALS_PATH,
    instructions: 'Review each block, then replace the matching websearch entry fields in portals.yml.',
    tracked_companies: hits };

  await mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await atomicWrite(RESULTS_PATH, `${JSON.stringify(document, null, 2)}\n`);
  await atomicWrite(PATCH_PATH, yaml.dump(patch, { noRefs: true, lineWidth: 120, quotingType: '"', forceQuotes: false }));
  printTable(results);
  console.log(`\nHits: ${counts.hit} | Weak (<=2 postings, confirm by hand): ${counts.weak} | Empty: ${counts.empty} | None: ${counts.none}`);
  for (const r of results.filter(x => x.verdict === 'weak')) {
    console.log(`  weak: ${r.company} -> ${r.provider}/${r.slug} (${r.postingsSeen} posting(s)) ${r.url}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(error => { console.error(`Fatal: ${error.message}`); process.exitCode = 1; });
}
