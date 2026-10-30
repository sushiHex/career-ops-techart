#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const QUICK = process.argv.includes('--quick');
const NODE = process.execPath;

// Every temporary directory this run creates lives under one root that is removed when
// the run ends, so no case can leak one. tmpdir() reads TEMP/TMP/TMPDIR on every call,
// and the Node and Python children the suite spawns inherit them.
const RUN_TMP = mkdtempSync(join(tmpdir(), 'career-ops-test-'));
for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = RUN_TMP;
process.on('exit', () => {
  // Best effort: a file still held open (antivirus, a killed child) must not turn a
  // finished run into a stack trace. The run's own exit code already stands.
  try { rmSync(RUN_TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the OS */ }
});

const TRACKER_HEAD = '# Applications Tracker\n\n' +
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
  '|---|------|---------|------|-------|--------|-----|--------|-------|\n';

// Every tool reads its configuration from CAREER_OPS_CONFIG_DIR when it is set. Point it
// at an empty directory for this whole run, children included, so the suite sees no
// configuration at all: a result must not depend on whose profile, location policy or
// lane vocabulary happens to be installed. Tests that need a config build their own.
process.env.CAREER_OPS_CONFIG_DIR = mkdtempSync(join(RUN_TMP, 'noconfig-'));

let passed = 0;
let failed = 0;
let warnings = 0;

/**
 * Record and print one passing test assertion.
 *
 * The suite uses these small counters instead of a framework so it can run in
 * any freshly cloned career-ops checkout with only Node.js available.
 *
 * @param {string} msg - Human-readable success message for the terminal log.
 * @returns {void}
 */
function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }

/**
 * Record and print one failing test assertion.
 *
 * Failures increment the shared counter that controls the final process exit
 * code, while still allowing later checks to run and show the full problem set.
 *
 * @param {string} msg - Human-readable failure message for the terminal log.
 * @returns {void}
 */
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }

/**
 * Record and print one non-fatal warning.
 *
 * Warnings are used for expected local-environment gaps, such as missing user
 * data in a clean repo, where the check should stay visible but not fail CI.
 *
 * @param {string} msg - Human-readable warning message for the terminal log.
 * @returns {void}
 */
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

/**
 * Run an executable with an argument vector and return trimmed stdout on success.
 *
 * Never through a shell: a path or pattern with a quote or a space in it cannot
 * change what runs. Failures return null so the caller can decide whether to count
 * the result as a failure or a warning.
 *
 * @param {string} cmd - Executable to run.
 * @param {string[]} [args=[]] - Argument vector.
 * @param {object} [opts={}] - Extra child_process options.
 * @returns {string|null} Trimmed stdout, or null when the command fails.
 */
function run(cmd, args = [], opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Check whether a repo-relative file exists.
 *
 * @param {string} path - Path relative to the career-ops repository root.
 * @returns {boolean} True when the file exists.
 */
function fileExists(path) { return existsSync(join(ROOT, path)); }

/**
 * Resolve a bash interpreter that actually runs, or null when none does.
 *
 * On Windows, plain `bash` on PATH is normally C:\Windows\System32\bash.exe —
 * the WSL launcher — which fails outright when no WSL distribution is
 * installed. The shell fixtures here are written for Git Bash, so prefer it
 * explicitly and prove the candidate works before returning it. Cached because
 * probing spawns a process.
 *
 * @returns {string|null} Path or command name of a working bash, else null.
 */
let _resolvedBash;
function resolveBash() {
  if (_resolvedBash !== undefined) return _resolvedBash;
  const candidates = [];
  if (process.env.CAREER_OPS_BASH) candidates.push(process.env.CAREER_OPS_BASH);
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    );
  }
  candidates.push('bash');
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'echo ok'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 15000,
      });
      _resolvedBash = candidate;
      return candidate;
    } catch {}
  }
  _resolvedBash = null;
  return null;
}

/**
 * Convert a Windows path to the form the resolved bash can open.
 *
 * The converter MUST match the interpreter: WSL mounts the C drive at
 * /mnt/c while Git Bash and other MSYS builds use /c. Asking wslpath for a
 * path and then handing it to Git Bash produces a path that cannot be
 * opened, which fails silently through run()'s catch.
 *
 * @param {string} wpath - Absolute Windows path.
 * @returns {string} Path in the resolved interpreter's namespace.
 */
function toBashPath(wpath) {
  if (process.platform !== 'win32') return wpath;
  const forwardSlashed = wpath.replace(/\\/g, '/');
  const bash = resolveBash();
  const isWsl = !bash || /system32[\\/]bash\.exe$/i.test(bash) || bash === 'bash';

  if (bash && !isWsl) {
    // Use the cygpath shipped beside the chosen bash, never a PATH lookup.
    const cygpath = bash.replace(/bin[\\/]bash\.exe$/i, 'usr\\bin\\cygpath.exe');
    try {
      const out = execFileSync(cygpath, ['-u', forwardSlashed], {
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString().trim();
      if (out) return out;
    } catch {}
    // MSYS drive-letter form is the correct fallback for this family.
    return forwardSlashed.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  }

  for (const [exe, args] of [['wsl', ['wslpath', '-u', forwardSlashed]], ['cygpath', ['-u', forwardSlashed]]]) {
    try {
      const out = execFileSync(exe, args, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out;
    } catch {}
  }
  return forwardSlashed.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

/**
 * Read a repo-relative text file as UTF-8.
 *
 * @param {string} path - Path relative to the career-ops repository root.
 * @returns {string} File contents.
 */
function readFile(path) {
  const fullPath = join(ROOT, path);
  let content = readFileSync(fullPath, 'utf-8');
  if (content.trim().startsWith('..') && content.trim().split('\n').length === 1) {
    const target = join(dirname(fullPath), content.trim());
    if (existsSync(target)) {
      content = readFileSync(target, 'utf-8');
    }
  }
  return content;
}

/**
 * Drop block comments and whole-line `//` comments, for scans that must read code
 * and not the prose explaining it.
 *
 * @param {string} s - JavaScript source.
 * @returns {string} The source without those comments.
 */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

// One child parses every file, because a `node --check` per file spent ~10s of this
// suite on process spawns alone. vm.SourceTextModule compiles a module without linking
// or running it, which is what --check does for an .mjs (hashbang, top-level await and
// the module-only early errors included). The child needs --experimental-vm-modules,
// which is why this is a child at all rather than in-process.
const SYNTAX_CHECKER = `
const { SourceTextModule } = require('vm');
const { readFileSync } = require('fs');
const out = process.argv.slice(1).map((f) => {
  try { new SourceTextModule(readFileSync(f, 'utf8'), { identifier: f }); return null; }
  catch (e) { return String(e && e.message || e); }
});
process.stdout.write(JSON.stringify(out));`;
const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
let syntaxErrors = null;
try {
  syntaxErrors = JSON.parse(run(NODE,
    ['--experimental-vm-modules', '--no-warnings', '-e', SYNTAX_CHECKER, ...mjsFiles]) ?? 'null');
} catch { /* reported below */ }
if (!Array.isArray(syntaxErrors) || syntaxErrors.length !== mjsFiles.length) {
  // A checker that answers for nothing must not read as every file passing.
  fail(`syntax checker did not return one result per file (${mjsFiles.length} files)`);
} else {
  mjsFiles.forEach((f, i) => {
    if (syntaxErrors[i] === null) pass(`${f} syntax OK`);
    else fail(`${f} has syntax errors`);
  });
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'verify-pipeline.mjs', expectExit: 0 },
  // --dry-run: these scripts resolve ROOT from import.meta.url and write
  // data/applications.md (or data/pipeline.md) in place. On a provisioned working
  // copy with a real tracker present, running them without --dry-run mutates user
  // data. Harmless in this repo (no tracker shipped), risky for end users who run
  // tests inside their active career-ops workspace.
  { name: 'normalize-statuses.mjs --dry-run', expectExit: 0 },
  { name: 'dedup-tracker.mjs --dry-run', expectExit: 0 },
  { name: 'merge-tracker.mjs --dry-run', expectExit: 0 },
  { name: 'reconcile-pipeline.mjs --dry-run', expectExit: 0 },
  { name: 'analyze-patterns.mjs --self-test', expectExit: 0 },
  // Recomputes each report's global from its own stated dimensions. Gated to reports
  // dated on/after its baseline, so a large legacy backlog cannot make it permanently
  // red; new reports that drift from the rubric DO fail. Exits 0 with no reports/.
  { name: 'audit-scores.mjs', expectExit: 0 },
  // Dry run: composes score-model.mjs over the whole board and writes nothing.
  { name: 'apply-model.mjs', expectExit: 0 },
  // Unit tests for the scoring model. Every case is a bug that reached the board
  // or an invariant whose violation would silently mis-rank roles. Mutation-tested:
  // all 18 seeded mutations of score-model.mjs are caught.
  { name: 'score-model-tests.mjs', expectExit: 0 },
  { name: 'tracker-columns-tests.mjs', expectExit: 0 },
  { name: 'validate-portals.mjs --file templates/portals.example.yml', expectExit: 0 },
  // Bare run with no portals file: it must exit 0 gracefully and hit no network. It is
  // pointed at a missing file on purpose, because against an installed portals.yml it
  // probes every board in it (15s and growing); the probe logic is unit-tested below
  // with a mock.
  { name: 'verify-portals.mjs', expectExit: 0,
    env: { CAREER_OPS_PORTALS: join(RUN_TMP, 'no-portals.yml') } },
];

for (const { name, allowFail, timeoutMs, env } of scripts) {
  const result = run(NODE, name.split(' '), {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }

  const cloudflareChallenge = classifyLiveness({
    status: 403,
    finalUrl: 'https://www.pracuj.pl/praca/sap-consultant,oferta,1227443248',
    bodyText: 'www.pracuj.pl\nJust a moment...\nPerforming security verification\nThis website uses a security service to protect against malicious bots.\nRay ID: a06489bab8bc4cd7\nPerformance and Security by Cloudflare',
    applyControls: [],
  });
  if (cloudflareChallenge.result === 'uncertain' && cloudflareChallenge.code === 'bot_challenge') {
    pass('Cloudflare anti-bot challenge pages are uncertain, not expired');
  } else {
    fail(`Cloudflare challenge misclassified as ${cloudflareChallenge.result} (${cloudflareChallenge.code})`);
  }

  const blocked403 = classifyLiveness({
    status: 403,
    finalUrl: 'https://www.pracuj.pl/praca/sap-consultant,oferta,1227443248',
    bodyText: 'Access denied',
    applyControls: [],
  });
  if (blocked403.result === 'uncertain' && blocked403.code === 'access_blocked') {
    pass('HTTP 403 is treated as access-blocked (uncertain), not expired');
  } else {
    fail(`HTTP 403 misclassified as ${blocked403.result} (${blocked403.code})`);
  }

  const activePolishPosting = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.pracuj.pl/praca/administrator-sap-utilities-warszawa,oferta,1227443248',
    bodyText: 'Administrator SAP Utilities. Connectis_. Siedziba firmy: Chmielna 71, Warszawa. '.repeat(6),
    applyControls: ['Aplikuj Aplikuj na ogłoszenie'],
  });
  if (activePolishPosting.result === 'active') {
    pass('Polish "Aplikuj" apply control marks a loaded posting active');
  } else {
    fail(`Polish apply control not recognized: ${activePolishPosting.result} (${activePolishPosting.code})`);
  }

  // Headed-fallback-on-challenge path (liveness-browser.mjs). Fake Playwright
  // pages script the goto/evaluate calls so we can exercise the wrapper without
  // launching a browser. checkUrlLiveness reads body text first, apply controls
  // second — the fake returns them in that order.
  const { checkUrlLivenessWithFallback, isChallengeResult, jitteredDelayMs } =
    await import(pathToFileURL(join(ROOT, 'liveness-browser.mjs')).href);

  const disabled = jitteredDelayMs(0) === 0 && jitteredDelayMs(-1) === 0;
  let inRange = true;
  for (let i = 0; i < 200; i += 1) {
    const d = jitteredDelayMs(5000);
    if (d < 5000 || d >= 10000) { inRange = false; break; }
  }
  if (disabled && inRange) {
    pass('jitteredDelayMs returns 0 when disabled and stays in [base, 2*base)');
  } else {
    fail(`jitteredDelayMs out of spec (disabled=${disabled}, inRange=${inRange})`);
  }

  const fakePage = ({ status, finalUrl, bodyText, applyControls }) => {
    let evalCall = 0;
    return {
      async goto() { return { status: () => status }; },
      async waitForTimeout() {},
      url() { return finalUrl; },
      async evaluate() { evalCall += 1; return evalCall === 1 ? bodyText : applyControls; },
    };
  };
  const URL = 'https://www.pracuj.pl/praca/sap-consultant,oferta,1227443248';
  const challengePage = () => fakePage({
    status: 403,
    finalUrl: URL,
    bodyText: 'Just a moment... Performing security verification. Ray ID: abc123. Cloudflare.',
    applyControls: [],
  });
  const livePage = () => fakePage({
    status: 200,
    finalUrl: URL,
    bodyText: 'Administrator SAP Utilities. '.repeat(20),
    applyControls: ['Apply for this job'],
  });

  if (isChallengeResult({ result: 'uncertain', code: 'bot_challenge' }) &&
      isChallengeResult({ result: 'uncertain', code: 'access_blocked' }) &&
      !isChallengeResult({ result: 'expired', code: 'http_gone' }) &&
      !isChallengeResult({ result: 'active', code: 'apply_control_visible' })) {
    pass('isChallengeResult flags only bot_challenge/access_blocked uncertains');
  } else {
    fail('isChallengeResult misclassified a result');
  }

  const fellBackToActive = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => livePage(),
  });
  if (fellBackToActive.result === 'active') {
    pass('Headed fallback recovers a challenge-blocked page as active');
  } else {
    fail(`Headed fallback did not recover page: ${fellBackToActive.result} (${fellBackToActive.code})`);
  }

  const noProvider = await checkUrlLivenessWithFallback(challengePage(), URL, {});
  if (noProvider.result === 'uncertain' && noProvider.code === 'bot_challenge') {
    pass('No fallback provider keeps the original challenge result');
  } else {
    fail(`Missing provider changed result to ${noProvider.result} (${noProvider.code})`);
  }

  const stillBlocked = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => challengePage(),
  });
  if (stillBlocked.result === 'uncertain' && stillBlocked.code === 'bot_challenge'
      && /headed retry also blocked/.test(stillBlocked.reason)) {
    pass('Persistent challenge stays uncertain after headed retry (never upgraded to expired)');
  } else {
    fail(`Persistent challenge mishandled: ${stillBlocked.result} (${stillBlocked.code})`);
  }

  const noHeadedAvailable = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => null, // headed launch failed (no display)
  });
  if (noHeadedAvailable.result === 'uncertain' && noHeadedAvailable.code === 'bot_challenge') {
    pass('Headless-only environment degrades to original challenge result');
  } else {
    fail(`No-display degrade path wrong: ${noHeadedAvailable.result} (${noHeadedAvailable.code})`);
  }

  // SSRF guard — `rejectPrivateOrInvalid` has to refuse every URL whose host
  // resolves to loopback / private / link-local space. The earlier guard only
  // matched literal IPv4 patterns and bracketless IPv6, so several Chromium-
  // routable bypasses (0.0.0.0, [::], [::1] (bracketed), [::ffff:127.0.0.1],
  // localhost.) slipped through. These cases keep that regression covered.
  const { rejectPrivateOrInvalid } = await import(
    pathToFileURL(join(ROOT, 'liveness-browser.mjs')).href
  );
  const blockCases = [
    ['http://0.0.0.0/admin', 'IPv4 all-zeros (Linux routes to loopback)'],
    ['http://[::]/', 'IPv6 all-zeros (Linux routes to loopback)'],
    ['http://[::1]/', 'IPv6 loopback (brackets included in url.hostname)'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback (dotted form)'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped IPv6 loopback (hex form)'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped IPv6 link-local (cloud metadata)'],
    ['http://[fc00::1]/', 'IPv6 ULA (private)'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://localhost./', 'FQDN-trailing-dot localhost'],
    ['http://localhost.localdomain/', 'localhost.localdomain alias'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata IPv4 link-local'],
    ['http://10.0.0.5/', 'IPv4 RFC1918'],
  ];
  let blockMissed = 0;
  for (const [url, label] of blockCases) {
    const verdict = rejectPrivateOrInvalid(url);
    if (verdict?.code !== 'blocked_host') {
      fail(`SSRF guard missed ${label}: ${url} → ${verdict ? verdict.code : 'allowed'}`);
      blockMissed += 1;
    }
  }
  if (blockMissed === 0) pass(`SSRF guard blocks ${blockCases.length} known bypass vectors`);

  const allowCases = [
    'https://boards.greenhouse.io/example/jobs/123',
    'https://jobs.lever.co/example/abc-def',
    'https://example.com/careers/role',
    'https://www.pracuj.pl/praca/role,oferta,1194374',
  ];
  let allowDenied = 0;
  for (const url of allowCases) {
    if (rejectPrivateOrInvalid(url) !== null) {
      fail(`SSRF guard false-positive on legitimate ATS URL: ${url}`);
      allowDenied += 1;
    }
  }
  if (allowDenied === 0) pass('SSRF guard lets legitimate ATS URLs through');

  const protoCase = rejectPrivateOrInvalid('file:///etc/passwd');
  if (protoCase?.code === 'unsupported_protocol') {
    pass('SSRF guard rejects unsupported protocol');
  } else {
    fail(`SSRF guard let unsupported protocol through: ${protoCase?.code ?? 'allowed'}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const isWindows = process.platform === 'win32';
  const outPath = isWindows ? 'career-dashboard-test.exe' : '/tmp/career-dashboard-test';
  // A cold build downloads modules and compiles the TUI stack; on a Windows runner that
  // takes longer than run()'s 30s, which killed it and reported "build failed" with the
  // compiler's output thrown away. Give it its own budget and show what it said.
  let buildErr = null;
  try {
    execFileSync('go', ['build', '-o', outPath, '.'], { cwd: join(ROOT, 'dashboard'), encoding: 'utf-8', timeout: 300000, stdio: 'pipe' });
  } catch (e) {
    buildErr = `${e.killed ? 'timed out after 300s. ' : ''}${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
  }
  if (buildErr === null) {
    pass('Dashboard compiles');
    if (isWindows) {
      try { rmSync(join(ROOT, 'dashboard', 'career-dashboard-test.exe'), { force: true }); } catch (e) {}
    }
  } else {
    fail(`Dashboard build failed: ${buildErr.trim().slice(0, 400)}`);
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'OPENCODE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
  '.opencode/skills/career-ops/SKILL.md',
  '.antigravitycli/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Files carrying personal or third-party data must be both UNTRACKED and IGNORED.
//
// Untracked alone is not enough: on a fresh clone nothing personal exists yet, so
// an untracked check passes vacuously, and the first `git add .` after onboarding
// would then commit the CV, the tracker and every recruiter contact. The property
// that protects a user is that git refuses to see these paths at all, so this asks
// `git check-ignore` about each one whether or not the file exists.
// data/follow-ups.md holds recruiter names and email addresses; reports and
// research/ hold per-employer judgements.
const userFiles = [
  'cv.md',
  'config/profile.yml',
  'config/lane-vocab.json',
  'config/location.json',
  'modes/_profile.md',
  'portals.yml',
  'article-digest.md',
  'voice-dna.md',
  'data/applications.md',
  'data/pipeline.md',
  'data/follow-ups.md',
  'data/scan-history.tsv',
  'reports/001-example-2026-01-01.md',
  'research/notes.md',
  'interview-prep/story-bank.md',
  'output/cv.pdf',
  '.env',
  'dispositions.json',
  'batch/eval-queue/packet.json',
];
// The other direction matters as much: a file the SELF-TESTS need must never be ignored,
// or a fresh clone arrives without it. An unanchored `portals.yml` rule once swallowed
// test-fixtures/portals.yml, and every resolver selftest would have failed on a clone.
const neededFiles = [
  'test-fixtures/portals.yml', 'presets/lanes/general.json',
  'presets/lanes/techart-ai-tooling.json', 'presets/lanes/techart-ai-tooling.profile.md',
  'presets/locations/_base-us.json', 'presets/locations/california-socal.json',
  'presets/locations/remote-us.json', 'templates/portals.example.yml', 'config/profile.example.yml',
];
if (run('git', ['rev-parse', '--is-inside-work-tree']) === 'true') {
  const swallowed = neededFiles.filter((f) => run('git', ['check-ignore', '--no-index', '-q', f]) !== null);
  if (!swallowed.length) pass(`no file the suites need is gitignored (${neededFiles.length} checked)`);
  else fail(`gitignored, so a fresh clone would not have them: ${swallowed.join(', ')}`);
}

if (run('git', ['rev-parse', '--is-inside-work-tree']) !== 'true') {
  warn('Not a git work tree: user-file ignore rules NOT CHECKED');
} else {
  for (const f of userFiles) {
    const tracked = run('git', ['ls-files', f]);
    const ignored = run('git', ['check-ignore', '--no-index', '-q', f]) !== null;
    if (tracked) {
      fail(`User file IS tracked (should be gitignored): ${f}`);
    } else if (!ignored) {
      fail(`User file is NOT gitignored (one \`git add .\` from a commit): ${f}`);
    } else {
      pass(`User file gitignored: ${f}`);
    }
  }
}

const batchRunnerSource = readFile('batch/batch-runner.sh');
const minScoreSkipIndex = batchRunnerSource.indexOf('update_state "$id" "$url" "skipped"');
const minScoreReturnIndex = batchRunnerSource.indexOf('return 0', minScoreSkipIndex);
const completedStateIndex = batchRunnerSource.indexOf('update_state "$id" "$url" "completed"', minScoreSkipIndex);
if (
  minScoreSkipIndex !== -1 &&
  minScoreReturnIndex !== -1 &&
  completedStateIndex !== -1 &&
  minScoreSkipIndex < minScoreReturnIndex &&
  minScoreReturnIndex < completedStateIndex
) {
  pass('Batch min-score gate returns before completed state update');
} else {
  fail('Batch min-score gate can fall through to completed state update');
}

if (/if \[\[ "\$status" == "completed" \|\| "\$status" == "skipped" \]\]/.test(batchRunnerSource)) {
  pass('Batch resume treats min-score skipped offers as terminal');
} else {
  fail('Batch resume can reprocess min-score skipped offers');
}

if (/local total=0 completed=0 skipped=0 failed=0 pending=0/.test(batchRunnerSource) &&
    /skipped\) skipped=\$\(\(skipped \+ 1\)\)/.test(batchRunnerSource) &&
    /Completed: \$completed \| Skipped: \$skipped \| Failed: \$failed \| Pending: \$pending/.test(batchRunnerSource)) {
  pass('Batch summary reports skipped offers separately from pending');
} else {
  fail('Batch summary can misreport skipped offers as pending');
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '605430924', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.fr.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md', 'README.cn.md', 'README.zh-TW.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md', 'CHANGELOG.md', 'TRADEMARK.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'AGENTS.md', 'go.mod', 'test-all.mjs',
  '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
  'dashboard/internal/ui/screens/progress.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `*.${e}`);

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run('git', ['grep', '-n', pattern, '--', ...grepPathspec], { stdio: ['pipe', 'pipe', 'ignore'] });
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathResult = (run('git', ['grep', '-n', '/Users/', '--', '*.mjs', '*.sh', '*.md', '*.go', '*.yml'],
  { stdio: ['pipe', 'pipe', 'ignore'] }) || '')
  .split('\n').filter((l) => l && !/README\.md|LICENSE|CLAUDE\.md|test-all\.mjs/.test(l)).join('\n');
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 7b. PDF RENDER WAIT CONDITION ───────────────────────────────

console.log('\n7b. PDF render wait condition');

const generatePdfScript = readFile('generate-pdf.mjs');
if (/waitUntil:\s*['"]load['"]/.test(generatePdfScript)) {
  pass('generate-pdf waits for load before rendering');
} else {
  fail('generate-pdf does not wait for load before rendering');
}
if (!/waitUntil:\s*['"]networkidle['"]/.test(generatePdfScript)) {
  pass('generate-pdf does not wait for networkidle');
} else {
  fail('generate-pdf still waits for networkidle');
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

// NOTE (techart-career-ops fork): LaTeX export was pruned (Windows-native, no
// LaTeX) — `latex.md` and `generate-latex.mjs` are intentionally absent, so
// `latex.md` is removed from this list and the LaTeX-validator section below.
const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
  'interview.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

for (const skillPath of ['.claude/skills/career-ops/SKILL.md', '.agents/skills/career-ops/SKILL.md']) {
  if (!fileExists(skillPath)) {
    fail(`${skillPath} is missing`);
    continue;
  }
  const skill = readFile(skillPath);
  // Fork: the LaTeX route was pruned — assert it stays removed (no dangling route).
  if (!skill.includes('/career-ops latex')) {
    pass(`${skillPath} has no /career-ops latex route (LaTeX pruned in this fork)`);
  } else {
    fail(`${skillPath} still exposes /career-ops latex — LaTeX was pruned, remove the route`);
  }
}

const applyMode = readFile('modes/apply.md');
if (
  applyMode.includes('## Step 5 — Preflight gate') &&
  applyMode.includes('verify liveness with Playwright') &&
  applyMode.includes('matching report has been loaded') &&
  applyMode.includes('Do not continue to Step 6 until this preflight is resolved') &&
  applyMode.includes('refuse to generate final copy')
) {
  pass('apply mode includes liveness and role-match preflight gate');
} else {
  fail('apply mode missing liveness/role-match preflight gate');
}

const ofertaMode = readFile('modes/oferta.md');
const autoPipelineMode = readFile('modes/auto-pipeline.md');
if (
  ofertaMode.includes('## Liveness gate (URL inputs)') &&
  ofertaMode.includes('closed posting evidence') &&
  ofertaMode.includes('Do not continue to Block A until this gate is resolved') &&
  autoPipelineMode.includes('## Step 0.5 — Liveness gate') &&
  autoPipelineMode.includes('closed posting evidence') &&
  autoPipelineMode.includes('Do not continue to Step 1 until this gate is resolved')
) {
  pass('eval modes (oferta/auto-pipeline) gate dead links before evaluation');
} else {
  fail('eval modes missing liveness gate before evaluation');
}

const pipelineMode = readFile('modes/pipeline.md');
if (
  pipelineMode.includes('## Liveness sweep') &&
  pipelineMode.includes('check-liveness.mjs') &&
  pipelineMode.includes('unconfirmed') &&
  pipelineMode.includes('Do not') &&
  pipelineMode.includes('liveness sweep')
) {
  pass('pipeline mode sweeps unconfirmed entries for liveness before processing');
} else {
  fail('pipeline mode missing batch liveness sweep for unconfirmed entries');
}

// ── 9. LOCAL PARSER CONTRACT ────────────────────────────────────

console.log('\n9. Local parser contract');

const scanScript = readFile('scan.mjs');
if (
  scanScript.includes('typeof entry.name !== \'string\'') &&
  scanScript.includes('entry.name.trim()') &&
  scanScript.includes('entry.name.toLowerCase()')
) {
  pass('scan.mjs guards company names before filtering');
} else {
  fail('scan.mjs does not guard company names before filtering');
}

if (
  scanScript.includes("skipIds: ['local-parser']") &&
  scanScript.includes('local parser failed, used API fallback') &&
  scanScript.includes('resolveProvider(company, providers')
) {
  pass('scan.mjs falls back to ATS API when local parser fails');
} else {
  fail('scan.mjs does not fall back to ATS API when local parser fails');
}

if (fileExists('providers/local-parser.mjs')) {
  pass('local-parser provider module exists');
} else {
  fail('local-parser provider module is missing');
}

const scanMode = fileExists('modes/scan.md') ? readFile('modes/scan.md') : '';
if (
  scanMode.includes('local_parser_ok') &&
  (scanMode.includes('No Expensive Scraping Repetition') || scanMode.includes('no repetir scraping caro')) &&
  (scanMode.includes('name not listed in `local_parser_ok`') || scanMode.includes('nombre no listado en `local_parser_ok`'))
) {
  pass('scan.md skips expensive levels after successful local parser');
} else {
  fail('scan.md missing local_parser_ok skip rules for agent scan');
}

if (!fileExists('scripts/parsers/cohere_jobs.py')) {
  pass('Cohere parser example is not bundled as a runtime script');
} else {
  fail('Cohere parser example is still bundled as a runtime script');
}

const portalExample = readFile('templates/portals.example.yml');
if (
  !portalExample.includes('cohere_jobs.py') &&
  portalExample.includes('scripts/parsers/example-js-company-jobs.js') &&
  portalExample.includes('scripts/parsers/example_python_company_jobs.py') &&
  portalExample.includes('already know their target careers URL')
) {
  pass('portals example documents a generic local parser contract');
} else {
  fail('portals example still points at a bundled Cohere parser');
}

// Security hardening: command allowlist, in-repo script containment, careers_url/company validation.
try {
  const localParser = (await import(pathToFileURL(join(ROOT, 'providers/local-parser.mjs')).href)).default;

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'rm' } }) === null) {
    pass('local-parser rejects a non-interpreter command (e.g. rm)');
  } else {
    fail('local-parser should reject a command that is not a whitelisted interpreter or in-repo script');
  }

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'python3', script: '/etc/passwd' } }) === null) {
    pass('local-parser rejects a script outside the project root');
  } else {
    fail('local-parser should reject a script path that escapes the project root');
  }

  const okEntry = localParser.detect({
    name: 'X', careers_url: 'https://x.co',
    parser: { command: 'node', script: 'scan.mjs' },
  });
  if (okEntry && okEntry.url) pass('local-parser accepts a whitelisted interpreter + an in-repo script');
  else fail('local-parser should accept a whitelisted interpreter with an in-repo script');

  let rejectedUrl = false;
  try {
    await localParser.fetch({ name: 'X', careers_url: '--oops', parser: { command: 'python3', args: ['--url', '{careers_url}'] } });
  } catch (e) {
    rejectedUrl = /careers_url/.test(e.message);
  }
  if (rejectedUrl) pass('local-parser rejects a non-URL careers_url before spawning (argument injection guard)');
  else fail('local-parser should reject a careers_url that is not http(s)');

  let rejectedCompany = false;
  try {
    await localParser.fetch({ name: '--rf', careers_url: 'https://x.co', parser: { command: 'python3', args: ['--company', '{company}'] } });
  } catch (e) {
    rejectedCompany = /company/.test(e.message);
  }
  if (rejectedCompany) pass('local-parser rejects a company name that could be read as a flag');
  else fail('local-parser should reject an unsafe company name');

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'node', args: ['-e', 'process.exit(0)'] } }) === null) {
    pass('local-parser rejects inline interpreter code (node -e ...)');
  } else {
    fail('local-parser should reject inline-code flags (-e/-c/--eval)');
  }

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'node', args: ['--eval=globalThis.x=1', 'scan.mjs'] } }) === null) {
    pass('local-parser rejects interpreter options before the script (node --eval=… script)');
  } else {
    fail('local-parser should reject interpreter options preceding the parser script');
  }

  if (localParser.detect({ name: 'Yahoo!', careers_url: 'https://x.co', parser: { command: 'node', script: 'scan.mjs' } })?.url) {
    pass('local-parser accepts a company name with punctuation when {company} is unused');
  } else {
    fail('local-parser should not reject a fixed-script entry over an unused company placeholder');
  }
} catch (e) {
  fail(`local-parser hardening tests crashed: ${e.message}`);
}

// Reverse-scan SSRF guard: a constructed careers_url must resolve to the ATS's own host.
try {
  const { entryOnHost } = await import(pathToFileURL(join(ROOT, 'scan-ats-full.mjs')).href);
  const canonical = entryOnHost('acme', 'https://jobs.lever.co/acme', (h) => h === 'jobs.lever.co');
  const offHost = entryOnHost('acme', 'https://evil.example.com/acme', (h) => h === 'jobs.lever.co');
  if (canonical && canonical.careers_url === 'https://jobs.lever.co/acme' && offHost === null) {
    pass('scan-ats-full entryOnHost keeps canonical ATS hosts and drops others (SSRF guard)');
  } else {
    fail('scan-ats-full entryOnHost should keep canonical hosts and drop non-canonical ones');
  }
} catch (e) {
  fail(`scan-ats-full host-guard test crashed: ${e.message}`);
}

// ── 10. PORTALS CONFIG VALIDATOR ────────────────────────────────

console.log('\n10. Portals config validator');

try {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-portals-validator-'));
  const validPath = join(tmp, 'valid.yml');
  const invalidProviderPath = join(tmp, 'invalid-provider.yml');
  const emptyKeywordPath = join(tmp, 'empty-keyword.yml');
  const duplicateCompanyPath = join(tmp, 'duplicate-company.yml');
  const badContentFilterPath = join(tmp, 'bad-content-filter.yml');

  writeFileSync(validPath, `
title_filter:
  positive: ["AI"]
  negative: ["Intern"]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  writeFileSync(invalidProviderPath, `
title_filter:
  positive: ["AI"]
tracked_companies:
  - name: "Acme"
    provider: "missing-provider"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  writeFileSync(emptyKeywordPath, `
title_filter:
  positive: ["AI", "   "]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  writeFileSync(duplicateCompanyPath, `
title_filter:
  positive: ["AI"]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
  - name: " acme "
    careers_url: "https://jobs.lever.co/acme2"
`, 'utf-8');

  // content_filter with an empty-string keyword must be rejected, same as
  // title/location filters (an empty keyword would match every description).
  writeFileSync(badContentFilterPath, `
title_filter:
  positive: ["AI"]
content_filter:
  positive: ["rust", "   "]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  const validResult = run(NODE, ['validate-portals.mjs', '--file', validPath]);
  if (validResult !== null && validResult.includes('0 errors')) {
    pass('validate-portals accepts a minimal valid portals file');
  } else {
    fail('validate-portals should accept a minimal valid portals file');
  }

  const exampleResult = run(NODE, ['validate-portals.mjs', '--file', 'templates/portals.example.yml']);
  if (exampleResult !== null && exampleResult.includes('0 errors')) {
    pass('validate-portals accepts templates/portals.example.yml');
  } else {
    fail('validate-portals should accept templates/portals.example.yml');
  }

  const invalidProviderResult = run(NODE, ['validate-portals.mjs', '--file', invalidProviderPath]);
  if (invalidProviderResult === null) {
    pass('validate-portals rejects unknown explicit providers');
  } else {
    fail('validate-portals should reject unknown explicit providers');
  }

  const emptyKeywordResult = run(NODE, ['validate-portals.mjs', '--file', emptyKeywordPath]);
  if (emptyKeywordResult === null) {
    pass('validate-portals rejects empty title/location keywords');
  } else {
    fail('validate-portals should reject empty title/location keywords');
  }

  const duplicateCompanyResult = run(NODE, ['validate-portals.mjs', '--file', duplicateCompanyPath]);
  if (duplicateCompanyResult !== null && duplicateCompanyResult.includes('1 warning')) {
    pass('validate-portals warns on duplicate enabled company names');
  } else {
    fail('validate-portals should warn on duplicate enabled company names');
  }

  const badContentFilterResult = run(NODE, ['validate-portals.mjs', '--file', badContentFilterPath]);
  if (badContentFilterResult === null) {
    pass('validate-portals rejects empty content_filter keywords');
  } else {
    fail('validate-portals should reject empty content_filter keywords');
  }

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fail(`portals validator tests crashed: ${e.message}`);
}

// ── 10b. PORTAL SLUG VALIDATOR (verify-portals.mjs) ─────────────

console.log('\n10b. Portal slug validator');

try {
  const { deriveSlugCandidates, parseAtsSlug, verifyCompanies } =
    await import(pathToFileURL(join(ROOT, 'verify-portals.mjs')).href);

  const slugs = deriveSlugCandidates('Acme Corp!');
  if (JSON.stringify(slugs) === JSON.stringify(['acmecorp', 'acme-corp', 'acme_corp', 'acme'])) {
    pass('verify-portals derives slug candidates from a company name');
  } else {
    fail(`verify-portals slug candidates wrong: ${JSON.stringify(slugs)}`);
  }

  if (
    parseAtsSlug('https://job-boards.greenhouse.io/acme')?.ats === 'greenhouse' &&
    parseAtsSlug('https://jobs.ashbyhq.com/acme')?.ats === 'ashby' &&
    parseAtsSlug('https://api.lever.co/v0/postings/acme')?.slug === 'acme' &&
    parseAtsSlug('https://openai.com/careers') === null
  ) {
    pass('verify-portals recognizes ATS slugs and skips branded URLs');
  } else {
    fail('verify-portals parseAtsSlug misclassified an ATS or branded URL');
  }

  // Mock fetchJson: 200+jobs → live, 200+empty → empty, otherwise 404 → missing.
  const mockFetch = async (url) => {
    if (url.includes('/boards/live/')) return { jobs: [{}, {}] };
    if (url.includes('/boards/empty/')) return { jobs: [] };
    const err = new Error('HTTP 404'); err.status = 404; throw err;
  };
  const results = await verifyCompanies([
    { name: 'Live', careers_url: 'https://job-boards.greenhouse.io/live' },
    { name: 'Empty', careers_url: 'https://job-boards.greenhouse.io/empty' },
    { name: 'Typo', careers_url: 'https://job-boards.greenhouse.io/nope' },
    { name: 'Branded', careers_url: 'https://acme.com/careers' },
    { name: 'Off', enabled: false, careers_url: 'https://job-boards.greenhouse.io/live' },
  ], { fetchJson: mockFetch });
  const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
  if (
    results.length === 4 &&
    byName.Live === 'live' && byName.Empty === 'empty' &&
    byName.Typo === 'missing' && byName.Branded === 'skipped'
  ) {
    pass('verify-portals classifies live / empty / unresolved / non-ATS (disabled excluded)');
  } else {
    fail(`verify-portals classification wrong: ${JSON.stringify(byName)} (${results.length} rows)`);
  }
} catch (e) {
  fail(`portal slug validator tests crashed: ${e.message}`);
}

// ── 11. AGENTS.md INTEGRITY ─────────────────────────────────────

console.log('\n11. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 11. CLI WRAPPER FILE INTEGRITY ──────────────────────────

console.log('\n11. CLI wrapper file integrity');

const cliWrappers = ['CLAUDE.md', 'OPENCODE.md', 'GEMINI.md'];
for (const f of cliWrappers) {
  if (!fileExists(f)) {
    fail(`Missing CLI wrapper: ${f}`);
    continue;
  }
  const content = readFile(f);
  if (content.includes('AGENTS.md')) {
    pass(`${f} references AGENTS.md`);
  } else {
    fail(`${f} does NOT reference AGENTS.md`);
  }
}

// ── 12. SKILL SYMLINK INTEGRITY ─────────────────────────────

console.log('\n12. Skill symlink integrity');

const canonicalSkill = '.agents/skills/career-ops/SKILL.md';
const symlinks = [
  '.claude/skills/career-ops/SKILL.md',
  '.opencode/skills/career-ops/SKILL.md',
  '.antigravitycli/skills/career-ops/SKILL.md',
];

let canonicalReal = null;
let canonicalContent = null;
try {
  canonicalReal = realpathSync(join(ROOT, canonicalSkill));
  canonicalContent = readFile(canonicalSkill);
  pass(`Canonical skill resolves: ${canonicalSkill}`);
} catch {
  fail(`Canonical skill not found: ${canonicalSkill}`);
}

for (const link of symlinks) {
  let resolved = null;
  try {
    resolved = realpathSync(join(ROOT, link));
    if (resolved !== canonicalReal) {
      const content = readFileSync(resolved, 'utf-8').trim();
      if (content.startsWith('..') && content.split('\n').length === 1) {
        resolved = realpathSync(join(dirname(join(ROOT, link)), content));
      }
    }
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    fail(`Symlink missing: ${link}`);
    continue;
  }
  if (resolved === canonicalReal) {
    pass(`${link} → canonical skill`);
  } else if (canonicalContent !== null && readFile(link) === canonicalContent) {
    pass(`${link} is a materialized copy of canonical skill`);
  } else {
    fail(`${link} resolves to ${resolved}, expected ${canonicalReal} or byte-identical canonical skill copy`);
  }
}

// ── 14. VERSION FILE ─────────────────────────────────────────────

console.log('\n14. Version file');

if (fileExists('VERSION')) {
  // VERSION may carry a release-please marker, e.g. "1.9.0 # x-release-please-version".
  // Validate the first whitespace-delimited token, the same parse the release tooling uses.
  const version = readFile('VERSION').trim().split(/\s+/)[0];
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 15. LOCATION FILTER — always_allow tier ───────────────────────
// These exercise scan.mjs's exported buildLocationFilter helper and its generic
// allow/block contract. The scanners themselves build from effectiveLocationFilter(),
// which ignores those keys; that path is tested under "Scanner location filter".

console.log('\n15. Location filter — always_allow tier');

try {
  const {
    buildLocationFilter,
    buildLocationDecider,
    buildContentFilter,
    shouldDedupScanHistoryRow,
    formatPipelineOffer,
    formatScanHistoryRow,
  } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const filter = buildLocationFilter({
    always_allow_scoped: ['belgium', 'brussels'],
    allow: ['europe', 'emea', 'remote'],
    block: ['france', 'germany', 'united states'],
  });

  // Case 1: home-region passes regardless of other text
  if (filter('Brussels, Belgium') === true) pass('Brussels, Belgium passes (always_allow hit)');
  else fail('Brussels, Belgium should pass');

  // Case 2: a scoped home-region option wins over block (THE motivating case for this tier)
  if (filter('Remote, Belgium or France') === true) pass('Remote, Belgium or France passes (always_allow_scoped beats block)');
  else fail('Remote, Belgium or France should pass — always_allow_scoped must win over block');

  // Case 3: no always_allow hit, block still rejects
  if (filter('Paris, France') === false) pass('Paris, France is rejected (block still applies)');
  else fail('Paris, France should be rejected');

  // Case 4: empty location → pass (existing semantics, unchanged)
  if (filter('') === true) pass('empty location passes (unchanged semantics)');
  else fail('empty location should pass');

  // Case 5: case-insensitivity
  if (filter('BRUSSELS, BELGIUM') === true) pass('case-insensitive match works');
  else fail('case-insensitive match failed');

  // Case 6: backward compatibility — no always_allow key behaves like stock allow/block
  const stockFilter = buildLocationFilter({
    allow: ['europe', 'remote'],
    block: ['france'],
  });
  if (stockFilter('Remote, Belgium or France') === false) pass('without always_allow, block still wins (backward compatible)');
  else fail('without always_allow, behaviour must match stock allow/block (block wins)');

  // Case 7: null/missing locationFilter → pass-all filter (early-return path)
  const nullFilter = buildLocationFilter(null);
  if (nullFilter('Anywhere on Earth') === true && nullFilter('') === true) {
    pass('null locationFilter returns a pass-all filter (early-return path)');
  } else {
    fail('null locationFilter should return a pass-all filter');
  }

  // Case 8: string-instead-of-array → wrapped to a 1-item list
  const stringFilter = buildLocationFilter({ always_allow_scoped: 'belgium', block: ['france'] });
  if (stringFilter('Remote, Belgium or France') === true) {
    pass('always_allow as a bare string is wrapped to a single-item list');
  } else {
    fail('always_allow as a bare string should still work');
  }

  // Case 9: null/non-string items are filtered out (no crash, no false matches)
  const messyFilter = buildLocationFilter({
    always_allow: [null, 'belgium', 42, undefined],
    block: ['france', null, 7],
  });
  if (messyFilter('Brussels, Belgium') === true && messyFilter('Paris, France') === false) {
    pass('non-string entries (null, numbers, undefined) are filtered out without crashing');
  } else {
    fail('mixed-type keyword lists should not crash and should still match string entries');
  }

  // Case 10: all-null/non-string list → empty after normalization (no false rejects)
  const allBadFilter = buildLocationFilter({ block: [null, 42, undefined], allow: ['remote'] });
  if (allBadFilter('Remote') === true) {
    pass('a block list with only non-string entries normalizes to [] (no false rejects)');
  } else {
    fail('non-string-only block list should not cause rejection');
  }

  // Case 11: empty / whitespace-only entries are dropped (would otherwise pass-all via includes(''))
  const emptyKeywordFilter = buildLocationFilter({
    always_allow: ['', '  '],
    allow: ['remote'],
    block: ['france'],
  });
  if (emptyKeywordFilter('Paris, France') === false) {
    pass('empty/whitespace always_allow entries are dropped (no pass-all via includes(""))');
  } else {
    fail('empty always_allow entries should NOT bypass block — would have made the filter pass-all');
  }

  // Case 12: surrounding whitespace is trimmed so the keyword still matches
  const whitespaceFilter = buildLocationFilter({
    always_allow_scoped: ['  Belgium  ', '\tBrussels\n'],
    block: ['france'],
  });
  if (whitespaceFilter('Remote, Belgium or France') === true) {
    pass('whitespace-padded keywords still match after trim');
  } else {
    fail('"  Belgium  " should be trimmed and still match "Remote, Belgium or France"');
  }

  // Case 13: whitespace-only location is treated as missing (pass-all-tiers)
  if (filter('   \t  ') === true) pass('whitespace-only location passes (treated as missing)');
  else fail('whitespace-only location should pass');

  // Case 14: non-string location (number/object/null) → pass without throwing
  let crashed = false;
  try {
    const r1 = filter(42);
    const r2 = filter({ city: 'Brussels' });
    const r3 = filter(null);
    const r4 = filter(undefined);
    if (r1 === true && r2 === true && r3 === true && r4 === true) {
      pass('non-string location values (number, object, null, undefined) pass without throwing');
    } else {
      fail(`non-string location results: number=${r1}, object=${r2}, null=${r3}, undefined=${r4}`);
    }
  } catch (e) {
    crashed = true;
    fail(`non-string location crashed: ${e.message}`);
  }

  // Case 15: a malformed location (e.g. legacy object) does NOT bypass block when interpreted naively —
  // the guard returns true (pass) BEFORE block/allow even run, which is correct: scoring/eval happens
  // downstream from the scan filter, so malformed locations should fall through to the manual evaluation
  // step rather than being silently dropped here.
  if (filter(42) === true) pass('non-string locations are passed through to downstream evaluation, not silently dropped');
  else fail('non-string locations should pass through');

  const exampleFilter = buildLocationFilter({
    remote_signals: ['remote'],
    us_wide_signals: ['united states', 'usa', 'u.s.', 'us'],
    california_signals: ['california', 'ca'],
    us_state_signals: ['california', 'ca', 'washington', 'wa', 'new york', 'ny', 'north carolina', 'nc'],
    socal_signals: ['los angeles', 'orange county', 'irvine', 'fullerton', 'long beach', 'anaheim', 'glendale', 'burbank', 'culver city', 'playa vista', 'santa monica', 'el segundo', 'costa mesa', 'pasadena', 'torrance'],
    blocked_geo: ['united kingdom', 'london', 'canada', 'ontario', 'quebec', 'emea', 'bangalore'],
    hard_out_metro: ['san francisco', 'santa clara', 'new york', 'bellevue', 'cary'],
  });
  const locationCases = [
    ['Remote', true],
    ['Remote - United States', true],
    ['United States (Remote)', true],
    ['USA | Remote', true],
    ['Remote, United States', true],
    ['US, CA, Remote', true],
    ['Remote, Canada; Remote, United States', true],
    ['CA - Canada; US - United States', true],
    ['San Francisco · New York · United States · Remote', true],
    ['Remote, US (occasional travel to London)', true],
    ['Long Beach, California, United States', true],
    ['Irvine, CA', true],
    ['Glendale, CA, USA', true],
    ['Culver City, CA', true],
    ['', true],
    [null, true],
    ['Remote, United Kingdom', false],
    ['Remote, Canada', false],
    ['Remote, Ontario, Canada', false],
    ['Choice of Remote (in Quebec)', false],
    ['Remote (EMEA)', false],
    ['Remote, Bangalore', false],
    ['Remote (New York)', false],
    ['Remote, Washington, USA', false],
    ['San Francisco, CA', false],
    ['San Francisco, CA | New York City, NY', false],
    ['US, CA, Santa Clara', false],
    ['New York, NY, USA', false],
    ['Bellevue, WA, USA', false],
    ['Cary,North Carolina,United States', false],
  ];
  for (const [location, expected] of locationCases) {
    if (exampleFilter(location) === expected) pass(`location policy: ${JSON.stringify(location)} → ${expected ? 'accept' : 'reject'}`);
    else fail(`location policy mismatch: ${JSON.stringify(location)} should ${expected ? 'pass' : 'fail'}`);
  }

  // ── every writing script refuses an unrecognised argument ────────
  // `node dedup-tracker.mjs --help` did not print help: the flag was simply not
  // recognised, argument parsing ignored it, and the script ran its default
  // action — a destructive rewrite of the tracker — deleting two rows
  // (2026-08-12). Every writing script had that shape. A typo like --dryrun
  // reads as "no flags" and runs the real thing.
  // recompute-tracker and rederive-red-flags have the INVERTED failure: they
  // preview by default and write only on --apply, so a mistyped --apply is not
  // destructive, it silently previews while the operator believes the change
  // landed. Same guard, different reason — and the refusal says so.
  // recompute-tracker.mjs had its write path stripped on 2026-08-25 and is not shipped
  // here. It was a SECOND tracker writer that computed base (sum/4 + red
  // flags, no factors, no min) via audit-scores.mjs and wrote that into the tracker's FINAL
  // column, which would have moved 234 rows while apply-model and score-audit both called
  // the same tracker clean.
  //
  // Which scripts must be guarded is SCANNED, not listed: a hand-kept list is one that
  // falls behind the code without saying so, and seven writers had been added outside it.
  // Every repo-root script that both writes files and reads its arguments imports
  // cli-guard.mjs and calls it, or is named below with the reason it does not.
  const GUARD_EXEMPT = {
    'test-all.mjs': 'the test suite; it writes only under its own RUN_TMP',
    'validate-portals.mjs': 'its only writes are a mkdtemp scratch directory inside --self-test',
  };
  try {
    const WRITES = /\b(?:writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync)\s*\(/;
    const scanned = readdirSync(ROOT).filter((f) => f.endsWith('.mjs') && f !== 'cli-guard.mjs')
      .map((f) => [f, codeOnly(readFileSync(join(ROOT, f), 'utf8'))])
      .filter(([, src]) => WRITES.test(src)
        && (/process\.argv/.test(src) || /from '\.\/cli-guard\.mjs'/.test(src)));
    const unguarded = scanned.filter(([f, src]) => !GUARD_EXEMPT[f]
      && !(/from '\.\/cli-guard\.mjs'/.test(src) && /\bguardArgs\(/.test(src))).map(([f]) => f);
    const stale = Object.keys(GUARD_EXEMPT).filter((f) => !scanned.some(([s]) => s === f));
    // A scanner that matches nothing passes everything.
    if (scanned.length < 15) {
      fail(`cli-guard scan found only ${scanned.length} writers that read their arguments; the scan is broken`);
    } else if (unguarded.length || stale.length) {
      fail(`writers that read argv without cli-guard: ${unguarded.join(', ') || 'none'}; `
        + `exemptions matching no writer: ${stale.join(', ') || 'none'}`);
    } else {
      pass(`all ${scanned.length - Object.keys(GUARD_EXEMPT).length} argument-reading writers go through `
        + `cli-guard (${Object.keys(GUARD_EXEMPT).length} exempt, each with a reason)`);
    }
  } catch (e) {
    fail(`cli-guard scan crashed: ${e.message}`);
  }

  // The parser itself, in-process, on the accepting side (a refusal exits the process,
  // so those cases run as children below). A flag that declares a value takes it in
  // either spelling, and the value is consumed rather than mistaken for a stray argument.
  try {
    const { guardArgs } = await import(pathToFileURL(join(ROOT, 'cli-guard.mjs')).href);
    const spec = (argv) => guardArgs({ name: 'probe', summary: 'probe', argv, flags: [
      ['--dry-run', ''], ['--company <name>', ''], ['--throttle[=<ms>]', ''], ['--min <n>', '']] });
    const spaced = spec(['--company', 'Acme', '--dry-run']);
    const joined = spec(['--company=Acme Corp', '--throttle']);
    const tuned = spec(['--throttle=8000', '--min', '-1']);
    const cases = [
      ['--company X', spaced.value('--company') === 'Acme' && spaced.has('--dry-run')
        && spaced.positional.length === 0],
      ['--company=X', joined.value('--company') === 'Acme Corp'],
      ['bare optional --throttle', joined.has('--throttle') && joined.value('--throttle', 'dflt') === 'dflt'],
      ['--throttle=N', tuned.value('--throttle') === '8000'],
      ['a "-1" value', tuned.value('--min') === '-1'],
      ['an absent flag', !spaced.has('--min') && spaced.value('--min', '6') === '6'],
    ];
    for (const [what, ok] of cases) {
      if (ok) pass(`cli-guard parses ${what}`); else fail(`cli-guard mis-parses ${what}`);
    }
  } catch (e) {
    fail(`cli-guard parser probe crashed: ${e.message}`);
  }

  // Behavioural probes run only where a broken guard is harmless: from an empty scratch
  // directory, so a script reading reports/ or data/ relative to its cwd finds nothing,
  // and with the three tracker writers pointed at a scratch tracker by CAREER_OPS_TRACKER.
  // rederive-red-flags imports audit-scores.mjs before it parses arguments, so it runs
  // from the repo; it previews by default, so a broken guard there writes nothing. None of the five takes a bare argument, so a bare word and a "-1" are
  // refused as well.
  const guardDir = join(RUN_TMP, 'guard');
  mkdirSync(guardDir, { recursive: true });
  const guardEnv = { ...process.env, CAREER_OPS_TRACKER: join(guardDir, 'applications.md'),
    CAREER_OPS_ADDITIONS: join(guardDir, 'additions') };
  const guarded = (script, argv, cwd = guardDir) => {
    try {
      return { code: 0, out: execFileSync(NODE, [join(ROOT, script), ...argv],
        { cwd, env: guardEnv, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) };
    } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  for (const script of ['dedup-tracker.mjs', 'normalize-statuses.mjs',
    'merge-tracker.mjs', 'refresh-job-links.mjs',
    'rederive-red-flags.mjs']) {
    const cwd = script === 'rederive-red-flags.mjs' ? ROOT : guardDir;
    const helped = /--help/.test(guarded(script, ['--help'], cwd).out);
    const bad = ['--definitely-not-a-flag', '-1', 'dry-run'];
    const codes = bad.map((arg) => guarded(script, [arg], cwd).code);

    if (helped && codes.every((c) => c === 2)) {
      pass(`${script}: --help prints usage, ${bad.join(' / ')} exit 2`);
    } else {
      fail(`${script}: help=${helped}, exits ${codes.join('/')} for ${bad.join(' / ')} (want usage + exit 2)`);
    }
  }

  // A typo of the one flag that writes, on a script that previews by default. From the
  // empty directory, a guard that let it through would fail to import and exit 1.
  {
    const r = guarded('apply-model.mjs', ['--aply']);
    if (r.code === 2 && /would silently preview/.test(r.out)) {
      pass('apply-model.mjs: a mistyped --apply exits 2 and says it would have silently previewed');
    } else {
      fail(`apply-model.mjs --aply: exit ${r.code}, ${r.out.trim().slice(0, 160)}`);
    }
  }

  // A declared value flag, in both spellings, reaches the script. doctor --json only reads.
  // The two targets differ in whether cv.md exists, so a value dropped on the floor would
  // read the repo root for both and the two answers could not both hold.
  {
    const bare = join(guardDir, 'doctor-bare');
    const withCv = join(guardDir, 'doctor-cv');
    mkdirSync(bare, { recursive: true });
    mkdirSync(withCv, { recursive: true });
    writeFileSync(join(withCv, 'cv.md'), '# CV\n');
    const missing = (argv) => {
      try { return JSON.parse(guarded('doctor.mjs', argv).out).missing; } catch { return null; }
    };
    const spaced = missing(['--json', '--target', bare]);
    const joined = missing(['--json', `--target=${withCv}`]);
    if (spaced?.includes('cv.md') && Array.isArray(joined) && !joined.includes('cv.md')) {
      pass('doctor.mjs: --target <dir> and --target=<dir> both reach the script');
    } else {
      fail(`doctor.mjs --target: missing ${JSON.stringify(spaced)} / ${JSON.stringify(joined)}`);
    }
    const valueless = guarded('doctor.mjs', ['--json', '--target']);
    if (valueless.code === 2 && /--target needs a value/.test(valueless.out)) {
      pass('doctor.mjs: a value flag given no value exits 2');
    } else {
      fail(`doctor.mjs --target with no value: exit ${valueless.code}, ${valueless.out.trim().slice(0, 160)}`);
    }
  }

  // ── every entry point finds out it is the main module through isMain ──
  // argv[1] keeps a symlinked or junctioned path while import.meta.url is the resolved
  // file, so comparing the two directly says "imported" for a direct run, and the
  // script exits 0 having done nothing. Its --selftest then reads as green in CI. That
  // was fixed in nine scripts and missed in location-core.mjs and providers/greenhouse.mjs,
  // so the rule is checked over every tracked .mjs rather than a list of names.
  {
    const mjs = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf-8' })
      .split('\n').filter((f) => f && f !== 'cli-guard.mjs');
    const naive = mjs.filter((f) => {
      const src = readFileSync(join(ROOT, f), 'utf-8').replace(/^\s*(\/\/|\*).*$/gm, '');
      return /pathToFileURL\(\s*process\.argv\[1\]\s*\)|process\.argv\[1\][^\n;]*===\s*import\.meta\.url/.test(src);
    });
    if (mjs.length < 20) fail(`entry-point scan read only ${mjs.length} .mjs files; git ls-files is not seeing the tree`);
    else if (!naive.length) pass(`no .mjs compares argv[1] to import.meta.url directly (${mjs.length} files scanned)`);
    else fail(`compare argv[1] to import.meta.url without resolving links; use cli-guard isMain(): ${naive.join(', ')}`);
  }

  // ── python selftests ──────────────────────────────────────────────
  // Both of these guard a rule whose failure is SILENT, which is why they belong in
  // the suite rather than being run by hand. req-resolve's routing decides which ATS
  // adapter sees a URL, and a misroute reports a live req as closed. triage-leads'
  // role matcher decides whether a pasted lead is treated as already-tracked: it once
  // merged "Agent Architecture and Evaluation" into "Agent Simulation and Evaluation",
  // two different reqs with opposite location verdicts, which would have hidden one of
  // them. Neither selftest touches the network.
  // ── every ATS adapter must read its secondary-locations field ──────
  // The same bug landed three times on 2026-08-24, each time silently discarding a role
  // the candidate could actually take. Every ATS splits location across a primary string and a
  // secondary array, and they disagree: Ashby hides remote in secondaryLocations, Lever
  // in categories.allLocations (a req whose primary reads "Toronto, ON"), Workday in
  // additionalLocations (a per-req home-state remote entry, which is the difference
  // between a workable role and a hard out). Reading only the primary is
  // the single most expensive mistake this resolver can make, because it fails closed
  // and prints nothing. This is a structural check, not a behavioural one: it asserts
  // the field name still appears inside each adapter, so a rewrite that drops it fails
  // here rather than in six weeks when a good role quietly vanishes.
  // Comments are stripped before the check. The first version of this guard passed a
  // mutation test with the adapter deliberately broken, because the explanatory comment
  // above the fix also contained the field name. It was matching prose, not code.
  try {
    const src = readFileSync(join(ROOT, 'scripts', 'req-resolve.py'), 'utf-8')
      .split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
    for (const [ats, field] of [
      ['greenhouse', 'offices'],
      ['ashby', 'secondaryLocations'],
      ['lever', 'allLocations'],
      ['workday', 'additionalLocations'],
      ['workable', 'locations']]) {
      const at = src.indexOf(`ats="${ats}"`);
      const branch = src.slice(Math.max(0, at - 2500), at + 600);
      if (at >= 0 && branch.includes(field)) {
        pass(`req-resolve ${ats} adapter reads ${field}`);
      } else {
        fail(`req-resolve ${ats} adapter no longer reads ${field} — secondary locations ` +
             `will be dropped and remote-eligible roles will silently fail the gate`);
      }
    }
  } catch (e) {
    fail(`secondary-location adapter check crashed: ${e.message}`);
  }

  for (const [script, want] of [
    ['scripts/req-resolve.py', /all \d+ routing cases pass/],
    ['scripts/triage-leads.py', /all \d+ role-matching cases pass/],
    ['scripts/check-remote.py', /all \d+ remote-contradiction cases pass/],
    ['scripts/eval-prep.py', /all \d+ location cases pass/],
    // workday-sweep guards two silent truncations and one dead dedup key, all three of
    // which looked like ordinary results rather than failures: a tenant reporting
    // total=0 after its first page (436 jobs read as 40), our own page cap standing in
    // for a board size (NVIDIA read as exactly 800), and a \b-anchored requisition
    // pattern that matched nothing in "..._R26710" so every row claimed to be untracked.
    ['scripts/workday-sweep.py', /0 failure\(s\)/],
    ['scripts/_lane.py', /0 failure\(s\)/],
    // _ashby_embed had a passing selftest that nothing ever ran. It is the fallback that
    // reads a board whose opt-in posting API answers 404, which is how Whatnot's 131-posting
    // board was filed as unreachable for months, so a silent regression here restores that
    // blind spot.
    ['scripts/_ashby_embed.py', /0 failure\(s\)/],
    // find-ats decides whether a company has a board at all. owns() encodes three named
    // false negatives it has already produced.
    ['scripts/find-ats.py', /0 failure\(s\)/],
    // inbox-liveness can WRITE to the inbox with --mark, and its two safety properties
    // are what make that safe: a board that could not be read, and a board that parsed
    // but is empty, must both yield zero closed verdicts. Without them one unreachable
    // board would retire every row it owns in a single pass.
    ['scripts/inbox-liveness.py', /0 failure\(s\)/],
    // The board-rebuild hook fires on data, not on a list of script names, because the
    // name list silently fell behind the code: score-audit --fix, apply-model --apply,
    // dedup-tracker and normalize-statuses all rewrite the tracker and none of them
    // rebuilt the pages, so the board's timestamps claimed currency it did not have.
    // Its fingerprint has to be BOTH sensitive (a tracker rewrite is seen) and stable
    // (an unchanged tree is not), since a fingerprint that drifts rebuilds the whole
    // board on every shell command.
    ['scripts/hooks/rebuild_boards_hook.py', /0 failure\(s\)/],
    // eval-blockers answers "what is left to do" and it used to answer "what is in the
    // directory". On 2026-09-20 those had diverged: 106 of 128 packets carrying a url
    // already had a report, and they read as `filled` or as `ready` depending only on
    // whether their judgement fields happened to be set, while nothing consulted the
    // tri-state `live` field, so the READY list was headed by a requisition retired an
    // hour earlier. Its selftest guards the two states that fixed that (`reported`,
    // keyed on REQUISITION IDENTITY across a Workday re-slug, a Greenhouse gh_jid and
    // an Ashby uuid, and `closed`), the rule that a null `live` is `liveness-unknown`
    // rather than ready, and the three safety properties of --prune, which MOVES
    // packets out of the queue: it never deletes, it never overwrites a colliding
    // destination, and a dry run writes nothing.
    ['scripts/eval-blockers.py', /0 failure\(s\)/],
    // The location policy loader every Python gate reads, and NVIDIA's per-req remote
    // check, which used to hard-code California and now asks the policy.
    ['scripts/_location.py', /_location selftest: \d+ checks, 0 failure\(s\)/],
    // Both also read Workday liveness, and each closed live reqs on a one-page search or a
    // response with no canApply until it moved onto req-resolve's walker and reader.
    ['scripts/nvidia-liveness.py',
      /nvidia-liveness selftest: \d+ home-remote cases \+ \d+ search cases, 0 failure\(s\)/],
    ['scripts/workday-peek.py', /0 failure\(s\)/],
    // select()'s own filters (live, home_remote, tracked, the floor boundary, and a
    // zero-scoring title rescued by an in-lane body) used to be pinned only by test 23's
    // two-row fixture, which never exercised most of them.
    ['scripts/nvidia-sweep.py', /nvidia-sweep selftest: \d+ select\(\) cases, 0 failure\(s\)/]]) {
    let out = null, code = 0;
    try {
      out = execFileSync('python', [join(ROOT, script), '--selftest'],
        { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
    } catch (e) { code = e.status ?? 1; out = `${e.stdout || ''}${e.stderr || ''}`; }
    if (code === 0 && want.test(out || '')) {
      pass(`${script} --selftest: ${(out || '').trim().split('\n').pop()}`);
    } else {
      fail(`${script} --selftest exited ${code}: ${(out || '').trim().slice(0, 160)}`);
    }
  }

  // ── the python writers refuse an unrecognised argument too ───────
  // Same guard and same reason as the node loop above: `node dedup-tracker.mjs --help`
  // was not recognised, argument parsing ignored it and the script ran its default
  // destructive action. eval-blockers.py moves packets out of the live queue with
  // --prune, so a mistyped flag must stop rather than fall through to the default run.
  // These two use argparse, which gives usage on --help and exit 2 on an unknown flag,
  // but that is a property of how they parse arguments and a hand-rolled sys.argv scan
  // would silently lose it, which is precisely what happened on the node side.
  // eval-assist.py was the third: it ignored its arguments entirely, so `--help` ran the
  // default rewrite of every packet and a typo beside --retire could still delete them.
  for (const script of ['scripts/eval-blockers.py', 'scripts/inbox-liveness.py', 'scripts/eval-assist.py']) {
    let helped = false, refusedCode = null;
    try {
      const h = execFileSync('python', [join(ROOT, script), '--help'],
        { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
      helped = /--help/.test(h || '');
    } catch { helped = false; }
    try {
      execFileSync('python', [join(ROOT, script), '--definitely-not-a-flag'],
        { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
    } catch (e) { refusedCode = e.status; }
    if (helped && refusedCode === 2) {
      pass(`${script}: --help prints usage, unknown flag exits 2`);
    } else {
      fail(`${script}: help=${helped}, unknown-flag exit=${refusedCode} (want usage + exit 2)`);
    }
  }

  // ── build-home's dashboard scrape still matches the dashboard ─────
  // The home page does not compute its two headline numbers; it reads them back out of
  // the rendered prospects dashboard with a regex. That couples one file's OUTPUT WORDING
  // to another file's pattern, with nothing to notice when they drift apart. They did:
  // the pattern demanded "N actionable 4.0+ leads &middot; N packets ready", the template
  // headline gained a "near miss 3.8-3.9" segment between the two counts and dropped the
  // word "leads", and from then on index.html rendered "- leads - prepped". A failed
  // scrape was indistinguishable from a genuine zero, so it never surfaced.
  {
    const home = readFileSync(join(ROOT, 'scripts', 'build-home.py'), 'utf-8');
    const m = home.match(/re\.search\(r'([^']+)',\s*txt\)/);
    if (!m) {
      fail('build-home.py no longer scrapes the dashboard with a re.search(r\'...\'); update this test');
    } else {
      // Render the template the way build-dashboard.py does, with digits standing in for
      // the counts, then check the live pattern against it.
      const tpl = readFileSync(join(ROOT, 'scripts', '_dashboard_template.html'), 'utf-8');
      const headline = tpl.replace(/__ACTIONABLE__/g, '34').replace(/__NEARMISS__/g, '21')
        .replace(/__PREPPED__/g, '26').replace(/__TOTAL__/g, '526');
      const hit = new RegExp(m[1]).exec(headline);
      if (!hit) {
        fail(`build-home.py's scrape pattern no longer matches the dashboard template; ` +
             `index.html will show a dash instead of its lead counts. Pattern: ${m[1]}`);
      } else if (hit[1] !== '34' || hit[2] !== '26') {
        fail(`build-home.py's scrape matched the wrong numbers (${hit[1]}, ${hit[2]}); ` +
             `expected the actionable count 34 and the prepped count 26, so the home page ` +
             `would publish the near-miss or total figure as its lead count`);
      } else {
        pass('build-home.py scrapes the actionable and prepped counts out of the current dashboard template');
      }
    }
  }

  // ── probe-boards rejects ATS demo boards ──────────────────────────
  // Self-serve ATS platforms host demo boards on generic slugs. Probing
  // "google" on Recruitee returned a board whose only posting was
  // "Senior Marketer (Sample)" in Amsterdam, reported as a confident hit for
  // Google — which would have wired a fake board into portals.yml.
  {
    const { looksLikeSampleBoard } = await import(pathToFileURL(join(ROOT, 'probe-boards.mjs')).href);
    const sampleCases = [
      [[{ title: 'Senior Marketer (Sample)' }], true, 'the exact Recruitee demo posting'],
      [[{ title: 'Sample Job' }, { title: 'Demo Position' }], true, 'all postings are seed data'],
      [[{ title: 'Senior Technical Artist' }], false, 'a real single-posting board must survive'],
      [[{ title: 'Sample Job' }, { title: 'Senior Rigging TD' }], false, 'a real posting present — not a demo board'],
      [[], false, 'empty board is not a sample board'],
      [null, false, 'non-array input'],
    ];
    for (const [items, expected, why] of sampleCases) {
      if (looksLikeSampleBoard(items) === expected) pass(`sample-board detect: ${why}`);
      else fail(`sample-board detect wrong (${why}): got ${!expected}`);
    }
  }

  // ── dedup-tracker refuses to run on an unrecognised flag ──────────
  // Its default action REWRITES data/applications.md. `--help` used to fall
  // through to the real run and deleted two tracker rows (2026-08-12).
  {
    const tmpTracker = join(mkdtempSync(join(tmpdir(), 'co-dedup-guard-')), 'applications.md');
    writeFileSync(tmpTracker, [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-08-01 | Acme | Technical Artist | 4.0/5 | Evaluated | ❌ | [1](reports/1.md) | n |',
    ].join('\n') + '\n');
    const env = { ...process.env, CAREER_OPS_TRACKER: tmpTracker };
    const before = readFileSync(tmpTracker, 'utf-8');

    const helpOut = run('node', [join(ROOT, 'dedup-tracker.mjs'), '--help'], { env, cwd: ROOT });
    if (helpOut && /--dry-run/.test(helpOut) && readFileSync(tmpTracker, 'utf-8') === before) {
      pass('dedup-tracker --help prints usage and writes nothing');
    } else {
      fail('dedup-tracker --help did not behave as a help flag');
    }

    let refused = false;
    try {
      execFileSync('node', [join(ROOT, 'dedup-tracker.mjs'), '--not-a-flag'],
        { env, cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      refused = e.status === 2;
    }
    if (refused && readFileSync(tmpTracker, 'utf-8') === before) {
      pass('dedup-tracker refuses an unrecognised flag (exit 2) and writes nothing');
    } else {
      fail('dedup-tracker did not refuse an unrecognised flag — a typo can rewrite the tracker');
    }
    rmSync(dirname(tmpTracker), { recursive: true, force: true });
  }

  // verify-pipeline's duplicate warning keyed on company + title alone, so two Zillow reqs
  // sharing a title (P732510, P711740) read as a duplicate on every run (2026-10-20). Rows
  // with disjoint requisition ids are provably distinct; rows without ids still warn.
  {
    const dir = mkdtempSync(join(tmpdir(), 'co-verify-dupes-'));
    mkdirSync(join(dir, 'reports'));
    const wd = (id) => `**URL:** https://acme.wd5.myworkdayjobs.com/External/job/Remote-USA/ML-Engineer_${id}\n`;
    writeFileSync(join(dir, 'reports', '1.md'), wd('JR1000101'));
    writeFileSync(join(dir, 'reports', '2.md'), wd('JR1000202'));
    writeFileSync(join(dir, 'reports', '3.md'), '**URL:** https://beta.example/careers\n');
    writeFileSync(join(dir, 'reports', '4.md'), '**URL:** https://beta.example/careers\n');
    // Disjoint but NOT comparable: a Greenhouse id and a company-hosted id can be one posting.
    writeFileSync(join(dir, 'reports', '5.md'), '**URL:** https://job-boards.greenhouse.io/gamma/jobs/1234567\n');
    writeFileSync(join(dir, 'reports', '6.md'), '**URL:** https://gamma.example/careers/jobs/7654321\n');
    writeFileSync(join(dir, 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-10-01 | Acme | ML Engineer | 3.0/5 | SKIP | ❌ | [1](reports/1.md) | n |',
      '| 2 | 2026-10-02 | Acme | ML Engineer | 3.0/5 | SKIP | ❌ | [2](reports/2.md) | n |',
      '| 3 | 2026-10-03 | Beta | Designer | 3.0/5 | SKIP | ❌ | [3](reports/3.md) | n |',
      '| 4 | 2026-10-04 | Beta | Designer | 3.0/5 | SKIP | ❌ | [4](reports/4.md) | n |',
      '| 5 | 2026-10-05 | Gamma | Engineer | 3.0/5 | SKIP | ❌ | [5](reports/5.md) | n |',
      '| 6 | 2026-10-06 | Gamma | Engineer | 3.0/5 | SKIP | ❌ | [6](reports/6.md) | n |',
    ].join('\n') + '\n');
    const out = run('node', [join(ROOT, 'verify-pipeline.mjs')],
      { env: { ...process.env, CAREER_OPS_TRACKER: join(dir, 'applications.md') }, cwd: ROOT }) || '';
    if (!/Possible duplicates: #1, #2/.test(out) && /Possible duplicates: #3, #4/.test(out)
        && /Possible duplicates: #5, #6/.test(out)) {
      pass('verify-pipeline flags a same-title pair only when its req ids do not tell them apart');
    } else {
      fail(`verify-pipeline duplicate check wrong: ${(out.match(/Possible duplicates.*/g) || ['none']).join('; ')}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // ── Score units: the tracker states FINAL, not BASE ───────────────
  // board-recompute.mjs and audit-scores.mjs both compared the tracker's score
  // against `base` while the tracker records `final = base * comp * pref * arr`.
  // Every modifier read as drift, producing a standing "11 of 25 actionable
  // leads fall below 4.0" on a board that was correct, plus a bogus suggestion
  // to lower the cutoff to ~3.88. This pins the two units apart so a future
  // change cannot quietly conflate them again.
  const { applyModel: am, MODEL: M } =
    await import(pathToFileURL(join(ROOT, 'score-model.mjs')).href);
  // Inline preferences, NOT loadPrefs('config'): config/profile.yml is
  // git-ignored user data, so on a fresh clone or in CI it does not exist,
  // prefFactor collapses to 1.0, and this test silently degraded to a no-op —
  // warning instead of asserting in exactly the environment CI runs in.
  // loadPrefs returns [RegExp, weight] pairs, longest name first.
  const unitPrefs = [[/^ExampleCo/i, 1.0]];
  const baseScore = 3.95;
  const modelled = am(baseScore, {
    company: 'ExampleCo', role: 'Senior Software Engineer, Agentic Engineering',
    prefs: unitPrefs, text: 'Remote, US',
  });
  if (modelled && Number.isFinite(modelled.final)) {
    pass('applyModel returns a finite final score');
    if (modelled.final !== modelled.base) {
      pass(`final differs from base when a modifier applies (${modelled.base} -> ${modelled.final})`);
    } else {
      warn('no modifier applied for this fixture — units test is weaker than intended');
    }
    // The concrete failure the units bug produced: a row that clears 4.0 on
    // final but not on base. Comparing base to the 4.0 line drops it wrongly.
    if (modelled.final >= 4.0 && baseScore < 4.0) {
      pass('a row can clear the 4.0 line on final while its base is under — base must not be compared to that line');
    } else {
      warn(`fixture did not straddle the 4.0 line (base ${baseScore}, final ${modelled.final})`);
    }
  } else {
    fail('applyModel did not return a usable result for the units fixture');
  }
  // Work arrangement: the "City ST" fallback must not require a comma. Real
  // reports write both forms, and requiring the comma left 29 reports with a
  // clear office location classified `unknown` — which scores an onsite role
  // with a neutral arrFactor, i.e. as if it were remote.
  const { arrangement: arr } = await import(pathToFileURL(join(ROOT, 'score-model.mjs')).href);
  const arrCases = [
    ['Costa Mesa CA ~20mi — PASS (ideal commute)', 'onsite', 'no comma before the state code'],
    ['Santa Clara, CA', 'onsite', 'comma form still works'],
    ['US, CA, Remote', 'remote', 'remote wins over any city mention'],
    ['Remote - United States (HQ in Santa Clara CA)', 'remote', 'a remote role naming an HQ stays remote'],
    ['Hybrid, 3 days/week in Irvine CA', 'hybrid', 'hybrid wins over the city fallback'],
    // "West LA" parses as city + Louisiana. Both readings are an office, so
    // onsite is right either way — but the state part must be a real state-code
    // list, or "Vision Products HQ" matches on the same shape.
    ['Los Angeles (West LA HQ)', 'onsite', 'LA is a state code and the city abbreviation; both mean an office'],
    ['Vision Products HQ', 'unknown', 'HQ is not a state code — a bare [A-Z]{2} would have matched'],
    ['Applied AI', 'unknown', 'AI is not a state code'],
    ['Fully distributed', 'remote', 'distributed reads as remote'],
    ['', 'unknown', 'empty'],
  ];
  for (const [text, expected, why] of arrCases) {
    const got = arr(text);
    if (got === expected) pass(`arrangement: ${JSON.stringify(text.slice(0, 40))} → ${expected} (${why})`);
    else fail(`arrangement mismatch: ${JSON.stringify(text)} → got ${got}, want ${expected} (${why})`);
  }

  // The comp floor is a CANDIDATE fact and lives in config/profile.yml. It used to be
  // a literal in score-model.mjs, and a literal there is one person's walk-away number
  // shipped to everyone. Guard the structure, not a value: the model may read a floor,
  // never hard-code one.
  {
    const smSrc = readFileSync(join(ROOT, 'score-model.mjs'), 'utf-8');
    if (/COMP_FLOOR:\s*\d/.test(smSrc)) {
      fail('score-model.mjs hard-codes a comp floor; it must come from config/profile.yml');
    } else if (M.COMP_FLOOR === null || M.COMP_FLOOR > 0) {
      pass(`comp floor comes from config (${M.COMP_FLOOR === null ? 'none configured, so no gate' : '$' + M.COMP_FLOOR + 'K'})`);
    } else {
      fail(`comp floor is neither configured nor absent: ${M.COMP_FLOOR}`);
    }
  }

  // ── scan-history records the location the FILTER saw ──────────────
  // A multi-site Workday posting arrives as "5 Locations" and the provider
  // resolves it before filtering. Recording the raw placeholder left history
  // stating something the decision never used, and made _locaudit.mjs — which
  // replays this file — report every enriched row as an unresolved `unknown`.
  {
    const withLocations = formatScanHistoryRow({
      url: 'https://example.com/j/1', source: 'workday', title: 'Senior Engineer',
      company: 'NVIDIA', location: '5 Locations',
      locations: ['US, CA, Remote', 'US, CA, Santa Clara'],
    }, '2026-08-13').split('\t');
    const withoutLocations = formatScanHistoryRow({
      url: 'https://example.com/j/2', source: 'greenhouse', title: 'Technical Artist',
      company: 'Acme', location: 'Irvine, CA',
    }, '2026-08-13').split('\t');

    if (withLocations[6] === 'US, CA, Remote | US, CA, Santa Clara') {
      pass('scan-history records the resolved option list, not the "N Locations" placeholder');
    } else {
      fail(`scan-history kept the placeholder: ${JSON.stringify(withLocations[6])}`);
    }
    if (withoutLocations[6] === 'Irvine, CA') {
      pass('scan-history falls back to the raw location when no option list exists');
    } else {
      fail(`scan-history fallback wrong: ${JSON.stringify(withoutLocations[6])}`);
    }
  }

  // ── Tracker dedup: canonical company/role keys ────────────────────
  // portals.yml decorates company names; the tracker stores plain ones. The old
  // exact key therefore missed 23 of 362 rows on the 2026-08-11 scan, and
  // already-evaluated roles came back as new every time.
  const { canonicalCompany, canonicalRole } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const canonCases = [
    ['company', 'Crunchyroll (Sony) — Applied AI (LA hybrid)', 'crunchyroll'],
    ['company', 'Anduril Industries — Costa Mesa (defense-AI / real-time 3D)', 'anduril industries'],
    ['company', 'SentinelOne (AI Developer Experience / enablement) [REMOTE-US]', 'sentinelone'],
    ['company', 'NVIDIA', 'nvidia'],
    // A dash INSIDE a parenthetical used to cut the string mid-paren (2026-10-23).
    ['company', 'Zillow (Agentic AI org \u2014 Zillow AI Copilot) [REMOTE-US]', 'zillow'],
    ['company', 'Grafana Labs (Senior AI Engineer \u2014 multi-agent) [REMOTE-US]', 'grafana labs'],
    ['company', 'Future / future.co (Applied AI Engineer \u2014 agents + eval) [REMOTE-US]', 'future'],
    ['company', 'Appian Corporation', 'appian'],
    ['company', 'ThirdLaw Inc', 'thirdlaw'],
    ['role', 'Senior AI Platform & Tools Engineer', 'senior ai platform and tools engineer'],
    ['role', 'Senior AI Platform and Tools Engineer', 'senior ai platform and tools engineer'],
    ['role', 'Staff Software Engineer, DevEx - VALORANT (REQ-0645134)', 'staff software engineer devex valorant'],
    ['role', 'Staff Software Engineer, DevEx - VALORANT', 'staff software engineer devex valorant'],
    // The tracker records a Greenhouse or Riot id as a BARE number; a board title
    // carries none. Missing this form brought 33 tracked roles back as new.
    ['role', 'Staff Software Engineer - Test Systems & Tooling (5349405250)', 'staff software engineer test systems and tooling'],
    ['role', 'Technical Art Lead, Rigging - VALORANT, Agents (8102471)', 'technical art lead rigging valorant agents'],
    // A parenthetical that CONTAINS an id goes whole, team label included.
    ['role', 'Senior Technical Marketing Engineer - Content Specialist (Industrial Engineering, JR2878530)', 'senior technical marketing engineer content specialist'],
    ['role', 'Lead Technical Artist (26WD145751)', 'lead technical artist'],
    ['role', 'Principal Machine Learning Engineer (P711740)', 'principal machine learning engineer'],
    // A facet suffix is part of the id, or it survives as a stray "1" in the key.
    ['role', 'Senior Engineer - JR2292444-1', 'senior engineer'],
    // A parenthetical WITHOUT an id is part of the title. The old `r` branch
    // stripped any word starting with r, so these two collapsed into one key.
    ['role', 'Technical Artist (Rigging)', 'technical artist rigging'],
    ['role', 'Senior Software Engineer (Robotics)', 'senior software engineer robotics'],
    // A short number in a title is not an id.
    ['role', 'Senior Engineer, Team 2026 Launch (Year 3)', 'senior engineer team 2026 launch year 3'],
  ];
  // A tracked req re-titled on a differently spelled URL is still the tracked req
  // (NVIDIA JR2935363, re-listed as new on 2026-10-23); a different req of the same
  // company is not; a decorated portals.yml name reaches the same key.
  {
    const { loadSeenReqIds, reqIdKey } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
    const tracker = [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-09-26 | NVIDIA | Technical Marketing Engineer - Example (JR1000731) | 4.0/5 | SKIP | x | [1](../reports/none.md) | n |',
    ].join('\n');
    const seen = loadSeenReqIds(tracker);
    const base = 'https://acme.wd5.myworkdayjobs.com/Site/job/US-CA-Santa-Clara/';
    const hit = seen.get(reqIdKey('NVIDIA', `${base}Senior-Technical-Marketing-Engineer---Example_JR1000731`));
    const miss = seen.get(reqIdKey('NVIDIA', `${base}Senior-Technical-Marketing-Engineer---Example_JR1000732`));
    const decorated = seen.get(reqIdKey('NVIDIA (Omniverse) [REMOTE-US]', `${base}X_JR1000731`));
    if (hit?.num === '1' && !miss && decorated?.num === '1') {
      pass('scan dedups a tracked req by requisition id across a re-title and a changed URL');
    } else {
      fail(`scan req-id dedup: hit=${JSON.stringify(hit)} miss=${JSON.stringify(miss)} decorated=${JSON.stringify(decorated)}`);
    }
    // An employer-unique id ignores the company spelling; a tenant-local one never does.
    const g = 'https://www.google.com/about/careers/applications/jobs/results/114723757451217499-example';
    const sameG = reqIdKey('Google / Alphabet (DeepMind, Pixel)', g) === reqIdKey('Google', g);
    const wd = `${base}X_R1000731`;
    const splitWd = reqIdKey('Acme', wd) !== reqIdKey('Other Co', wd);
    if (sameG && splitWd) pass('scan keys a Google id across company spellings and a bare Workday id per company');
    else fail(`scan global-id key: google same=${sameG} workday split=${splitWd}`);
  }
  // A title match must not override a requisition conflict. A live req was dropped
  // every scan as a tracked row that is a different req with the same title. Both carry ids and share none, so the posting is new; a
  // posting or a row with no id still falls back to the title.
  {
    const { loadSeenCompanyRoles, titleDupOf } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
    const { extractJobId } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);
    const tracker = [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 7 | 2026-10-13 | CrowdStrike | Sr. AI Agent Developer (Remote) (R37811) | 3.8/5 | Discarded | x | [7](../reports/none.md) | n |',
      '| 8 | 2026-10-13 | Acme | Staff Agent Engineer | 3.0/5 | SKIP | x | [8](../reports/none.md) | n |',
    ].join('\n');
    const seen = loadSeenCompanyRoles(tracker);
    const cs = `${canonicalCompany('CrowdStrike')}::${canonicalRole('Sr. AI Agent Developer (Remote)')}`;
    const base = 'https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---Remote/';
    const other = titleDupOf(seen, cs, extractJobId(`${base}Example-Role-A_R21535`));
    const same = titleDupOf(seen, cs, extractJobId(`${base}Example-Role-B_R37811`));
    const noId = titleDupOf(seen, cs, null);
    const acme = `${canonicalCompany('Acme')}::${canonicalRole('Staff Agent Engineer')}`;
    const rowNoId = titleDupOf(seen, acme, 'R12345');
    if (!other && same?.num === '7' && noId?.num === '7' && rowNoId?.num === '8') {
      pass('scan title dedup yields to a requisition conflict (a different req with the same title is new)');
    } else {
      fail(`scan title dedup vs req conflict: other=${other?.num} same=${same?.num} noId=${noId?.num} rowNoId=${rowNoId?.num}`);
    }
  }
  for (const [kind, input, expected] of canonCases) {
    const got = kind === 'company' ? canonicalCompany(input) : canonicalRole(input);
    if (got === expected) pass(`canonical ${kind}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`);
    else fail(`canonical ${kind} mismatch: ${JSON.stringify(input)} → got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  }
  // The known hazard: stripping req ids collapses distinct reqs that share a
  // title. This asserts the collapse HAPPENS, so the behaviour is deliberate and
  // documented rather than discovered later. The collapse is now answered by
  // titleDupOf() (case above), which lets a requisition conflict override it; the
  // already-evaluated.tsv log alone was not a safeguard, since nobody reads it.
  if (canonicalRole('Senior Engineer - AI Agents and Systems (JR2462112)')
      === canonicalRole('Senior Engineer - AI Agents and Systems (JR2525326)')) {
    pass('canonical role collapses same-title different-req pairs (logged, not silently dropped)');
  } else {
    fail('canonical role no longer collapses same-title reqs — update the already-evaluated logging rationale');
  }

  // ── Title filter: word boundaries and known false negatives ───────
  // The title filter drops ~97% of every scan and logged nothing, so its
  // mistakes were invisible. Replaying it over the roles actually evaluated
  // showed 224 of 392 rejected, including one that reached interview.
  // These cases pin the specific failures.
  const { buildTitleFilter: makeTitle } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const titlePass = makeTitle({
    positive: ['Technical Artist', 'Rigging', 'Agent*', 'Eval*', 'AI Engineer*',
      'Technical Marketing', 'Applied AI', 'Pipeline', 'Graphics', 'Forward Deployed',
      'Solutions Architect'],
    negative: ['Intern', 'Sales', 'Sales Director', 'Product Marketing', 'Advertis*', 'Finance'],
    override: ['Solutions Architect', 'Applied AI'],
    override_lifts: ['Sales'],
  });
  const titleCases = [
    // 2026-10-29: a space in a keyword matches a hyphen, and an override lifts a veto
    // (a profile may want technical pre-sales architects in scope) but never stands in for a positive.
    ['Forward-Deployed Engineer, AI', true, '"Forward Deployed" matches the hyphenated spelling'],
    ['Pre-Sales Solutions Architect, Agentic AI', true, 'the override lifts the "Sales" veto'],
    ['Sales Engineer', false, 'a sales title with no override still goes'],
    ['Sales Director, Solutions Architect Team', false, 'a sales-function negative is never lifted'],
    ['Applied AI Intern', false, 'an override never lifts an early-career veto'],
    ['Applied AI Sales Intern', false, 'a liftable veto beside an unliftable one still vetoes'],
    // Word boundaries: substring matching ate these.
    ['Internal Tools Engineer, Pipeline', true, '"Intern" must not match "Internal"'],
    // Carries a positive ("Pipeline") so this isolates the veto: the only way
    // it can fail is "Sales" matching inside "Salesforce".
    ['Pipeline Engineer, Salesforce Data', true, '"Sales" must not match "Salesforce"'],
    ['Software Engineering Intern', false, 'a real internship still goes'],
    // Stems cover the inflected forms the noun-only keyword missed.
    ['Senior Software Engineer, Agentic Engineering', true, '"Agent*" covers Agentic'],
    ['Software Engineer 5 - Agent Platform', true, '"Agent*" covers Agent'],
    ['Research Engineer, Model Evaluations', true, '"Eval*" covers Evaluations'],
    ['Senior Software Engineer, AI Engineering', true, '"AI Engineer*" covers AI Engineering'],
    // The one that matters most: bare "Marketing" rejected an engineering title.
    ['Senior Technical Marketing Engineer', true, 'a Technical Marketing Engineer title must pass'],
    ['Product Marketing Manager, Games', false, 'actual marketing roles still go'],
    // Stem negatives still work.
    ['Staff Engineer, Advertising Platform', false, '"Advertis*" covers Advertising'],
    // A craft keyword must not drag in a business function.
    ['Senior Financial Analyst - Graphics Finance', false, '"Finance" beats the "Graphics" match'],
  ];
  for (const [title, expected, why] of titleCases) {
    if (titlePass(title) === expected) pass(`title filter: ${JSON.stringify(title)} → ${expected ? 'keep' : 'drop'} (${why})`);
    else fail(`title filter mismatch: ${JSON.stringify(title)} should ${expected ? 'pass' : 'fail'} — ${why}`);
  }

  // ── Three-way location policy (accept / reject / unknown) ──────────
  // The boolean filter above cannot express "unknown", which is the whole
  // point of the rewrite: an unresolved multi-location posting must be
  // reported for triage, never guessed in either direction.
  // Self-contained config so this runs in a clean checkout with no portals.yml
  // (that file is user-layer). It mirrors the shipped policy on every axis these
  // cases exercise. Note what is deliberately NOT here: bare "Ontario" in
  // blocked_geo, which used to reject Ontario, California, a Southern California city.
  const exampleDecide = buildLocationDecider({
    remote_signals: ['remote'],
    us_wide_signals: ['united states', 'usa', 'u.s.', 'us'],
    california_signals: ['california', 'ca'],
    us_state_signals: ['california', 'ca', 'washington', 'wa', 'new york', 'ny',
      'north carolina', 'nc', 'texas', 'tx', 'oregon', 'or', 'arizona', 'az',
      'georgia', 'ga', 'alabama', 'al'],
    socal_signals: ['los angeles', 'orange county', 'irvine', 'fullerton', 'long beach',
      'anaheim', 'glendale', 'burbank', 'culver city', 'playa vista', 'santa monica',
      'el segundo', 'costa mesa', 'pasadena', 'torrance', 'hawthorne', 'ontario, ca'],
    blocked_geo: ['united kingdom', 'london', 'canada', 'quebec', 'toronto', 'emea',
      'bangalore', 'india', 'noida', 'ireland', 'dublin', 'argentina', 'buenos aires'],
    hard_out_metro: ['san francisco', 'santa clara', 'new york', 'bellevue', 'cary',
      'seattle', 'austin', 'hillsboro', 'san jose'],
    review_metro_companies: ['NVIDIA'],
  });

  // [input, expected verdict, why, meta]
  const decisionCases = [
    // Workday placeholders carry no geography and MUST NOT be guessed. This is
    // the defect that made the filter a no-op on 40% of NVIDIA's board.
    ['5 Locations', 'unknown', 'unresolved multi-location placeholder'],
    ['2 Locations', 'unknown', 'unresolved multi-location placeholder'],
    ['', 'unknown', 'no location given'],
    ['Kathmandu', 'unknown', 'unrecognized place, must not be guessed either way'],

    // Structured option lists, post-enrichment. Same primary, opposite answers:
    // the sibling locations are the deciding evidence, which is why the
    // provider fetches them instead of parsing the URL slug.
    [['US, CA, Santa Clara', 'US, TX, Austin', 'US, OR, Hillsboro', 'US, WA, Seattle'],
      'reject', 'JR2134145 — every option onsite and out'],
    [['US, CA, Remote', 'US, GA, Remote', 'US, CA, Santa Clara'],
      'accept', 'JR2391853 — CA-remote sibling makes it workable'],

    // Bare "CA" is both California and the Canada country code.
    ['Toronto, CA', 'reject', 'CA is Canada here'],
    ['CA - Canada', 'reject', 'CA is Canada here'],
    // Diacritics must not manufacture a word boundary: "Montréal" split into
    // "montré" + "al" and matched the Alabama state code, inventing a US signal.
    ['Montréal, Québec, Canada', 'reject', 'accented form behaves like the plain one'],
    ['Montreal, Quebec, Canada', 'reject', 'plain form'],

    // City names repeat across states.
    ['Glendale, AZ', 'reject', 'Arizona, not the SoCal Glendale'],
    ['Glendale, CA', 'accept', 'the SoCal one'],
    ['Ontario, Canada', 'reject', 'the province'],
    ['Ontario, CA', 'accept', 'Ontario, California — must not be blocked as the province'],

    // Options are independent; flattening used to lose the association.
    ['Remote, Washington, USA; Santa Clara, CA', 'reject', 'the remote option is WA-scoped'],
    ['London, UK | Los Angeles, CA', 'accept', 'one workable option is enough'],
    // An incidental foreign mention must not outrank an explicit US-remote offer.
    ['Remote, US (occasional travel to London)', 'accept', 'a US job that mentions London'],

    // Unenumerated foreign geography.
    ['Noida', 'reject', 'foreign'],
    ['Dublin, Ireland', 'reject', 'foreign'],
    ['Remote, Argentina', 'reject', 'foreign-scoped remote'],

    // Employers that post an HQ metro for distributed teams.
    ['US, CA, Santa Clara', 'unknown', 'NVIDIA metro is a question, not an answer', { company: 'NVIDIA' }],
    ['US, CA, Santa Clara', 'reject', 'no review policy for other employers', { company: 'Roblox' }],
    ['Bengaluru, India', 'reject', 'review policy must never rescue a foreign location', { company: 'NVIDIA' }],
  ];
  for (const [input, expected, why, meta] of decisionCases) {
    const got = exampleDecide(input, meta || {}).verdict;
    const label = Array.isArray(input) ? `[${input.join(' + ')}]` : JSON.stringify(input);
    if (got === expected) pass(`location verdict: ${label} → ${expected} (${why})`);
    else fail(`location verdict mismatch: ${label} → got ${got}, want ${expected} (${why})`);
  }

  if (
    shouldDedupScanHistoryRow({ firstSeen: '2026-06-01', status: 'added' }, { recheckAfterDays: 30, today: '2026-06-10' }) === true &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-05-01', status: 'added' }, { recheckAfterDays: 30, today: '2026-06-10' }) === false &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-02-31', status: 'added' }, { recheckAfterDays: 30, today: '2026-06-10' }) === true &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-05-01', status: 'skipped_blocked_host' }, { recheckAfterDays: 30, today: '2026-06-10' }) === true &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-05-01', status: 'added' }, { today: '2026-06-10' }) === true &&
    scanScript.includes('Recheck eligible:')
  ) {
    pass('scan-history TTL rechecks old added URLs while permanent statuses stay deduped');
  } else {
    fail('scan-history TTL policy did not match expected recheck/permanent behavior');
  }

  const hostileOffer = {
    url: 'https://jobs.example.com/123|evil\nhttps://evil.example/later',
    source: 'local-parser',
    title: 'Senior Engineer | Growth\n- [ ] https://evil.example/job | EvilCorp | Injected',
    company: '=ACME\\Corp\t| R&D',
    location: '@Remote\nEU',
  };
  const pipelineRow = formatPipelineOffer(hostileOffer);
  const pendingLines = pipelineRow.split('\n').filter(line => /^\s*- \[ \] https?:\/\//.test(line));
  const pipelineFields = pipelineRow.split('|').map(part => part.trim());
  if (
    pendingLines.length === 1 &&
    pipelineFields.length === 3 &&
    pipelineFields[0] === '- [ ] https://jobs.example.com/123%7Cevil' &&
    !pipelineRow.includes('\n') &&
    !pipelineRow.includes('\t') &&
    !pipelineRow.includes('\\|') &&
    pipelineRow.includes('=ACME\\\\Corp / R&D') &&
    pipelineRow.includes('- \\[ \\] https://evil.example/job / EvilCorp / Injected')
  ) {
    pass('scan pipeline writer preserves row shape without injected checkboxes or extra pipes');
  } else {
    fail(`scan pipeline metadata sanitizer produced unsafe row: ${pipelineRow}`);
  }

  const historyRow = formatScanHistoryRow(hostileOffer, '2026-06-18');
  const historyColumns = historyRow.split('\t');
  if (
    historyColumns.length === 7 &&
    !historyColumns.some(col => /[\r\n\t]/.test(col)) &&
    historyColumns[0] === 'https://jobs.example.com/123|evil' &&
    historyColumns[3].includes('- [ ] https://evil.example/job') &&
    historyColumns[4] === "'=ACME\\Corp | R&D" &&
    historyColumns[6] === "'@Remote EU"
  ) {
    pass('scan-history writer preserves row shape and neutralizes spreadsheet formulas');
  } else {
    fail(`scan-history metadata sanitizer produced unsafe TSV row: ${JSON.stringify(historyColumns)}`);
  }

  // ── content_filter (#734) ──
  // Absent config → all jobs pass.
  const noContentFilter = buildContentFilter(null);
  if (noContentFilter('any description') === true && noContentFilter('') === true) {
    pass('content_filter absent → all jobs pass');
  } else {
    fail('content_filter absent should pass all jobs');
  }

  // Empty / missing description always passes (providers without descriptions
  // must never be silently dropped).
  const cf = buildContentFilter({ positive: ['rust'], negative: ['php'] });
  if (cf('') === true && cf('   ') === true && cf(undefined) === true && cf(null) === true && cf(42) === true) {
    pass('content_filter passes empty/missing/non-string descriptions');
  } else {
    fail('content_filter should pass empty/missing/non-string descriptions');
  }

  // Negative keyword present → reject (even if a positive also matches).
  if (cf('We build in PHP and Rust') === false && cf('Legacy PHP shop') === false) {
    pass('content_filter rejects descriptions containing a negative keyword');
  } else {
    fail('content_filter should reject negative-keyword descriptions');
  }

  // Positive required when positive list is non-empty.
  if (cf('We write everything in Rust') === true && cf('A Python and Go team') === false) {
    pass('content_filter requires a positive keyword when positives are set');
  } else {
    fail('content_filter should require a positive keyword');
  }

  // Positive empty → pass after clearing negatives.
  const negOnly = buildContentFilter({ negative: ['wordpress'] });
  if (negOnly('Modern TypeScript stack') === true && negOnly('WordPress maintenance') === false) {
    pass('content_filter with only negatives blocks them and passes the rest');
  } else {
    fail('content_filter negative-only behavior wrong');
  }

  // Case-insensitive.
  const caseCf = buildContentFilter({ positive: ['Kubernetes'] });
  if (caseCf('deploys on KUBERNETES daily') === true) {
    pass('content_filter matches case-insensitively');
  } else {
    fail('content_filter should be case-insensitive');
  }

} catch (e) {
  fail(`always_allow tests crashed: ${e.message}`);
}
// ── 12. FOLLOW-UP CADENCE LOGIC ─────────────────────────────────

console.log('\n12. Follow-up cadence logic');

try {
  const cadence = await import(pathToFileURL(join(ROOT, 'followup-cadence.mjs')).href);

  // CLI regression: the import.meta.url guard must still let the module run as a CLI.
  // Data-independent — default mode emits the result as JSON: a `metadata` object when
  // the tracker has applications, or an `{error}` object (exit 1) when it is empty.
  // Empty output would mean the guard wrongly suppressed main().
  let cliOut = '';
  try {
    cliOut = execFileSync(NODE, [join(ROOT, 'followup-cadence.mjs')], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
  } catch (cliErr) {
    cliOut = `${cliErr.stdout || ''}`; // exit 1 on an empty tracker is expected; keep stdout
  }
  let cliJson = null;
  try { cliJson = JSON.parse(cliOut.trim()); } catch { /* leave null → fail below */ }
  if (cliJson && typeof cliJson === 'object' && ('metadata' in cliJson || 'error' in cliJson)) {
    pass('CLI still executes under the import.meta.url guard (emits result JSON)');
  } else {
    fail('CLI produced no structured JSON when run directly — import.meta.url guard may be broken');
  }

  // Date helpers
  if (cadence.addDays(cadence.parseDate('2026-05-01'), 7) === '2026-05-08') {
    pass('addDays advances a parsed date by N days (UTC)');
  } else {
    fail(`addDays produced ${cadence.addDays(cadence.parseDate('2026-05-01'), 7)}`);
  }
  if (cadence.daysBetween(cadence.parseDate('2026-05-01'), cadence.parseDate('2026-05-08')) === 7) {
    pass('daysBetween counts whole days between two dates');
  } else {
    fail('daysBetween miscounted');
  }
  if (cadence.parseDate('not-a-date') === null && cadence.parseDate('2026-05-01') instanceof Date) {
    pass('parseDate rejects malformed input and accepts ISO dates');
  } else {
    fail('parseDate validation wrong');
  }

  // parseAppliedDate — extracts the real submission date from notes (the
  // tracker `date` column is the evaluation date), case-insensitive.
  if (cadence.parseAppliedDate('Applied 2026-06-09 via Personio; raised part-time') === '2026-06-09') {
    pass('parseAppliedDate extracts "Applied YYYY-MM-DD" from notes');
  } else {
    fail(`parseAppliedDate got ${JSON.stringify(cadence.parseAppliedDate('Applied 2026-06-09 via Personio; raised part-time'))}`);
  }
  if (cadence.parseAppliedDate('APPLIED 2026-06-17 (German CV; jobId=104170)') === '2026-06-17') {
    pass('parseAppliedDate is case-insensitive (APPLIED)');
  } else {
    fail('parseAppliedDate should match uppercase APPLIED');
  }
  // First "Applied" date wins even when a later status date follows.
  if (cadence.parseAppliedDate('Applied 2026-06-09. No response; discarded 2026-06-18.') === '2026-06-09') {
    pass('parseAppliedDate takes the first applied date, not a later status date');
  } else {
    fail('parseAppliedDate should take the first applied date');
  }
  if (cadence.parseAppliedDate('On-archetype fit; no submission yet') === null && cadence.parseAppliedDate('') === null) {
    pass('parseAppliedDate returns null when notes carry no applied date');
  } else {
    fail('parseAppliedDate should return null without an applied date');
  }
  // "reapplied" must not be mistaken for an applied date (word boundary).
  if (cadence.parseAppliedDate('reapplied 2026-06-09 after rejection') === null) {
    pass('parseAppliedDate does not match inside "reapplied"');
  } else {
    fail('parseAppliedDate should not match the date inside "reapplied"');
  }

  // Status normalization (strips bold + trailing date, lowercases, maps aliases)
  if (cadence.normalizeStatus('**Applied** 2026-05-01') === 'applied') {
    pass('normalizeStatus strips bold + trailing date and lowercases');
  } else {
    fail(`normalizeStatus produced ${cadence.normalizeStatus('**Applied** 2026-05-01')}`);
  }

  const cadenceTmp = mkdtempSync(join(tmpdir(), 'co-cadence-'));
  const profilePath = join(cadenceTmp, 'profile.yml');
  writeFileSync(profilePath, [
    'followup_cadence:',
    '  applied_first_days: 11',
    '  applied_subsequent_days: 5',
    '  applied_max_followups: 4',
    '  responded_initial_days: 2',
    '  responded_subsequent_days: 6',
    '  interview_thankyou_days: 3',
  ].join('\n'));

  const profileCadence = cadence.resolveCadenceConfig({ profilePath });
  if (
    profileCadence.applied_first === 11 &&
    profileCadence.applied_subsequent === 5 &&
    profileCadence.applied_max_followups === 4 &&
    profileCadence.responded_initial === 2 &&
    profileCadence.responded_subsequent === 6 &&
    profileCadence.interview_thankyou === 3
  ) {
    pass('follow-up cadence reads profile.yml overrides');
  } else {
    fail(`profile cadence override failed: ${JSON.stringify(profileCadence)}`);
  }

  const cliCadence = cadence.resolveCadenceConfig({ profilePath, appliedDays: 9 });
  if (cliCadence.applied_first === 9 && cliCadence.applied_subsequent === 5) {
    pass('follow-up cadence CLI override wins over profile applied_first');
  } else {
    fail(`CLI cadence override failed: ${JSON.stringify(cliCadence)}`);
  }

  const malformedProfile = join(cadenceTmp, 'malformed.yml');
  writeFileSync(malformedProfile, 'followup_cadence: [');
  const fallbackCadence = cadence.resolveCadenceConfig({ profilePath: malformedProfile });
  if (fallbackCadence.applied_first === cadence.DEFAULT_CADENCE.applied_first) {
    pass('follow-up cadence ignores malformed optional profile config');
  } else {
    fail(`malformed profile did not fall back to defaults: ${JSON.stringify(fallbackCadence)}`);
  }

  rmSync(cadenceTmp, { recursive: true, force: true });

  // Urgency decision tree (CADENCE defaults: applied_first=7, max_followups=2, responded_initial=1, interview_thankyou=1)
  const urgencyCases = [
    [['applied', 7, null, 0], 'overdue', 'applied past applied_first → overdue'],
    [['applied', 3, null, 0], 'waiting', 'applied within window → waiting'],
    [['applied', 30, null, 2], 'cold', 'applied at max follow-ups → cold'],
    [['responded', 0, null, 0], 'urgent', 'responded before responded_initial → urgent'],
    [['interview', 1, null, 0], 'overdue', 'interview past thank-you window → overdue'],
  ];
  for (const [args, expected, label] of urgencyCases) {
    const got = cadence.computeUrgency(...args);
    if (got === expected) pass(`computeUrgency: ${label}`);
    else fail(`computeUrgency ${label}: expected ${expected}, got ${got}`);
  }

  // Next follow-up date scheduling
  const nextCases = [
    [['applied', '2026-05-01', null, 0], '2026-05-08', 'first applied follow-up = appDate + applied_first'],
    [['applied', '2026-05-01', null, 2], null, 'cold (max follow-ups) → null'],
    [['interview', '2026-05-01', null, 0], '2026-05-02', 'interview = appDate + interview_thankyou'],
  ];
  for (const [args, expected, label] of nextCases) {
    const got = cadence.computeNextFollowupDate(...args);
    if (got === expected) pass(`computeNextFollowupDate: ${label}`);
    else fail(`computeNextFollowupDate ${label}: expected ${expected}, got ${got}`);
  }
} catch (e) {
  fail(`follow-up cadence module crashed: ${e.message}`);
}

// ── 12. PROVIDERS — Workable ────────────────────────────────────────

console.log('\n12. Provider — workable');

try {
  const workable = (await import(pathToFileURL(join(ROOT, 'providers/workable.mjs')).href)).default;
  const { parseWorkableMarkdown } = await import(pathToFileURL(join(ROOT, 'providers/workable.mjs')).href);

  // detect() — auto-detection from careers_url
  if (workable.id === 'workable') pass('workable.id is "workable"');
  else fail(`workable.id is ${JSON.stringify(workable.id)}`);

  const hit = workable.detect({ name: 'TestCo', careers_url: 'https://apply.workable.com/optimile' });
  if (hit && hit.url === 'https://apply.workable.com/optimile/jobs.md') {
    pass('workable.detect() resolves apply.workable.com/<slug> → /jobs.md feed');
  } else {
    fail(`workable.detect() returned ${JSON.stringify(hit)}`);
  }

  const miss = workable.detect({ name: 'TestCo', careers_url: 'https://example.com/careers' });
  if (miss === null) pass('workable.detect() returns null for non-workable URLs');
  else fail(`workable.detect() should return null, got ${JSON.stringify(miss)}`);

  // parse() — markdown table
  const sampleMd = [
    '# Optimile — All Open Positions',
    '',
    '| Title | Department | Location | Type | Salary | Posted | Details |',
    '|---|---|---|---|---|---|---|',
    '| Senior AI PM | Product | Ghent, Belgium | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/optimile/jobs/view/ABC123.md) |',
    '| Tech Lead | Engineering | Remote | Full-time | — | 2026-03-25 | [View](https://apply.workable.com/optimile/jobs/view/DEF456.md) |',
  ].join('\n');

  const jobs = parseWorkableMarkdown(sampleMd, 'Optimile');
  if (jobs.length === 2) pass('parseWorkableMarkdown extracts 2 jobs from 2-row table');
  else fail(`parseWorkableMarkdown returned ${jobs.length} jobs, expected 2`);

  if (jobs[0]?.title === 'Senior AI PM' && jobs[0]?.location === 'Ghent, Belgium' && jobs[0]?.company === 'Optimile') {
    pass('parseWorkableMarkdown extracts title, location, company correctly');
  } else {
    fail(`parseWorkableMarkdown row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[0]?.url === 'https://apply.workable.com/optimile/jobs/view/ABC123') {
    pass('parseWorkableMarkdown strips .md suffix from job URL');
  } else {
    fail(`parseWorkableMarkdown should strip .md; got url=${JSON.stringify(jobs[0]?.url)}`);
  }

  // Robustness
  if (parseWorkableMarkdown('', 'X').length === 0) pass('empty input → empty result');
  else fail('empty input should yield empty result');

  if (parseWorkableMarkdown(null, 'X').length === 0) pass('null input → empty result (no crash)');
  else fail('null input should yield empty result without crashing');

  // fetch() reaches the http context on the happy path (allowed hostname).
  await workable.fetch(
    { name: 'Smoke', careers_url: 'https://apply.workable.com/optimile' },
    {
      transport: 'http',
      fetchText: async (url) => {
        if (!url.startsWith('https://apply.workable.com/')) {
          throw new Error('fetchText called with unexpected URL');
        }
        return '| Title | Department | Location | Type | Salary | Posted | Details |\n|---|---|---|---|---|---|---|\n';
      },
      fetchJson: async () => { throw new Error('fetchJson should not be called'); },
    },
  );
  pass('workable.fetch() reaches fetchText on the happy path (allowed hostname)');

  // fetch() rejects an unresolvable careers_url (no apply.workable.com match in URL).
  let rejected = false;
  try {
    await workable.fetch(
      { name: 'BadUrl', careers_url: 'https://evil.com/totally-not-workable' },
      {
        transport: 'http',
        fetchText: async () => { throw new Error('SSRF! should not reach here'); },
        fetchJson: async () => { throw new Error('SSRF! should not reach here'); },
      },
    );
  } catch (e) {
    if (e.message.includes('cannot derive feed URL')) {
      rejected = true;
    } else {
      fail(`workable.fetch() rejected with wrong error: ${e.message}`);
    }
  }
  if (rejected) pass('workable.fetch() rejects unresolvable careers_url before fetch');
  else fail('workable.fetch() should throw cannot-derive-feed-URL for non-Workable URLs');

  // SSRF: malicious URL with apply.workable.com in the PATH (not hostname) must not be detected as Workable.
  // With strict URL parsing, the hostname `evil.example` fails the check and detect() returns null.
  if (workable.detect({ name: 'Spoof', careers_url: 'https://evil.example/apply.workable.com/slug' }) === null) {
    pass('workable.detect() rejects path-spoofed URLs (apply.workable.com in path, not hostname)');
  } else {
    fail('workable.detect() must NOT misdetect URLs that contain apply.workable.com in the path');
  }

  // careers_url with non-string value (e.g. YAML mistake passing a number) → detect() returns null without crashing
  if (workable.detect({ name: 'X', careers_url: 42 }) === null) {
    pass('workable.detect() returns null for non-string careers_url (42)');
  } else {
    fail('workable.detect() should treat non-string careers_url as missing');
  }

  // Workable parser tolerates a title with a stray pipe — URL is extracted from the line, not cols[7]
  const strayPipeMd = [
    '| Title | Department | Location | Type | Salary | Posted | Details |',
    '|---|---|---|---|---|---|---|',
    '| Senior PM (full | part-time) | Product | Remote | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/x/jobs/view/PIPE.md) |',
  ].join('\n');
  const strayJobs = parseWorkableMarkdown(strayPipeMd, 'X');
  if (strayJobs.length === 1 && strayJobs[0].url === 'https://apply.workable.com/x/jobs/view/PIPE') {
    pass('parseWorkableMarkdown extracts URL from line-level regex (survives stray pipes in title)');
  } else {
    fail(`stray-pipe row not handled correctly: ${JSON.stringify(strayJobs)}`);
  }

  // Off-domain [View] link is dropped (URL validation)
  const offDomainMd = [
    '| Title | Department | Location | Type | Salary | Posted | Details |',
    '|---|---|---|---|---|---|---|',
    '| Good Role | Product | Remote | Full-time | — | 2026-04-01 | [View](https://apply.workable.com/x/jobs/view/ABC.md) |',
    '| Evil Role | Product | Remote | Full-time | — | 2026-04-01 | [View](https://evil.example/jobs/view/X) |',
    '| Insecure Role | Product | Remote | Full-time | — | 2026-04-01 | [View](http://apply.workable.com/x/jobs/view/Y.md) |',
  ].join('\n');
  const filteredJobs = parseWorkableMarkdown(offDomainMd, 'X');
  if (filteredJobs.length === 1 && filteredJobs[0].title === 'Good Role') {
    pass('parseWorkableMarkdown drops off-domain and non-https [View] links');
  } else {
    fail(`expected only "Good Role" through, got ${JSON.stringify(filteredJobs.map(j => j.title))}`);
  }

} catch (e) {
  fail(`workable provider tests crashed: ${e.message}`);
}




// ── PROVIDERS — Breezy HR ───────────────────────────────────────────

console.log('\nProvider — breezy');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/breezy.mjs')).href);
  const breezy = mod.default;
  const { parseBreezyJobs } = mod;

  if (breezy.id === 'breezy') pass('breezy.id is "breezy"');
  else fail(`breezy.id is ${JSON.stringify(breezy.id)}`);

  const hit = breezy.detect({ name: 'AGBO', careers_url: 'https://agbo.breezy.hr' });
  if (hit && hit.url === 'https://agbo.breezy.hr/json') {
    pass('breezy.detect() resolves {org}.breezy.hr → the /json feed');
  } else {
    fail(`breezy.detect() returned ${JSON.stringify(hit)}`);
  }

  const miss = breezy.detect({ name: 'X', careers_url: 'https://example.com/careers' });
  if (miss === null) pass('breezy.detect() returns null for non-breezy URLs');
  else fail(`breezy.detect() should return null, got ${JSON.stringify(miss)}`);

  const board = [
    { name: 'Technical Artist', url: 'https://agbo.breezy.hr/p/aaa',
      location: { city: 'Los Angeles', state: { name: 'California' }, country: { name: 'United States' } },
      published_date: '2026-08-01T00:00:00Z', salary: '$120k - $150k' },
    { name: 'Remote Rigging Artist', url: 'https://agbo.breezy.hr/p/bbb',
      location: { city: 'Raleigh', state: 'North Carolina' },
      locations: [{ city: 'Los Angeles', state: { name: 'California' } }],
      is_remote: true },
    { name: 'No URL Role' },                      // dropped: no url
    { url: 'https://agbo.breezy.hr/p/ccc' },      // dropped: no name
  ];
  const rows = parseBreezyJobs(board, 'AGBO');
  if (rows.length === 2) pass('parseBreezyJobs drops rows missing a name or url');
  else fail(`parseBreezyJobs returned ${rows.length} rows, expected 2`);

  if (rows[0] && rows[0].location === 'Los Angeles, California, United States') {
    pass('parseBreezyJobs flattens the nested location object');
  } else {
    fail(`parseBreezyJobs location: ${JSON.stringify(rows[0]?.location)}`);
  }

  // `locations` (plural) is Breezy's secondary-location field, and is_remote is often the
  // ONLY remote signal. Reading just the singular location is the silent-discard class
  // that has cost reachable roles in every other adapter here.
  if (rows[1] && /Los Angeles/.test(rows[1].location) && /Remote/.test(rows[1].location)) {
    pass('parseBreezyJobs folds in locations[] and the is_remote flag');
  } else {
    fail(`parseBreezyJobs dropped secondary location or remote flag: ${JSON.stringify(rows[1]?.location)}`);
  }

  if (rows[0] && rows[0].salary === '$120k - $150k') pass('parseBreezyJobs carries the salary string');
  else fail(`parseBreezyJobs salary: ${JSON.stringify(rows[0]?.salary)}`);

  // Breezy answers 200 with [] for ANY subdomain, so an empty board must yield no rows
  // rather than anything that reads as a finding.
  if (parseBreezyJobs([], 'X').length === 0) pass('parseBreezyJobs yields nothing for an empty board');
  else fail('parseBreezyJobs invented rows from an empty board');
} catch (e) {
  fail(`breezy provider tests crashed: ${e.message}`);
}

// ── PROVIDERS: Rippling ATS ────────────────────────────────────────

console.log('\nProvider: rippling');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/rippling.mjs')).href);
  const rippling = mod.default;
  const { parseRipplingJobs } = mod;

  if (rippling.id === 'rippling') pass('rippling.id is "rippling"');
  else fail(`rippling.id is ${JSON.stringify(rippling.id)}`);

  const hit = rippling.detect({ name: 'Layer', careers_url: 'https://ats.rippling.com/layer/jobs' });
  if (hit && hit.url === 'https://api.rippling.com/platform/api/ats/v1/board/layer/jobs') {
    pass('rippling.detect() resolves ats.rippling.com/{slug} to the board API');
  } else {
    fail(`rippling.detect() returned ${JSON.stringify(hit)}`);
  }
  if (rippling.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('rippling.detect() returns null for non-rippling URLs');
  } else {
    fail('rippling.detect() claimed a non-rippling URL');
  }

  // One row per (posting, location): rows sharing a uuid are ONE posting with every location.
  const board = [
    { uuid: 'a1', name: 'Staff Engineer, AI', url: 'https://ats.rippling.com/x/jobs/a1', workLocation: { label: 'San Francisco, CA' } },
    { uuid: 'a1', name: 'Staff Engineer, AI', url: 'https://ats.rippling.com/x/jobs/a1', workLocation: { label: 'Remote (United States)' } },
    { uuid: 'b2', name: 'Rigging TD', url: 'https://ats.rippling.com/x/jobs/b2', workLocation: { label: 'Los Angeles, CA' } },
    { name: 'No URL' },
  ];
  const rows = parseRipplingJobs(board, 'X');
  if (rows.length === 2) pass('parseRipplingJobs folds per-location duplicates and drops rows with no url');
  else fail(`parseRipplingJobs returned ${rows.length} rows, expected 2`);
  if (rows[0] && /San Francisco/.test(rows[0].location) && /Remote/.test(rows[0].location)) {
    pass('parseRipplingJobs keeps every location of a folded posting (a remote entry is not discarded)');
  } else {
    fail(`parseRipplingJobs location: ${JSON.stringify(rows[0]?.location)}`);
  }
  if (parseRipplingJobs([], 'X').length === 0) pass('parseRipplingJobs yields nothing for an empty board');
  else fail('parseRipplingJobs invented rows from an empty board');

  // A missing board answers an error OBJECT; it must throw, not read as an empty board.
  let threw = false;
  try {
    await rippling.fetch({ name: 'Ghost', careers_url: 'https://ats.rippling.com/ghost' },
      { fetchJson: async () => ({ error_code: 'RESOURCE_NOT_FOUND', message: 'Job Board not found' }) });
  } catch { threw = true; }
  if (threw) pass('rippling.fetch() throws on a missing board instead of reporting it empty');
  else fail('rippling.fetch() read an error object as an empty board');
} catch (e) {
  fail(`rippling provider tests crashed: ${e.message}`);
}

// ── PROVIDERS: Eightfold (PCS) ─────────────────────────────────────

console.log('\nProvider: eightfold');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/eightfold.mjs')).href);
  const ef = mod.default;
  const { resolveBoard, parsePage, postingLocations, toJob } = mod;

  if (ef.id === 'eightfold') pass('eightfold.id is "eightfold"');
  else fail(`eightfold.id is ${JSON.stringify(ef.id)}`);

  // The tenant domain is DECLARED (a verified host, or ?domain= on the careers URL) and
  // never derived: explore.jobs.netflix.NET answers to netflix.COM.
  const nf = resolveBoard({ careers_url: 'https://explore.jobs.netflix.net/careers' });
  if (nf && nf.domain === 'netflix.com' && nf.api === 'v2') pass('eightfold: a recorded host resolves to its verified domain, not one derived from the hostname');
  else fail(`eightfold: Netflix host resolved to ${JSON.stringify(nf)}`);
  if (resolveBoard({ careers_url: 'https://acme.eightfold.ai/careers' }) === null) pass('eightfold: an unrecorded host with no declared domain is refused, not guessed');
  else fail('eightfold: derived a tenant domain from an unrecorded hostname');
  const decl = resolveBoard({ careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com' });
  if (decl && decl.domain === 'acme.com' && decl.api === null) pass('eightfold: ?domain= on a /careers URL is a declaration, with the API variant left to probe');
  else fail(`eightfold: declared domain resolved to ${JSON.stringify(decl)}`);
  if (ef.detect({ careers_url: 'https://jobs.netflix.com/careers/games' }) === null
      && ef.detect({ careers_url: 'https://example.com/search?domain=example.com' }) === null) {
    pass('eightfold.detect() claims neither a non-Eightfold Netflix page nor a stray domain parameter');
  } else fail('eightfold.detect() claimed a URL that is not an Eightfold board');

  // A 200 with no positions array is unreadable, never an empty board.
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  if (throws(() => parsePage({}, 'v2')) && throws(() => parsePage({ data: {} }, 'pcsx'))
      && throws(() => parsePage({ status: 200, error: { message: 'Not authorized' }, data: { positions: [] } }, 'pcsx'))) {
    pass('eightfold.parsePage() refuses a body with no positions array or a pcsx error');
  } else fail('eightfold.parsePage() read an unreadable body as a page');

  // Every location is kept, and the remote flag is qualified by each place, never bare.
  const locs = postingLocations({ location: 'Los Gatos,California,United States of America',
    locations: ['Los Gatos,California,United States of America', 'Los Angeles,California,United States of America'],
    work_location_option: 'onsite' });
  if (locs.length === 2 && locs.some((l) => /Los Angeles/.test(l))) pass('eightfold: a secondary location is folded in, not dropped');
  else fail(`eightfold: locations ${JSON.stringify(locs)}`);
  const rl = postingLocations({ locations: ['London,England,United Kingdom', 'Remote, United States'], workLocationOption: 'remote_local' });
  if (rl.includes('London,England,United Kingdom (Remote)') && rl.includes('Remote, United States') && !rl.includes('Remote')) {
    pass('eightfold: the remote flag qualifies each place and adds no bare "Remote" option');
  } else fail(`eightfold: remote folding gave ${JSON.stringify(rl)}`);
  // Microsoft's list payload says `onsite` for every posting; a declared remote-only filter
  // is the remote signal, and must not turn a Redmond-listed remote role into a WA-only one.
  const msBoard = resolveBoard({ careers_url: 'https://apply.careers.microsoft.com/careers?domain=microsoft.com&filter_work_site=0%20days%20%2F%20week%20in-office%20%E2%80%93%20remote' });
  const { filtersDeclareRemote, pageUrl } = mod;
  if (msBoard && msBoard.remoteOnly && pageUrl(msBoard, 'pcsx', 0).includes('&filter_work_site=0%20days')
      && !filtersDeclareRemote([['filter_work_site', '0 days / week in-office – remote'], ['filter_work_site', 'fully on-site']])) {
    pass('eightfold: a filter_* on the careers url is passed through, and is remote-only only when every value says remote');
  } else fail(`eightfold: filter handling gave ${JSON.stringify(msBoard)}`);
  const msLocs = postingLocations({ locations: ['United States, Washington, Redmond', 'India, Karnataka, Bengaluru'], workLocationOption: 'onsite' }, { remoteOnly: true });
  if (msLocs.includes('Remote, United States') && msLocs.includes('India, Karnataka, Bengaluru (Remote)') && !msLocs.includes('Remote')) {
    pass('eightfold: a declared remote-only board reads a US place as remote-US and keeps a foreign place foreign');
  } else fail(`eightfold: remote-only folding gave ${JSON.stringify(msLocs)}`);
  const pj = toJob({ id: 1256963385116965, name: 'Senior SWE', positionUrl: '/careers/job/1256963385116965', locations: ['US'] },
    { origin: 'https://apply.careers.microsoft.com' }, 'Microsoft');
  if (pj && pj.url === 'https://apply.careers.microsoft.com/careers/job/1256963385116965') pass('eightfold: a pcsx posting gets the absolute /careers/job/<id> url');
  else fail(`eightfold: toJob gave ${JSON.stringify(pj)}`);

  // The walk: count latched from page one, pages of 10 until a short page.
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ id: 1000 + from + i, name: `Role ${from + i}`, locations: ['Remote, United States'], work_location_option: 'remote_local' }));
  const ctxFor = (count, sizes, { breakAt = -1 } = {}) => ({
    async fetchJson(url) {
      const start = Number(new URL(url).searchParams.get('start'));
      const idx = start / 10;
      if (idx === breakAt) return { error: 'waf' };
      return { positions: page(sizes[idx] ?? 0, start), count };
    },
  });
  const entry = { name: 'Netflix', careers_url: 'https://explore.jobs.netflix.net/careers' };
  const whole = await ef.fetch(entry, ctxFor(24, [10, 10, 4]));
  if (whole.length === 24 && !whole.truncated) pass('eightfold.fetch() walks every page to a short page and reports the board whole');
  else fail(`eightfold.fetch() read ${whole.length} (truncated=${whole.truncated})`);
  const short = await ef.fetch(entry, ctxFor(30, [10, 10, 4]));
  if (short.length === 24 && /TRUNCATED/.test(short.truncated || '')) pass('eightfold.fetch() reports a walk that read fewer postings than the board count as TRUNCATED');
  else fail(`eightfold.fetch() absorbed a shortfall: ${short.length}, ${short.truncated}`);
  // A posting skipped by offset shift on the first walk is recovered by the second.
  let calls = 0;
  const shiftCtx = {
    async fetchJson(url) {
      const start = Number(new URL(url).searchParams.get('start'));
      calls++;
      const all = page(24, 0);
      // First walk: postings 10..23 served one slot late from page 2 on, so id 1010 is never seen.
      const served = calls <= 3 && start >= 10 ? all.slice(start + 1, start + 11) : all.slice(start, start + 10);
      return { positions: served, count: 24 };
    },
  };
  const healed = await ef.fetch(entry, shiftCtx);
  if (healed.length === 24 && !healed.truncated) pass('eightfold.fetch() recovers an offset-shift skip with one second walk instead of flagging it');
  else fail(`eightfold.fetch() shift recovery: ${healed.length}, ${healed.truncated}`);
  let threw = false;
  try { await ef.fetch(entry, ctxFor(24, [10, 10, 4], { breakAt: 1 })); } catch { threw = true; }
  if (threw) pass('eightfold.fetch() throws on an unreadable mid-walk page instead of ending the board there');
  else fail('eightfold.fetch() read an unreadable page as the end of the board');

  // An unrecorded tenant answering v2 with 403 is a pcsx tenant (Microsoft's shape).
  const asked = [];
  const pcsxCtx = {
    async fetchJson(url) {
      asked.push(new URL(url).pathname);
      if (url.includes('/api/apply/v2/')) { const e = new Error('HTTP 403'); e.status = 403; throw e; }
      const start = Number(new URL(url).searchParams.get('start'));
      return { status: 200, error: { message: '' }, data: { positions: start === 0 ? page(3, 0) : [], count: 3 } };
    },
  };
  const viaPcsx = await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com' }, pcsxCtx);
  if (viaPcsx.length === 3 && asked[0].includes('/api/apply/v2/') && asked[1] === '/api/pcsx/search') pass('eightfold.fetch() falls back to pcsx when an unrecorded tenant refuses v2 with 403');
  else fail(`eightfold.fetch() variant probe: ${viaPcsx.length} jobs, asked ${JSON.stringify(asked)}`);
} catch (e) {
  fail(`eightfold provider tests crashed: ${e.message}`);
}

// ── PROVIDERS — Ashby embedded-board fallback ───────────────────────

console.log('\nProvider — ashby (embedded board fallback)');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/ashby.mjs')).href);
  const { extractAppData, parseEmbeddedBoard } = mod;

  // Ashby's posting API is opt-in per org. An org with it off answers 404 forever while
  // its board is live, and those two states are indistinguishable from outside. Whatnot
  // sat in the websearch handoff bucket for months because of exactly this.
  const html = [
    '<html><body><script>',
    '  window.__appData = {"organization":{"name":"Acme {Inc}"},"jobBoard":{',
    '  "jobPostings":[',
    '    {"id":"aaa","title":"AI Tooling Engineer","locationName":"San Francisco, CA",',
    '     "workplaceType":"Remote","secondaryLocations":[{"locationName":"Los Angeles, CA"}],',
    '     "compensationTierSummary":"$225K - $320K"},',
    '    {"id":"bbb","title":"Account Executive","locationName":"Berlin, Germany",',
    '     "secondaryLocations":[]},',
    '    {"id":"ccc","locationName":"Nowhere"}',
    '  ]}};',
    '</script></body></html>',
  ].join('\n');

  const data = extractAppData(html);
  // The brace matcher must survive a brace INSIDE a JSON string ("Acme {Inc}"), which is
  // the case a naive depth counter gets wrong.
  if (data && data.organization?.name === 'Acme {Inc}') {
    pass('extractAppData brace-matches past braces inside JSON strings');
  } else {
    fail(`extractAppData returned ${JSON.stringify(data)?.slice(0, 80)}`);
  }

  if (extractAppData('<html>no appdata</html>') === null) {
    pass('extractAppData returns null when the page has no __appData');
  } else {
    fail('extractAppData should return null on a page with no __appData');
  }

  const rows = parseEmbeddedBoard(html, 'acme', 'Acme');
  if (rows.length === 2) pass('parseEmbeddedBoard drops title-less postings');
  else fail(`parseEmbeddedBoard returned ${rows.length} rows, expected 2`);

  // Secondary locations decide reachability: this role is only workable because of the
  // Los Angeles entry, which does not appear in locationName.
  if (rows[0] && /Los Angeles/.test(rows[0].location)) {
    pass('parseEmbeddedBoard folds secondaryLocations into the location string');
  } else {
    fail(`parseEmbeddedBoard dropped secondaryLocations: ${JSON.stringify(rows[0]?.location)}`);
  }

  if (rows[0] && rows[0].salary === '$225K - $320K') {
    pass('parseEmbeddedBoard carries the compensation summary');
  } else {
    fail(`parseEmbeddedBoard salary: ${JSON.stringify(rows[0]?.salary)}`);
  }

  if (rows[0] && rows[0].url === 'https://jobs.ashbyhq.com/acme/aaa') {
    pass('parseEmbeddedBoard builds a per-posting URL from the slug and id');
  } else {
    fail(`parseEmbeddedBoard url: ${JSON.stringify(rows[0]?.url)}`);
  }

  if (parseEmbeddedBoard('<html>nothing</html>', 'x', 'X').length === 0) {
    pass('parseEmbeddedBoard yields nothing when the page carries no board');
  } else {
    fail('parseEmbeddedBoard invented rows from a page with no board');
  }

  // The posting API's secondary address: its country must never stand alone as a
  // location option, or every office role with a US address reads as "a country, not a
  // place" (unknown) instead of a far-metro reject (Perplexity, 2026-10-18).
  // Asserted through the GATE, not just the string, since the verdict is what matters.
  const { buildSignals, decideLocations, effectiveLocationFilter, loadLocationPolicy } =
    await import(pathToFileURL(join(ROOT, 'location-core.mjs')).href);
  // A pinned policy with a commute area, never the installed one: the verdicts below need
  // a home state and a far metro, which the neutral fallback does not have.
  const sig = buildSignals(effectiveLocationFilter({},
    loadLocationPolicy(join(ROOT, 'presets', 'locations', 'california-socal.json'))));
  const addr = (location, addressLocality, addressCountry, addressRegion) =>
    ({ location, address: { postalAddress: { addressLocality, addressCountry, addressRegion } } });
  const verdictOf = (...secondaries) => decideLocations(
    mod.formatLocation({ location: 'San Francisco', secondaryLocations: secondaries }), sig).verdict;
  const cases = [
    // The bug: every office far, so a reject, never "a country, not a place".
    [[addr('Seattle', 'Seattle', 'United States'), addr('New York City', 'New York', 'United States')], 'reject'],
    // Verdicts the old shape got right must not move (Codex's probes, 2026-10-18).
    [[addr('Remote, United States', 'New York', 'United States')], 'accept'],
    [[addr('United States', 'Los Angeles', 'United States')], 'accept'],
    [[addr('Remote', undefined, 'United States')], 'accept'],
    // A bare Remote label is qualified by its own address, region included.
    [[addr('Remote', undefined, 'Canada')], 'reject'],
    [[addr('Remote', undefined, 'United States', 'Texas')], 'reject'],
    [[addr('Remote', undefined, 'United States', 'California')], 'accept'],
    // A label that names its country keeps its meaning over an office region.
    [[addr('Remote, United States', undefined, 'United States', 'New York')], 'accept'],
  ];
  const bad = cases.filter(([s, want]) => verdictOf(...s) !== want)
    .map(([s, want]) => `${JSON.stringify(mod.formatLocation({ location: 'San Francisco', secondaryLocations: s }))} -> ${verdictOf(...s)}, want ${want}`);
  if (!bad.length) pass(`ashby formatLocation: ${cases.length} secondary-address shapes reach the right gate verdict`);
  else fail(`ashby formatLocation: ${bad.join(' | ')}`);
} catch (e) {
  fail(`ashby embedded-board tests crashed: ${e.message}`);
}

// ── PROVIDERS: Google careers (embedded results list) ──────────────

console.log('\nProvider: google (careers results page)');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/google.mjs')).href);
  const google = mod.default;
  const { parseResultsPage, locationOptions, walkSearch } = mod;
  const RESULTS = 'https://www.google.com/about/careers/applications/jobs/results/';

  if (google.id === 'google') pass('google.id is "google"');
  else fail(`google.id is ${JSON.stringify(google.id)}`);
  if (google.detect({ name: 'G', careers_url: RESULTS }) && google.detect({ name: 'G', careers_url: RESULTS.slice(0, -1) })
      && !google.detect({ name: 'G', careers_url: 'https://tracker.example/r/www.google.com/about/careers/applications/jobs/results/' })) {
    pass('google.detect() claims the results URL, anchored at the host');
  } else {
    fail('google.detect() routing is wrong');
  }

  // Fixture in the live shape (2026-10-29): ds:0 is a company list, ds:1 the job list
  // [records, null, total, pageSize]; a record is [id, title, ..., [7] company, ...,
  // [9] locations, ..., [16] remote flag, [17], [18] [null, note]].
  const rec = (id, title, locs, { remote = false, note = '', company = 'Google' } = {}) => {
    const r = new Array(21).fill(null);
    r[0] = id; r[1] = title; r[7] = company;
    r[9] = locs.map(([display, cc]) => [display, [display], null, null, null, cc]);
    r[10] = [null, `<p>About ${title}</p>`];
    if (remote) r[16] = 1;
    if (note) r[18] = [null, note];
    return r;
  };
  const page = (records, total, slugs = []) =>
    `<html><script>AF_initDataCallback({key: 'ds:0', hash: '1', data:[[["c","DeepMind","deepmind"]]], sideChannel: {}});</script>`
    + `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify([records, null, total, 20])}, sideChannel: {}});</script>`
    + slugs.map(([id, s]) => `<a href="jobs/results/${id}-${s}?q=&amp;page=1">x</a>`).join('') + '</html>';

  const p = parseResultsPage(page([rec('111111111', 'A', [['Los Angeles, CA, USA', 'US']])], 1, [['111111111', 'a-aiml']]));
  if (p && p.total === 1 && p.records.length === 1 && p.slugs.get('111111111') === 'a-aiml') {
    pass('parseResultsPage finds the job list by shape, with its total and the page\'s own slugs');
  } else {
    fail(`parseResultsPage returned ${JSON.stringify(p && { total: p.total, n: p.records.length })}`);
  }
  if (parseResultsPage('<html>consent</html>') === null) pass('a page with no job list is UNREADABLE (null), not empty');
  else fail('parseResultsPage read a page with no job list as a result');
  const past = parseResultsPage(page(null, 41));
  if (past && past.records.length === 0 && past.total === 41) pass('a page past the end parses as zero records with the total kept');
  else fail('parseResultsPage mishandled the past-the-end page');

  const mixed = locationOptions(rec('2', 'B', [['Kirkland, WA, USA', 'US'], ['California, USA', 'US'], ['Ontario, CA', 'CA']], {
    remote: true,
    note: 'Note: ... from the following:<br><br><b>In-office locations: Kirkland, WA, USA.</b><br><b>Remote location(s): California, USA; Ontario, CA.</b>',
  }));
  if (JSON.stringify(mixed) === JSON.stringify(['Kirkland, WA, USA', 'California, USA - Remote', 'Ontario, Canada - Remote'])) {
    pass('locationOptions marks the note\'s remote places " - Remote", keeps offices plain, and spells out a non-US "CA"');
  } else {
    fail(`locationOptions returned ${JSON.stringify(mixed)}`);
  }
  const single = locationOptions(rec('3', 'C', [['Colorado, USA', 'US']], { remote: true, note: '<b>Remote location: Colorado, USA.</b>' }));
  if (JSON.stringify(single) === JSON.stringify(['Colorado, USA - Remote'])) pass('locationOptions reads the singular "Remote location:" note');
  else fail(`locationOptions (singular note) returned ${JSON.stringify(single)}`);

  // A fake fetchText serving pages by query string.
  const serve = (routes) => ({
    fetchText: async (url) => {
      const u = new URL(url);
      const key = `${u.searchParams.get('has_remote') ? 'R' : 'L'}${u.searchParams.get('page')}`;
      if (!(key in routes)) throw Object.assign(new Error('HTTP 500'), { status: 500 });
      return routes[key];
    },
  });
  const twenty = Array.from({ length: 20 }, (_, i) => rec(String(500000000 + i), `Role ${i}`, [['Irvine, CA, USA', 'US']]));
  const entry = { name: 'Google', careers_url: RESULTS, provider: 'google', google_pause_ms: 0 };
  const jobs = await google.fetch(entry, serve({
    L1: page(twenty, 21, [['500000000', 'role-0']]),
    L2: page([rec('600880921', 'Last', [['Los Angeles, CA, USA', 'US']])], 21),
    R1: page([twenty[0], rec('700000000', 'Remote Role', [['United States', 'US']], { remote: true, note: '<b>Remote location: United States.</b>' })], 2),
  }));
  if (jobs.length === 22 && !jobs.truncated) pass('google.fetch walks every page to the total and dedups across searches by id');
  else fail(`google.fetch returned ${jobs.length} jobs, truncated=${jobs.truncated}`);
  const r0 = jobs.find((j) => j.url.includes('500000000'));
  if (r0 && r0.url === `${RESULTS}500000000-role-0`) pass('a row\'s URL uses the page\'s own slug for the id');
  else fail(`row URL is ${r0 && r0.url}`);
  if (jobs.find((j) => j.title === 'Remote Role')?.location === 'United States - Remote') pass('a remote posting reaches the gate as "<scope> - Remote"');
  else fail('the remote posting lost its remote marker');

  const short = await google.fetch(entry, serve({ L1: page(twenty, 45), L2: page(null, 45), R1: page([], 0) }));
  if (short.length === 20 && /served 20 of 45/.test(short.truncated || '')) pass('a server that runs out of rows before its total marks the result truncated');
  else fail(`short walk: ${short.length} rows, truncated=${short.truncated}`);

  const oneDead = await google.fetch(entry, serve({ L1: page(twenty, 20), R1: '<html>consent</html>' }));
  if (oneDead.length === 20 && /UNREADABLE/.test(oneDead.truncated || '')) pass('one unreadable search is reported, not read as empty, and the rest is kept');
  else fail(`one unreadable search: ${oneDead.length} rows, truncated=${oneDead.truncated}`);

  let threw = false;
  try { await google.fetch(entry, serve({ L1: '<html></html>', R1: '<html></html>' })); } catch { threw = true; }
  if (threw) pass('google.fetch throws when no search could be read, instead of reporting no jobs');
  else fail('google.fetch read an unreadable board as empty');

  const capped = await walkSearch(serve({ L1: page(twenty, 45) }), { q: '', locations: ['Irvine, CA, USA'], remote: false }, { maxPages: 1, pauseMs: 0 });
  if (/^TRUNCATED at 1 pages: 20 of 45/.test(capped.truncated || '')) pass('a walk that hits its page bound says TRUNCATED');
  else fail(`page bound: truncated=${capped.truncated}`);
} catch (e) {
  fail(`google provider tests crashed: ${e.message}`);
}

// ── PROVIDERS — GitHub (github.careers) ─────────────────────────────

console.log('\nProvider — github (github.careers)');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/github.mjs')).href);
  const github = mod.default;
  const { parseGithubJobs } = mod;

  if (github.id === 'github') pass('github.id is "github"');
  else fail(`github.id is ${JSON.stringify(github.id)}`);

  const hit = github.detect({ name: 'GitHub', careers_url: 'https://www.github.careers/careers-home/jobs' });
  if (hit && hit.url === 'https://www.github.careers/api/jobs') {
    pass('github.detect() resolves github.careers → the jobs API');
  } else {
    fail(`github.detect() returned ${JSON.stringify(hit)}`);
  }

  const miss = github.detect({ name: 'X', careers_url: 'https://boards.greenhouse.io/notgithub' });
  if (miss === null) pass('github.detect() returns null for non-github URLs');
  else fail(`github.detect() should return null, got ${JSON.stringify(miss)}`);

  // The hostname check must not be satisfied by a lookalike domain.
  const spoof = github.detect({ name: 'X', careers_url: 'https://github.careers.evil.com/jobs' });
  if (spoof === null) pass('github.detect() rejects a lookalike host (github.careers.evil.com)');
  else fail(`github.detect() accepted a spoofed host: ${JSON.stringify(spoof)}`);

  // Each jobs[] element wraps the real record under .data on this API.
  const page = {
    jobs: [
      { data: { title: 'Senior SWE, CoPilot Agent Platform', req_id: '5501', slug: '5501',
                full_location: 'United States', location_type: 'US Remote',
                apply_url: 'https://careers-githubinc.icims.com/jobs/5501/login',
                posted_date: '2026-08-01T00:00:00Z' } },
      { data: { title: 'Staff SWE, Copilot Agents', req_id: '5502', slug: '5502',
                full_location: 'United States', country: 'United States' } },
      { data: { req_id: '5503', full_location: 'United States' } },   // no title -> dropped
    ],
  };
  const rows = parseGithubJobs(page, 'GitHub');
  if (rows.length === 2) pass('parseGithubJobs unwraps .data and drops title-less rows');
  else fail(`parseGithubJobs returned ${rows.length} rows, expected 2`);

  // location_type is NOT part of full_location. Dropping it makes a remote-eligible role
  // read as a bare country string, which is the same secondary-location class that has
  // silently discarded reachable roles in every other adapter here.
  if (rows[0] && /US Remote/.test(rows[0].location)) {
    pass('parseGithubJobs folds location_type into the location string');
  } else {
    fail(`parseGithubJobs dropped location_type: ${JSON.stringify(rows[0]?.location)}`);
  }

  if (rows[0] && rows[0].url === 'https://careers-githubinc.icims.com/jobs/5501/login') {
    pass('parseGithubJobs prefers apply_url when present');
  } else {
    fail(`parseGithubJobs url: ${JSON.stringify(rows[0]?.url)}`);
  }
  if (rows[1] && /github\.careers\/careers-home\/jobs\/5502$/.test(rows[1].url)) {
    pass('parseGithubJobs falls back to a careers-home URL built from the slug');
  } else {
    fail(`parseGithubJobs fallback url: ${JSON.stringify(rows[1]?.url)}`);
  }

  // Dedup by req_id must span pages: the API returns an overlapping window, not clean pages.
  const carried = new Set();
  parseGithubJobs(page, 'GitHub', carried);
  const again = parseGithubJobs(page, 'GitHub', carried);
  if (again.length === 0) pass('parseGithubJobs dedups by req_id across pages');
  else fail(`parseGithubJobs re-emitted ${again.length} duplicate row(s)`);

  // fetch() must stop on a short page rather than walking to MAX_PAGES.
  let calls = 0;
  const ctx = {
    fetchJson: async () => {
      calls += 1;
      return calls === 1
        ? { jobs: Array.from({ length: 50 }, (_v, i) => ({ data: { title: `Role ${i}`, req_id: `p1-${i}` } })) }
        : { jobs: [{ data: { title: 'Last', req_id: 'p2-0' } }] };
    },
  };
  const fetched = await github.fetch({ name: 'GitHub', careers_url: 'https://www.github.careers/careers-home/jobs' }, ctx);
  if (calls === 2 && fetched.length === 51) {
    pass('github.fetch() paginates and stops on the first short page');
  } else {
    fail(`github.fetch() made ${calls} call(s) and returned ${fetched.length} rows; expected 2 and 51`);
  }
} catch (e) {
  fail(`github provider tests crashed: ${e.message}`);
}

// ── 13. PROVIDERS — SmartRecruiters ─────────────────────────────────

console.log('\n13. Provider — smartrecruiters');

try {
  const sr = (await import(pathToFileURL(join(ROOT, 'providers/smartrecruiters.mjs')).href)).default;
  const { parseSmartRecruitersResponse } = await import(pathToFileURL(join(ROOT, 'providers/smartrecruiters.mjs')).href);

  if (sr.id === 'smartrecruiters') pass('smartrecruiters.id is "smartrecruiters"');
  else fail(`smartrecruiters.id is ${JSON.stringify(sr.id)}`);

  const hitCareers = sr.detect({ name: 'Adyen', careers_url: 'https://careers.smartrecruiters.com/adyen' });
  if (hitCareers && hitCareers.url.startsWith('https://api.smartrecruiters.com/v1/companies/adyen/postings')) {
    pass('smartrecruiters.detect() resolves careers.smartrecruiters.com/<slug> → api URL');
  } else {
    fail(`smartrecruiters.detect(careers) returned ${JSON.stringify(hitCareers)}`);
  }

  const hitJobs = sr.detect({ name: 'X', careers_url: 'https://jobs.smartrecruiters.com/x' });
  if (hitJobs && hitJobs.url.startsWith('https://api.smartrecruiters.com/v1/companies/x/postings')) {
    pass('smartrecruiters.detect() also handles jobs.smartrecruiters.com');
  } else {
    fail(`smartrecruiters.detect(jobs) returned ${JSON.stringify(hitJobs)}`);
  }

  if (sr.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('smartrecruiters.detect() returns null for non-SR URLs');
  } else {
    fail('smartrecruiters.detect() should return null for non-SR URLs');
  }

  // parseSmartRecruitersResponse
  const sample = {
    content: [
      {
        id: 'abc-123',
        name: 'Senior PM',
        ref: 'https://api.smartrecruiters.com/v1/companies/sgs/postings/abc-123',
        location: { fullLocation: 'Geneva, Switzerland', remote: false },
      },
      {
        id: 'def-456',
        name: 'Remote AI Engineer',
        ref: 'https://api.smartrecruiters.com/v1/companies/sgs/postings/def-456',
        location: { city: 'Paris', country: 'France', remote: true },
      },
      {
        id: 'ghi-789',
        name: 'No-ref Role',
        location: { fullLocation: 'Berlin, Germany' },
      },
    ],
  };
  const jobs = parseSmartRecruitersResponse(sample, 'SGS');
  if (jobs.length === 3) pass('parseSmartRecruitersResponse extracts 3 jobs');
  else fail(`parseSmartRecruitersResponse returned ${jobs.length} jobs`);

  if (jobs[0]?.location === 'Geneva, Switzerland' && jobs[0]?.title === 'Senior PM') {
    pass('parseSmartRecruitersResponse uses fullLocation when present');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.location === 'Paris, France, Remote') {
    pass('parseSmartRecruitersResponse builds location from city/country/remote when no fullLocation');
  } else {
    fail(`row 1 location = ${JSON.stringify(jobs[1]?.location)}, expected "Paris, France, Remote"`);
  }

  if (jobs[0]?.url === 'https://jobs.smartrecruiters.com/sgs/postings/abc-123') {
    pass('parseSmartRecruitersResponse rewrites api.smartrecruiters.com → jobs.smartrecruiters.com');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[2]?.url && jobs[2].url.startsWith('https://jobs.smartrecruiters.com/sgs/ghi-789')) {
    pass('parseSmartRecruitersResponse falls back to synthetic URL when ref is missing');
  } else {
    fail(`row 2 url = ${JSON.stringify(jobs[2]?.url)}`);
  }

  // Empty input safety
  if (parseSmartRecruitersResponse({}, 'X').length === 0) pass('empty {} input → empty result');
  else fail('empty {} input should yield empty result');

  if (parseSmartRecruitersResponse({ content: 'not an array' }, 'X').length === 0) {
    pass('non-array content → empty result (no crash)');
  } else {
    fail('non-array content should yield empty result');
  }

  // careers_url with non-string value → detect() returns null without crashing
  if (sr.detect({ name: 'X', careers_url: { foo: 'bar' } }) === null) {
    pass('smartrecruiters.detect() returns null for non-string careers_url (object)');
  } else {
    fail('smartrecruiters.detect() should treat non-string careers_url as missing');
  }

  // Fallback URL when both ref AND id are missing → empty string (not "undefined" in URL)
  const noRefNoId = parseSmartRecruitersResponse(
    { content: [{ name: 'Stranded Role' }] },
    'X',
  );
  if (noRefNoId.length === 1 && noRefNoId[0].url === '') {
    pass('parseSmartRecruitersResponse returns url="" when both ref and id are missing');
  } else {
    fail(`expected url='' when ref+id both missing, got ${JSON.stringify(noRefNoId[0])}`);
  }

  // SSRF: malicious URL with smartrecruiters hostname in the PATH (not host) must not be detected.
  if (sr.detect({ name: 'Spoof', careers_url: 'https://evil.example/careers.smartrecruiters.com/slug' }) === null) {
    pass('smartrecruiters.detect() rejects path-spoofed URLs');
  } else {
    fail('smartrecruiters.detect() must NOT misdetect path-spoofed URLs');
  }

  // SmartRecruiters: untrusted j.ref host falls through to fallback rather than rewriting
  const bogusRef = parseSmartRecruitersResponse(
    { content: [{ id: 'X1', name: 'Strange Role', ref: 'https://evil.example/v1/companies/x/postings/X1' }] },
    'TestCo',
  );
  if (bogusRef[0]?.url && !bogusRef[0].url.includes('evil.example')) {
    pass('parseSmartRecruitersResponse rejects untrusted j.ref host (falls through to fallback)');
  } else {
    fail(`untrusted j.ref leaked into url: ${JSON.stringify(bogusRef[0]?.url)}`);
  }

  // SmartRecruiters: companyName with spaces/symbols is slugified for the fallback URL
  const slugifiedCompany = parseSmartRecruitersResponse(
    { content: [{ id: 'X2', name: 'Strange Role' }] },
    'My Acme & Co.',
  );
  if (slugifiedCompany[0]?.url === 'https://jobs.smartrecruiters.com/my-acme-co/X2-strange-role') {
    pass('parseSmartRecruitersResponse slugifies the companyName for the fallback URL');
  } else {
    fail(`fallback URL not properly slugified: ${JSON.stringify(slugifiedCompany[0]?.url)}`);
  }

  // Pagination: fetch() loops until an empty page (or short page) is returned
  let pageRequests = 0;
  const pagedJobs = await sr.fetch(
    { name: 'PagedCo', careers_url: 'https://careers.smartrecruiters.com/paged' },
    {
      transport: 'http',
      fetchText: async () => { throw new Error('fetchText should not be called'); },
      fetchJson: async (url) => {
        pageRequests++;
        const offset = parseInt(new URL(url).searchParams.get('offset') || '0', 10);
        if (offset === 0) {
          // Page 1: full page (100 items)
          return { content: Array.from({ length: 100 }, (_, i) => ({ id: `P1-${i}`, name: `Role 1-${i}` })) };
        }
        if (offset === 100) {
          // Page 2: short page (50 items) → loop stops after this
          return { content: Array.from({ length: 50 }, (_, i) => ({ id: `P2-${i}`, name: `Role 2-${i}` })) };
        }
        // Should not be reached because page 2 was short
        return { content: [] };
      },
    },
  );
  if (pageRequests === 2 && pagedJobs.length === 150) {
    pass('smartrecruiters.fetch() paginates and aggregates results (2 pages → 150 total)');
  } else {
    fail(`pagination: pageRequests=${pageRequests}, total=${pagedJobs.length} (expected 2 requests / 150 results)`);
  }

  // Pagination stop condition: empty content terminates the loop
  let emptyPageRequests = 0;
  const emptyJobs = await sr.fetch(
    { name: 'EmptyCo', careers_url: 'https://careers.smartrecruiters.com/empty' },
    {
      transport: 'http',
      fetchText: async () => { throw new Error('fetchText should not be called'); },
      fetchJson: async () => {
        emptyPageRequests++;
        return { content: [] };
      },
    },
  );
  if (emptyPageRequests === 1 && emptyJobs.length === 0) {
    pass('smartrecruiters.fetch() stops on the first empty page');
  } else {
    fail(`empty pagination: requests=${emptyPageRequests}, total=${emptyJobs.length}`);
  }

} catch (e) {
  fail(`smartrecruiters provider tests crashed: ${e.message}`);
}

// ── 14. PROVIDERS — Recruitee ───────────────────────────────────────

console.log('\n14. Provider — recruitee');

try {
  const recruitee = (await import(pathToFileURL(join(ROOT, 'providers/recruitee.mjs')).href)).default;
  const { parseRecruiteeResponse } = await import(pathToFileURL(join(ROOT, 'providers/recruitee.mjs')).href);

  if (recruitee.id === 'recruitee') pass('recruitee.id is "recruitee"');
  else fail(`recruitee.id is ${JSON.stringify(recruitee.id)}`);

  const hit = recruitee.detect({ name: 'Channable', careers_url: 'https://channable.recruitee.com' });
  if (hit && hit.url === 'https://channable.recruitee.com/api/offers/') {
    pass('recruitee.detect() resolves <slug>.recruitee.com → api offers');
  } else {
    fail(`recruitee.detect() returned ${JSON.stringify(hit)}`);
  }

  if (recruitee.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('recruitee.detect() returns null for non-recruitee URLs');
  } else {
    fail('recruitee.detect() should return null for non-recruitee URLs');
  }

  // parseRecruiteeResponse
  const sample = {
    offers: [
      { title: 'Senior PM', careers_url: 'https://channable.recruitee.com/o/senior-pm', city: 'Utrecht', country: 'Netherlands', remote: false },
      { title: 'Backend Eng', url: 'https://channable.recruitee.com/o/backend', city: 'Amsterdam', country: 'Netherlands', remote: true },
      { title: 'AI Lead', location: 'Remote, EMEA' },
    ],
  };
  const jobs = parseRecruiteeResponse(sample, 'Channable');
  if (jobs.length === 3) pass('parseRecruiteeResponse extracts 3 offers');
  else fail(`parseRecruiteeResponse returned ${jobs.length} offers`);

  if (jobs[0]?.title === 'Senior PM' && jobs[0]?.company === 'Channable' && jobs[0]?.url === 'https://channable.recruitee.com/o/senior-pm') {
    pass('parseRecruiteeResponse prefers careers_url field over url');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.location === 'Amsterdam, Netherlands, Remote') {
    pass('parseRecruiteeResponse assembles city/country/remote when no location field');
  } else {
    fail(`row 1 location = ${JSON.stringify(jobs[1]?.location)}, expected "Amsterdam, Netherlands, Remote"`);
  }

  if (jobs[2]?.location === 'Remote, EMEA') {
    pass('parseRecruiteeResponse uses explicit location field when present');
  } else {
    fail(`row 2 location = ${JSON.stringify(jobs[2]?.location)}`);
  }

  if (parseRecruiteeResponse({}, 'X').length === 0) pass('empty {} → empty result');
  else fail('empty {} should yield empty result');

  if (parseRecruiteeResponse({ offers: null }, 'X').length === 0) {
    pass('null offers → empty result (no crash)');
  } else {
    fail('null offers should yield empty result');
  }

  // careers_url with non-string value → detect() returns null without crashing
  if (recruitee.detect({ name: 'X', careers_url: null }) === null && recruitee.detect({ name: 'X', careers_url: 7 }) === null) {
    pass('recruitee.detect() returns null for non-string careers_url (null and 7)');
  } else {
    fail('recruitee.detect() should treat non-string careers_url as missing');
  }

  // SSRF: malicious URL with recruitee.com in the PATH (not host) must not be detected.
  if (recruitee.detect({ name: 'Spoof', careers_url: 'https://evil.example/channable.recruitee.com/foo' }) === null) {
    pass('recruitee.detect() rejects path-spoofed URLs');
  } else {
    fail('recruitee.detect() must NOT misdetect path-spoofed URLs');
  }

  // Off-domain offer URL is dropped (URL validation)
  const offDomainOffers = parseRecruiteeResponse(
    {
      offers: [
        { title: 'Good', careers_url: 'https://channable.recruitee.com/o/good' },
        { title: 'Evil', careers_url: 'https://evil.example/o/evil' },
        { title: 'Insecure', careers_url: 'http://channable.recruitee.com/o/insecure' },
        { title: 'No URL field' },
      ],
    },
    'Channable',
  );
  if (offDomainOffers[0]?.url === 'https://channable.recruitee.com/o/good' && offDomainOffers[1]?.url === '' && offDomainOffers[2]?.url === '' && offDomainOffers[3]?.url === '') {
    pass('parseRecruiteeResponse drops off-domain, non-https, and missing offer URLs');
  } else {
    fail(`URL validation: row0=${JSON.stringify(offDomainOffers[0]?.url)}, row1=${JSON.stringify(offDomainOffers[1]?.url)}, row2=${JSON.stringify(offDomainOffers[2]?.url)}, row3=${JSON.stringify(offDomainOffers[3]?.url)}`);
  }

} catch (e) {
  fail(`recruitee provider tests crashed: ${e.message}`);
}

// ── 12. TRACKER REPORT LINK NORMALIZATION (#760) ────────────────

console.log('\n12. Tracker report-link normalization');

try {
  const { normalizeReportLink } = await import(pathToFileURL(join(ROOT, 'tracker-links.mjs')).href);
  const repo = '/repo';
  const dataDir = join(repo, 'data');

  // data/ layout: root-relative TSV link → ../reports/...
  const fromTsv = normalizeReportLink('[12](reports/012-acme-2026-01-04.md)', dataDir, repo);
  if (fromTsv === '[12](../reports/012-acme-2026-01-04.md)') {
    pass('data/ layout: root-relative link rewritten to ../reports/...');
  } else {
    fail(`data/ layout normalization wrong: ${fromTsv}`);
  }

  // Idempotent: re-running on an already-normalized link must not double-prefix
  const twice = normalizeReportLink(fromTsv, dataDir, repo);
  if (twice === fromTsv) {
    pass('normalization is idempotent (no double-prefix on re-run)');
  } else {
    fail(`normalization not idempotent: ${twice}`);
  }

  // Root layout: tracker at repo root → link stays reports/...
  const atRoot = normalizeReportLink('[12](reports/012-acme-2026-01-04.md)', repo, repo);
  if (atRoot === '[12](reports/012-acme-2026-01-04.md)') {
    pass('root layout: link stays root-relative reports/...');
  } else {
    fail(`root layout normalization wrong: ${atRoot}`);
  }

  // Non-report links are left untouched — including external URLs that happen
  // to contain an embedded "/reports/" segment (must not be rewritten).
  const other = normalizeReportLink('[site](https://example.com/reports/foo.md)', dataDir, repo);
  if (other === '[site](https://example.com/reports/foo.md)') {
    pass('non-report links (incl. URLs with embedded /reports/) are left untouched');
  } else {
    fail(`non-report link altered: ${other}`);
  }

  // End-to-end migration against a fictional fixture tracker (no personal data)
  const tmpDir = mkdtempSync(join(tmpdir(), 'career-ops-migrate-'));
  try {
    mkdirSync(join(tmpDir, 'data'));
    mkdirSync(join(tmpDir, 'reports'));
    writeFileSync(join(tmpDir, 'reports', '012-acme-2026-01-04.md'), '# fixture\n');
    const tracker = join(tmpDir, 'data', 'applications.md');
    writeFileSync(tracker,
      TRACKER_HEAD +
      '| 12 | 2026-01-04 | Acme | Engineer | 4.2/5 | Evaluated | ✅ | [12](reports/012-acme-2026-01-04.md) | ok |\n');

    // Migrate by pointing the script at the fixture tracker via env override.
    run(NODE, ['merge-tracker.mjs', '--migrate'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    const after = readFileSync(tracker, 'utf-8');
    if (after.includes('[12](../reports/012-acme-2026-01-04.md)')) {
      pass('migration rewrites fixture tracker links to ../reports/...');
    } else {
      fail('migration did not rewrite fixture tracker link');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
} catch (e) {
  fail(`tracker-link normalization tests crashed: ${e.message}`);
}

// ── SHARED ROLE MATCHER + DEDUP-TRACKER SAFETY (#947) ───────────
// dedup-tracker.mjs used to ship an older fuzzy role matcher than
// merge-tracker.mjs. That weaker matcher collapsed sibling roles at the same
// company when they shared generic title words such as "Full Stack Engineer",
// and could delete an already-Applied row because data/applications.md is
// normally gitignored. The matcher is now shared, and dedup protects advanced
// application states from fuzzy-only deletion.
console.log('\n🧪 Testing shared role matcher and dedup-tracker safety...');
try {
  const { roleFuzzyMatch } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);

  if (!roleFuzzyMatch('Full Stack Engineer, Foundation', 'Full Stack Engineer, Guarded Releases')) {
    pass('role matcher keeps Full Stack Engineer sibling teams distinct (#947)');
  } else {
    fail('role matcher still collapses distinct Full Stack Engineer sibling teams');
  }

  if (!roleFuzzyMatch('Staff Software Engineer, API', 'Staff Software Engineer, SDK')) {
    pass('role matcher keeps short-acronym sibling teams distinct');
  } else {
    fail('role matcher collapsed API and SDK sibling teams');
  }

  if (roleFuzzyMatch('Staff Software Engineer, API', 'Staff Software Engineer, API Platform')) {
    pass('role matcher still uses short specialty acronyms for true overlaps');
  } else {
    fail('role matcher ignored a real short-acronym overlap');
  }

  const dedupTmp = mkdtempSync(join(tmpdir(), 'career-ops-dedup-'));
  try {
    mkdirSync(join(dedupTmp, 'data'));
    const tracker = join(dedupTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      TRACKER_HEAD +
      '| 21 | 2026-01-08 | Acme | Full Stack Engineer, Foundation | 3.9/5 | Applied | ❌ | [21](../reports/021-foundation.md) | applied sibling |\n' +
      '| 22 | 2026-01-08 | Acme | Full Stack Engineer, Guarded Releases | 4.3/5 | Evaluated | ❌ | [22](../reports/022-guarded.md) | evaluated sibling |\n' +
      '| 23 | 2026-01-08 | Acme | Staff Software Engineer, API | 4.0/5 | Evaluated | ❌ | [23](../reports/023-api.md) | acronym sibling |\n' +
      '| 24 | 2026-01-08 | Acme | Staff Software Engineer, SDK | 4.2/5 | Evaluated | ❌ | [24](../reports/024-sdk.md) | acronym sibling |\n' +
      '| 25 | 2026-01-08 | Acme | Product Engineer, Growth | 3.8/5 | Evaluated | ❌ | [25](../reports/025-growth-old.md) | duplicate old |\n' +
      '| 26 | 2026-01-09 | Acme | Product Engineer, Growth | 4.0/5 | Evaluated | ❌ | [26](../reports/026-growth-new.md) | duplicate new |\n' +
      '| 27 | 2026-01-08 | Acme | Solutions Engineer, Revenue | 3.0/5 | Applied | ❌ | [27](../reports/027-revenue-applied.md) | applied exact-title row |\n' +
      '| 28 | 2026-01-09 | Acme | Solutions Engineer, Revenue | 4.6/5 | Evaluated | ❌ | [28](../reports/028-revenue-eval.md) | evaluated exact-title row |\n' +
      '| 29 | 2026-01-08 | Acme | Data Engineer, Search | 3.1/5 | Applied | ❌ | [29](../reports/029-search-old.md) | malformed duplicate-number old row |\n' +
      '| 29 | 2026-01-09 | Acme | Data Engineer, Search | 4.1/5 | Evaluated | ❌ | [30](../reports/030-search-new.md) | malformed duplicate-number new row |\n');

    const dedupResult = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (dedupResult === null) {
      fail('dedup-tracker.mjs crashed during shared role matcher safety test');
    } else {
      const deduped = readFileSync(tracker, 'utf-8');

      if (deduped.includes('Full Stack Engineer, Foundation') && deduped.includes('Full Stack Engineer, Guarded Releases')) {
        pass('dedup-tracker preserves distinct Full Stack Engineer sibling rows');
      } else {
        fail('dedup-tracker removed a distinct Full Stack Engineer sibling row');
      }

      if (deduped.includes('Staff Software Engineer, API') && deduped.includes('Staff Software Engineer, SDK')) {
        pass('dedup-tracker preserves short-acronym sibling rows');
      } else {
        fail('dedup-tracker removed a short-acronym sibling row');
      }

      const growthRows = deduped.split('\n').filter(l => l.includes('Product Engineer, Growth'));
      if (growthRows.length === 1 && growthRows[0].includes('4.0/5')) {
        pass('dedup-tracker still removes a real duplicate evaluated row');
      } else {
        fail(`dedup-tracker duplicate handling broken: ${growthRows.length} Growth rows`);
      }

      const revenueRows = deduped.split('\n').filter(l => l.includes('Solutions Engineer, Revenue'));
      if (revenueRows.length === 2 && revenueRows.some(l => l.includes('Applied'))) {
        pass('dedup-tracker never removes Applied+ rows by fuzzy title match');
      } else {
        fail('dedup-tracker removed an Applied+ row by fuzzy title match');
      }

      const searchRows = deduped.split('\n').filter(l => l.includes('Data Engineer, Search'));
      if (searchRows.length === 1 && searchRows[0].includes('4.1/5') && searchRows[0].includes('Applied')) {
        pass('dedup-tracker handles duplicate tracker numbers using row-local line indexes');
      } else {
        fail(`dedup-tracker duplicate-number handling broken: ${searchRows.length} Search rows`);
      }
    }
  } finally {
    rmSync(dedupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`shared role matcher / dedup safety tests crashed: ${e.message}`);
}

// dedup-tracker / normalize-statuses rebuilt promoted rows with
// `parts.slice(1, -1)`, which assumes the closing `|` produced a trailing empty
// cell. A valid row written WITHOUT a trailing pipe keeps its real last cell
// (the notes) at the end, so the old reconstruction silently dropped the notes
// when promoting a keeper's status during dedup. rebuildRow() now preserves it.
console.log('\n🧪 Testing dedup row rebuild preserves notes on no-trailing-pipe rows...');
try {
  const rebuildTmp = mkdtempSync(join(tmpdir(), 'career-ops-rebuild-'));
  try {
    mkdirSync(join(rebuildTmp, 'data'));
    const tracker = join(rebuildTmp, 'data', 'applications.md');
    // Keeper row #50 has the higher score AND no trailing pipe; dup #51 carries a
    // more-advanced status (both below Applied, so the advanced-status safety
    // guard doesn't block the collapse), so dedup promotes #50's status and
    // rewrites the row — exercising rebuildRow() on a no-trailing-pipe row.
    writeFileSync(tracker,
      TRACKER_HEAD +
      '| 50 | 2026-02-01 | Globex | Widget Engineer | 4.5/5 | Rejected | ❌ | [50](../reports/050-widget.md) | KEEPER_NOTE_SENTINEL\n' +
      '| 51 | 2026-02-02 | Globex | Widget Engineer | 3.0/5 | Evaluated | ❌ | [51](../reports/051-widget.md) | dup row |\n');

    const r = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (r === null) {
      fail('dedup-tracker.mjs crashed during notes-preservation test');
    } else {
      const out = readFileSync(tracker, 'utf-8');
      const keeperRow = out.split('\n').find(l => l.includes('| 50 |'));
      if (keeperRow && keeperRow.includes('KEEPER_NOTE_SENTINEL') && keeperRow.includes('Evaluated')) {
        pass('dedup row rebuild preserves the notes column on rows without a trailing pipe');
      } else {
        fail(`dedup row rebuild dropped notes / status on no-trailing-pipe row: "${keeperRow}"`);
      }
    }
  } finally {
    rmSync(rebuildTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup row-rebuild notes test crashed: ${e.message}`);
}

// ── SCORE-AUDIT LINK-KEYED PAIRING (2026-09-19 off-by-one) ──────────
// score-audit.mjs used to key tracker rows by the row's OWN leading number and
// then look them up by the report FILE's number. Those are two independent
// sequences: merge-tracker assigns row numbers from the tracker's own counter,
// so after a merge where the two sequences differ, every pair is off by one
// and the tool compares row N against report N-1. That is not theoretical: on
// 2026-09-19 reports 591-602 merged as rows 592-603 and this printed four
// false disagreements, and an earlier --fix run in the same shape wrote
// scores into the wrong rows and the tracker had to be restored by hand. Rows
// are now keyed by the report FILENAME parsed out of the row's markdown link
// and looked up by that filename, and a row with no parseable link is
// reported NOT CHECKED rather than silently dropped.
console.log('\n🧪 Testing score-audit pairs rows to reports by LINK, not by row number...');
try {
  const auditTmp = mkdtempSync(join(tmpdir(), 'career-ops-score-audit-'));
  try {
    mkdirSync(join(auditTmp, 'data'));
    mkdirSync(join(auditTmp, 'reports'));
    const tracker = join(auditTmp, 'data', 'applications.md');
    // Rows 592 and 593 each carry a row number one MORE than the report they
    // link to, the exact 2026-09-19 merge shape. Row 594 has no report link
    // at all. The two linked reports carry deliberately different scores
    // (4.05 vs 3.64) so a number-keyed lookup, which would pair row 592 with
    // report 592 instead of report 591, sees a real disagreement while a
    // link-keyed lookup sees none.
    writeFileSync(tracker,
      TRACKER_HEAD +
      '| 592 | 2026-09-19 | Fixtureco | Report Link Fixture One | 4.05/5 | Evaluated | ❌ | [592](../reports/591-fixture-link-one-2026-09-19.md) | row number is one more than its linked report |\n' +
      '| 593 | 2026-09-19 | Fixtureco | Report Link Fixture Two | 3.64/5 | Evaluated | ❌ | [593](../reports/592-fixture-link-two-2026-09-19.md) | row number is one more than its linked report |\n' +
      '| 594 | 2026-09-19 | Fixtureco | Report Link Fixture Unlinked | 4.0/5 | Evaluated | ❌ | not yet linked | no parseable report link at all, must read NOT CHECKED |\n');

    writeFileSync(join(auditTmp, 'reports', '591-fixture-link-one-2026-09-19.md'),
      '# 591 - Fixtureco - Report Link Fixture One\n\n' +
      '**Company:** Fixtureco\n' +
      '**Role:** Report Link Fixture One\n' +
      '**Score:** 4.05/5\n' +
      '**URL:** https://example.invalid/fixture/591\n' +
      '**Date:** 2026-09-19\n\n' +
      '## Machine Summary\n\n' +
      '```yaml\n' +
      'num: 591\n' +
      'company: "Fixtureco"\n' +
      'role: "Report Link Fixture One"\n' +
      'date: 2026-09-19\n' +
      'final: 4.05\n' +
      '```\n');

    writeFileSync(join(auditTmp, 'reports', '592-fixture-link-two-2026-09-19.md'),
      '# 592 - Fixtureco - Report Link Fixture Two\n\n' +
      '**Company:** Fixtureco\n' +
      '**Role:** Report Link Fixture Two\n' +
      '**Score:** 3.64/5\n' +
      '**URL:** https://example.invalid/fixture/592\n' +
      '**Date:** 2026-09-19\n\n' +
      '## Machine Summary\n\n' +
      '```yaml\n' +
      'num: 592\n' +
      'company: "Fixtureco"\n' +
      'role: "Report Link Fixture Two"\n' +
      'date: 2026-09-19\n' +
      'final: 3.64\n' +
      '```\n');

    let code = 0, out = '';
    try {
      out = execFileSync(NODE, [join(ROOT, 'score-audit.mjs')],
        { cwd: auditTmp, encoding: 'utf-8', timeout: 30000 });
    } catch (e) { code = e.status ?? 1; out = `${e.stdout || ''}${e.stderr || ''}`; }

    if (code === 0 && /\b0 live disagreement\(s\)/.test(out)) {
      pass('score-audit: row/report numbers off by one still agree once the link is followed');
    } else {
      fail(`score-audit reported a disagreement for correctly-linked off-by-one rows ` +
           `(exit ${code}): ${out.trim().slice(0, 300)}`);
    }

    if (/NOT CHECKED \(no report link\)/.test(out) && /audited by nothing: 594/.test(out)) {
      pass('score-audit reports a linkless row as NOT CHECKED rather than silently passing');
    } else {
      fail(`score-audit did not flag the linkless row as NOT CHECKED: ${out.trim().slice(0, 300)}`);
    }
  } finally {
    rmSync(auditTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`score-audit link-keyed pairing test crashed: ${e.message}`);
}

// ── VERIFY-BOARD: NO TRACKER IS NOT CHECKED, NOT A SILENT PASS (N45) ────────
// verify-board.mjs used to print "no tracker yet, nothing to verify" and exit 0 for a
// missing tracker, which a CI step or another script reads as a pass. score-audit.mjs
// hits the same state and reports NOT CHECKED with exit 2, since "no tracker" and "a
// tracker that agrees" are different answers; verify-board now follows the same rule.
console.log('\n🧪 Testing verify-board reports NOT CHECKED, not a silent pass, with no tracker...');
{
  const noTrackerTmp = mkdtempSync(join(tmpdir(), 'career-ops-verifyboard-notracker-'));
  let code = 0, out = '';
  try {
    out = execFileSync(NODE, [join(ROOT, 'verify-board.mjs')],
      { cwd: noTrackerTmp, encoding: 'utf-8', timeout: 30000 });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout || ''}${e.stderr || ''}`; }

  if (code === 2 && /^NOT CHECKED/m.test(out)) {
    pass('verify-board: no tracker prints NOT CHECKED and exits 2, not a silent green');
  } else {
    fail(`verify-board should report NOT CHECKED and exit 2 with no tracker ` +
         `(got exit ${code}): ${out.trim().slice(0, 200)}`);
  }
  rmSync(noTrackerTmp, { recursive: true, force: true });
}

// One merge-tracker fixture: a tracker holding `rows`, report files and TSV additions,
// merged in a temp dir. Returns the merged tracker text, or null if merge-tracker crashed;
// `inspect(trackerPath)`, when given, runs after the merge and before the dir is removed.
const mergeFixture = (prefix, { rows, reports = {}, tsvs = {}, inspect }) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    for (const d of ['data', 'reports', 'additions']) mkdirSync(join(dir, d));
    const tracker = join(dir, 'data', 'applications.md');
    writeFileSync(tracker, TRACKER_HEAD + rows.map(r => `${r}\n`).join(''));
    for (const [f, body] of Object.entries(reports)) writeFileSync(join(dir, 'reports', f), `${body}\n`);
    for (const [f, body] of Object.entries(tsvs)) writeFileSync(join(dir, 'additions', f), `${body}\n`);
    const r = run(NODE, ['merge-tracker.mjs'], {
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: join(dir, 'additions') },
    });
    if (r === null) return null;
    inspect?.(tracker);
    return readFileSync(tracker, 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── MERGE-TRACKER FUZZY DEDUP (#751 / #721 family) ──────────────
// roleFuzzyMatch over-matched whenever the token overlap dominated the
// SMALLER side: two distinct roles sharing a long prefix ("Full-Stack
// Engineer 5, AI Insights & Visualizations" vs "Full Stack Engineer 5, Ads
// Reporting") or a brand token (#751: "UberEats Feed" vs "Consumer
// Fulfillment (UberEats)") collapsed onto one tracker row — silently
// dropping evaluations. The ratio now divides by the token UNION (true
// Jaccard): genuine reposts (identical token sets) still score 1.0, while
// distinct specialties fall below the 0.6 threshold.
console.log('\n🧪 Testing merge-tracker fuzzy dedup (distinct roles vs reposts)...');
try {
  const merged = mergeFixture('career-ops-merge-', {
    rows: [
      '| 1 | 2026-01-04 | StreamCo | Full Stack Engineer 5, Ads Reporting | 4.4/5 | Evaluated | ❌ | [1](../reports/001-streamco-2026-01-04.md) | existing |',
      '| 2 | 2026-01-04 | Uber | Senior Software Engineer, Consumer Fulfillment (UberEats) | 4.2/5 | Evaluated | ❌ | [2](../reports/002-uber-2026-01-04.md) | existing |',
    ],
    reports: Object.fromEntries(['001-streamco-2026-01-04', '002-uber-2026-01-04', '003-streamco-2026-01-05',
      '004-uber-2026-01-05', '005-streamco-2026-01-06'].map(n => [`${n}.md`, '# fixture'])),
    // Two DISTINCT roles (long shared prefix / shared brand token) + one true repost (score bump).
    tsvs: {
      '003-streamco.tsv': '3\t2026-01-05\tStreamCo\tFull-Stack Engineer 5, AI Insights & Visualizations\tEvaluated\t4.6/5\t❌\t[3](reports/003-streamco-2026-01-05.md)\tdistinct role',
      '004-uber.tsv': '4\t2026-01-05\tUber\tSenior Software Engineer, UberEats Feed\tEvaluated\t4.1/5\t❌\t[4](reports/004-uber-2026-01-05.md)\tdistinct team (#751)',
      '005-streamco.tsv': '5\t2026-01-06\tStreamCo\tFull Stack Engineer 5, Ads Reporting\tEvaluated\t4.5/5\t❌\t[5](reports/005-streamco-2026-01-06.md)\trepost',
    },
  });
  if (merged === null) {
    fail('merge-tracker.mjs crashed during fuzzy dedup regression test');
  } else {
    // Distinct role sharing a long prefix must be ADDED, not folded into the existing row.
    if (merged.includes('AI Insights & Visualizations') && merged.includes('Ads Reporting')) {
      pass('distinct roles with shared prefix kept as separate rows');
    } else {
      fail('distinct role with shared prefix was merged away (silent data loss)');
    }

    // #751 repro: different teams under one brand token must both survive.
    if (merged.includes('UberEats Feed') && merged.includes('Consumer Fulfillment')) {
      pass('brand-token roles (#751: UberEats Feed vs Consumer Fulfillment) kept separate');
    } else {
      fail('brand-token roles were deduped (#751 regression)');
    }

    // True repost (identical role tokens) must still UPDATE in place — exactly one row, score bumped.
    const adsRows = merged.split('\n').filter(l => l.includes('Ads Reporting'));
    if (adsRows.length === 1 && adsRows[0].includes('4.5/5')) {
      pass('true repost still updates the existing row in place (4.4 → 4.5, no duplicate)');
    } else {
      fail(`repost handling broken: ${adsRows.length} 'Ads Reporting' rows, expected 1 updated to 4.5/5`);
    }
  }
} catch (e) {
  fail(`merge-tracker fuzzy dedup tests crashed: ${e.message}`);
}

// ── JOB-ID AUTHORITATIVE DEDUP (distinct postings, similar titles) ──
// roleFuzzyMatch conflates sibling roles at the same company that share a
// technical domain but differ in specialty/seniority — e.g. Zillow "Principal
// ML Engineer, Agentic AI" vs "Senior ML Engineer" (Jaccard 0.75), or Anduril
// "Modeling & Simulation Engineer, Space" vs "SWE - Modeling & Simulation"
// (0.6). The fuzzy fallback merged them, clobbering the existing row (or
// silently skipping the new one). The report URL's job-id is the authoritative
// identity: distinct job-ids must NEVER merge; a matching job-id merges even
// across a report-number/title change.
console.log('\n🧪 Testing job-id authoritative dedup (merge + dedup)...');
try {
  const { extractJobId, roleFuzzyMatch, idSetsOverlap, idSetsConflict } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);

  // unit: extractJobId distinguishes the real-world URLs that were mis-merged
  const zSenior = extractJobId('https://zillow.wd5.myworkdayjobs.com/zillow_group_external/job/remote-usa/example-role-08_p739064');
  const zPrincipal = extractJobId('https://zillow.wd5.myworkdayjobs.com/en-US/Zillow_Group_External/job/Remote-USA/Example-Role-04_P711740-2');
  const aSpace = extractJobId('https://job-boards.greenhouse.io/andurilindustries/jobs/4223404714');
  const aModsim = extractJobId('https://job-boards.greenhouse.io/andurilindustries/jobs/5932781535');
  if (zSenior && zPrincipal && zSenior !== zPrincipal && aSpace && aModsim && aSpace !== aModsim) {
    pass('extractJobId yields distinct ids for distinct postings (Workday + Greenhouse)');
  } else {
    fail(`extractJobId failed to distinguish: zSenior=${zSenior} zPrincipal=${zPrincipal} aSpace=${aSpace} aModsim=${aModsim}`);
  }
  // Sony writes the requisition with a separator (_JR-119345) where NVIDIA writes
  // it solid (_JR2357552). The solid-only pattern returned null for the Sony form,
  // and two nulls do not conflict, so dedup fell through to fuzzy matching and
  // proposed merging the Staff and Senior reqs of the same Sony team. Assert on the
  // exact ids, not merely that they differ: the earlier facet-suffix strip turned
  // "JR-119345" into the bare prefix "jr", which is equal for every Sony posting.
  const sonyStaff = extractJobId('https://sonyglobal.wd1.myworkdayjobs.com/SonyGlobalCareers/job/Culver-City/Staff-Research-Engineer---Computer-Graphics_JR-119345');
  const sonySenior = extractJobId('https://sonyglobal.wd1.myworkdayjobs.com/SonyGlobalCareers/job/Culver-City/Senior-Research-Engineer---Computer-Graphics_JR-105215');
  if (sonyStaff === 'wd:jr119345' && sonySenior === 'wd:jr105215') {
    pass('extractJobId reads a separator-form Workday req id (Sony JR-119345)');
  } else {
    fail(`extractJobId mangled the separator form: staff=${sonyStaff} senior=${sonySenior}`);
  }
  // Company-hosted boards whose ids the generic rules missed. github.careers writes a
  // FOUR-digit id, so the Senior (5742) and Staff (5708) reqs of one team both came back
  // null and dedup-tracker proposed deleting one as the other's duplicate.
  const hosted = [
    // github.careers and atlassian.com are front ends over iCIMS whose page id IS the
    // iCIMS id, so all three spellings of one posting share one key.
    ['https://www.github.careers/careers-home/jobs/5742', 'icims:5742'],
    ['https://www.github.careers/careers-home/jobs/5742?lang=en-us', 'icims:5742'],
    ['https://www.github.careers/careers-home/jobs/5708', 'icims:5708'],
    ['https://careers-githubinc.icims.com/jobs/5708/login', 'icims:5708'],
    ['https://globalcareers-githubinc.icims.com/jobs/15816/x/job', 'icims:15816'],
    ['https://jobs.apple.com/en-us/details/275158197-0670/lead-developer-ai-workflows', 'apple:275158197'],
    ['https://www.google.com/about/careers/applications/jobs/results/72710505838017443-software-engineer-iii', 'google:72710505838017443'],
    // the same Google posting WITHOUT its title slug: the generic 7+ digit rule used to
    // claim this spelling first and key it as id:, a different key for one posting.
    ['https://www.google.com/about/careers/applications/jobs/results/72710505838017443', 'google:72710505838017443'],
    ['https://jobs.ea.com/en_US/careers/JobDetail/Senior-Tools-Engineer-Apex-Legends/212777', 'ea:212777'],
    ['https://www.atlassian.com/company/careers/details/26789', 'icims:26789'],
    ['https://agbo.breezy.hr/p/f90b2472f4e5-expression-of-interest', 'breezy:f90b2472f4e5'],
  ];
  const hostedBad = hosted.filter(([u, want]) => extractJobId(u) !== want)
    .map(([u, want]) => `${u} -> ${extractJobId(u)} (want ${want})`);
  if (!hostedBad.length) pass(`extractJobId reads ${hosted.length} company-hosted id forms, query strings ignored`);
  else fail(`extractJobId missed hosted ids: ${hostedBad.join('; ')}`);
  // A host-anchored rule must not fire on a host it does not own: an Apple-shaped path on
  // a tracker would otherwise hand two postings one id, and equal ids MERGE.
  if (extractJobId('https://tracker.example.com/r/jobs.apple.com/en-us/details/275158197-0670/x') !== 'apple:275158197') {
    pass('a hosted id rule does not fire on a URL that only mentions the host');
  } else {
    fail('a hosted id rule fired on a wrapper URL that merely mentions jobs.apple.com');
  }

  // A row's identity is a SET: one posting is recorded under different numbering systems
  // (an Eightfold id in its URL, a JR id in its role cell). Rows sharing ANY
  // id are one posting; rows conflict only when both have ids and share none.
  {
    const both = new Set(['id:790310000001', 'wd:jr10001']);
    const jrOnly = new Set(['wd:jr10001']);
    const other = new Set(['wd:jr10002']);
    const none = new Set();
    const ok = idSetsOverlap(both, jrOnly) && !idSetsConflict(both, jrOnly)
      && idSetsConflict(both, other) && !idSetsOverlap(both, other)
      && !idSetsConflict(both, none) && !idSetsConflict(none, none) && !idSetsOverlap(none, none);
    if (ok) pass('identity sets: any shared id is one posting; disjoint non-empty sets conflict; empty is inconclusive');
    else fail('identity set semantics wrong (overlap / conflict / empty)');
  }

  // PROVABLY distinct needs the same numbering system on both sides. Riot's
  // ".../job/7873504?gh_jid=7873504" reads gh: and the report's query-less URL reads id:;
  // calling that a conflict resurfaced tracked rows as new. R21535 against a row
  // holding R37811 is the same system disagreeing.
  {
    const { idSetsProvablyDistinct } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);
    const riotScan = new Set([extractJobId('https://www.riotgames.com/en/work-with-us/job/7873504?gh_jid=7873504')]);
    const riotRow = new Set([extractJobId('https://www.riotgames.com/en/work-with-us/job/7873504')]);
    const ok = !idSetsProvablyDistinct(riotScan, riotRow)
      && idSetsProvablyDistinct(new Set(['wd:r21535']), new Set(['wd:r37811']))
      && !idSetsProvablyDistinct(new Set(['wd:r21535']), new Set(['wd:r21535', 'id:1']))
      && !idSetsProvablyDistinct(new Set(['id:827845510324']), new Set(['wd:jr2113671']))
      && !idSetsProvablyDistinct(new Set(), new Set(['wd:r1']));
    if (ok) pass('identity sets: only a same-namespace disagreement proves two reqs distinct');
    else fail('idSetsProvablyDistinct semantics wrong (cross-namespace, same-namespace, overlap, empty)');
  }

  // the facet suffix must still be stripped where it really is a facet
  if (extractJobId('https://zillow.wd5.myworkdayjobs.com/x/job/Remote-USA/Principal-MLE_P711740-2') === 'wd:p711740') {
    pass('extractJobId still strips a genuine Workday facet suffix (-2)');
  } else {
    fail('extractJobId no longer strips the Workday facet suffix');
  }
  // the guard is load-bearing precisely because these titles DO fuzzy-match
  if (roleFuzzyMatch('Principal Machine Learning Engineer, Agentic AI', 'Senior Machine Learning Engineer')) {
    pass('fuzzy fallback still matches the distinct pair (so job-id guard must protect it)');
  } else {
    pass('fuzzy no longer matches the distinct pair (extra safety layer)');
  }

  // integration: merge-tracker must ADD a distinct-job-id role, not clobber the existing one
  {
    const m = mergeFixture('career-ops-jobid-', {
      rows: ['| 10 | 2026-07-05 | Zillow | Senior Machine Learning Engineer | 3.0/5 | Discarded | ❌ | [10](../reports/010-zillow-senior.md) | existing distinct role |'],
      reports: {
        '010-zillow-senior.md': '**URL:** https://zillow.wd5.myworkdayjobs.com/zillow_group_external/job/remote-usa/example-role-08_p739064',
        '011-zillow-principal.md': '**URL:** https://zillow.wd5.myworkdayjobs.com/en-US/Zillow_Group_External/job/Remote-USA/Example-Role-04_P711740-2',
      },
      // distinct posting (higher score) whose title fuzzy-matches the existing row
      tsvs: { '011-zillow.tsv': '11\t2026-07-16\tZillow\tPrincipal Machine Learning Engineer, Agentic AI\tEvaluated\t3.5/5\t❌\t[11](reports/011-zillow-principal.md)\tdistinct job id' },
    });
    if (m === null) fail('merge-tracker crashed during job-id dedup test');
    else if (m.includes('Senior Machine Learning Engineer') && m.includes('Principal Machine Learning Engineer, Agentic AI')) {
      pass('merge-tracker keeps distinct-job-id roles separate (no clobber)');
    } else fail('merge-tracker clobbered a distinct-job-id role via fuzzy title match');
  }

  // integration: an id the report states BESIDE a bare careers host, or only in the
  // row's role cell, is still an id. On 2026-10-08 a report reading "**URL:**
  // https://<tenant>.wd5.myworkdayjobs.com/<site> (JR...)" yielded no id because only
  // the first token of the line was read; with no id the row conflicted with nothing,
  // and a new requisition whose title fuzzy-matched was merged over it.
  for (const [label, existingUrlLine, existingRole] of [
    ['an id beside a bare host on the URL line',
     '**URL:** https://acme.wd5.myworkdayjobs.com/AcmeExternal (JR1000101)',
     'Senior Machine Learning Engineer'],
    ['an id only in the role cell',
     '**URL:** https://acme.wd5.myworkdayjobs.com/AcmeExternal',
     'Senior Machine Learning Engineer (JR1000101)'],
  ]) {
    const m = mergeFixture('career-ops-jobid-line-', {
      rows: [`| 20 | 2026-07-08 | Acme | ${existingRole} | 2.0/5 | Discarded | ❌ | [20](../reports/020-acme-senior.md) | existing distinct req |`],
      reports: {
        '020-acme-senior.md': existingUrlLine,
        '021-acme-mle.md': '**URL:** https://acme.wd5.myworkdayjobs.com/AcmeExternal/job/US-CA-Remote/Example-Role-21_JR1000202',
      },
      tsvs: { '021-acme.tsv': '21\t2026-10-08\tAcme\tMachine Learning Engineer (JR1000202)\tSKIP\t4.0/5\t❌\t[21](reports/021-acme-mle.md)\tdistinct req' },
    }) || '';
    if (m.includes('existing distinct req') && m.includes('Machine Learning Engineer (JR1000202)')) {
      pass(`merge-tracker keeps a distinct req separate when the existing row's id is ${label}`);
    } else fail(`merge-tracker merged a distinct req over a row whose id is ${label}`);
  }

  // integration: an addition whose REPORT number equals an existing row's ROW number at
  // the same employer is not that row. The two sequences are independent, and a
  // number-plus-company match that ran before the id guard would have folded the next
  // evaluation into whichever row of that employer carried the number.
  {
    const m = mergeFixture('career-ops-rownum-', {
      rows: ['| 31 | 2026-10-08 | Acme | Example Role Alpha (JR1000303) | 3.0/5 | SKIP | ❌ | [29](../reports/029-acme-alpha.md) | row 31, report 29 |'],
      reports: {
        '029-acme-alpha.md': '**URL:** https://acme.wd5.myworkdayjobs.com/AcmeExternal/job/US-CA-Remote/Example-Role-29_JR1000303',
        '031-acme-beta.md': '**URL:** https://acme.wd5.myworkdayjobs.com/AcmeExternal/job/US-CA-Remote/Example-Role-31_JR1000404',
      },
      tsvs: { '031-acme.tsv': '31\t2026-10-09\tAcme\tExample Role Beta (JR1000404)\tEvaluated\t4.2/5\t❌\t[31](reports/031-acme-beta.md)\tnew req, report 31' },
    }) || '';
    if (m.includes('row 31, report 29') && m.includes('Example Role Beta (JR1000404)')) {
      pass('merge-tracker does not pair an addition with a row by row number');
    } else fail('merge-tracker folded a new req into the row that shares its number');
  }

  // integration: SAME job-id across a report-number + title change must UPDATE in place
  {
    const m = mergeFixture('career-ops-jobid-repost-', {
      rows: ['| 40 | 2026-07-05 | Acme | Data Engineer, Search | 3.2/5 | Evaluated | ❌ | [40](../reports/040-acme.md) | original |'],
      reports: {
        '040-acme.md': '**URL:** https://boards.greenhouse.io/acme/jobs/1194374',
        '041-acme.md': '**URL:** https://boards.greenhouse.io/acme/jobs/1194374',
      },
      // same greenhouse job id, different report number and a retitle -> should UPDATE #40, not add
      tsvs: { '041-acme.tsv': '41\t2026-07-16\tAcme\tSenior Data Engineer, Discovery Search\tEvaluated\t4.0/5\t❌\t[41](reports/041-acme.md)\tsame job reposted' },
    });
    if (m === null) fail('merge-tracker crashed during same-job-id repost test');
    else {
      const rows = m.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l) && l.includes('Acme'));
      if (rows.length === 1 && rows[0].includes('4.0/5')) {
        pass('merge-tracker updates same-job-id repost in place across a report-number change');
      } else {
        fail(`same-job-id repost handling broken: ${rows.length} Acme rows (expected 1 at 4.0/5)`);
      }
    }
  }

  // integration: TWO additions updating ONE row in a single run must both land. The row
  // was found by its raw text as read at start, which the first write had replaced, so
  // the second update was logged and silently dropped.
  {
    const url = '**URL:** https://boards.greenhouse.io/acme/jobs/7654321';
    const m = mergeFixture('career-ops-twice-', {
      rows: ['| 50 | 2026-07-05 | Acme | Data Engineer, Search | 3.2/5 | Evaluated | ❌ | [50](../reports/050-acme.md) | original |'],
      reports: { '050-acme.md': url, '051-acme.md': url, '052-acme.md': url },
      tsvs: {
        '051-acme.tsv': '51\t2026-07-16\tAcme\tData Engineer, Search\tEvaluated\t4.0/5\t❌\t[51](reports/051-acme.md)\tfirst re-eval',
        '052-acme.tsv': '52\t2026-07-17\tAcme\tData Engineer, Search\tEvaluated\t4.3/5\t❌\t[52](reports/052-acme.md)\tsecond re-eval',
      },
    });
    const rows = (m || '').split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l) && l.includes('Acme'));
    if (rows.length === 1 && rows[0].includes('4.3/5') && rows[0].includes('(4→4.3)')) {
      pass('merge-tracker applies two updates to one row in a single run');
    } else {
      fail(`second update to one row in a run was dropped: ${rows.join(' / ') || 'merge crashed'}`);
    }
  }

  // integration: a BRAND-NEW posting sent twice in one run is one row. The second
  // addition was compared only against rows read at start, so it was added again.
  {
    const url = '**URL:** https://boards.greenhouse.io/acme/jobs/7654322';
    const m = mergeFixture('career-ops-newtwice-', {
      rows: [],
      reports: { '060-acme.md': url, '061-acme.md': url },
      tsvs: {
        '060-acme.tsv': '60\t2026-07-16\tAcme\tPlatform Engineer\tEvaluated\t3.9/5\t❌\t[60](reports/060-acme.md)\tfirst',
        '061-acme.tsv': '61\t2026-07-17\tAcme\tPlatform Engineer\tEvaluated\t4.2/5\t❌\t[61](reports/061-acme.md)\tsecond',
      },
    });
    const rows = (m || '').split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l) && l.includes('Acme'));
    if (rows.length === 1 && rows[0].includes('4.2/5')) {
      pass('merge-tracker folds a new posting sent twice in one run into one row');
    } else {
      fail(`a new posting sent twice in one run: ${rows.join(' / ') || 'merge crashed'}`);
    }
  }
} catch (e) {
  fail(`job-id authoritative dedup tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER BACKUP-ON-WRITE ────────────────────────────────
// applications.md is gitignored, so a bad merge has no git-history fallback.
// merge-tracker now snapshots the tracker to a single-level .bak before its
// destructive write (mirroring dedup-tracker), so the prior state is always
// recoverable.
console.log('\n🧪 Testing merge-tracker backup-on-write...');
try {
  const row = '| 1 | 2026-01-04 | BackupCo | Widget Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-backupco.md) | original row |';
  let bak = null;
  const merged = mergeFixture('career-ops-merge-bak-', {
    rows: [row],
    reports: { '001-backupco.md': '# fixture', '002-backupco.md': '# fixture' },
    tsvs: { '002-backupco.tsv': '2\t2026-01-05\tBackupCo\tGadget Engineer\tEvaluated\t4.1/5\t❌\t[2](reports/002-backupco.md)\tnew row' },
    inspect: (tracker) => { if (existsSync(`${tracker}.bak`)) bak = readFileSync(`${tracker}.bak`, 'utf-8'); },
  });
  if (merged === null) {
    fail('merge-tracker crashed during backup test');
  } else if (bak === null) {
    fail('merge-tracker did not write a .bak snapshot before the destructive write');
  } else if (bak !== `${TRACKER_HEAD}${row}\n`) {
    fail('merge-tracker .bak does not match the pre-merge tracker content');
  } else if (merged.includes('Gadget Engineer') && merged.includes('Widget Engineer')) {
    pass('merge-tracker writes a pre-merge .bak and still applies the merge');
  } else {
    fail('merge-tracker merge did not apply after backup');
  }
} catch (e) {
  fail(`merge-tracker backup test crashed: ${e.message}`);
}

// ── MERGE-TRACKER REPORT-NUMBER COLLISION (#912) ─────────────────
// The report-number dedup check was not company-guarded: a TSV for NewCo
// with report [1] would find the existing tracker row [1] for OtherCo and
// update it in-place instead of appending NewCo as a new row.
console.log('\n🧪 Testing merge-tracker report-number cross-company collision (#912)...');
try {
  const col912Merged = mergeFixture('career-ops-merge-912-', {
    rows: ['| 1 | 2026-01-01 | OtherCo | Staff Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-otherco-2026-01-01.md) | original |'],
    reports: { '001-otherco-2026-01-01.md': '# fixture', '001-newco-2026-01-05.md': '# fixture' },
    // NewCo TSV also carries report number [1] — cross-company collision
    tsvs: { '001-newco.tsv': '1\t2026-01-05\tNewCo\tNew Role\tEvaluated\t2.7/5\t❌\t[1](reports/001-newco-2026-01-05.md)\tcollision' },
  });
  if (col912Merged === null) {
    fail('merge-tracker crashed during report-number collision test (#912)');
  } else {
    const col912Rows = col912Merged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));
    const expectedOtherCoRow = '| 1 | 2026-01-01 | OtherCo | Staff Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-otherco-2026-01-01.md) | original |';

    if (col912Rows.length === 2) {
      pass('report-number collision (#912): merged tracker has exactly 2 rows');
    } else {
      fail(`report-number collision (#912): expected 2 rows, got ${col912Rows.length}`);
    }

    if (col912Rows.some(r => r.trim() === expectedOtherCoRow.trim())) {
      pass('report-number collision (#912): existing OtherCo row left untouched (exact match)');
    } else {
      fail('report-number collision (#912): OtherCo row was overwritten by NewCo addition');
    }

    const expectedNewCoRow = '| 2 | 2026-01-05 | NewCo | New Role | 2.7/5 | Evaluated | ❌ | [1](../reports/001-newco-2026-01-05.md) | collision |';
    if (col912Rows.some(r => r.trim() === expectedNewCoRow.trim())) {
      pass('report-number collision (#912): NewCo appended as a new entry with correct data');
    } else {
      fail('report-number collision (#912): NewCo entry was swallowed or has incorrect data');
    }
  }
} catch (e) {
  fail(`merge-tracker report-number collision test crashed: ${e.message}`);
}

// ── MERGE-TRACKER CONCURRENT WRITES (#781 follow-up) ─────────────────────
// Report-number reservation is atomic now (#803), but tracker merges are a
// separate read/modify/write step. If two merge-tracker processes read the same
// old applications.md snapshot and then write back independently, one process
// can erase the row added by the other. This fixture gives each process a
// different additions dir and pauses the first process after it has read the
// tracker, making the old race deterministic.
console.log('\n🧪 Testing merge-tracker concurrent writes...');
try {
  const mergeTmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-lock-'));
  /**
   * Spawn one isolated `merge-tracker.mjs` process against the temporary fixture.
   *
   * Each spawned process receives the same tracker path and lock path but a
   * different additions directory. Without serialization, both processes can
   * read the same old tracker and the later write can lose the other row. The
   * first worker also sends an IPC readiness message after reading the tracker
   * and before its test hold, which lets the test launch the second worker at
   * the exact old race point instead of relying on scheduler timing.
   *
   * @param {string} additionsDir - Directory containing this process's TSV row.
   * @param {number} [holdMs=0] - Optional post-read delay injected into the merge.
   * @returns {{ready: Promise<void>, result: Promise<{code:number|null,stdout:string,stderr:string}>}}
   * Worker readiness and final process result promises.
   */
  function spawnMerge(additionsDir, holdMs = 0) {
    let markReady;
    let readyMarked = false;
    const ready = new Promise(resolve => { markReady = resolve; });
    const result = new Promise(resolve => {
      const child = spawn(NODE, ['merge-tracker.mjs'], {
        cwd: ROOT,
        env: {
          ...process.env,
          CAREER_OPS_TRACKER: join(mergeTmp, 'data', 'applications.md'),
          CAREER_OPS_ADDITIONS: additionsDir,
          CAREER_OPS_TRACKER_LOCK: join(mergeTmp, 'career-ops-merge-tracker-fixture.lock'),
          CAREER_OPS_MERGE_HOLD_MS: String(holdMs),
          CAREER_OPS_MERGE_READY_IPC: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = '';
      let stderr = '';
      const resolveReady = () => {
        if (readyMarked) return;
        readyMarked = true;
        markReady();
      };
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('message', msg => {
        if (msg?.type === 'merge-tracker-ready') resolveReady();
      });
      child.on('error', err => {
        resolveReady();
        resolve({ code: -1, stdout, stderr: String(err) });
      });
      child.on('close', code => {
        resolveReady();
        resolve({ code, stdout, stderr });
      });
    });
    return { ready, result };
  }

  /**
   * Fail fast when a worker never reaches the deterministic race checkpoint.
   *
   * A missing readiness signal would otherwise hang the test suite. Timing out
   * turns that broken test contract into a normal assertion failure with a clear
   * message.
   *
   * @param {Promise<void>} ready - Worker readiness promise.
   * @param {number} timeoutMs - Maximum milliseconds to wait.
   * @returns {Promise<void>} Resolves when ready arrives before the timeout.
   */
  function waitForReady(ready, timeoutMs) {
    return Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('merge worker did not signal readiness')), timeoutMs)),
    ]);
  }

  try {
    mkdirSync(join(mergeTmp, 'data'));
    mkdirSync(join(mergeTmp, 'reports'));
    const additionsA = join(mergeTmp, 'additions-a');
    const additionsB = join(mergeTmp, 'additions-b');
    mkdirSync(additionsA);
    mkdirSync(additionsB);

    writeFileSync(join(mergeTmp, 'data', 'applications.md'),
      TRACKER_HEAD);
    writeFileSync(join(mergeTmp, 'reports', '010-alpha-2026-01-07.md'), '# fixture\n');
    writeFileSync(join(mergeTmp, 'reports', '011-beta-2026-01-07.md'), '# fixture\n');
    writeFileSync(join(additionsA, '010-alpha.tsv'),
      '10\t2026-01-07\tAlpha\tPlatform Engineer\tEvaluated\t4.1/5\t❌\t[10](reports/010-alpha-2026-01-07.md)\tfirst concurrent merge\n');
    writeFileSync(join(additionsB, '011-beta.tsv'),
      '11\t2026-01-07\tBeta\tData Engineer\tEvaluated\t4.2/5\t❌\t[11](reports/011-beta-2026-01-07.md)\tsecond concurrent merge\n');

    const first = spawnMerge(additionsA, 350);
    await waitForReady(first.ready, 2_000);
    const second = spawnMerge(additionsB, 0);
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

    if (firstResult.code === 0 && secondResult.code === 0) {
      pass('concurrent merge processes both exited successfully');
    } else {
      fail(`concurrent merge process failed: first=${firstResult.code} second=${secondResult.code} stderr=${firstResult.stderr || secondResult.stderr}`);
    }

    const merged = readFileSync(join(mergeTmp, 'data', 'applications.md'), 'utf-8');
    if (merged.includes('Alpha') && merged.includes('Beta')) {
      pass('concurrent tracker merges preserve rows from both processes');
    } else {
      fail(`concurrent tracker merge lost a row: ${merged}`);
    }
  } finally {
    rmSync(mergeTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker concurrent write test crashed: ${e.message}`);
}

// ── 12. COLD-START TRIGGER ──────────────────────────────────────

console.log('\n12. Cold-start trigger (deterministic onboarding state)');

try {
  // Virgin env: none of the 4 user-layer prerequisites present → must onboard.
  const virgin = mkdtempSync(join(tmpdir(), 'co-cold-'));
  const v = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', virgin]) || '{}');
  if (
    v.onboardingNeeded === true &&
    Array.isArray(v.missing) &&
    v.missing.length === 4 &&
    Array.isArray(v.warnings)
  ) {
    pass('Virgin env → onboarding triggered (4 prerequisites missing)');
  } else {
    fail(`Virgin env not flagged for onboarding: ${JSON.stringify(v)}`);
  }
  rmSync(virgin, { recursive: true, force: true });

  // Fully provisioned env: all 4 present → must NOT onboard.
  const ready = mkdtempSync(join(tmpdir(), 'co-ready-'));
  mkdirSync(join(ready, 'config'), { recursive: true });
  mkdirSync(join(ready, 'modes'), { recursive: true });
  for (const f of ['cv.md', 'config/profile.yml', 'modes/_profile.md', 'portals.yml']) {
    writeFileSync(join(ready, f), 'x');
  }
  const r = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', ready]) || '{}');
  if (r.onboardingNeeded === false && Array.isArray(r.warnings)) {
    pass('Provisioned env → no onboarding');
  } else {
    fail(`Provisioned env falsely flagged for onboarding: ${JSON.stringify(r)}`);
  }
  rmSync(ready, { recursive: true, force: true });

  const claudeDoc = readFile('CLAUDE.md');
  if (
    /node\s+doctor\.mjs\s+--json/.test(claudeDoc) &&
    /"warnings"\s*:\s*\[\.\.\.\]/.test(claudeDoc) &&
    !/Does\s+`cv\.md`\s+exist\?/i.test(claudeDoc)
  ) {
    pass('CLAUDE.md delegates onboarding state to doctor --json');
  } else {
    fail('CLAUDE.md still duplicates onboarding prerequisite checks');
  }
} catch (e) {
  fail(`Cold-start trigger test crashed: ${e.message}`);
}

// ── 15. TRACKER DERIVED INDEX (#918 phase 1) ────────────────────
// applications.md is the source of truth; applications.db is a derived index
// rebuilt from it. Round-trip md → db → md must be lossless for clean input
// (a hard condition from #918 before any phase-2 work), sync must DETECT
// corruption without ever modifying the markdown, and reads must never be
// stale.

console.log('\n15. Tracker derived index (sync/query/export round-trip)');

const sqliteAvailable = run(NODE, ['--no-warnings', '-e', "import('node:sqlite').then(()=>process.exit(0),()=>process.exit(1))"]) !== null;
if (!sqliteAvailable) {
  warn('node:sqlite unavailable (Node < 22.5) — tracker index tests skipped');
} else {
  try {
    const idxTmp = mkdtempSync(join(tmpdir(), 'career-ops-index-'));
    try {
      const md = join(idxTmp, 'applications.md');
      const env = { ...process.env, CAREER_OPS_TRACKER: md };
      const trackerRun = (args) => run(NODE, ['tracker.mjs', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });

      // 1. Round trip: clean canonical input must export byte-identical.
      const clean =
        TRACKER_HEAD +
        '| 2 | 2026-01-05 | Beta | Designer | 4.0/5 | Applied | ✅ | [2](../reports/002-beta-2026-01-05.md) | second |\n' +
        '| 1 | 2026-01-04 | Acme | Engineer | 4.2/5 | Evaluated | ❌ | [1](../reports/001-acme-2026-01-04.md) | first |\n';
      writeFileSync(md, clean);
      if (trackerRun(['sync']) === null) {
        fail('tracker sync crashed on clean fixture');
      } else {
        const exported = trackerRun(['export']);
        if (exported === clean.trim()) {
          pass('round trip md → db → md is lossless on clean input');
        } else {
          fail('round trip is NOT lossless on clean input');
        }
        if (readFileSync(md, 'utf-8') === clean) {
          pass('sync/export never modify the source markdown');
        } else {
          fail('sync/export modified applications.md (source of truth violated)');
        }
      }

      // 2. Corruption is detected and normalized in the index ONLY.
      const corrupted = clean +
        '| 1 | 2026-01-06 | Gamma | PM | — | 3.5/5 | ❌ | 鈥? | drifted |\n'; // dup id + score in status + mojibake
      writeFileSync(md, corrupted);
      if (trackerRun(['sync', '--check']) === null) {
        pass('sync --check exits non-zero when corruption is present');
      } else {
        fail('sync --check did not flag corrupted fixture');
      }
      const queried = JSON.parse(trackerRun(['query', '--company', 'Gamma', '--json']) || '[]');
      if (queried.length === 1 && queried[0].status === 'Evaluated' && queried[0].score === '3.5/5' && queried[0].id === 3) {
        pass('corrupted row is normalized in the index (status/score/id repaired)');
      } else {
        fail(`corrupted row not normalized in index: ${JSON.stringify(queried)}`);
      }
      if (readFileSync(md, 'utf-8') === corrupted) {
        pass('corruption repair never touches the markdown itself');
      } else {
        fail('sync modified the corrupted markdown (must only diagnose)');
      }

      // 3. Staleness: query after an md edit must auto-resync (no stale reads).
      writeFileSync(md, clean +
        '| 3 | 2026-01-07 | Delta | Analyst | 4.5/5 | Applied | ✅ | [3](../reports/003-delta-2026-01-07.md) | new |\n');
      const fresh = JSON.parse(trackerRun(['query', '--company', 'Delta', '--json']) || '[]');
      if (fresh.length === 1) {
        pass('query auto-resyncs when applications.md changed since last sync');
      } else {
        fail('query served a stale index after the markdown changed');
      }

      // 4. Status transitions across syncs accumulate in status_events.
      writeFileSync(md, readFileSync(md, 'utf-8').replace('| 4.0/5 | Applied |', '| 4.0/5 | Interview |'));
      const log = trackerRun(['history', '--id', '2']);
      if (log && log.includes('Applied') && log.includes('Interview')) {
        pass('history records the Applied → Interview transition across syncs');
      } else {
        fail(`history missing status transition: ${log}`);
      }
    } finally {
      rmSync(idxTmp, { recursive: true, force: true });
    }
  } catch (e) {
    fail(`tracker derived-index tests crashed: ${e.message}`);
  }
}

// ── 12b. PLAYWRIGHT MCP DETECTION WARNING (#522) ────────────────

console.log('\n12b. Playwright MCP detection warning');

try {
  // No project MCP config → doctor surfaces a (non-fatal) warning instead of
  // letting SPA job boards fail silently.
  const noMcp = mkdtempSync(join(tmpdir(), 'co-nomcp-'));
  const a = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', noMcp]) || '{}');
  if (Array.isArray(a.warnings) && a.warnings.some((w) => /playwright mcp/i.test(w))) {
    pass('No Playwright MCP config → warning surfaced');
  } else {
    fail(`Expected a Playwright MCP warning, got: ${JSON.stringify(a.warnings)}`);
  }
  rmSync(noMcp, { recursive: true, force: true });

  // A project that registers a Playwright MCP server → no warning.
  const withMcp = mkdtempSync(join(tmpdir(), 'co-mcp-'));
  mkdirSync(join(withMcp, '.claude'), { recursive: true });
  writeFileSync(
    join(withMcp, '.claude', 'settings.json'),
    JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp', '--headless'] } } }),
  );
  const b = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', withMcp]) || '{}');
  if (Array.isArray(b.warnings) && !b.warnings.some((w) => /playwright mcp/i.test(w))) {
    pass('Playwright MCP configured → no warning');
  } else {
    fail(`Did not expect a Playwright MCP warning, got: ${JSON.stringify(b.warnings)}`);
  }
  rmSync(withMcp, { recursive: true, force: true });
} catch (e) {
  fail(`Playwright MCP detection test crashed: ${e.message}`);
}

// ── 15. PROVIDERS — SolidJobs ─────────────────────────────────────

console.log('\n15. Provider — solidjobs');

try {
  const sj = (await import(pathToFileURL(join(ROOT, 'providers/solidjobs.mjs')).href)).default;

  if (sj.id === 'solidjobs') pass('solidjobs.id is "solidjobs"');
  else fail(`solidjobs.id is ${JSON.stringify(sj.id)}`);

  // detect() matches valid SolidJobs API URL
  const hit = sj.detect({ name: 'SJ', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' });
  if (hit && hit.url) pass('solidjobs.detect() matches valid API URL');
  else fail('solidjobs.detect() should match solid.jobs public-api URL');

  // detect() rejects non-SolidJobs URL
  if (sj.detect({ name: 'X', careers_url: 'https://example.com/jobs' }) === null) {
    pass('solidjobs.detect() rejects non-SolidJobs URL');
  } else {
    fail('solidjobs.detect() must reject non-SolidJobs URLs');
  }

  // detect() rejects path-spoofed URL (solid.jobs in path, not hostname)
  if (sj.detect({ name: 'X', careers_url: 'https://evil.example/solid.jobs/public-api/offers/it' }) === null) {
    pass('solidjobs.detect() rejects path-spoofed URLs');
  } else {
    fail('solidjobs.detect() must NOT misdetect URLs with solid.jobs in the path');
  }

  // detect() returns null for non-string careers_url
  if (sj.detect({ name: 'X', careers_url: 42 }) === null) {
    pass('solidjobs.detect() returns null for non-string careers_url (42)');
  } else {
    fail('solidjobs.detect() should treat non-string careers_url as missing');
  }

  // detect() returns null for missing careers_url
  if (sj.detect({ name: 'X' }) === null) {
    pass('solidjobs.detect() returns null for missing careers_url');
  } else {
    fail('solidjobs.detect() should return null when careers_url is missing');
  }

  // fetch() parses { jobs: [...] } response with company from API
  const fakeJobs = {
    jobs: [
      { title: 'Senior Dev', url: 'https://solid.jobs/o/abc123/career-ops', company: 'Acme Corp', locations: ['Warszawa', 'Remote'] },
      { title: 'Junior Dev', url: 'https://solid.jobs/o/def456/career-ops', company: 'Beta Inc', locations: ['Kraków'] },
    ],
  };
  const parsed = await sj.fetch(
    { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
    { transport: 'http', fetchJson: async () => fakeJobs, fetchText: async () => '' },
  );
  if (parsed.length === 2) pass('solidjobs.fetch() returns 2 jobs from mock response');
  else fail(`solidjobs.fetch() returned ${parsed.length} jobs, expected 2`);

  if (parsed[0].company === 'Acme Corp') pass('solidjobs.fetch() uses j.company from API response');
  else fail(`solidjobs.fetch() company is ${JSON.stringify(parsed[0].company)}, expected "Acme Corp"`);

  if (parsed[0].location === 'Warszawa, Remote') pass('solidjobs.fetch() joins locations array');
  else fail(`solidjobs.fetch() location is ${JSON.stringify(parsed[0].location)}, expected "Warszawa, Remote"`);

  if (parsed[0].title === 'Senior Dev' && parsed[0].url === 'https://solid.jobs/o/abc123/career-ops') {
    pass('solidjobs.fetch() maps title and url correctly');
  } else {
    fail(`solidjobs.fetch() title/url wrong: ${JSON.stringify(parsed[0])}`);
  }

  // fetch() falls back to entry.name when j.company is missing
  const noCompanyJobs = { jobs: [{ title: 'Tester', url: 'https://solid.jobs/o/xyz/career-ops', locations: [] }] };
  const fallback = await sj.fetch(
    { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
    { transport: 'http', fetchJson: async () => noCompanyJobs, fetchText: async () => '' },
  );
  if (fallback[0].company === 'SolidJobs IT') pass('solidjobs.fetch() falls back to entry.name when j.company missing');
  else fail(`solidjobs.fetch() fallback company is ${JSON.stringify(fallback[0].company)}`);

  // fetch() handles empty locations array
  if (fallback[0].location === '') pass('solidjobs.fetch() returns empty string for empty locations array');
  else fail(`solidjobs.fetch() location for empty array is ${JSON.stringify(fallback[0].location)}`);

  // fetch() rejects non-SolidJobs hostname (SSRF)
  let ssrfRejected = false;
  try {
    await sj.fetch(
      { name: 'Evil', careers_url: 'https://evil.com/public-api/offers/it' },
      { transport: 'http', fetchJson: async () => { throw new Error('SSRF! should not reach here'); }, fetchText: async () => '' },
    );
  } catch (e) {
    if (e.message.includes('untrusted hostname')) ssrfRejected = true;
    else fail(`solidjobs.fetch() rejected with wrong error: ${e.message}`);
  }
  if (ssrfRejected) pass('solidjobs.fetch() rejects untrusted hostname (SSRF protection)');
  else fail('solidjobs.fetch() should reject non-solid.jobs hostnames');

  // fetch() throws on missing careers_url
  let missingUrl = false;
  try {
    await sj.fetch(
      { name: 'No URL' },
      { transport: 'http', fetchJson: async () => ({}), fetchText: async () => '' },
    );
  } catch (e) {
    if (e.message.includes('careers_url required')) missingUrl = true;
    else fail(`solidjobs.fetch() missing URL error: ${e.message}`);
  }
  if (missingUrl) pass('solidjobs.fetch() throws on missing careers_url');
  else fail('solidjobs.fetch() should throw when careers_url is missing');

  // fetch() rejects HTTP (non-HTTPS) URL
  let httpRejected = false;
  try {
    await sj.fetch(
      { name: 'HTTP', careers_url: 'http://solid.jobs/public-api/offers/it' },
      { transport: 'http', fetchJson: async () => { throw new Error('should not reach here'); }, fetchText: async () => '' },
    );
  } catch (e) {
    if (e.message.includes('HTTPS')) httpRejected = true;
    else fail(`solidjobs.fetch() HTTP rejection wrong error: ${e.message}`);
  }
  if (httpRejected) pass('solidjobs.fetch() rejects HTTP URLs (HTTPS enforcement)');
  else fail('solidjobs.fetch() should reject non-HTTPS URLs');

  // fetch() rejects malformed/unparseable URL
  let malformedRejected = false;
  try {
    await sj.fetch(
      { name: 'Bad', careers_url: 'not-a-url' },
      { transport: 'http', fetchJson: async () => { throw new Error('should not reach here'); }, fetchText: async () => '' },
    );
  } catch (e) {
    if (e.message.includes('invalid URL')) malformedRejected = true;
    else fail(`solidjobs.fetch() malformed URL wrong error: ${e.message}`);
  }
  if (malformedRejected) pass('solidjobs.fetch() rejects malformed URLs');
  else fail('solidjobs.fetch() should reject unparseable URLs');

  // fetch() throws on unexpected API response (no jobs array)
  const badResponses = [
    [{}, 'empty object'],
    [{ jobs: null }, 'jobs: null'],
    [{ jobs: 'not-array' }, 'jobs: string'],
    [{ offers: [] }, 'wrong key name'],
    [null, 'null response'],
  ];
  for (const [resp, label] of badResponses) {
    let threw = false;
    try {
      await sj.fetch(
        { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
        { transport: 'http', fetchJson: async () => resp, fetchText: async () => '' },
      );
    } catch (e) {
      if (e.message.includes('unexpected API response')) threw = true;
      else fail(`solidjobs.fetch() bad response (${label}) wrong error: ${e.message}`);
    }
    if (threw) pass(`solidjobs.fetch() throws on bad API response (${label})`);
    else fail(`solidjobs.fetch() should throw on bad API response (${label})`);
  }

  // fetch() filters out jobs with empty/missing url
  const mixedJobs = {
    jobs: [
      { title: 'Has URL', url: 'https://solid.jobs/o/1/career-ops', company: 'A', locations: [] },
      { title: 'No URL', url: '', company: 'B', locations: [] },
      { title: 'Missing URL', company: 'C', locations: [] },
    ],
  };
  const filtered = await sj.fetch(
    { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
    { transport: 'http', fetchJson: async () => mixedJobs, fetchText: async () => '' },
  );
  if (filtered.length === 1 && filtered[0].title === 'Has URL') pass('solidjobs.fetch() filters out jobs with empty/missing url');
  else fail(`solidjobs.fetch() should filter empty URLs, got ${filtered.length} jobs: ${JSON.stringify(filtered)}`);

  // fetch() handles string locations (non-array)
  const stringLocJobs = { jobs: [{ title: 'Dev', url: 'https://solid.jobs/o/2/career-ops', company: 'X', locations: 'Warsaw' }] };
  const strLoc = await sj.fetch(
    { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
    { transport: 'http', fetchJson: async () => stringLocJobs, fetchText: async () => '' },
  );
  if (strLoc[0].location === 'Warsaw') pass('solidjobs.fetch() handles string locations');
  else fail(`solidjobs.fetch() string location is ${JSON.stringify(strLoc[0].location)}, expected "Warsaw"`);

  // detect() returns null for valid hostname but wrong path
  if (sj.detect({ name: 'X', careers_url: 'https://solid.jobs/careers' }) === null) {
    pass('solidjobs.detect() rejects solid.jobs URL with wrong path');
  } else {
    fail('solidjobs.detect() should reject solid.jobs URLs not under /public-api/offers/');
  }

  // fetch() passes redirect:'error' to fetchJson
  let capturedOpts = null;
  await sj.fetch(
    { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
    { transport: 'http', fetchJson: async (_url, opts) => { capturedOpts = opts; return { jobs: [] }; }, fetchText: async () => '' },
  );
  if (capturedOpts && capturedOpts.redirect === 'error') pass('solidjobs.fetch() passes redirect:"error" to fetchJson');
  else fail(`solidjobs.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);

  // fetch() tolerates malformed array members without crashing
  const malformedMembers = { jobs: [null, 7, { title: 'OK', url: 'https://solid.jobs/o/3/career-ops', company: 'Z' }] };
  const safeParsed = await sj.fetch(
    { name: 'SolidJobs IT', careers_url: 'https://solid.jobs/public-api/offers/it?campaign=career-ops' },
    { transport: 'http', fetchJson: async () => malformedMembers, fetchText: async () => '' },
  );
  if (safeParsed.length === 1 && safeParsed[0].url === 'https://solid.jobs/o/3/career-ops') {
    pass('solidjobs.fetch() skips malformed jobs members without crashing');
  } else {
    fail(`solidjobs.fetch() malformed members handling failed: ${JSON.stringify(safeParsed)}`);
  }
} catch (e) {
  fail(`solidjobs provider tests crashed: ${e.message}`);
}

// ── 15. URL REDISCOVERY FALLBACK (--rediscover-404) ─────────────

console.log('\n15. URL rediscovery fallback');

try {
  const { extractCareersUrlDomain, pickRediscoveredUrl } = await import(
    pathToFileURL(join(ROOT, 'scan.mjs')).href
  );

  // extractCareersUrlDomain — pure hostname extraction, null on missing/invalid
  if (extractCareersUrlDomain('https://job-boards.greenhouse.io/anthropic') === 'job-boards.greenhouse.io') {
    pass('extractCareersUrlDomain pulls hostname from a careers URL');
  } else {
    fail('extractCareersUrlDomain failed on a valid URL');
  }
  if (extractCareersUrlDomain(null) === null) {
    pass('extractCareersUrlDomain returns null for missing careers_url');
  } else {
    fail('extractCareersUrlDomain did not return null for null input');
  }
  if (extractCareersUrlDomain('not-a-url') === null) {
    pass('extractCareersUrlDomain returns null for an unparseable URL');
  } else {
    fail('extractCareersUrlDomain did not return null for a bad URL');
  }

  // pickRediscoveredUrl — first search hit whose hostname exactly matches domain
  const domain = 'job-boards.greenhouse.io';
  const hrefs = [
    'https://duckduckgo.com/l/?uddg=ad',          // search-engine chrome / noise
    'https://other-board.lever.co/acme/123',      // wrong domain
    'https://job-boards.greenhouse.io/acme/456',  // first real match
    'https://job-boards.greenhouse.io/acme/789',  // later match
  ];
  if (pickRediscoveredUrl(hrefs, domain) === 'https://job-boards.greenhouse.io/acme/456') {
    pass('pickRediscoveredUrl returns the first same-domain result');
  } else {
    fail(`pickRediscoveredUrl picked the wrong URL: ${pickRediscoveredUrl(hrefs, domain)}`);
  }
  if (pickRediscoveredUrl(['https://elsewhere.com/x'], domain) === null) {
    pass('pickRediscoveredUrl returns null when no result matches the domain');
  } else {
    fail('pickRediscoveredUrl did not return null for no domain match');
  }
  if (pickRediscoveredUrl([], domain) === null) {
    pass('pickRediscoveredUrl returns null for an empty result set');
  } else {
    fail('pickRediscoveredUrl did not return null for empty input');
  }
  // Redirect unwrapping is restricted to real DuckDuckGo hosts: a look-alike
  // host must not get its uddg target unwrapped (and its own hostname does not
  // match the careers domain, so the result is null).
  const lookAlike = `https://evil-duckduckgo.com/l/?uddg=${encodeURIComponent('https://job-boards.greenhouse.io/acme/456')}`;
  if (pickRediscoveredUrl([lookAlike], domain) === null) {
    pass('pickRediscoveredUrl ignores uddg redirects from look-alike hosts');
  } else {
    fail('pickRediscoveredUrl unwrapped a redirect from a look-alike host');
  }
  // DuckDuckGo HTML wraps each result in a /l/?uddg= redirect — must be
  // unwrapped, otherwise every hostname looks like duckduckgo.com and nothing
  // ever matches the careers domain (the fallback would silently never fire).
  const ddg = ['//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://job-boards.greenhouse.io/acme/999')];
  if (pickRediscoveredUrl(ddg, domain) === 'https://job-boards.greenhouse.io/acme/999') {
    pass('pickRediscoveredUrl unwraps DuckDuckGo redirect links');
  } else {
    fail(`pickRediscoveredUrl did not unwrap DDG redirect: ${pickRediscoveredUrl(ddg, domain)}`);
  }
  // A look-alike host that merely contains the domain as a substring must not match.
  if (pickRediscoveredUrl(['https://job-boards.greenhouse.io.attacker.com/x'], domain) === null) {
    pass('pickRediscoveredUrl rejects look-alike hostnames');
  } else {
    fail('pickRediscoveredUrl accepted a look-alike hostname');
  }
} catch (e) {
  fail(`URL rediscovery tests crashed: ${e.message}`);
}

// ── 13. BATCH RATE-LIMIT PAUSE ──────────────────────────────────

console.log('\n13. Batch rate-limit pause');

const BASH = resolveBash();
if (!BASH) {
  // Skip rather than fail: these two assertions exercise batch-runner.sh, and
  // a machine with no working bash cannot speak to their correctness either
  // way. Failing here would report a environment gap as a product defect.
  warn('no working bash found — skipping batch rate-limit pause tests (set CAREER_OPS_BASH to override)');
}
try {
  if (!BASH) throw { skip: true };
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-rate-'));
  const batchDir = join(tmp, 'batch');
  const fakeBin = join(tmp, 'bin');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(join(tmp, 'reports'), { recursive: true });
  mkdirSync(join(tmp, 'data'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n'));
  if (process.platform === 'win32') {
    try { execFileSync(BASH, ['-c', 'chmod +x batch/batch-runner.sh'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(batchDir, 'batch-runner.sh')]);
  }
  writeFileSync(join(tmp, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(tmp, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(batchDir, 'batch-input.tsv'), [
    'id\turl\tsource\tnotes',
    '1\thttps://example.com/one\tfixture\t-',
    '2\thttps://example.com/two\tfixture\t-',
    '3\thttps://example.com/three\tfixture\t-',
  ].join('\n') + '\n');
  writeFileSync(join(fakeBin, 'claude'), [
    '#!/usr/bin/env bash',
    'echo "You\\x27ve hit your session limit · resets 12:30pm (Asia/Taipei)"',
    'exit 1',
  ].join('\n') + '\n');
  if (process.platform === 'win32') {
    try { execFileSync(BASH, ['-c', 'chmod +x bin/claude'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(fakeBin, 'claude')]);
  }

  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` };
  // Not run(): it returns null on a non-zero exit or its 30 s timeout, and under load (a
  // full scan running beside the suite, 2026-10-29) the runner finished its job correctly
  // while the test saw "" and failed. Keep stdout from a failed exit too, and allow longer.
  let out = '';
  try {
    out = execFileSync(BASH, [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1', '--max-retries', '3', '--rate-limit-sleep', '0'], {
      cwd: tmp, env, encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const state = readFileSync(join(batchDir, 'batch-state.tsv'), 'utf-8').trim().split('\n');
  const first = state[1]?.split('\t') || [];

  if (state.length === 2 && first[0] === '1' && first[2] === 'paused_rate_limit' && first[8] === '0' && out.includes('pausing batch')) {
    pass('session-limit pauses batch without consuming retry budget or scheduling more jobs');
  } else {
    fail(`session-limit pause wrong: lines=${state.length}, first=${JSON.stringify(first)}, out=${JSON.stringify(out.slice(-240))}`);
  }

  writeFileSync(join(batchDir, 'batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://example.com/one\tpaused_rate_limit\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t001\t-\tsession-limit; paused\t0',
    '2\thttps://example.com/two\tfailed\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t002\t-\tworker-crash\t1',
  ].join('\n') + '\n');
  const dry = run(BASH, [toBashPath(join(batchDir, 'batch-runner.sh')), '--resume-paused', '--dry-run'], {
    cwd: tmp,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) || '';
  if (dry.includes('#1: https://example.com/one') && !dry.includes('#2: https://example.com/two')) {
    pass('--resume-paused dry-run selects paused jobs only');
  } else {
    fail(`--resume-paused selection wrong: ${dry}`);
  }

  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) {
  if (!e?.skip) fail(`Batch rate-limit pause test crashed: ${e.message}`);
}

// ── 15. BATCH RUNNER MCP ISOLATION (#506) ───────────────────────

console.log('\n15. Batch runner MCP isolation');

try {
  const batchRunner = readFileSync(join(ROOT, 'batch', 'batch-runner.sh'), 'utf-8');
  // Workers must be spawned with --strict-mcp-config so they don't inherit the
  // parent session's MCP servers (e.g. Playwright) and deadlock fighting over a
  // single browser when --parallel > 1 (issue #506).
  const claudeArgsLine = batchRunner
    .split('\n')
    .find(l => l.includes('claude_args=('));
  if (claudeArgsLine && claudeArgsLine.includes('--strict-mcp-config')) {
    pass('batch workers spawn with --strict-mcp-config (no inherited MCP)');
  } else {
    fail('batch-runner.sh worker spawn missing --strict-mcp-config (issue #506 regression)');
  }
} catch (e) {
  fail(`Batch runner MCP isolation test crashed: ${e.message}`);
}

// ── 17. COVER LETTER GREETING BLOCK ─────────────────────────────

console.log('\n17. Cover letter greeting block');

try {
  const { buildHtml } = await import(pathToFileURL(join(ROOT, 'generate-cover-letter.mjs')).href);

  const basePayload = {
    candidate: { name: 'Jane Doe' },
    letter: {
      role_title: 'Head of Applied AI',
      opening: 'OPENING_MARKER sentence.',
      profile_intro: 'Profile intro.',
    },
  };

  // (a) greeting present → renders <p class="greeting"> above the opening
  const withGreeting = buildHtml({
    ...basePayload,
    letter: { ...basePayload.letter, greeting: 'Dear Hiring Manager,' },
  });
  const greetingTag = '<p class="greeting">Dear Hiring Manager,</p>';
  const greetingIdx = withGreeting.indexOf(greetingTag);
  const openingIdx = withGreeting.indexOf('OPENING_MARKER');
  if (greetingIdx !== -1 && openingIdx !== -1 && greetingIdx < openingIdx) {
    pass('Greeting renders as <p class="greeting"> above the opening');
  } else {
    fail(`Greeting block missing or misordered (greeting=${greetingIdx}, opening=${openingIdx})`);
  }

  // greeting text is HTML-escaped
  const escaped = buildHtml({
    ...basePayload,
    letter: { ...basePayload.letter, greeting: 'Dear <O\'Brien> & "Co",' },
  });
  if (escaped.includes('Dear &lt;O&#39;Brien&gt; &amp; &quot;Co&quot;,') && !escaped.includes('Dear <O\'Brien>')) {
    pass('Greeting text is HTML-escaped');
  } else {
    fail('Greeting text was not HTML-escaped');
  }

  // (b) greeting omitted → no salutation, no leftover token (backward compatible)
  const withoutGreeting = buildHtml(basePayload);
  if (!withoutGreeting.includes('class="greeting"')
      && !withoutGreeting.includes('{{GREETING_BLOCK}}')
      && withoutGreeting.includes('OPENING_MARKER')) {
    pass('Omitted greeting leaves no salutation and no leftover token (backward compatible)');
  } else {
    fail('Omitted greeting did not render cleanly (stray greeting markup or unreplaced token)');
  }
} catch (e) {
  fail(`Cover letter greeting test crashed: ${e.message}`);
}

// ── 18. COVER LETTER SINGLE-PASS SUBSTITUTION ───────────────────

console.log('\n18. Cover letter single-pass substitution');

try {
  const { buildHtml } = await import(pathToFileURL(join(ROOT, 'generate-cover-letter.mjs')).href);

  // A field value that itself contains literal {{TOKEN}} sequences must NOT be
  // re-substituted. The old iterative split/join loop would have blanked these
  // (no footnotes/closing in the payload → replaced with ""). Single-pass leaves
  // them verbatim because replacement output is never re-scanned.
  const injected = buildHtml({
    candidate: { name: 'Jane Doe' },
    letter: {
      role_title: 'Engineer',
      opening: 'See {{FOOTNOTES_BLOCK}} and {{CLOSING_BLOCK}} markers.',
      profile_intro: 'Intro.',
    },
  });

  if (injected.includes('See {{FOOTNOTES_BLOCK}} and {{CLOSING_BLOCK}} markers.')) {
    pass('Field values containing {{TOKEN}} are left literal (single-pass, not re-substituted)');
  } else {
    fail('A field value containing {{TOKEN}} was re-substituted');
  }

  // Known template tokens still resolve, and no unreplaced tokens leak through.
  if (injected.includes('Jane Doe') && !injected.includes('{{NAME}}') && !injected.includes('{{ROLE_TITLE}}')) {
    pass('Known template tokens still substitute under single-pass');
  } else {
    fail('Single-pass substitution left a known token unreplaced');
  }
} catch (e) {
  fail(`Cover letter single-pass substitution test crashed: ${e.message}`);
}

// ── 19. FONT INLINING (#951) ────────────────────────────────────

console.log('\n19. Font inlining (data: URLs, #951)');

try {
  // Importing must not trigger the CLI (the import.meta.url guard); it
  // exposes inlineLocalFonts, which renderHtmlToPdf runs before setContent.
  const { inlineLocalFonts } = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);

  // Chromium blocks file:// subresources from setContent() pages (the page
  // stays at about:blank), so ./fonts refs must become data: URLs (#951).
  const fontFile = readdirSync(join(ROOT, 'fonts')).find(f => f.endsWith('.woff2'));
  const inlined = await inlineLocalFonts(
    `<style>@font-face { src: url('./fonts/${fontFile}') format('woff2'); }</style>`
  );
  if (inlined.includes('data:font/woff2;base64,') && !inlined.includes('./fonts/')) {
    pass('local ./fonts references are inlined as data: URLs');
  } else {
    fail('./fonts reference was not inlined as a data: URL — fonts will silently fall back (#951)');
  }

  // A missing font file must not corrupt the HTML or throw.
  const missing = await inlineLocalFonts(`<style>src: url('./fonts/does-not-exist.woff2');</style>`);
  if (missing.includes(`url('./fonts/does-not-exist.woff2')`)) {
    pass('missing font files keep their original reference');
  } else {
    fail('missing font file mangled the url() reference');
  }

  // Traversal outside fonts/ must never be inlined — neither via ".."
  // segments nor via absolute names (resolve() returns those verbatim).
  const traversal = await inlineLocalFonts(`<style>src: url('./fonts/../cv.md');</style>`);
  if (traversal.includes(`url('./fonts/../cv.md')`)) {
    pass('path traversal outside fonts/ is not inlined');
  } else {
    fail('path traversal escaped the fonts/ directory');
  }
  const absolute = await inlineLocalFonts(`<style>src: url('./fonts//etc/passwd');</style>`);
  if (absolute.includes(`url('./fonts//etc/passwd')`)) {
    pass('absolute-path escape (./fonts//etc/passwd) is not inlined');
  } else {
    fail('absolute-path reference escaped the fonts/ directory');
  }
} catch (e) {
  fail(`font inlining test crashed: ${e.message}`);
}

// ── 20. LATEX VALIDATOR I18N ── REMOVED (fork) ──────────────────
// LaTeX export (generate-latex.mjs) was pruned for the Windows-native,
// English-only fork, so the LaTeX-validator i18n checks (localized sections,
// section-count, CJK guard) are gone with it. The HTML→PDF path is the only
// CV output; its CJK handling is still covered by section 21 below.

// ── 21. CJK CV RENDERING (lang="ja" font fallback) ──────────────

console.log('\n21. CJK CV rendering (lang="ja" font fallback)');

try {
  // The bundled webfonts are Latin-only, so a Japanese CV (html lang="ja")
  // needs a CJK system-font fallback or it renders as tofu (□) in headless
  // Chromium. This mirrors the existing lang="ar" handling.
  const template = readFileSync(join(ROOT, 'templates', 'cv-template.html'), 'utf-8');

  if (/html\[lang="ja"\]\s+body/.test(template)) {
    pass('cv-template.html has a lang="ja" body rule for CJK text');
  } else {
    fail('cv-template.html is missing a lang="ja" font fallback — Japanese CVs render as tofu (□)');
  }

  // The fallback must name a real CJK font family, not just rely on sans-serif
  // (the generic sans-serif has no CJK glyphs on minimal/CI environments).
  const cjkFonts = ['Hiragino Sans', 'Yu Gothic', 'Noto Sans CJK JP', 'Noto Sans JP', 'Meiryo', 'MS PGothic'];
  const jaBlock = template.slice(template.indexOf('html[lang="ja"]'));
  if (cjkFonts.some((f) => jaBlock.includes(f))) {
    pass('lang="ja" rules name a concrete CJK font family');
  } else {
    fail('lang="ja" rules do not name any CJK font family — CJK fallback will not work');
  }
} catch (e) {
  fail(`CJK rendering test crashed: ${e.message}`);
}

// ── 22. PROVIDERS — Jobstreet ──────────────────────────────────────

console.log('\n22. Provider — jobstreet');

try {
  const jobstreet = (await import(pathToFileURL(join(ROOT, 'providers/jobstreet.mjs')).href)).default;
  const { parseJobstreetItem } = await import(pathToFileURL(join(ROOT, 'providers/jobstreet.mjs')).href);

  // id check
  if (jobstreet.id === 'jobstreet') pass('jobstreet.id is "jobstreet"');
  else fail(`jobstreet.id is ${JSON.stringify(jobstreet.id)}`);

  // detect() always returns null (job board, not ATS)
  if (jobstreet.detect({ name: 'X', careers_url: 'https://id.jobstreet.com/jobs' }) === null) {
    pass('jobstreet.detect() returns null — explicit provider only, no URL auto-detection');
  } else {
    fail('jobstreet.detect() should return null for any URL');
  }

  // parseJobstreetItem — valid item
  const sampleItem = {
    id: 123456,
    title: 'Senior Data Scientist',
    branding: { companyName: 'TechCorp Indonesia' },
    location: 'Jakarta Selatan',
    listingDate: '2026-06-15T00:00:00Z',
    jobUrl: '/id/job/123456',
  };
  const parsed = parseJobstreetItem(sampleItem, 'https://id.jobstreet.com', 'FallbackCo');
  if (parsed && parsed.title === 'Senior Data Scientist'
      && parsed.url === 'https://id.jobstreet.com/id/job/123456'
      && parsed.company === 'TechCorp Indonesia'
      && parsed.location === 'Jakarta Selatan'
      && parsed.postedAt != null) {
    pass('parseJobstreetItem extracts title, url, company, location, postedAt correctly');
  } else {
    fail(`parseJobstreetItem returned ${JSON.stringify(parsed)}`);
  }

  // parseJobstreetItem — resolves absolute URL without modification
  const absItem = { id: 1, title: 'Role', jobUrl: 'https://id.jobstreet.com/id/job/999' };
  const absParsed = parseJobstreetItem(absItem, 'https://id.jobstreet.com', 'Co');
  if (absParsed && absParsed.url === 'https://id.jobstreet.com/id/job/999') {
    pass('parseJobstreetItem preserves absolute URLs');
  } else {
    fail(`parseJobstreetItem absolute URL: ${JSON.stringify(absParsed)}`);
  }

  // parseJobstreetItem — rejects items without title
  if (parseJobstreetItem({ jobUrl: '/id/job/1' }, 'https://id.jobstreet.com', 'Co') === null) {
    pass('parseJobstreetItem returns null for items without title');
  } else {
    fail('parseJobstreetItem should return null for title-less items');
  }

  // parseJobstreetItem — rejects items without url
  if (parseJobstreetItem({ title: 'Role' }, 'https://id.jobstreet.com', 'Co') === null) {
    pass('parseJobstreetItem returns null for items without jobUrl');
  } else {
    fail('parseJobstreetItem should return null for URL-less items');
  }

  // parseJobstreetItem — rejects off-domain URLs
  const offDomain = parseJobstreetItem(
    { title: 'Role', jobUrl: 'https://evil.example.com/jobs/1' },
    'https://id.jobstreet.com', 'Co'
  );
  if (offDomain === null) pass('parseJobstreetItem rejects off-domain job URLs');
  else fail(`parseJobstreetItem should reject off-domain URLs, got ${JSON.stringify(offDomain)}`);

  // parseJobstreetItem — handles null/malformed input safely
  if (parseJobstreetItem(null, 'https://id.jobstreet.com', 'Co') === null) pass('parseJobstreetItem(null) → null');
  else fail('parseJobstreetItem(null) should return null');
  if (parseJobstreetItem(7, 'https://id.jobstreet.com', 'Co') === null) pass('parseJobstreetItem(7) → null');
  else fail('parseJobstreetItem(number) should return null');

  // parseJobstreetItem — fallback company when branding is missing
  const noBrand = parseJobstreetItem(
    { id: 1, title: 'Engineer', jobUrl: '/id/job/42' },
    'https://id.jobstreet.com', 'PortalFallback'
  );
  if (noBrand && noBrand.company === 'PortalFallback') {
    pass('parseJobstreetItem uses fallback company when branding is absent');
  } else {
    fail(`parseJobstreetItem fallback company: ${JSON.stringify(noBrand)}`);
  }

  // fetch() — happy path with mock context
  const mockCtx = {
    transport: 'http',
    fetchJson: async (url) => {
      if (!url.startsWith('https://id.jobstreet.com/')) throw new Error('Unexpected URL');
      return {
        data: [
          { id: 1, title: 'AI Engineer', branding: { companyName: 'TestCo' }, location: 'Remote', listingDate: '2026-01-01T00:00:00Z', jobUrl: '/id/job/1' },
        ],
      };
    },
    fetchText: async () => { throw new Error('should not be called'); },
  };
  const jobs = await jobstreet.fetch(
    { name: 'Jobstreet ID', provider: 'jobstreet', searchKeywords: 'AI' },
    mockCtx,
  );
  if (jobs.length === 1 && jobs[0].title === 'AI Engineer') pass('jobstreet.fetch() returns parsed jobs');
  else fail(`jobstreet.fetch() returned ${JSON.stringify(jobs)}`);

  // fetch() — handles empty results
  const emptyCtx = {
    transport: 'http',
    fetchJson: async () => ({ data: [] }),
    fetchText: async () => { throw new Error('should not be called'); },
  };
  const emptyJobs = await jobstreet.fetch(
    { name: 'Jobstreet ID', provider: 'jobstreet', searchKeywords: 'nonexistent' },
    emptyCtx,
  );
  if (emptyJobs.length === 0) pass('jobstreet.fetch() handles empty results');
  else fail(`jobstreet.fetch() should return empty array for no results, got ${emptyJobs.length}`);

  // fetch() — rejects invalid hostname
  let hostRejected = false;
  try {
    await jobstreet.fetch(
      { name: 'Bad', provider: 'jobstreet', api: 'https://evil.example.com/api/search' },
      { transport: 'http', fetchJson: async () => ({}), fetchText: async () => '' },
    );
  } catch (e) {
    if (e.message.includes('untrusted hostname')) hostRejected = true;
    else fail(`jobstreet.fetch() host rejection wrong error: ${e.message}`);
  }
  if (hostRejected) pass('jobstreet.fetch() rejects untrusted hostnames');
  else fail('jobstreet.fetch() should reject non-jobstreet hostnames');

  // fetch() — handles non-array data field
  const badDataCtx = {
    transport: 'http',
    fetchJson: async () => ({ data: null }),
    fetchText: async () => { throw new Error('should not be called'); },
  };
  const badDataJobs = await jobstreet.fetch(
    { name: 'Jobstreet ID', provider: 'jobstreet', searchKeywords: 'test' },
    badDataCtx,
  );
  if (badDataJobs.length === 0) pass('jobstreet.fetch() handles null data field');
  else fail(`jobstreet.fetch() should return empty for null data`);

} catch (e) {
  fail(`jobstreet provider tests crashed: ${e.message}`);
}

// ── 23. PROVIDERS — Glints ─────────────────────────────────────────

console.log('\n23. Provider — glints');

try {
  const glints = (await import(pathToFileURL(join(ROOT, 'providers/glints.mjs')).href)).default;
  const { parseGlintsItem } = await import(pathToFileURL(join(ROOT, 'providers/glints.mjs')).href);

  // id check
  if (glints.id === 'glints') pass('glints.id is "glints"');
  else fail(`glints.id is ${JSON.stringify(glints.id)}`);

  // detect() always returns null (job board, not ATS)
  if (glints.detect({ name: 'X', careers_url: 'https://glints.com/id/jobs' }) === null) {
    pass('glints.detect() returns null — explicit provider only, no URL auto-detection');
  } else {
    fail('glints.detect() should return null for any URL');
  }

  // parseGlintsItem — valid item
  const sampleItem = {
    id: 'abc123',
    title: 'Backend Engineer',
    company: { name: 'StartupCorp' },
    location: 'Jakarta, Indonesia',
    postedAt: '2026-06-10T00:00:00Z',
    url: 'https://glints.com/id/jobs/backend-engineer/abc123',
  };
  const parsed = parseGlintsItem(sampleItem, 'https://glints.com', 'FallbackCo');
  if (parsed && parsed.title === 'Backend Engineer'
      && parsed.url === 'https://glints.com/id/jobs/backend-engineer/abc123'
      && parsed.company === 'StartupCorp'
      && parsed.location === 'Jakarta, Indonesia'
      && parsed.postedAt != null) {
    pass('parseGlintsItem extracts title, url, company, location, postedAt correctly');
  } else {
    fail(`parseGlintsItem returned ${JSON.stringify(parsed)}`);
  }

  // parseGlintsItem — resolves relative URL
  const relItem = { id: 'x', title: 'Dev', url: '/id/jobs/dev/x' };
  const relParsed = parseGlintsItem(relItem, 'https://glints.com', 'Co');
  if (relParsed && relParsed.url === 'https://glints.com/id/jobs/dev/x') {
    pass('parseGlintsItem resolves relative URLs');
  } else {
    fail(`parseGlintsItem relative URL: ${JSON.stringify(relParsed)}`);
  }

  // parseGlintsItem — rejects items without title
  if (parseGlintsItem({ url: 'https://glints.com/job/1' }, 'https://glints.com', 'Co') === null) {
    pass('parseGlintsItem returns null for title-less items');
  } else {
    fail('parseGlintsItem should return null for items without title');
  }

  // parseGlintsItem — rejects items without url
  if (parseGlintsItem({ title: 'Role' }, 'https://glints.com', 'Co') === null) {
    pass('parseGlintsItem returns null for URL-less items');
  } else {
    fail('parseGlintsItem should return null for items without URL');
  }

  // parseGlintsItem — rejects off-domain URLs
  const offDomain = parseGlintsItem(
    { title: 'Role', url: 'https://evil.example.com/jobs/1' },
    'https://glints.com', 'Co'
  );
  if (offDomain === null) pass('parseGlintsItem rejects off-domain URLs');
  else fail(`parseGlintsItem should reject off-domain URLs, got ${JSON.stringify(offDomain)}`);

  // parseGlintsItem — allows subdomains of glints.com
  const subdomainItem = parseGlintsItem(
    { title: 'Role', url: 'https://www.glints.com/id/jobs/role/1' },
    'https://glints.com', 'Co'
  );
  if (subdomainItem && subdomainItem.url === 'https://www.glints.com/id/jobs/role/1') {
    pass('parseGlintsItem accepts www.glints.com subdomain URLs');
  } else {
    fail(`parseGlintsItem subdomain URL rejected: ${JSON.stringify(subdomainItem)}`);
  }

  // parseGlintsItem — handles null/malformed input
  if (parseGlintsItem(null, 'https://glints.com', 'Co') === null) pass('parseGlintsItem(null) → null');
  else fail('parseGlintsItem(null) should return null');
  if (parseGlintsItem(42, 'https://glints.com', 'Co') === null) pass('parseGlintsItem(number) → null');
  else fail('parseGlintsItem(number) should return null');

  // parseGlintsItem — fallback company when company.name is missing
  const noCompany = parseGlintsItem(
    { title: 'Engineer', url: 'https://glints.com/id/jobs/eng/1' },
    'https://glints.com', 'PortalName'
  );
  if (noCompany && noCompany.company === 'PortalName') {
    pass('parseGlintsItem uses fallback company when company.name is absent');
  } else {
    fail(`parseGlintsItem fallback company: ${JSON.stringify(noCompany)}`);
  }

  // fetch() — happy path with mock context
  const mockCtx = {
    transport: 'http',
    fetchJson: async (url, opts) => {
      if (opts?.method !== 'POST') throw new Error('Expected POST');
      const body = JSON.parse(opts.body || '{}');
      if (!body.query) throw new Error('Expected GraphQL query');
      return {
        data: {
          opportunities: {
            data: [
              { title: 'AI PM', company: { name: 'TechCo' }, location: 'Remote', postedAt: '2026-01-01T00:00:00Z', url: 'https://glints.com/id/jobs/ai-pm/1' },
            ],
            totalCount: 1,
          },
        },
      };
    },
    fetchText: async () => { throw new Error('should not be called'); },
  };
  const jobs = await glints.fetch(
    { name: 'Glints ID', provider: 'glints', searchKeywords: 'AI' },
    mockCtx,
  );
  if (jobs.length === 1 && jobs[0].title === 'AI PM') pass('glints.fetch() returns parsed jobs via GraphQL');
  else fail(`glints.fetch() returned ${JSON.stringify(jobs)}`);

  // fetch() — handles empty results
  const emptyCtx = {
    transport: 'http',
    fetchJson: async () => ({ data: { opportunities: { data: [], totalCount: 0 } } }),
    fetchText: async () => { throw new Error('should not be called'); },
  };
  const emptyJobs = await glints.fetch(
    { name: 'Glints ID', provider: 'glints', searchKeywords: 'nonexistent' },
    emptyCtx,
  );
  if (emptyJobs.length === 0) pass('glints.fetch() handles empty results');
  else fail(`glints.fetch() should return empty array for no results, got ${emptyJobs.length}`);

  // fetch() — handles flat opportunities array (alternative response shape)
  const flatCtx = {
    transport: 'http',
    fetchJson: async () => ({
      data: {
        opportunities: [
          { title: 'Dev', company: { name: 'Co' }, location: 'Remote', url: 'https://glints.com/id/jobs/dev/1' },
        ],
      },
    }),
    fetchText: async () => { throw new Error('should not be called'); },
  };
  const flatJobs = await glints.fetch(
    { name: 'Glints ID', provider: 'glints', searchKeywords: 'dev' },
    flatCtx,
  );
  if (flatJobs.length === 1) pass('glints.fetch() handles flat opportunities array response');
  else fail(`glints.fetch() flat array: ${JSON.stringify(flatJobs)}`);

  // fetch() — rejects invalid hostname
  let hostRejected = false;
  try {
    await glints.fetch(
      { name: 'Bad', provider: 'glints', api: 'https://evil.example.com/graphql' },
      { transport: 'http', fetchJson: async () => ({}), fetchText: async () => '' },
    );
  } catch (e) {
    if (e.message.includes('untrusted hostname')) hostRejected = true;
    else fail(`glints.fetch() host rejection wrong error: ${e.message}`);
  }
  if (hostRejected) pass('glints.fetch() rejects untrusted hostnames');
  else fail('glints.fetch() should reject non-glints hostnames');

  // fetch() — throws on missing opportunities in response
  let missingThrew = false;
  try {
    await glints.fetch(
      { name: 'Glints ID', provider: 'glints', searchKeywords: 'test' },
      {
        transport: 'http',
        fetchJson: async () => ({ data: { somethingElse: [] } }),
        fetchText: async () => { throw new Error('should not be called'); },
      },
    );
  } catch (e) {
    if (e.message.includes('unexpected API response')) missingThrew = true;
    else fail(`glints.fetch() missing opportunities wrong error: ${e.message}`);
  }
  if (missingThrew) pass('glints.fetch() throws on unexpected API response shape');
  else fail('glints.fetch() should throw when opportunities is missing');

} catch (e) {
  fail(`glints provider tests crashed: ${e.message}`);
}

console.log('\n25. Provider — arbeitsagentur');

try {
  const aa = (await import(pathToFileURL(join(ROOT, 'providers/arbeitsagentur.mjs')).href)).default;
  const { parseArbeitsagenturConfig, buildLocation, normalizeJob } =
    await import(pathToFileURL(join(ROOT, 'providers/arbeitsagentur.mjs')).href);

  if (aa.id === 'arbeitsagentur') pass('arbeitsagentur.id is "arbeitsagentur"');
  else fail(`arbeitsagentur.id is ${JSON.stringify(aa.id)}`);

  // parseArbeitsagenturConfig — defaults when block is absent
  const def = parseArbeitsagenturConfig({});
  if (def.keywords.length === 0 && def.wo === '' && def.umkreis === 50 && def.days === 30 && def.size === 100 && def.remoteNationwide === false) {
    pass('parseArbeitsagenturConfig applies defaults (umkreis 50, days 30, size 100)');
  } else {
    fail(`parseArbeitsagenturConfig defaults = ${JSON.stringify(def)}`);
  }

  // parseArbeitsagenturConfig — sanitizes keywords and clamps numbers
  const cfg = parseArbeitsagenturConfig({
    arbeitsagentur: { keywords: ['  ML Engineer  ', '', 7, 'NLP'], wo: ' Berlin ', umkreis: 999999, size: 0, days: -3, remoteNationwide: 'yes' },
  });
  if (cfg.keywords.length === 2 && cfg.keywords[0] === 'ML Engineer' && cfg.keywords[1] === 'NLP') {
    pass('parseArbeitsagenturConfig trims keywords and drops empty/non-string entries');
  } else {
    fail(`parseArbeitsagenturConfig keywords = ${JSON.stringify(cfg.keywords)}`);
  }
  if (cfg.wo === 'Berlin' && cfg.umkreis === 1000 && cfg.size === 1 && cfg.days === 1 && cfg.remoteNationwide === false) {
    pass('parseArbeitsagenturConfig clamps umkreis/size/days and treats non-true remoteNationwide as false');
  } else {
    fail(`parseArbeitsagenturConfig sanitized = ${JSON.stringify(cfg)}`);
  }

  // buildLocation — ort/region join, non-DE country appended, DE omitted
  if (buildLocation({ ort: 'Berlin', region: 'Berlin', land: 'Deutschland' }) === 'Berlin, Berlin') {
    pass('buildLocation joins ort/region and omits Germany');
  } else {
    fail(`buildLocation DE = ${JSON.stringify(buildLocation({ ort: 'Berlin', region: 'Berlin', land: 'Deutschland' }))}`);
  }
  if (buildLocation({ ort: 'Wien', land: 'Österreich' }) === 'Wien, Österreich') {
    pass('buildLocation appends non-DE country');
  } else {
    fail(`buildLocation non-DE = ${JSON.stringify(buildLocation({ ort: 'Wien', land: 'Österreich' }))}`);
  }
  if (buildLocation(null) === '' && buildLocation('x') === '') pass('buildLocation returns "" for missing/garbage input');
  else fail('buildLocation should return "" for missing/garbage input');

  // normalizeJob — happy path encodes refnr into the detail URL
  const norm = normalizeJob({ refnr: '10000-123/4 X', titel: '  ML Engineer  ', arbeitgeber: ' ACME ', arbeitsort: { ort: 'Berlin' } });
  if (norm && norm.title === 'ML Engineer' && norm.company === 'ACME'
      && norm.url === 'https://www.arbeitsagentur.de/jobsuche/jobdetail/' + encodeURIComponent('10000-123/4 X')
      && norm.refnr === '10000-123/4 X') {
    pass('normalizeJob trims fields and URL-encodes refnr');
  } else {
    fail(`normalizeJob = ${JSON.stringify(norm)}`);
  }
  if (normalizeJob({ titel: 'No refnr' }) === null && normalizeJob({ refnr: 'x', titel: '' }) === null) {
    pass('normalizeJob returns null without a refnr or title');
  } else {
    fail('normalizeJob should return null when refnr or title is missing');
  }

  // fetch() — nationwide single-keyword pass, dedup across keywords, header sent
  let sentApiKey = null;
  const mkCtx = (byWas) => ({
    fetchJson: async (url, opts) => {
      sentApiKey = opts?.headers?.['X-API-Key'] ?? sentApiKey;
      const was = new URL(url).searchParams.get('was');
      return { stellenangebote: byWas[was] || [] };
    },
  });
  const fetched = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML', 'NLP'] } },
    mkCtx({
      ML: [{ refnr: 'A', titel: 'ML Engineer', arbeitgeber: 'Co', arbeitsort: { ort: 'Berlin' } }],
      NLP: [
        { refnr: 'A', titel: 'ML Engineer', arbeitgeber: 'Co', arbeitsort: { ort: 'Berlin' } }, // dup refnr
        { refnr: 'B', titel: 'NLP Scientist', arbeitgeber: 'Co', arbeitsort: { ort: 'Köln' } },
      ],
    }),
  );
  if (fetched.length === 2 && !('refnr' in fetched[0])) pass('aa.fetch() dedups by refnr and strips refnr from output');
  else fail(`aa.fetch() returned ${JSON.stringify(fetched)}`);
  if (sentApiKey === 'jobboerse-jobsuche') pass('aa.fetch() sends the X-API-Key header');
  else fail(`aa.fetch() X-API-Key = ${JSON.stringify(sentApiKey)}`);

  // fetch() — remoteNationwide pass keeps only remote-titled wide hits
  let calls = 0;
  const remoteFetched = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML'], wo: 'Berlin', remoteNationwide: true } },
    {
      fetchJson: async (url) => {
        calls++;
        const hasWo = new URL(url).searchParams.has('wo');
        // Pass A (wo set) → local hit; Pass B (no wo) → one remote-titled, one not.
        return hasWo
          ? { stellenangebote: [{ refnr: 'L', titel: 'ML Engineer', arbeitgeber: 'Co', arbeitsort: { ort: 'Berlin' } }] }
          : { stellenangebote: [
              { refnr: 'R', titel: 'ML Engineer (Remote)', arbeitgeber: 'Co', arbeitsort: { ort: 'Hamburg' } },
              { refnr: 'X', titel: 'Onsite ML Engineer', arbeitgeber: 'Co', arbeitsort: { ort: 'Hamburg' } },
            ] };
      },
    },
  );
  if (calls === 2 && remoteFetched.some(j => j.url.endsWith('R')) && !remoteFetched.some(j => j.url.endsWith('X'))) {
    pass('aa.fetch() remoteNationwide keeps remote-titled wide hits and drops onsite ones');
  } else {
    fail(`aa.fetch() remoteNationwide = ${calls} calls, ${JSON.stringify(remoteFetched.map(j => j.url))}`);
  }

  // fetch() — no keywords throws; total outage throws (not silent)
  let noKw = false;
  try { await aa.fetch({ name: 'AA', arbeitsagentur: {} }, mkCtx({})); } catch { noKw = true; }
  if (noKw) pass('aa.fetch() throws when no keywords are configured');
  else fail('aa.fetch() should throw without keywords');

  let outage = false;
  try {
    await aa.fetch({ name: 'AA', arbeitsagentur: { keywords: ['ML'] } }, { fetchJson: async () => { throw new Error('HTTP 503'); } });
  } catch { outage = true; }
  if (outage) pass('aa.fetch() throws when every keyword request fails (no silent empty)');
  else fail('aa.fetch() should throw on total outage');

  // fetch() — one keyword answers (empty) while another fails → NOT a total
  // outage; partial success must not throw.
  let partialThrew = false;
  let partial;
  try {
    partial = await aa.fetch(
      { name: 'AA', arbeitsagentur: { keywords: ['OK', 'BAD'] } },
      { fetchJson: async (url) => {
          if (new URL(url).searchParams.get('was') === 'BAD') throw new Error('HTTP 503');
          return { stellenangebote: [] }; // OK answers, just empty
        } },
    );
  } catch { partialThrew = true; }
  if (!partialThrew && Array.isArray(partial) && partial.length === 0) {
    pass('aa.fetch() does not throw when one keyword succeeds empty and another fails');
  } else {
    fail(`aa.fetch() partial-success threw=${partialThrew}, result=${JSON.stringify(partial)}`);
  }

  // fetch() — Pass A succeeds with jobs, optional Pass B fails → Pass A jobs kept.
  const passBFail = await aa.fetch(
    { name: 'AA', arbeitsagentur: { keywords: ['ML'], wo: 'Berlin', remoteNationwide: true } },
    { fetchJson: async (url) => {
        // Pass A (wo set) returns a job; Pass B (no wo) throws.
        if (new URL(url).searchParams.has('wo')) {
          return { stellenangebote: [{ refnr: 'L', titel: 'ML Engineer', arbeitgeber: 'Co', arbeitsort: { ort: 'Berlin' } }] };
        }
        throw new Error('HTTP 503');
      } },
  );
  if (passBFail.length === 1 && passBFail[0].url.endsWith('L')) {
    pass('aa.fetch() preserves primary (Pass A) results when the remote pass (Pass B) fails');
  } else {
    fail(`aa.fetch() Pass B failure dropped primary: ${JSON.stringify(passBFail)}`);
  }

} catch (e) {
  fail(`arbeitsagentur provider tests crashed: ${e.message}`);
}

console.log('\n23b. Provider — workday multi-location resolution');

try {
  const workday = (await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href)).default;
  const entry = { name: 'NVIDIA', careers_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' };

  // Workday reports any multi-site posting as "N Locations" — a string with no
  // geography — so the list payload alone cannot be filtered. The provider must
  // fetch the detail record for exactly those rows.
  const listPayload = {
    jobPostings: [
      { title: 'Applied AI Engineer', externalPath: '/job/US-CA-Remote/Example-Role-01_JR2391853', locationsText: '6 Locations', postedOn: 'Posted Today' },
      { title: 'Onsite Only Role', externalPath: '/job/US-CA-Santa-Clara/Onsite_JR1', locationsText: '2 Locations', postedOn: 'Posted 3 Days Ago' },
      { title: 'Single Location Role', externalPath: '/job/US-CA-Remote/Single_JR2', locationsText: 'US, CA, Remote', postedOn: 'Posted 1 Days Ago' },
      { title: 'Detail Fetch Fails', externalPath: '/job/Somewhere/Broken_JR3', locationsText: '3 Locations', postedOn: 'Posted Today' },
    ],
  };
  const detailByPath = {
    '/job/US-CA-Remote/Example-Role-01_JR2391853': {
      jobPostingInfo: { location: 'US, CA, Remote', additionalLocations: ['US, GA, Remote', 'US, CA, Santa Clara'] },
    },
    '/job/US-CA-Santa-Clara/Onsite_JR1': {
      jobPostingInfo: { location: 'US, CA, Santa Clara', additionalLocations: ['US, WA, Redmond'] },
    },
  };

  let detailCalls = 0;
  const ctx = {
    async fetchJson(url, opts) {
      if (opts?.method === 'POST') return detailCalls === 0 ? listPayload : { jobPostings: [] };
      detailCalls++;
      const path = url.replace('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite', '');
      if (!detailByPath[path]) throw new Error('404');
      return detailByPath[path];
    },
  };

  const jobs = await workday.fetch(entry, ctx);
  const byTitle = Object.fromEntries(jobs.map(j => [j.title, j]));

  if (JSON.stringify(byTitle['Applied AI Engineer']?.locations) ===
      JSON.stringify(['US, CA, Remote', 'US, GA, Remote', 'US, CA, Santa Clara'])) {
    pass('workday resolves "N Locations" into the full structured option list');
  } else {
    fail(`workday placeholder not resolved: ${JSON.stringify(byTitle['Applied AI Engineer']?.locations)}`);
  }

  if (byTitle['Single Location Role']?.locations === undefined) {
    pass('workday does not fetch detail for a posting that already names its location');
  } else {
    fail('workday fetched detail for a single-location posting (wasted request)');
  }

  // A failed detail fetch must leave the placeholder alone. The policy then
  // reports `unknown` and routes it to review — inventing a location here
  // would silently drop or admit the posting on a guess.
  if (byTitle['Detail Fetch Fails']?.locations === undefined
      && byTitle['Detail Fetch Fails']?.location === '3 Locations') {
    pass('workday leaves the placeholder intact when detail lookup fails');
  } else {
    fail('workday invented locations after a failed detail fetch');
  }

  if (jobs.every(j => !('_externalPath' in j))) {
    pass('workday strips its private _externalPath before returning');
  } else {
    fail('workday leaked _externalPath into the returned jobs');
  }

  // Workday's RESULT cap: total says 100 while the facets say 175. One walk ends cleanly at
  // the cap and read as the whole board (NVIDIA: 2000 of 2734). It must walk per facet value.
  {
    const sizes = [90, 70, 15], cap = 100;
    const facets = [{ facetParameter: 'jobFamilyGroup',
      values: sizes.map((n, i) => ({ id: `f${i}`, descriptor: `F${i}`, count: n })) }];
    const pool = (i) => Array.from({ length: sizes[i] }, (_, k) => `/job/US-CA-Remote/F${i}_${k}`);
    const capCtx = {
      async fetchJson(_url, opts) {
        const q = JSON.parse(opts.body);
        const sel = q.appliedFacets?.jobFamilyGroup;
        const all = sel ? pool(Number(sel[0].slice(1))) : sizes.flatMap((_, i) => pool(i)).slice(0, cap);
        const page = all.slice(q.offset, q.offset + q.limit)
          .map((p) => ({ title: 'T', externalPath: p, locationsText: 'US, CA, Remote' }));
        return { total: sel ? all.length : cap, jobPostings: page, facets };
      },
    };
    const got = await workday.fetch(entry, capCtx);
    if (got.length === 175 && !got.truncated) {
      pass('workday walks past the 2000-style result cap by facet partition');
    } else {
      fail(`workday capped board: ${got.length} postings, truncated=${got.truncated}; want 175 and none`);
    }

    // A served row with no externalPath was read, not lost (NVIDIA, five rows, 2026-10-23):
    // it must not flag the board TRUNCATED. A piece that serves FEWER rows than its share
    // still must.
    const variant = (mutate) => ({
      async fetchJson(url, opts) {
        const r = await capCtx.fetchJson(url, opts);
        return { ...r, jobPostings: mutate(JSON.parse(opts.body), r.jobPostings) };
      },
    });
    const pathless = await workday.fetch(entry, variant((q, rows) =>
      q.appliedFacets?.jobFamilyGroup?.[0] === 'f2' && q.offset === 0
        ? rows.map((r, k) => (k < 3 ? { ...r, externalPath: undefined } : r)) : rows));
    if (pathless.length === 172 && !pathless.truncated) {
      pass('workday counts a served row with no externalPath as read, not missing');
    } else {
      fail(`pathless rows misread: ${pathless.length} postings, truncated=${pathless.truncated}; want 172 and none`);
    }
    // Pathless rows are transient on NVIDIA's side: a page re-read returns them whole.
    let reread = 0;
    const transient = await workday.fetch(entry, variant((q, rows) => {
      if (q.appliedFacets?.jobFamilyGroup?.[0] !== 'f2' || q.offset !== 0) return rows;
      return reread++ === 0 ? rows.map((r, k) => (k < 3 ? { ...r, externalPath: undefined } : r)) : rows;
    }));
    if (transient.length === 175 && !transient.truncated) {
      pass('workday re-reads a page whose rows came back with no externalPath');
    } else {
      fail(`transient pathless rows not recovered: ${transient.length} postings; want 175`);
    }
    const short = await workday.fetch(entry, variant((q, rows) =>
      q.appliedFacets?.jobFamilyGroup?.[0] === 'f2' && q.offset === 0 ? rows.slice(0, 12) : rows));
    if (short.truncated) {
      pass('workday still flags a facet piece that served fewer rows than the board claims');
    } else {
      fail(`a short piece passed as whole: ${short.length} postings`);
    }
  }

  // One 429 mid-walk used to fail NVIDIA's whole board (2026-10-20): a single retry was
  // not enough for a ~240-request walk. Throttling is retried with escalating waits; a
  // real miss is not retried at all, and an unending throttle still surfaces.
  {
    const { fetchJsonBackoff } = await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href);
    const throttle = (n, status = 429) => {
      let calls = 0;
      return { get calls() { return calls; }, async fetchJson() {
        calls++;
        if (calls <= n) { const e = new Error(`HTTP ${status}`); e.status = status; throw e; }
        return { ok: true };
      } };
    };
    const twice = throttle(2);
    const got = await fetchJsonBackoff(twice, 'u', {}, [1, 1, 1]).catch(() => null);
    if (got?.ok && twice.calls === 3) pass('workday retries a throttle past the first backoff');
    else fail(`workday gave up on a twice-throttled request (calls=${twice.calls})`);

    const forever = throttle(99);
    const threw = await fetchJsonBackoff(forever, 'u', {}, [1, 1]).then(() => false, (e) => e.status === 429);
    if (threw && forever.calls === 3) pass('workday surfaces a throttle that outlasts every retry');
    else fail(`workday swallowed an unending throttle (calls=${forever.calls})`);

    const missing = throttle(1, 404);
    await fetchJsonBackoff(missing, 'u', {}, [1, 1]).catch(() => {});
    if (missing.calls === 1) pass('workday does not retry a real miss');
    else fail(`workday retried a 404 (calls=${missing.calls})`);

    const unavailable = throttle(1, 503);
    const ok503 = await fetchJsonBackoff(unavailable, 'u', {}, [1]).catch(() => null);
    if (ok503?.ok && unavailable.calls === 2) pass('workday retries a 503 like a throttle');
    else fail(`workday did not retry a 503 (calls=${unavailable.calls})`);

    // The per-request waits bound one request; the board budget bounds the whole walk.
    const budget = { ms: 5 };
    const capped = throttle(99);
    await fetchJsonBackoff(capped, 'u', {}, [3, 3, 3, 3], budget).catch(() => {});
    if (capped.calls === 2 && budget.ms === 2) pass('workday stops retrying once the board budget is spent');
    else fail(`workday overspent its retry budget (calls=${capped.calls}, left=${budget.ms})`);
  }

  // A 200 with no jobPostings array (a WAF page, an error object) is UNREAD, not an
  // empty board. Read as empty, it would retire every row on the tenant.
  for (const [label, body] of [['an empty object', {}], ['an error object', { error: 'unread' }]]) {
    let threw = false;
    try {
      await workday.fetch(entry, { fetchJson: async () => body });
    } catch { threw = true; }
    if (threw) pass(`workday refuses a list response that is ${label}`);
    else fail(`workday read ${label} as an empty board`);
  }

  // The first page's `total` ends the walk, so a board whose size is a multiple of the
  // page size is not asked for one page past its end.
  {
    let calls = 0;
    const full = Array.from({ length: 20 }, (_v, i) => ({ title: `R${i}`, externalPath: `/job/X/R_JR${i}`, locationsText: 'US, CA, Remote' }));
    const got = await workday.fetch(entry, { fetchJson: async () => { calls += 1; return { total: 20, jobPostings: full }; } });
    if (calls === 1 && got.length === 20) pass('workday stops the walk at the first page\'s total');
    else fail(`workday made ${calls} list call(s) for a 20-posting board (expected 1)`);
  }

  // A walk that hits its own page cap says so, instead of passing the cap off as the
  // board size (NVIDIA's board is ~2000 postings, twice the old cap).
  {
    const full = Array.from({ length: 20 }, (_v, i) => ({ title: `R${i}`, externalPath: `/job/X/R_JR${i}`, locationsText: 'US, CA, Remote' }));
    const warnings = [];
    const origErr = console.error;
    console.error = (m) => warnings.push(String(m));
    let got = [];
    try {
      got = await workday.fetch(entry, { fetchJson: async () => ({ jobPostings: full }) });
    } finally { console.error = origErr; }
    if (warnings.some(w => /TRUNCATED/.test(w))) pass('workday reports a walk that hit its page cap as TRUNCATED');
    else fail('workday hit its page cap silently');
    // ...on the RESULT, which is what the scans read; stderr alone let a partial board
    // pass for a whole one. Both scans must read it.
    // Each reader must ACT on it, not merely mention it: scan.mjs lists the board under
    // Errors, scan-ats-full prints it whatever --verbose says.
    const readers = [['scan.mjs', /if \(jobs\.truncated\) \{\s*errors\.push\(/],
                     ['scan-ats-full.mjs', /if \(jobs\.truncated\) console\.error\(/]]
      .filter(([f, rx]) => !rx.test(readFileSync(join(ROOT, f), 'utf-8'))).map(([f]) => f);
    if (/TRUNCATED/.test(got.truncated || '') && got.length > 0 && !readers.length) {
      pass('a truncated Workday walk is flagged on its result and both scans read the flag');
    } else {
      fail(`truncation not carried to the scans: flag=${JSON.stringify(got.truncated)} ` +
        `jobs=${got.length} unread by ${readers.join(', ') || 'none'}`);
    }
  }

  // End-to-end: the same primary location must produce opposite verdicts once
  // the siblings are known. This is the case that makes URL-slug guessing wrong.
  const { buildLocationDecider: makeDecider } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const decide = makeDecider({
    remote_signals: ['remote'],
    us_wide_signals: ['united states', 'usa', 'us'],
    california_signals: ['california', 'ca'],
    us_state_signals: ['california', 'ca', 'georgia', 'ga', 'washington', 'wa'],
    socal_signals: ['irvine', 'los angeles'],
    blocked_geo: ['canada'],
    hard_out_metro: ['santa clara', 'redmond'],
  });
  const remoteVerdict = decide(byTitle['Applied AI Engineer'].locations, { company: 'Roblox' }).verdict;
  const onsiteVerdict = decide(byTitle['Onsite Only Role'].locations, { company: 'Roblox' }).verdict;
  if (remoteVerdict === 'accept' && onsiteVerdict === 'reject') {
    pass('same Santa Clara primary yields opposite verdicts once siblings are resolved');
  } else {
    fail(`sibling-driven verdicts wrong: remote=${remoteVerdict}, onsite=${onsiteVerdict}`);
  }
} catch (e) {
  fail(`workday multi-location tests crashed: ${e.message}`);
}

console.log('\n24. Provider — ibm');

try {
  const ibm = (await import(pathToFileURL(join(ROOT, 'providers/ibm.mjs')).href)).default;
  const { parseIbmResponse, buildPostFilter } = await import(pathToFileURL(join(ROOT, 'providers/ibm.mjs')).href);

  if (ibm.id === 'ibm') pass('ibm.id is "ibm"');
  else fail(`ibm.id is ${JSON.stringify(ibm.id)}`);

  // buildPostFilter — empty config yields no filter terms
  if (buildPostFilter({}).bool.must.length === 0) pass('buildPostFilter({}) → no must terms');
  else fail(`buildPostFilter({}) = ${JSON.stringify(buildPostFilter({}))}`);

  // buildPostFilter — country + categories produce the expected facet terms
  const pf = buildPostFilter({ country: 'Germany', categories: ['Software Engineering', 'Data & Analytics'] });
  const countryTerm = pf.bool.must.find(m => m.term && m.term.field_keyword_05);
  const catTerm = pf.bool.must.find(m => m.bool && m.bool.should);
  if (countryTerm?.term.field_keyword_05 === 'Germany' && catTerm?.bool.should.length === 2) {
    pass('buildPostFilter maps country → field_keyword_05 and categories → field_keyword_08 should[]');
  } else {
    fail(`buildPostFilter facets = ${JSON.stringify(pf)}`);
  }

  // buildPostFilter — sanitizes empty/non-string category entries
  const sanitized = buildPostFilter({ categories: ['Valid', '', '   ', 42, null] });
  const sanitizedShould = sanitized.bool.must.find(m => m.bool && m.bool.should)?.bool.should;
  if (sanitizedShould?.length === 1 && sanitizedShould[0].term.field_keyword_08 === 'Valid') {
    pass('buildPostFilter drops empty/non-string category entries');
  } else {
    fail(`buildPostFilter sanitization = ${JSON.stringify(sanitizedShould)}`);
  }

  // parseIbmResponse — happy path, location assembled from keyword_19 · keyword_17
  const sample = {
    hits: {
      hits: [
        { _source: { title: 'ML Engineer', url: 'https://ibm.com/careers/1', field_keyword_19: 'Berlin, Germany', field_keyword_17: 'Hybrid' } },
        { _source: { title: 'Data Scientist', url: 'https://ibm.com/careers/2', field_keyword_19: 'Remote' } },
      ],
    },
  };
  const jobs = parseIbmResponse(sample);
  if (jobs.length === 2 && jobs[0].company === 'IBM') pass('parseIbmResponse extracts 2 jobs with company "IBM"');
  else fail(`parseIbmResponse returned ${JSON.stringify(jobs)}`);

  if (jobs[0].location === 'Berlin, Germany · Hybrid') pass('parseIbmResponse joins location · work mode');
  else fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);

  if (jobs[1].location === 'Remote') pass('parseIbmResponse omits the separator when work mode is absent');
  else fail(`row 1 location = ${JSON.stringify(jobs[1]?.location)}`);

  // parseIbmResponse — drops title-less, url-less, and non-http(s) entries
  const dirty = parseIbmResponse({
    hits: {
      hits: [
        { _source: { title: '', url: 'https://ibm.com/careers/3' } },
        { _source: { title: 'No URL' } },
        { _source: { title: 'Bad scheme', url: 'ftp://ibm.com/careers/4' } },
        { _source: { title: 'Good', url: 'https://ibm.com/careers/5' } },
      ],
    },
  });
  if (dirty.length === 1 && dirty[0].title === 'Good') pass('parseIbmResponse drops title-less, url-less, and non-http(s) entries');
  else fail(`parseIbmResponse dirty = ${JSON.stringify(dirty)}`);

  // parseIbmResponse — throws on unexpected shape (endpoint drift surfaces loudly)
  let drifted = false;
  try { parseIbmResponse({ results: [] }); } catch { drifted = true; }
  if (drifted) pass('parseIbmResponse throws when hits.hits[] is missing');
  else fail('parseIbmResponse should throw on unexpected API response shape');

  // fetch() — paginates until a short page, via mock ctx
  let calls = 0;
  const mockCtx = {
    fetchJson: async (url, opts) => {
      calls++;
      if (url !== 'https://www-api.ibm.com/search/api/v2') throw new Error(`unexpected url ${url}`);
      if (opts?.method !== 'POST') throw new Error('Expected POST');
      // Page 1: a full page (30 hits) → keep paging; page 2: short page → stop.
      const n = calls === 1 ? 30 : 2;
      const hits = Array.from({ length: n }, (_, i) => ({
        _source: { title: `Role ${calls}-${i}`, url: `https://ibm.com/careers/${calls}-${i}` },
      }));
      return { hits: { hits } };
    },
  };
  const fetched = await ibm.fetch({ name: 'IBM', ibm: { country: 'Germany' } }, mockCtx);
  if (calls === 2 && fetched.length === 32) pass('ibm.fetch() paginates and stops on the first short page');
  else fail(`ibm.fetch() made ${calls} calls, returned ${fetched.length} jobs`);

} catch (e) {
  fail(`ibm provider tests crashed: ${e.message}`);
}

// ── CIIAA CODENAME SCRUB (fork) ─────────────────────────────────

console.log('\nCIIAA codename scrub (redactions-core.mjs)');

try {
  const { scrubCodenames } = await import('./redactions-core.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'co-redactions-'));
  try {
    // String form (default replacement) + object form (custom replacement).
    writeFileSync(
      join(dir, 'redactions.yml'),
      'codenames:\n  - "Project Helios"\n  - codename: "Project Nimbus"\n    replacement: "an internal avatar system"\n',
      'utf-8',
    );
    const scrubbed = scrubCodenames('We shipped Project Helios and Project Nimbus together.', { rootDir: dir, warn: false });
    if (!/Project Helios/.test(scrubbed) && scrubbed.includes('a confidential project')) {
      pass('string-form codename is scrubbed with the default descriptor');
    } else {
      fail(`string-form codename not scrubbed: ${scrubbed}`);
    }
    if (!/Project Nimbus/.test(scrubbed) && scrubbed.includes('an internal avatar system')) {
      pass('object-form codename is scrubbed with its custom replacement');
    } else {
      fail(`object-form codename not scrubbed: ${scrubbed}`);
    }

    // Word boundary: a codename must not match inside an unrelated word.
    writeFileSync(join(dir, 'redactions.yml'), 'codenames:\n  - "Halo"\n', 'utf-8');
    const wb = scrubCodenames('Halo shipped, but Haloform did not.', { rootDir: dir, warn: false });
    if (wb.includes('a confidential project') && wb.includes('Haloform')) {
      pass('codename scrub respects word boundaries (Haloform untouched)');
    } else {
      fail(`word-boundary scrub wrong: ${wb}`);
    }

    // Empty denylist → no-op.
    writeFileSync(join(dir, 'redactions.yml'), 'codenames: []\n', 'utf-8');
    const noop = scrubCodenames('Nothing to redact here.', { rootDir: dir, warn: false });
    if (noop === 'Nothing to redact here.') {
      pass('empty denylist is a no-op');
    } else {
      fail(`empty denylist changed text: ${noop}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (e) {
  fail(`CIIAA codename scrub test crashed: ${e.message}`);
}

// ── PIPELINE-AUDIT REQ-ID KEYS, END TO END ──────────────────────
// pipeline-audit's --selftest exercises jobKey in isolation and exits before
// the tracker, the inbox and --dispositions are ever read, so it cannot see a
// consumer that joins on the wrong thing. Every one of those consumers is
// destructive in the same direction: a duplicate group is pruned, a matched
// disposition marks a row [x], a tracker hit retires it.
//
// The fixture is two tenants holding the SAME bare Workday number, R11095,
// which is the shape a company-blind key gets wrong. An earlier draft of this
// change keyed the number alone, and a single Workiva disposition marked the
// Calix row resolved as well.
console.log('\n🧪 Testing pipeline-audit keeps two tenants sharing a req number apart...');
try {
  const paTmp = mkdtempSync(join(tmpdir(), 'career-ops-pipeline-keys-'));
  try {
    mkdirSync(join(paTmp, 'data'));
    const workiva = 'https://workiva.wd1.myworkdayjobs.com/Workiva/job/Remote/Senior-Staff-ML-Engineer_R11095';
    const calix = 'https://calix.wd1.myworkdayjobs.com/Calix/job/Remote/Staff-Software-Engineer-AI-ML_R11095';
    // Only the Workiva req is tracked. The Calix one is real pending work.
    writeFileSync(join(paTmp, 'data', 'applications.md'),
      TRACKER_HEAD +
      '| 700 | 2026-09-19 | Workiva | Senior Staff Machine Learning Engineer - US (R11095) | 4.0/5 | Evaluated | x | [700](../reports/700-workiva-2026-09-19.md) | tracked |\n');
    writeFileSync(join(paTmp, 'data', 'pipeline.md'),
      '# Inbox\n\n' +
      `- [ ] ${workiva} | Workiva | Senior Staff Machine Learning Engineer - US\n` +
      `- [ ] ${calix} | Calix | Staff Software Engineer, AI/ML\n`);

    let paOut = '';
    try {
      paOut = execFileSync(NODE, [join(ROOT, 'pipeline-audit.mjs'), '--verbose'],
        { cwd: paTmp, encoding: 'utf-8', timeout: 30000 });
    } catch (e) { paOut = `${e.stdout || ''}${e.stderr || ''}`; }

    if (/duplicates: 0 redundant rows/.test(paOut)) {
      pass('pipeline-audit: two tenants sharing a req number are not duplicates of each other');
    } else {
      fail(`pipeline-audit treated two tenants' R11095 as one req: ${paOut.trim().slice(0, 400)}`);
    }
    // Exactly one is tracked, so exactly one must survive as pending work.
    if (/already evaluated: 1 reqs/.test(paOut) && /genuinely pending: 1 reqs/.test(paOut)) {
      pass('pipeline-audit: the tracked tenant retires and the untracked one stays pending');
    } else {
      fail(`pipeline-audit retired the wrong count: ${paOut.trim().slice(0, 400)}`);
    }

    // --dispositions has only a URL to match on, so the key has to be safe with
    // no company available at all. This is the destructive one: --prune writes.
    writeFileSync(join(paTmp, 'dispositions.json'),
      JSON.stringify([{ url: calix, disposition: 'out of lane' }]));
    try {
      execFileSync(NODE, [join(ROOT, 'pipeline-audit.mjs'), '--prune',
        '--dispositions=dispositions.json'], { cwd: paTmp, encoding: 'utf-8', timeout: 30000 });
    } catch { /* assertions below read the file, not the exit code */ }
    const pruned = readFileSync(join(paTmp, 'data', 'pipeline.md'), 'utf-8');
    // The REASON is what has to be checked, not the [x]. Both rows are resolved
    // here and only one of them by the disposition: Workiva is retired because
    // it is genuinely on the tracker, which is a different and correct verdict.
    const reasonFor = (url) => (pruned.split('\n').find(l => l.includes(url)) || '')
      .match(/resolved: (.*?) -->/)?.[1] ?? '';
    if (reasonFor(calix) === 'triaged: out of lane'
        && !reasonFor(workiva).startsWith('triaged:')) {
      pass('pipeline-audit: a disposition reaches only the tenant whose URL it names');
    } else {
      fail(`a disposition crossed tenants (calix: "${reasonFor(calix)}", ` +
           `workiva: "${reasonFor(workiva)}"):\n${pruned.trim().slice(0, 400)}`);
    }
  } finally {
    rmSync(paTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`pipeline-audit req-id key integration test crashed: ${e.message}`);
}

// ── EVAL-WRITE LIVENESS GATE + REPORT NUMBERING ─────────────────
// Two defects in one writer, both of which produced a plausible-looking
// report rather than an error.
//
//   1. The gate read `p.live === false`, so a packet with `live: null` sailed
//      through and the template stamped it "LIVE (verified)". null is exactly
//      what the resolver returns when it could NOT tell: an unreadable board,
//      a bot-blocked host such as amazon.jobs, an ATS it does not support. An
//      explicit unknown was being converted into a verified posting.
//   2. CLAUDE.md states report numbering as "sequential three-digit, max
//      existing + 1, eval-write picks it". It did not pick it: eval-prep
//      initialises num to null, num was REQUIRED, and this writer only ever
//      rejected a collision, so the documented flow stopped for a manual step.

/** One filled eval-prep packet, overridable field by field. */
const evalPacket = (over = {}) => JSON.stringify({
  company: 'Fixtureco', title: 'Agent Evaluation Engineer',
  slug: 'fixtureco-agent-evaluation-engineer',
  url: 'https://example.invalid/fixture/job/1', ats: 'greenhouse',
  status: 'Evaluated', track: 'ai-ml',
  match_w_cv: 4.0, north_star: 4.0, comp_score: 4.0, cultural_signals: 4.0,
  red_flags_adj: 0,
  location: 'US, CA, Remote', location_why: 'California is a listed remote option',
  location_verdict: 'pass', verification_depth: 'API',
  comp: { posted: '$220,000 - $260,000' },
  body: 'Fixture body.', gate: 'none', recommendation: 'Fixture recommendation.',
  arrangement: 'remote', live: true, num: null, ...over,
}, null, 1);

// One eval-write sandbox: a temp dir holding reports/ and batch/eval-queue/. `packet`
// writes a queue packet and returns its path; `run` runs eval-write there, with `env`
// added to the environment, and never throws.
const evalWriteFixture = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'reports'));
  mkdirSync(join(dir, 'batch', 'eval-queue'), { recursive: true });
  const packet = (name, over) => {
    const p = join(dir, 'batch', 'eval-queue', name);
    writeFileSync(p, evalPacket(over));
    return p;
  };
  const run = (argv, env = {}) => {
    try {
      return { code: 0, out: execFileSync(NODE, [join(ROOT, 'eval-write.mjs'), ...argv],
        { cwd: dir, encoding: 'utf-8', timeout: 30000, env: { ...process.env, ...env } }) };
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  return { dir, packet, run };
};

console.log('\n🧪 Testing eval-write refuses to certify a posting it could not verify...');
try {
  const { dir: liveTmp, packet, run: runWrite } = evalWriteFixture('career-ops-eval-write-live-');
  try {
    const wroteSlug = (slug) => readdirSync(join(liveTmp, 'reports')).some(f => f.includes(slug));

    const unknown = runWrite([packet('unknown.json',
      { live: null, slug: 'gate-null' }), '--date=2026-09-19']);
    if (/liveness not confirmed/.test(unknown.out) && !wroteSlug('gate-null')) {
      pass('eval-write: live:null is skipped rather than written up as LIVE (verified)');
    } else {
      fail(`eval-write wrote a report for live:null (file on disk: ${wroteSlug('gate-null')}): ` +
           `${unknown.out.trim().slice(0, 250)}`);
    }

    // A resolver that never set the key at all is the same unknown by another
    // route, and `!== true` has to catch it for the same reason.
    const absent = runWrite([packet('absent.json',
      { live: undefined, slug: 'gate-absent' }), '--date=2026-09-19']);
    if (/liveness not confirmed/.test(absent.out) && !wroteSlug('gate-absent')) {
      pass('eval-write: a packet with no liveness key at all is skipped');
    } else {
      fail(`eval-write wrote a report for a packet with no live key: ${absent.out.trim().slice(0, 250)}`);
    }

    // "closed" and "not checked" are different answers and must not read alike.
    const closed = runWrite([packet('closed.json',
      { live: false, slug: 'gate-false' }), '--date=2026-09-19']);
    if (/posting is closed/.test(closed.out) && !/liveness not confirmed/.test(closed.out)
        && !wroteSlug('gate-false')) {
      pass('eval-write: a closed posting is named as closed, not as unverified');
    } else {
      fail(`eval-write did not distinguish live:false from live:null: ${closed.out.trim().slice(0, 250)}`);
    }

    // A truthy non-boolean is still not a confirmation. This is what separates
    // `p.live !== true` from a plain `!p.live`, which would wave it through.
    const truthy = runWrite([packet('truthy.json',
      { live: 'unknown', slug: 'gate-truthy' }), '--date=2026-09-19']);
    if (/liveness not confirmed/.test(truthy.out) && !wroteSlug('gate-truthy')) {
      pass('eval-write: a truthy non-boolean liveness is not treated as confirmation');
    } else {
      fail(`eval-write accepted live:"unknown" as verified: ${truthy.out.trim().slice(0, 250)}`);
    }

    const ok = runWrite([packet('live.json', { live: true, slug: 'gate-true' }), '--date=2026-09-19']);
    if (ok.code === 0 && wroteSlug('gate-true')) {
      pass('eval-write: a confirmed-live packet still writes its report');
    } else {
      fail(`eval-write refused a live:true packet (exit ${ok.code}): ${ok.out.trim().slice(0, 250)}`);
    }

    // An Ashby posting id is a UUID whose last group is often all digits; it is not a
    // requisition, and labelling the role cell with it put a fake id in the tracker.
    mkdirSync(join(liveTmp, 'batch', 'tracker-additions'), { recursive: true });
    runWrite([packet('uuid.json', { slug: 'gate-uuid', title: 'Staff Platform Engineer',
      url: 'https://jobs.ashbyhq.com/acme/a8581363-d348-ab0a-17b6-ee50cfa58aee' }), '--date=2026-09-19']);
    const tsvDir = join(liveTmp, 'batch', 'tracker-additions');
    const tsv = readdirSync(tsvDir).map(f => readFileSync(join(tsvDir, f), 'utf-8')).join('\n');
    if (tsv.includes('Staff Platform Engineer') && !tsv.includes('113241621221')) {
      pass('eval-write: an Ashby UUID does not become a requisition label in the role cell');
    } else {
      fail(`eval-write labelled a role with a UUID fragment: ${tsv.slice(0, 250)}`);
    }
  } finally {
    rmSync(liveTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write liveness gate test crashed: ${e.message}`);
}

console.log('\n🧪 Testing eval-write allocates report numbers instead of demanding them...');
try {
  const { dir: numTmp, packet, run: runNum } = evalWriteFixture('career-ops-eval-write-num-');
  try {
    // 600 is the highest finished report; 603 is a live reserve-report-num.mjs
    // sentinel, a slot another window is holding, so neither may be handed out
    // and the first allocation is 604.
    writeFileSync(join(numTmp, 'reports', '600-seed-fixture-2026-09-19.md'), '# 600 seed\n');
    writeFileSync(join(numTmp, 'reports', '603-RESERVED.md'), '');
    // Each packet here stands for a DIFFERENT req, so each needs its own url.
    // The fixture used to leave them all on the shared default, which was
    // invisible while the prior-report search was prefiltered to one title slug
    // and one date; eval-write now searches by requisition identity across the
    // whole reports directory, and under that these were correctly one req.
    // `over` still wins, so the rerun case below keeps its url by keeping its slug.
    const pk = (name, over) => packet(name, { url: `https://example.invalid/fixture/job/${over.slug}`, ...over });

    // Both packets in ONE invocation, which is where a naive max+1 hands the
    // same number out twice.
    const both = runNum([pk('a.json', { slug: 'alloc-one' }), pk('b.json', { slug: 'alloc-two' }),
      '--date=2026-09-19']);
    const written = readdirSync(join(numTmp, 'reports')).filter(f => /alloc-/.test(f)).sort();
    if (written.length === 2
        && written.some(f => f.startsWith('604-alloc-'))
        && written.some(f => f.startsWith('605-alloc-'))) {
      pass('eval-write: a null num allocates max+1, respects a live sentinel, and never repeats in one run');
    } else {
      fail(`eval-write numbering is wrong, got [${written.join(', ')}] (exit ${both.code}): ` +
           `${both.out.trim().slice(0, 250)}`);
    }

    // The tracker TSV and the report link have to carry the SAME allocated
    // number, or merge-tracker files a row pointing at nothing. Read through
    // existsSync so a numbering failure above degrades into a plain failure
    // here rather than crashing out of the block and taking the remaining
    // assertions with it.
    const tsvDir = join(numTmp, 'batch', 'tracker-additions');
    const tsv604 = existsSync(tsvDir)
      ? readdirSync(tsvDir).find(f => f.startsWith('604-')) : undefined;
    const tsvBody = tsv604 ? readFileSync(join(tsvDir, tsv604), 'utf-8') : '';
    if (tsvBody.startsWith('604\t') && tsvBody.includes('[604](reports/604-')) {
      pass('eval-write: the allocated number reaches the tracker TSV and its report link');
    } else {
      fail(`the allocated number did not reach the TSV: ${JSON.stringify(tsvBody.slice(0, 160))}`);
    }

    // The sentinel is a claim, so the allocation stepped over it; but the whole
    // point of reserve-report-num.mjs is handing that number to a packet, so an
    // EXPLICIT 603 must be accepted and the sentinel released, not rejected as
    // a collision.
    const claimed = runNum([pk('claimed.json', { num: 603, slug: 'alloc-claimed' }), '--date=2026-09-19']);
    const files603 = readdirSync(join(numTmp, 'reports'));
    if (files603.some(f => f.startsWith('603-alloc-claimed'))
        && !files603.includes('603-RESERVED.md')) {
      pass('eval-write: a packet may consume its own reservation, and the sentinel is released');
    } else {
      fail(`eval-write did not consume the 603 reservation: ${claimed.out.trim().slice(0, 250)}`);
    }

    // An explicitly supplied number is still checked, and 600 is a real report.
    const clash = runNum([pk('clash.json', { num: 600, slug: 'alloc-clash' }), '--date=2026-09-19']);
    if (/already exists/.test(clash.out)
        && !readdirSync(join(numTmp, 'reports')).some(f => /alloc-clash/.test(f))) {
      pass('eval-write: an explicitly supplied number that is taken is still rejected');
    } else {
      fail(`eval-write accepted a colliding explicit num: ${clash.out.trim().slice(0, 250)}`);
    }

    // Re-running the same packet must not mint a second report for one req.
    // With the number in the packet a rerun collided; with it allocated here a
    // rerun would quietly take the next free one.
    const rerun = runNum([pk('a.json', { slug: 'alloc-one' }), '--date=2026-09-19']);
    const oneCount = readdirSync(join(numTmp, 'reports'))
      .filter(f => /-alloc-one-2026-09-19\.md$/.test(f)).length;
    if (oneCount === 1 && /already written as 604-alloc-one/.test(rerun.out)) {
      pass('eval-write: re-running a packet does not write a second report for the same req');
    } else {
      fail(`re-running a packet produced ${oneCount} reports: ${rerun.out.trim().slice(0, 250)}`);
    }

    // A fraction allocates 601.5 next; 1e20 cannot be incremented in floating
    // point, so an allocation loop that starts from it never terminates.
    for (const bad of [600.5, 1e20]) {
      const r = runNum([pk(`bad-${bad}.json`, { num: bad, slug: `alloc-bad-${bad}` }), '--date=2026-09-19']);
      if (/whole number/.test(r.out)) {
        pass(`eval-write: num ${bad} is rejected as not a whole report number`);
      } else {
        fail(`eval-write accepted num ${bad}: ${r.out.trim().slice(0, 200)}`);
      }
    }

    // A dry run has to show two packets taking two DIFFERENT numbers, or it is
    // not a preview of what the real run would do.
    const dry = runNum([pk('d1.json', { slug: 'alloc-dry-one' }), pk('d2.json', { slug: 'alloc-dry-two' }),
      '--date=2026-09-19', '--dry-run']);
    const dryNums = [...dry.out.matchAll(/^DRY\s+(\d+)/gm)].map(x => x[1]);
    if (dryNums.length === 2 && dryNums[0] !== dryNums[1]
        && !readdirSync(join(numTmp, 'reports')).some(f => /alloc-dry/.test(f))) {
      pass('eval-write: a dry run allocates distinct numbers and writes nothing');
    } else {
      fail(`dry run allocated [${dryNums.join(', ')}]: ${dry.out.trim().slice(0, 250)}`);
    }

    // A dry run must also leave no sentinel behind, or it silently burns slots.
    if (!readdirSync(join(numTmp, 'reports')).some(f => f.endsWith('-RESERVED.md'))) {
      pass('eval-write: a dry run leaves no reservation sentinel on disk');
    } else {
      fail(`dry run left a sentinel: ${readdirSync(join(numTmp, 'reports')).filter(f => f.endsWith('-RESERVED.md')).join(', ')}`);
    }

    // Finding 3: the writer used to emit an em dash into every report it made,
    // so every report it had ever produced broke the repository's absolute rule
    // regardless of how clean the packet was.
    const emitted = readdirSync(join(numTmp, 'reports')).find(f => f.startsWith('604-alloc-'));
    const body = emitted ? readFileSync(join(numTmp, 'reports', emitted), 'utf-8') : '';
    if (!body.includes(String.fromCharCode(0x2014)) && /location_final: "[^"]* -- /.test(body)) {
      pass('eval-write: the generated report carries no em dash and uses the plain separator');
    } else {
      fail(`eval-write still emits an em dash or the wrong location_final separator: ` +
           `${(body.match(/location_final:.*/) || [''])[0].slice(0, 160)}`);
    }
  } finally {
    rmSync(numTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write report numbering test crashed: ${e.message}`);
}

// ── REPORT IDENTITY IS NOT A TITLE ──────────────────────────────
// The "already written" check was `reports/*-{slug}-{date}.md`, and slug comes
// from the TITLE alone. Two employers both posting "AI Engineer" on one day
// therefore shared one identity: the first wrote its report and the second was
// skipped as already written, by a report about a different company. That req
// then gets no report, no tracker row and no error, which is the same silent
// loss eval-prep's packet_name() was fixed for and the reason CLAUDE.md says
// never to dedup reqs by title.
console.log('\n🧪 Testing eval-write keys report identity on the req, not the title...');
try {
  const { dir: idTmp, packet: pk, run: runId } = evalWriteFixture('career-ops-eval-write-id-');
  try {
    const reportsFor = (slug) => readdirSync(join(idTmp, 'reports'))
      .filter(f => f.endsWith(`-${slug}-2026-09-19.md`));

    // Same title, same day, two employers, ONE invocation. This is the exact
    // shape that lost a req.
    const two = runId([
      pk('co-a.json', { company: 'Alphaco', slug: 'ai-engineer',
        url: 'https://example.invalid/alphaco/job/JR48085' }),
      pk('co-b.json', { company: 'Betaco', slug: 'ai-engineer',
        url: 'https://example.invalid/betaco/job/JR41415' }),
      '--date=2026-09-19']);
    const twoFiles = reportsFor('ai-engineer');
    const twoBodies = twoFiles.map(f => readFileSync(join(idTmp, 'reports', f), 'utf-8'));
    if (twoFiles.length === 2
        && twoBodies.some(b => /^company: "Alphaco"$/m.test(b))
        && twoBodies.some(b => /^company: "Betaco"$/m.test(b))) {
      pass('eval-write: two employers sharing a title slug both get a report');
    } else {
      fail(`two same-slug employers produced ${twoFiles.length} report(s) ` +
           `[${twoFiles.join(', ')}]: ${two.out.trim().slice(0, 250)}`);
    }

    // The duplicate guard must still hold, or this trades one silent loss for a
    // violation of pipeline rule 3. Same req, same URL, run twice.
    const again = runId([pk('co-a.json', { company: 'Alphaco', slug: 'ai-engineer',
      url: 'https://example.invalid/alphaco/job/JR48085' }), '--date=2026-09-19']);
    if (reportsFor('ai-engineer').length === 2 && /already written as/.test(again.out)) {
      pass('eval-write: re-running one req still refuses to write a second report');
    } else {
      fail(`a rerun wrote a duplicate: ${reportsFor('ai-engineer').join(', ')} / ` +
           `${again.out.trim().slice(0, 200)}`);
    }

    // A URL spelled differently is the same req and must still be caught, since
    // the identity is meant to be the requisition rather than the exact string.
    const spelt = runId([pk('co-a2.json', { company: 'Alphaco', slug: 'ai-engineer',
      url: 'https://example.invalid/alphaco/job/JR48085/' }), '--date=2026-09-19']);
    if (reportsFor('ai-engineer').length === 2 && /already written as/.test(spelt.out)) {
      pass('eval-write: a trailing-slash spelling of one req is the same req');
    } else {
      fail(`a re-spelled URL wrote a duplicate: ${spelt.out.trim().slice(0, 200)}`);
    }
  } finally {
    rmSync(idTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write report identity test crashed: ${e.message}`);
}

// ── A BASE BAND MUST NOT ARM THE TOTAL-COMP GATE ────────────────
// eval-write labelled ANY posted range as comp_total_est, and score-model reads
// that field as verified TOTAL compensation, scaling the whole score down when
// it misses the floor. Most postings print base, and a sub-floor base band
// says nothing about total once bonus and equity are counted. eval-prep.py
// records comp.basis precisely so this cannot happen; this asserts the writer
// honours it.
console.log('\n🧪 Testing eval-write gates comp only on a verified total band...');
try {
  const { dir: compTmp, packet, run: runWrite } = evalWriteFixture('career-ops-eval-write-comp-');
  try {
    mkdirSync(join(compTmp, 'config'));
    // The floor is configuration now, so this fixture supplies its own, as a real
    // setup would. 200 is a fixture value.
    writeFileSync(join(compTmp, 'config', 'profile.yml'),
      'compensation:\n  minimum: "USD 200K"\n');
    const SUB = '$120,000 - $150,000';   // well under the fixture's $200K total-comp floor
    const write = (slug, comp) => {
      // This fixture's own floor, not the suite-wide empty config directory. The
      // assertions below read the disk, not the exit code.
      runWrite([packet(`${slug}.json`, { slug, comp, url: `https://example.invalid/j/${slug}` }), '--date=2026-09-19'],
        { CAREER_OPS_CONFIG_DIR: join(compTmp, 'config') });
      const f = readdirSync(join(compTmp, 'reports')).find(x => x.includes(`-${slug}-`));
      const body = f ? readFileSync(join(compTmp, 'reports', f), 'utf-8') : '';
      return { body, final: Number((body.match(/^final:\s*([\d.]+)/m) || [])[1]) };
    };
    const base = write('comp-base', { posted: SUB, basis: 'base' });
    const total = write('comp-total', { posted: SUB, basis: 'total' });
    const none = write('comp-none', { posted: null, basis: null });
    const blank = write('comp-blank', { posted: SUB });   // basis never recorded

    // The invariant, stated as an equality rather than as an inequality: a
    // non-total band must score EXACTLY as a posting that published nothing,
    // because an unverified figure is not evidence about total comp at all.
    if (Number.isFinite(base.final) && base.final === none.final) {
      pass('eval-write: a sub-floor BASE band scores the same as no band at all');
    } else {
      fail(`a base band moved the score: base ${base.final} vs no-band ${none.final}`);
    }
    // ...and the gate must still exist, or the fix is just "never gate".
    if (Number.isFinite(total.final) && total.final < base.final) {
      pass('eval-write: a sub-floor band the posting calls TOTAL is still gated');
    } else {
      fail(`a sub-floor total band was not gated: total ${total.final} vs base ${base.final}`);
    }
    // A missing basis is unknown, not total. An older packet that never recorded
    // one has established nothing, and guessing toward the penalty is the bug.
    if (blank.final === none.final && /^comp_basis: unknown$/m.test(blank.body)) {
      pass('eval-write: a packet with no recorded basis is unknown, not total');
    } else {
      fail(`a basis-less packet scored ${blank.final} (want ${none.final}) and recorded ` +
           `${(blank.body.match(/^comp_basis:.*/m) || [''])[0]}`);
    }
    // The figure must not vanish from the report. Withholding it from the MODEL
    // is the fix; hiding it from the reader would be a different bug.
    if (base.body.includes(`comp_posted: "${SUB}"`) && /^comp_basis: base$/m.test(base.body)
        && !/comp_total_est/.test(base.body)) {
      pass('eval-write: the report still shows the posted band and names its basis');
    } else {
      fail(`the report lost the band or mislabelled it: ` +
           `${(base.body.match(/^comp_(posted|basis|total_est).*/gm) || []).join(' / ')}`);
    }
    // apply-model.mjs replays the model over the report TEXT, so a gate applied
    // at write time that the report does not record is undone on the next pass.
    if (/^comp_total_est: /m.test(total.body)) {
      pass('eval-write: a gated total band is persisted so a replay reproduces it');
    } else {
      fail('a gated total band was not written into the report, so a replay would undo it');
    }
  } finally {
    rmSync(compTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write comp basis test crashed: ${e.message}`);
}

// ── THE PACKET'S INSTRUCTION NAMES WHAT EVAL-WRITE REQUIRES ─────
// eval-prep told the evaluator to "fill every null", which included comp_total_est,
// the one field that arms the comp gate, so obeying it meant guessing a total. The
// instruction is now built from a list that must equal eval-write's REQUIRED, and
// must exempt comp_total_est by name.
console.log('\n🧪 Testing the eval-prep instruction matches eval-write REQUIRED...');
try {
  const ew = readFileSync(join(ROOT, 'eval-write.mjs'), 'utf-8');
  const ep = readFileSync(join(ROOT, 'scripts', 'eval-prep.py'), 'utf-8');
  const names = src => (src || '').match(/['"]([a-z_]+)['"]/g)?.map(x => x.slice(1, -1)) || [];
  const req = names(ew.match(/const REQUIRED = \[([^\]]*)\]/)?.[1]);
  const prepReq = names(ep.match(/^EVAL_WRITE_REQUIRED = \(([^)]*)\)/m)?.[1]);
  const instr = ep.match(/^INSTRUCTIONS = \(([\s\S]*?)\n\)/m)?.[1] || '';
  if (req.length && JSON.stringify(req) === JSON.stringify(prepReq)
      && /"_instructions": INSTRUCTIONS,/.test(ep)
      && /Leave comp_total_est null unless/.test(instr) && !/every null/i.test(instr)) {
    pass(`eval-prep's instruction names eval-write's ${req.length} required fields and exempts comp_total_est`);
  } else {
    fail(`eval-prep instruction drifted: REQUIRED ${JSON.stringify(req)} vs eval-prep ${JSON.stringify(prepReq)}`);
  }
} catch (e) {
  fail(`eval-prep instruction test crashed: ${e.message}`);
}

// ── A SCORED PACKET STATES ITS ARRANGEMENT ──────────────────────
// A null arrangement was derived from the location, so "Cary, NC" scored as onsite for
// an evaluator who meant unknown. Required now, and a value outside the four is refused
// per packet rather than thrown mid-run.
console.log('\n🧪 Testing eval-write requires a valid arrangement on a scored packet...');
try {
  const { dir: aTmp, packet, run: runA } = evalWriteFixture('career-ops-eval-write-arr-');
  try {
    const wrote = slug => readdirSync(join(aTmp, 'reports')).some(f => f.includes(`-${slug}-`));
    const none = runA([packet('none.json', { arrangement: null, slug: 'arr-none',
      url: 'https://example.invalid/fixture/job/71' }), '--date=2026-10-16']);
    const typo = runA([packet('typo.json', { arrangement: 'remote2', slug: 'arr-typo',
      url: 'https://example.invalid/fixture/job/72' }), '--date=2026-10-16']);
    const unk = runA([packet('unk.json', { arrangement: 'unknown', slug: 'arr-unk',
      url: 'https://example.invalid/fixture/job/73' }), '--date=2026-10-16']);
    if (/unfilled: arrangement/.test(none.out) && !wrote('arr-none')
        && /arrangement "remote2" is not/.test(typo.out) && !wrote('arr-typo')
        && wrote('arr-unk')) {
      pass('eval-write: a null or invalid arrangement is refused; "unknown" is written as a verdict');
    } else {
      fail(`arrangement gate: none=${wrote('arr-none')} typo=${wrote('arr-typo')} unknown=${wrote('arr-unk')} / ` +
        `${none.out.trim().slice(0, 120)} / ${typo.out.trim().slice(0, 120)}`);
    }
  } finally { rmSync(aTmp, { recursive: true, force: true }); }
} catch (e) {
  fail(`eval-write arrangement test crashed: ${e.message}`);
}

// ── A GATE-CLOSED PACKET IS RECORDED, NEVER SCORED ──────────────
// REQUIRED demanded all four dimensions, so a packet whose location gate failed
// after prep could not be written at all. Four in one day (2026-10-15) were moved
// into done/ by hand, the tracker got no row, and the next sweep re-surfaced each
// one as new work. The record it needs is the one audit-scores.mjs already accepts:
// `in_bounds: false`, the gate, every dimension null, no number anywhere, and a
// SKIP row whose score cell is N/A rather than a zero nobody judged.
console.log('\n🧪 Testing eval-write records a gate-closed packet without scoring it...');
try {
  const { SCORE_CELL } = await import(pathToFileURL(join(ROOT, 'tracker-rows.mjs')).href);
  const { dir: gTmp, packet, run: runG } = evalWriteFixture('career-ops-eval-write-gate-');
  try {
    const UNSCORED = { match_w_cv: null, north_star: null, comp_score: null, cultural_signals: null,
      red_flags_adj: 0, status: null, body: null, gate: null, recommendation: null };
    const FAIL = { ...UNSCORED, location: 'Texas, USA - Remote', location_verdict: 'fail',
      location_why: 'state-scoped remote, Texas only' };
    const reportOf = (slug) => {
      const f = readdirSync(join(gTmp, 'reports')).find(x => x.includes(`-${slug}-`));
      return f ? readFileSync(join(gTmp, 'reports', f), 'utf-8') : null;
    };
    const tsvOf = (slug) => {
      const d = join(gTmp, 'batch', 'tracker-additions');
      const f = existsSync(d) ? readdirSync(d).find(x => x.includes(slug)) : null;
      return f ? readFileSync(join(d, f), 'utf-8').trim().split('\t') : null;
    };
    const sentinels = () => readdirSync(join(gTmp, 'reports')).filter(x => x.endsWith('-RESERVED.md'));

    const out = runG([packet('tx.json', { ...FAIL, slug: 'gate-tx',
      url: 'https://example.invalid/acme/job/Texas/X_26WD134728' }), '--date=2026-10-15']);
    const md = reportOf('gate-tx') || '';
    const yaml = (md.split('```yaml')[1] || '');
    if (md && /^in_bounds: false$/m.test(yaml)
        && ['match_w_cv', 'north_star', 'comp', 'cultural_signals'].every(k =>
          new RegExp(`^  ${k}: null$`, 'm').test(yaml))
        && !/^(final|  global|  model_base):/m.test(yaml)
        && /^gate: "state-scoped remote, Texas only"$/m.test(yaml)
        && /^\*\*Score:\*\* N\/A/m.test(md)) {
      pass('eval-write: a location-fail packet writes in_bounds:false, null dimensions, its gate, and no number');
    } else {
      fail(`gate-closed report has the wrong shape: ${out.out.trim().slice(0, 200)} / ${yaml.slice(0, 400)}`);
    }

    // Status BEFORE score in the TSV; merge-tracker swaps them. N/A is the tracker's
    // own spelling for "no score", and a 0.0 there would read as a judgement of zero.
    const row = tsvOf('gate-tx') || [];
    if (row[4] === 'SKIP' && row[5] === 'N/A' && SCORE_CELL.test(row[5])
        && /Texas only/.test(row[8] || '') && /\(26WD134728\)/.test(row[3] || '')) {
      pass('eval-write: the gate-closed TSV is a SKIP row scored N/A with the gate in the note');
    } else {
      fail(`gate-closed TSV row is wrong: ${JSON.stringify(row)}`);
    }

    // The reader the shape exists for must actually accept it, asked of the tool and
    // not of a copy of its rule.
    let audit = { code: 0, out: '' };
    try {
      audit.out = execFileSync(NODE, [join(ROOT, 'audit-scores.mjs')],
        { cwd: gTmp, encoding: 'utf-8', timeout: 30000 });
    } catch (e) { audit = { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
    if (audit.code === 0 && /closed by a hard constraint before scoring: 1\b/.test(audit.out)
        && /no parseable scores: 0\b/.test(audit.out)) {
      pass('audit-scores reads the eval-write gate-closed report as closed, not as a missing score block');
    } else {
      fail(`audit-scores did not accept the gate-closed report (exit ${audit.code}): ${audit.out.trim().slice(0, 400)}`);
    }

    // A rerun is still one report per req.
    const again = runG([packet('tx.json', { ...FAIL, slug: 'gate-tx',
      url: 'https://example.invalid/acme/job/Texas/X_26WD134728' }), '--date=2026-10-15']);
    if (/already written as/.test(again.out)
        && readdirSync(join(gTmp, 'reports')).filter(x => x.includes('-gate-tx-')).length === 1) {
      pass('eval-write: re-running a gate-closed packet does not write a second report');
    } else {
      fail(`a gate-closed rerun wrote again: ${again.out.trim().slice(0, 200)}`);
    }

    // Closed AND scored is refused: a location fail scored 4.69 once put a 4.7 on the
    // tracker for a role the location policy rules out.
    const scored = runG([packet('scored.json', { ...FAIL, slug: 'gate-scored',
      url: 'https://example.invalid/acme/job/2', match_w_cv: 4.4, north_star: 4.6,
      comp_score: 4.5, cultural_signals: 4.2, status: 'Evaluated', body: 'b', gate: 'g',
      recommendation: 'r' }), '--date=2026-10-15']);
    if (/never scored/.test(scored.out) && !reportOf('gate-scored') && !sentinels().length) {
      pass('eval-write: a location-fail packet with filled dimensions is refused, not scored');
    } else {
      fail(`a gate-closed packet with dimensions was not refused: ${scored.out.trim().slice(0, 250)}`);
    }

    // The explicit form needs a reason: "no location returned" is not one.
    const bare = runG([packet('bare.json', { ...UNSCORED, slug: 'gate-bare', in_bounds: false,
      location_verdict: 'unknown', location_why: 'no location returned',
      url: 'https://example.invalid/acme/job/3' }), '--date=2026-10-15']);
    const said = runG([packet('said.json', { ...UNSCORED, slug: 'gate-said', in_bounds: false,
      location_verdict: 'unknown', location_why: 'no location returned',
      gate: 'Chatsworth onsite per the posting page; outside the commute ceiling',
      url: 'https://example.invalid/acme/job/4' }), '--date=2026-10-15']);
    const saidMd = reportOf('gate-said') || '';
    if (/unfilled: gate/.test(bare.out) && !reportOf('gate-bare')
        && /^gate: "Chatsworth onsite/m.test(saidMd) && /closed by a hard constraint/.test(saidMd)) {
      pass('eval-write: explicit in_bounds:false needs a gate, and writes it when given');
    } else {
      fail(`explicit in_bounds:false handled wrongly: ${bare.out.trim().slice(0, 150)} / ` +
           `${said.out.trim().slice(0, 150)}`);
    }

    // A role closed before scoring is a SKIP; any other status is a contradiction.
    const evald = runG([packet('evald.json', { ...FAIL, slug: 'gate-evald', status: 'Evaluated',
      url: 'https://example.invalid/acme/job/5' }), '--date=2026-10-15']);
    if (/recorded as SKIP/.test(evald.out) && !reportOf('gate-evald')) {
      pass('eval-write: a gate-closed packet with a non-SKIP status is refused');
    } else {
      fail(`a gate-closed packet kept status Evaluated: ${evald.out.trim().slice(0, 200)}`);
    }

    // parseScores keeps its MOST complete parse, one of them a loose prose scan, so
    // "comp floor of $175K" in the body reads as comp=175 and the audit would fail
    // the run. The writer asks the reader first, and refuses before claiming a number.
    const prose = runG([packet('prose.json', { ...FAIL, slug: 'gate-prose',
      body: 'The comp floor of $175K would have cleared.',
      url: 'https://example.invalid/acme/job/6' }), '--date=2026-10-15']);
    if (/audit-scores would read comp=175/.test(prose.out) && !reportOf('gate-prose')
        && !sentinels().length) {
      pass('eval-write: a body audit-scores would misread as a score is refused before a number is claimed');
    } else {
      fail(`a misreadable gate-closed body was not refused cleanly: ${prose.out.trim().slice(0, 250)} ` +
           `(sentinels: ${sentinels().join(', ')})`);
    }
  } finally {
    rmSync(gTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write gate-closed test crashed: ${e.message}`);
}

// ── SCORE-AUDIT PARSES BOTH location_final SEPARATORS ───────────
// The separator is a contract between two tools: eval-write writes the field
// and score-audit splits it to replay the model. Changing the writer off the
// em dash without teaching the reader would have silently dropped the model
// replay for the hundreds of reports already on disk that still carry the old
// one, and a replay that stops running looks exactly like a replay that agrees.
// Both fixtures state a final the model cannot reproduce, so the replay is
// OBSERVABLE: it prints "model says". If a branch stops parsing, its report
// falls out of the table entirely.
//
// The asserted VALUE is what makes this a parsing test rather than a "did it
// run" test. The reason text says the role is remote while the location says
// Santa Clara, so splitting the field correctly yields onsite and 3.77, while
// handing the model the whole undivided string yields remote and 4.00. A guard
// that fires but splits on nothing passes the weaker assertion and fails this one.
console.log('\n🧪 Testing score-audit replays the model for both location_final separators...');
try {
  const sepTmp = mkdtempSync(join(tmpdir(), 'career-ops-loc-sep-'));
  try {
    mkdirSync(join(sepTmp, 'data'));
    mkdirSync(join(sepTmp, 'reports'));
    const sepReport = (num, label, sep) =>
      `# ${num} - Fixtureco - ${label}\n\n` +
      `**Company:** Fixtureco\n` +
      `**Role:** ${label}\n` +
      `**Score:** 2.0/5\n` +
      `**URL:** https://example.invalid/fixture/${num}\n` +
      `**Date:** 2026-09-19\n\n` +
      `## Machine Summary\n\n` +
      '```yaml\n' +
      `num: ${num}\n` +
      `company: "Fixtureco"\n` +
      `role: "${label}"\n` +
      `date: 2026-09-19\n` +
      `location_final: "Santa Clara, California${sep}fully remote across the United States"\n` +
      `scores:\n` +
      `  match_w_cv: 4.0\n` +
      `  north_star: 4.0\n` +
      `  comp: 4.0\n` +
      `  cultural_signals: 4.0\n` +
      `  red_flags_adj: 0\n` +
      `  model_base: 4.00\n` +
      `comp_posted: "not published"\n` +
      `final: 2.00\n` +
      '```\n';
    // Built by code point, because nothing in this repository may contain that
    // character literally, this file included.
    writeFileSync(join(sepTmp, 'reports', '700-legacy-em-dash-2026-09-19.md'),
      sepReport(700, 'Legacy Separator Fixture', ` ${String.fromCharCode(0x2014)} `));
    writeFileSync(join(sepTmp, 'reports', '701-plain-separator-2026-09-19.md'),
      sepReport(701, 'Plain Separator Fixture', ' -- '));
    // Header and row agree with the stated final, so the ONLY thing that can
    // disagree is the model replay.
    writeFileSync(join(sepTmp, 'data', 'applications.md'),
      TRACKER_HEAD +
      '| 700 | 2026-09-19 | Fixtureco | Legacy Separator Fixture | 2.0/5 | Evaluated | x | [700](../reports/700-legacy-em-dash-2026-09-19.md) | legacy em dash separator |\n' +
      '| 701 | 2026-09-19 | Fixtureco | Plain Separator Fixture | 2.0/5 | Evaluated | x | [701](../reports/701-plain-separator-2026-09-19.md) | plain separator |\n');

    let sepOut = '';
    try {
      sepOut = execFileSync(NODE, [join(ROOT, 'score-audit.mjs')],
        { cwd: sepTmp, encoding: 'utf-8', timeout: 30000 });
    } catch (e) { sepOut = `${e.stdout || ''}${e.stderr || ''}`; }

    // 3.77 is the onsite reading of "Santa Clara, California". 4.00 would mean
    // the reason text reached the model too and it read the role as remote.
    const replayed = (num) => new RegExp(`^${num}\\s.*model says 3\\.77`, 'm').test(sepOut);
    if (replayed(700)) {
      pass('score-audit still splits the legacy em-dash separator and replays the location alone');
    } else {
      fail(`score-audit stopped parsing the legacy em-dash separator: ${sepOut.trim().slice(0, 400)}`);
    }
    if (replayed(701)) {
      pass('score-audit splits the plain separator eval-write now writes');
    } else {
      fail(`score-audit does not parse the plain separator eval-write now writes: ${sepOut.trim().slice(0, 400)}`);
    }
  } finally {
    rmSync(sepTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`score-audit separator test crashed: ${e.message}`);
}

// ── SCORE-AUDIT MUST NOT RE-ARM A GATE THE WRITER WITHHELD ──────
// This replay rebuilt `comp_total_est` out of comp_posted, which relabels any
// posted band as total compensation: the same mislabelling eval-write carried.
// Now that eval-write withholds the field for a non-total basis, a replay that
// kept relabelling would disagree with every correctly-written report, and this
// gate is supposed to exit non-zero only on a REAL disagreement. Asserted as a
// relation between three fixtures rather than against a constant, so it cannot
// pass by agreeing with a hardcoded number the model no longer produces.
console.log('\n🧪 Testing score-audit replays the comp gate on basis, not on presence...');
try {
  const cbTmp = mkdtempSync(join(tmpdir(), 'career-ops-audit-comp-'));
  try {
    mkdirSync(join(cbTmp, 'data'));
    mkdirSync(join(cbTmp, 'reports'));
    mkdirSync(join(cbTmp, 'config'));
    // The floor is configuration now, so this fixture supplies its own, as a real
    // setup would. 200 is a fixture value.
    writeFileSync(join(cbTmp, 'config', 'profile.yml'),
      'compensation:\n  minimum: "USD 200K"\n');
    const SUB = '$120,000 - $150,000';   // well under the fixture's $200K total-comp floor
    const cbReport = (num, posted, basis) =>
      `# ${num} - Fixtureco - Comp Basis Fixture\n\n` +
      `**Company:** Fixtureco\n**Role:** Comp Basis Fixture\n**Score:** 2.0/5\n` +
      `**URL:** https://example.invalid/fixture/${num}\n**Date:** 2026-09-19\n\n` +
      `## Machine Summary\n\n` +
      '```yaml\n' +
      `num: ${num}\ncompany: "Fixtureco"\nrole: "Comp Basis Fixture"\ndate: 2026-09-19\n` +
      `location_final: "Remote - United States -- remote across the United States"\n` +
      `scores:\n  match_w_cv: 4.0\n  north_star: 4.0\n  comp: 4.0\n` +
      `  cultural_signals: 4.0\n  red_flags_adj: 0\n  model_base: 4.00\n` +
      `comp_posted: "${posted}"\ncomp_basis: ${basis}\nfinal: 2.00\n` +
      '```\n';
    const fixtures = [[710, 'not published', 'none'], [711, SUB, 'base'],
                      [712, SUB, 'total'], [713, SUB, 'unknown']];
    let table = TRACKER_HEAD;
    for (const [num, posted, basis] of fixtures) {
      writeFileSync(join(cbTmp, 'reports', `${num}-comp-basis-2026-09-19.md`),
        cbReport(num, posted, basis));
      table += `| ${num} | 2026-09-19 | Fixtureco | Comp Basis Fixture | 2.0/5 | Evaluated | x | ` +
        `[${num}](../reports/${num}-comp-basis-2026-09-19.md) | ${basis} |\n`;
    }
    writeFileSync(join(cbTmp, 'data', 'applications.md'), table);

    let cbOut = '';
    try {
      cbOut = execFileSync(NODE, [join(ROOT, 'score-audit.mjs')],
        { cwd: cbTmp, encoding: 'utf-8', timeout: 30000,
          env: { ...process.env, CAREER_OPS_CONFIG_DIR: join(cbTmp, 'config') } });
    } catch (e) { cbOut = `${e.stdout || ''}${e.stderr || ''}`; }
    const said = (num) => {
      const m = cbOut.match(new RegExp(`^${num}\\s.*model says ([\\d.]+)`, 'm'));
      return m ? Number(m[1]) : null;
    };
    const [noBand, baseBand, totalBand, unknownBand] =
      [said(710), said(711), said(712), said(713)];
    if (noBand !== null && baseBand === noBand && unknownBand === noBand) {
      pass('score-audit: a base or unknown band replays exactly as no band at all');
    } else {
      fail(`score-audit re-armed the gate on an unverified band: no-band ${noBand}, ` +
           `base ${baseBand}, unknown ${unknownBand}`);
    }
    if (totalBand !== null && noBand !== null && totalBand < noBand) {
      pass('score-audit: a band the report calls TOTAL is still replayed through the gate');
    } else {
      fail(`score-audit stopped gating a sub-floor total band: ${totalBand} vs ${noBand}`);
    }
  } finally {
    rmSync(cbTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`score-audit comp basis test crashed: ${e.message}`);
}

// ── ONE REQUISITION PATTERN FOR EVERY NODE CONSUMER ─────────────
// The pattern existed in FOUR places in four spellings. The previous round
// unified two of them and asserted those two were byte-equal, which guards two
// of four; role-matcher.mjs had no branch for Autodesk's year-prefixed 26WD form
// (so _26WD161146 returned null, and a null id is not a conflict, so
// merge-tracker and dedup-tracker lost the job-id guard and fell back to fuzzy
// titles), and eval-write.mjs kept a four-digit floor after JR, which is the
// exact bug removed from pipeline-audit because four digits also matches the
// DATE in a report filename slug.
//
// Three of the four are Node and Node can import, so the fix is structural: they
// read one source. These checks assert the STRUCTURE, not the behaviour, because
// behaviour tests only catch a drift that happens to break a case they hold.
console.log('\n🧪 Testing one Workday requisition pattern serves every Node consumer...');
try {
  // Comments are stripped before the literal scan: naming the old broken pattern
  // in a comment is exactly how this stays understandable, and a scan that
  // punished it would push the explanation out of the file.
  for (const f of ['pipeline-audit.mjs', 'role-matcher.mjs', 'eval-write.mjs']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    if (/from '\.\/req-id-core\.mjs'/.test(src)) {
      pass(`${f} takes the requisition pattern from req-id-core.mjs`);
    } else {
      fail(`${f} no longer imports the shared requisition pattern`);
    }
    const literal = codeOnly(src).match(/JR[^\n]{0,8}\\d\{/i);
    if (!literal) {
      pass(`${f} holds no requisition pattern of its own`);
    } else {
      fail(`${f} reintroduced a literal requisition pattern: ${literal[0]}`);
    }
  }
  // The scan has to be able to SEE a literal, or "no literal found" means nothing.
  const canSee = /JR[^\n]{0,8}\\d\{/i.test("const x = /\\b(jr[-_]?\\d{4,})\\b/i;");
  if (canSee) {
    pass('the literal-pattern scan detects a reintroduced pattern');
  } else {
    fail('the literal-pattern scan cannot detect a literal, so it proves nothing');
  }
} catch (e) {
  fail(`shared requisition pattern test crashed: ${e.message}`);
}

console.log('\n🧪 Testing role-matcher reads the tenant forms the shared pattern knows...');
try {
  const { extractJobId } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);
  // The form this file had no branch for at all. It returned null, and two nulls
  // never conflict, so every Autodesk row lost the job-id dedup guard.
  const ad = extractJobId('https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/Example-Role-05_26WD161146');
  if (ad === 'wd:26wd161146') {
    pass('extractJobId reads Autodesk\'s year-prefixed req id (26WD161146)');
  } else {
    fail(`extractJobId returned ${ad} for an Autodesk 26WD requisition`);
  }
  // Two spellings of ONE Autodesk req. Both null before, which is equal by
  // accident rather than by identity, so assert the value and not just equality.
  const bare = extractJobId('https://autodesk.wd1.myworkdayjobs.com/Ext/job/Remote/Principal-MCP-AI-Dev_26WD91231');
  const facet = extractJobId('https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/Example-Role-05_26WD91231-1');
  if (bare === 'wd:26wd91231' && facet === 'wd:26wd91231') {
    pass('extractJobId folds an Autodesk facet suffix onto the bare req id');
  } else {
    fail(`Autodesk facet suffix not folded: bare=${bare} facet=${facet}`);
  }
  // Forms role-matcher legitimately needs beyond the shared pattern must survive
  // the unification, or a "fix" has quietly narrowed the extractor.
  const p = extractJobId('https://zillow.wd5.myworkdayjobs.com/x/job/Remote-USA/Principal-MLE_P711740-2');
  const req = extractJobId('https://careers.example.invalid/careers/REQ-0850786/apply');
  if (p === 'wd:p711740' && req === 'wd:req0850786') {
    pass('extractJobId still reads the P and REQ forms the shared pattern excludes');
  } else {
    fail(`composition dropped a form role-matcher needs: P=${p} REQ=${req}`);
  }
  // Disney-style bare numeric ids, keyed by tenant. Without them both rows were null and
  // the fuzzy title fallback merged two different requisitions with similar titles.
  const d1 = extractJobId('https://disney.wd5.myworkdayjobs.com/disneycareer/job/X/Y_10000101');
  const d2 = extractJobId('https://disney.wd5.myworkdayjobs.com/en-US/disneycareer/job/X/Z_10000202-1');
  if (d1 === 'wd:disney:10000101' && d2 === 'wd:disney:10000202') {
    pass('extractJobId keys a bare Workday id by tenant and folds the facet suffix');
  } else {
    fail(`bare Workday ids: d1=${d1} d2=${d2}`);
  }
  // Review findings: the tenant must be the URL's own HOST, and the fallback must never
  // re-key a URL an earlier rule already answered.
  const wrapped = extractJobId('https://wrapper.example/r/disney.wd5.myworkdayjobs.com/x/job/Y/Z_10000303');
  const kept = extractJobId('https://disney.wd5.myworkdayjobs.com/Site/job/1234567/Y_10000303');
  if (wrapped === null && kept === 'id:1234567') {
    pass('the bare-id fallback reads only a Workday host and never overrides an earlier rule');
  } else {
    fail(`bare-id fallback: wrapped=${wrapped} (want null), kept=${kept} (want id:1234567)`);
  }
} catch (e) {
  fail(`role-matcher tenant-form test crashed: ${e.message}`);
}

console.log('\n🧪 Testing eval-write labels the tracker role cell from the shared pattern...');
try {
  const { dir: labTmp, packet, run: runWrite } = evalWriteFixture('career-ops-eval-write-label-');
  try {
    const runLabel = (name, over) => {
      const r = runWrite([packet(name, over), '--date=2026-09-19']);
      if (r.code !== 0) return `RUN FAILED: ${r.out}`;
      const dir = join(labTmp, 'batch', 'tracker-additions');
      const tsv = readdirSync(dir).filter(x => x.includes(over.slug));
      return tsv.length ? readFileSync(join(dir, tsv[0]), 'utf-8') : '';
    };

    // The role cell is how the req id reaches merge-tracker, which dedups on it
    // and over-merges on the fuzzy fallback when it is missing. Autodesk had no
    // branch here either, so every Autodesk row arrived with no id at all.
    const adTsv = runLabel('autodesk.json', { slug: 'label-autodesk',
      url: 'https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/Example-Role-05_26WD161146' });
    if (/\(26WD161146\)/.test(adTsv)) {
      pass('eval-write labels an Autodesk 26WD requisition in the role cell');
    } else {
      fail(`eval-write dropped the Autodesk req id: ${adTsv.trim().slice(0, 200)}`);
    }

    // The four-digit floor this file used to carry is the DATE-in-a-slug bug. A
    // four-digit JR is not a requisition and must not be labelled as one.
    const shortTsv = runLabel('shortjr.json', { slug: 'label-shortjr',
      url: 'https://careers.example.invalid/job/Agent-Engineer_JR2026' });
    if (!/\(JR2026\)/.test(shortTsv)) {
      pass('eval-write does not read a four-digit JR token as a requisition');
    } else {
      fail(`eval-write labelled a four-digit token as a req id: ${shortTsv.trim().slice(0, 200)}`);
    }

    // The bare numeric Workday id is eval-write's OWN extra alternative, kept
    // because it is only a label here and not a dedup key. Composition must not
    // have dropped it.
    const numTsv = runLabel('barenum.json', { slug: 'label-barenum',
      url: 'https://fixtureco.wd1.myworkdayjobs.com/Ext/job/Remote/Agent-Engineer_17372837' });
    if (/\(17372837\)/.test(numTsv)) {
      pass('eval-write still labels a bare numeric Workday id');
    } else {
      fail(`eval-write dropped the bare numeric Workday id: ${numTsv.trim().slice(0, 200)}`);
    }
  } finally {
    rmSync(labTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write role-cell label test crashed: ${e.message}`);
}

// ── ONE REPORT PER REQ, ACROSS A CHANGED TITLE OR DATE ──────────
// sameReq() only ever ran against reports whose filename ended
// `-<slug>-<DATE>.md`, and both halves of that key are mutable: `slug` comes from
// the TITLE and the date comes from the command line. So a req retried on another
// day, or whose ATS title changed between packets, never had its existing report
// examined even though the machine summary carried an identical url, and a second
// report plus a second tracker row was written for one req, against pipeline
// rule 3.
console.log('\n🧪 Testing eval-write finds a prior report by req, not by title and date...');
try {
  const { dir: dupTmp, packet, run: runWrite } = evalWriteFixture('career-ops-eval-write-dup-');
  try {
    const runDup = (name, date, over) => runWrite([packet(name, over), `--date=${date}`]).out;
    const URL_A = 'https://example.invalid/fixture/job/900001';

    runDup('first.json', '2026-09-01', { slug: 'alpha-title', url: URL_A });
    // Same req. Different ATS title, different day. Both halves of the old key
    // changed and the url did not.
    const second = runDup('second.json', '2026-09-19', { slug: 'beta-title', url: URL_A });
    if (/SKIP .*already written as/.test(second)) {
      pass('eval-write: one url means one report, whatever the title and date say');
    } else {
      fail(`eval-write minted a second report for one req: ${second.trim().slice(0, 250)}`);
    }

    // normUrl folds the SCHEME and HOST and not the path, since lowercasing a whole URL
    // conflates postings that differ only by case. Here that change is invisible, and the
    // reason is worth recording: a path-case variant of the same URL still carries the
    // same REQUISITION, and req identity is the stronger key, so the report is correctly
    // found either way. The case sensitivity is load-bearing in scripts/eval-blockers.py,
    // whose report_for() consults the url index BEFORE the requisition index and would
    // otherwise mark an unevaluated packet `reported` and let --prune move it out. The
    // property is asserted there, against norm_url directly.
    const cased = runDup('cased.json', '2026-09-19',
      { slug: 'delta-title', url: URL_A.replace(/\/job\//, '/JOB/') });
    if (/SKIP .*already written as/.test(cased)) {
      pass('eval-write: one requisition stays one report through a path-case variant');
    } else {
      fail(`eval-write minted a second report for one req: ${cased.trim().slice(0, 250)}`);
    }
    const hosted = runDup('hosted.json', '2026-09-19',
      { slug: 'epsilon-title', url: URL_A.replace('example.invalid', 'EXAMPLE.invalid') });
    if (/SKIP .*already written as/.test(hosted)) {
      pass('eval-write: a host differing only in case is the same posting');
    } else {
      fail(`eval-write treated a host case change as a new req: ${hosted.trim().slice(0, 250)}`);
    }

    // normUrl's own property, asserted in the SOURCE. It cannot be reached through the
    // fixtures above, because requisition identity is the stronger key and finds the
    // report whatever the url comparison says, and eval-write.mjs runs its work at import
    // so it cannot be pulled in and called directly. Same idiom the requisition-pattern
    // scan uses: when behaviour cannot observe a rule, assert the rule.
    const ewSrc = readFileSync('eval-write.mjs', 'utf8');
    const nuAt = ewSrc.indexOf('const normUrl');
    const nuEnd = nuAt < 0 ? -1 : ewSrc.indexOf('\n};', nuAt);
    const nu = nuEnd < 0 ? '' : ewSrc.slice(nuAt, nuEnd);
    if (/m\[1\]\.toLowerCase\(\)\s*\+\s*m\[2\]\.toLowerCase\(\)\s*\+\s*m\[3\]/.test(nu)
        && !/m\[3\]\.toLowerCase/.test(nu)) {
      pass('eval-write normUrl folds scheme and host and leaves the path alone');
    } else {
      fail('eval-write normUrl must fold only the case-insensitive URL components: '
        + nu.trim().slice(0, 200));
    }

    // Control: the widened search must not skip everything. A genuinely different
    // req still gets its report, or the check above passes for the wrong reason.
    const other = runDup('other.json', '2026-09-19',
      { slug: 'gamma-title', url: 'https://example.invalid/fixture/job/900002' });
    if (/WROTE/.test(other) && !/SKIP/.test(other)) {
      pass('eval-write still writes a report for a genuinely different req');
    } else {
      fail(`eval-write skipped a distinct req: ${other.trim().slice(0, 250)}`);
    }

    // Two packets for one req inside a SINGLE invocation. The index is built once,
    // before either report exists, so without feeding each write back into it both
    // packets see an empty index and both write.
    const oneRun = runWrite([
      packet('batch1.json', { slug: 'theta-title', url: 'https://example.invalid/fixture/job/900003' }),
      packet('batch2.json', { slug: 'iota-title', url: 'https://example.invalid/fixture/job/900003' }),
      '--date=2026-09-19']).out;
    if ((oneRun.match(/^WROTE /gm) || []).length === 1 && /SKIP .*already written as/.test(oneRun)) {
      pass('eval-write: two packets for one req in one invocation write one report');
    } else {
      fail(`eval-write wrote both packets of one req in a single run: ${oneRun.trim().slice(0, 250)}`);
    }

    // A Workday re-slug gives ONE req two urls. The req-id arm is what catches it.
    runDup('wd1.json', '2026-09-01', { slug: 'delta-title', company: 'Fixtureco',
      url: 'https://fixtureco.wd1.myworkdayjobs.com/Ext/job/Santa-Clara/Old-Slug_JR2391853' });
    const reslug = runDup('wd2.json', '2026-09-19', { slug: 'epsilon-title', company: 'Fixtureco',
      url: 'https://fixtureco.wd1.myworkdayjobs.com/en-US/Ext/job/Remote/New-Slug_JR2391853' });
    if (/SKIP .*already written as/.test(reslug)) {
      pass('eval-write: a re-slugged Workday req resolves to its existing report');
    } else {
      fail(`eval-write minted a second report for a re-slugged req: ${reslug.trim().slice(0, 250)}`);
    }

    // ...and the req-id arm is SCOPED BY COMPANY, because a bare Workday R number
    // is not unique across tenants and a false hit here is a silent no-report.
    runDup('r1.json', '2026-09-01', { slug: 'zeta-title', company: 'Fixtureco',
      url: 'https://fixtureco.wd1.myworkdayjobs.com/Ext/job/Remote/Engineer_R11095' });
    const otherCo = runDup('r2.json', '2026-09-19', { slug: 'eta-title', company: 'Othercorp',
      url: 'https://othercorp.wd5.myworkdayjobs.com/Careers/job/Remote/Engineer_R11095' });
    if (/WROTE/.test(otherCo) && !/SKIP/.test(otherCo)) {
      pass('eval-write: two tenants sharing an R number are still two reqs');
    } else {
      fail(`eval-write merged two tenants on a shared R number: ${otherCo.trim().slice(0, 250)}`);
    }
  } finally {
    rmSync(dupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`eval-write prior-report test crashed: ${e.message}`);
}

// ── ONE HOST-ID TABLE, ONE ROLE-CELL ID DEFINITION ──────────────
// Host-anchored requisition ids (Apple, Google, iCIMS and its front ends, EA, Breezy)
// lived only in role-matcher.mjs, so eval-blockers.py could not recognise a packet on
// those hosts as already reported unless its url matched a report's exactly. They are
// DATA in host-ids.json now. Each rule carries its own example and key, which
// role-matcher is held to here and eval-blockers --selftest holds itself to, so a rule
// added to the file is tested in both with nothing else to edit.
//
// The role cell had three definitions of "an id": eval-write's label (writer),
// role-matcher's identity (reader) and scan.mjs's canonicalRole (stripper), kept in
// step by a comment. The writer and stripper now live in req-id-core.mjs beside the
// reader's pattern, and the inclusions that matter are asserted: whatever the writer
// puts in a role cell, and whatever the reader finds there, the stripper removes, or a
// tracked role comes back as new on every scan. Fixtures always run; the real tracker
// and the reports it links are read too whenever they are on disk.
console.log('\n🧪 Testing one host-id table and one role-cell id definition...');
try {
  const hostIds = JSON.parse(readFileSync(join(ROOT, 'host-ids.json'), 'utf-8'));
  const { extractJobId, rowIdReader } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);

  for (const r of hostIds.rules) {
    const got = extractJobId(r.example);
    if (got === r.key) pass(`role-matcher keys the ${r.ns} example as ${r.key}`);
    else fail(`role-matcher keyed host-ids.json's ${r.ns} example ${r.example} as ${got}, want ${r.key}`);
  }
  // An example proves a rule matches; only the anchor proves it matches nothing ELSE.
  // Two equal ids merge two rows, so an unanchored rule is the damage the id prevents.
  const loose = hostIds.rules.filter(r => !r.re.startsWith('^(?:https?://)?'));
  if (!loose.length) pass(`every host-ids.json rule is anchored at the url's own host (${hostIds.rules.length})`);
  else fail(`host-ids.json rules not anchored at the host: ${loose.map(r => r.ns).join(', ')}`);

  // role-matcher consumes the TABLE beside it, not a private copy: run it against a
  // planted table holding a rule nobody else has.
  const probeDir = mkdtempSync(join(tmpdir(), 'career-ops-host-ids-'));
  try {
    for (const f of ['role-matcher.mjs', 'req-id-core.mjs']) {
      writeFileSync(join(probeDir, f), readFileSync(join(ROOT, f)));
    }
    writeFileSync(join(probeDir, 'host-ids.json'), JSON.stringify({ rules: [
      { ns: 'probe', re: String.raw`^(?:https?://)?jobs\.probe\.invalid/(\d+)` }] }));
    const probed = await import(pathToFileURL(join(probeDir, 'role-matcher.mjs')).href);
    const got = probed.extractJobId('https://jobs.probe.invalid/123');
    if (got === 'probe:123') pass('role-matcher reads its host rules from host-ids.json');
    else fail(`role-matcher ignored a planted host-ids.json rule (got ${got})`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  // eval-blockers proves the same with a planted table in its own --selftest.
  if (readFileSync(join(ROOT, 'scripts/eval-blockers.py'), 'utf-8').includes('"host-ids.json"')) {
    pass('scripts/eval-blockers.py names host-ids.json as its table');
  } else {
    fail('scripts/eval-blockers.py no longer names host-ids.json');
  }

  // No literal copy. A copy is recognisable by a rule's host written as a REGEX would
  // write it, "jobs\.apple\.com" or "jobs[.]apple[.]com"; the plain spelling may appear
  // in prose and fixtures.
  const hostsOf = (re) => re.match(/[a-z0-9-]+(?:\\\.[a-z0-9-]+)+/gi) || [];
  const copyOf = (h) => new RegExp(h.split('\\.').join(String.raw`(?:\\\.|\[\.\])`), 'i');
  const hosts = [...new Set(hostIds.rules.flatMap(r => hostsOf(r.re)))];
  if (hostIds.rules.every(r => hostsOf(r.re).length)) {
    pass(`the literal scan found an escaped host in every rule (${hosts.length} hosts)`);
  } else {
    fail('a host-ids.json rule yields no escaped host, so the literal scan cannot see a copy of it');
  }
  const planted = ['const R = /^jobs\\.apple\\.com\\/x/i;', "R = re.compile(r'jobs[.]apple[.]com')"];
  if (planted.every(s => hosts.some(h => copyOf(h).test(s)))) {
    pass('the literal scan detects a planted copy in either spelling');
  } else {
    fail('the literal scan cannot detect a planted copy, so it proves nothing');
  }
  for (const f of ['role-matcher.mjs', 'scripts/eval-blockers.py']) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    const copies = hosts.filter(h => copyOf(h).test(src));
    if (!copies.length) pass(`${f} holds no literal copy of a host rule`);
    else fail(`${f} holds its own copy of a host rule: ${copies.join(', ')}`);
  }

  // The writer and the stripper are imported, never redefined.
  const core = await import(pathToFileURL(join(ROOT, 'req-id-core.mjs')).href);
  const { canonicalRole } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  for (const [f, name, def] of [
    ['eval-write.mjs', 'reqLabel', /(?:const|let|function)\s+reqLabel\b/],
    ['scan.mjs', 'ROLE_ID_TOKEN_SRC', /(?:const|let)\s+ROLE_ID_TOKEN\w*\s*=/],
  ]) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    const imports = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./req-id-core\\.mjs'`).test(src);
    if (imports && !def.test(src)) pass(`${f} imports ${name} from req-id-core.mjs and defines none of its own`);
    else fail(`${f} must import ${name} from req-id-core.mjs rather than define it`);
  }

  // An id token is stripped when the title comes back WHOLE and nothing else: once in
  // the parenthesis eval-write writes and once bare, as hand-written cells carry it.
  const T = 'Example Role';
  const strippedBy = (strip) => (tok) =>
    strip(`${T} (${tok})`) === 'example role' && strip(`${T} ${tok}`) === 'example role';
  const strips = strippedBy(canonicalRole);
  // A fake reader-side token list: every raw span the shared pattern finds, which is
  // role-matcher's reqIdsIn(). Checked below to account for every id rowIdReader reports.
  const rawIds = (cell) => [...String(cell).matchAll(core.reqIdGlobal())].map(m => m[1]);
  const keyOf = (raw) => `wd:${core.canonId(raw).toLowerCase()}`;
  const noStrip = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const digitsOnly = (s) => noStrip(String(s).replace(/\d+/g, ' '));
  if (canonicalRole(T) === 'example role' && strips('JR1000001')
      && !strippedBy(noStrip)('JR1000001') && !strippedBy(digitsOnly)('JR1000001')
      && !strippedBy(() => '')('JR1000001')) {
    pass('the inclusion check goes red against a stripper that strips nothing, keeps a prefix or erases the title');
  } else {
    fail('the inclusion check cannot fail, so it proves nothing');
  }

  // Fixtures: one url per writer branch and one cell per reader form.
  const writerFixtures = [
    'https://fixture.wd5.myworkdayjobs.com/Site/job/US/Role_JR1000001',
    'https://fixture.wd5.myworkdayjobs.com/Site/job/US/Role_JR-100001',
    'https://fixture.wd5.myworkdayjobs.com/Site/job/US/Role_R23555-1',
    'https://fixture.wd1.myworkdayjobs.com/Ext/job/CA/Role_26WD100001-1',
    'https://fixture.wd5.myworkdayjobs.com/Site/job/US/Role_10000101',
    'https://job-boards.greenhouse.io/fixture/jobs/1000001',
  ];
  const readerFixtures = ['Senior Engineer (Team, JR1000001)', 'Staff Engineer JR-100001',
    'Engineer (R23555-1)', 'Engineer - 26WD100001'];
  const read = rowIdReader(ROOT);
  const checkWriter = (urls) => {
    const out = { labels: 0, misses: [] };
    for (const u of urls) {
      const label = core.reqLabel(u);
      if (!label) continue;
      out.labels++;
      if (!strips(label)) out.misses.push(`${label} from ${u}`);
    }
    return out;
  };
  const checkReader = (cells) => {
    const out = { ids: 0, misses: [] };
    for (const cell of cells) {
      const raws = rawIds(cell);
      const located = new Set(raws.map(keyOf));
      for (const id of read({ role: cell, report: '' })) {
        out.ids++;
        if (!located.has(id)) out.misses.push(`${cell} [${id}: not a span this check can locate]`);
      }
      for (const raw of raws) if (!strips(raw)) out.misses.push(`${cell} [${raw}]`);
    }
    return out;
  };
  const wf = checkWriter(writerFixtures), rf = checkReader(readerFixtures);
  if (wf.labels === writerFixtures.length && !wf.misses.length) pass(`every writer fixture label is stripped (${wf.labels})`);
  else fail(`writer fixtures: ${wf.labels}/${writerFixtures.length} labelled, kept: ${wf.misses.join('; ')}`);
  if (rf.ids === readerFixtures.length && !rf.misses.length) pass(`every reader fixture id is stripped (${rf.ids})`);
  else fail(`reader fixtures: ${rf.ids}/${readerFixtures.length} read, kept: ${rf.misses.join('; ')}`);

  const { trackerPath, columnsOf, parseRow } = await import(pathToFileURL(join(ROOT, 'tracker-rows.mjs')).href);
  const tracker = trackerPath(ROOT);
  if (!existsSync(tracker)) {
    console.log(`  (no tracker at ${tracker}: the fixtures above are the whole check here)`);
  } else {
    const trackerDir = dirname(tracker);
    const lines = readFileSync(tracker, 'utf-8').split('\n');
    const cols = columnsOf(lines);
    const cells = [], urls = new Set();
    let links = 0, readable = 0;
    for (const line of lines) {
      const row = line.startsWith('|') ? parseRow(line, cols) : null;
      if (!row) continue;
      cells.push(row.role);
      const link = String(row.report).match(/\]\(([^)]+)\)/);
      if (!link) continue;
      links++;
      const path = join(trackerDir, link[1]);
      if (!existsSync(path)) continue;
      readable++;
      const m = readFileSync(path, 'utf-8').match(/^[ \t]*\*\*URL:\*\*[ \t]*(\S+)/im);
      if (m) urls.add(m[1]);
    }
    const r = checkReader(cells);
    if (!r.misses.length) pass(`every role-cell id role-matcher reads is stripped by canonicalRole (${r.ids} ids in ${cells.length} rows)`);
    else fail(`canonicalRole keeps ${r.misses.length} role-cell ids: ${r.misses.slice(0, 3).join('; ')}`);
    if (!readable) {
      console.log(`  (none of the tracker's ${links} report links is on disk: the writer corpus check has nothing to read)`);
    } else {
      const w = checkWriter(urls);
      if (!w.misses.length) pass(`every label eval-write would write is stripped by canonicalRole (${w.labels} labels, ${readable}/${links} linked reports read)`);
      else fail(`canonicalRole keeps ${w.misses.length} of ${w.labels} writer labels: ${w.misses.slice(0, 3).join('; ')}`);
    }
  }
} catch (e) {
  fail(`host-id table / role-cell definition test crashed: ${e.message}`);
}

// ── SETUP HARNESS ───────────────────────────────────────────────
//
// setup.mjs is the first thing a new user runs, and every other tool trusts what it
// writes. So the test is not "did it write files" but "does every READER accept them":
// the Node scoring model and location gate, the Python comp reader, location policy and
// lane scorer, the portals validator and doctor. A setup that wrote a profile eval-prep
// then refused would pass a files-exist check and fail on the user's first evaluation.

console.log('\nSetup harness (first-install configuration)');
{
  const setupRoot = mkdtempSync(join(tmpdir(), 'career-ops-setup-'));
  const sh = (args, opts = {}) => {
    try {
      return { code: 0, out: execFileSync(NODE, [join(ROOT, 'setup.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  const py = (code) => {
    const f = join(setupRoot, `check-${Math.abs(code.length)}.py`);
    writeFileSync(f, code);
    try {
      return execFileSync('python', [f], { cwd: ROOT, encoding: 'utf-8', timeout: 60000 }).trim();
    } catch (e) { return `ERROR ${e.stdout || ''}${e.stderr || ''}`.trim(); }
  };
  try {
    // 1. A custom Texas profile on the general preset, with a CV to copy in.
    const tx = join(setupRoot, 'tx');
    const answers = JSON.parse(sh(['--example-answers']).out);
    const cvSrc = join(setupRoot, 'cv-source.md');
    writeFileSync(cvSrc, '# Jane Smith\n\nBackend engineer.\n');
    answers.cv_path = cvSrc;
    const ansFile = join(setupRoot, 'tx-answers.json');
    writeFileSync(ansFile, JSON.stringify(answers));
    const r1 = sh(['--answers', ansFile, '--target', tx]);
    const wrote = ['config/profile.yml', 'config/location.json', 'config/lane-vocab.json',
      'portals.yml', 'modes/_profile.md', 'cv.md'].filter((f) => existsSync(join(tx, f)));
    if (r1.code === 0 && wrote.length === 6) pass('setup: writes all six User Layer files');
    else fail(`setup: exit ${r1.code}, wrote ${wrote.length}/6: ${r1.out.slice(0, 300)}`);

    const doc = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', tx]) || '{}');
    if (doc.onboardingNeeded === false) pass('setup: doctor sees a fully provisioned install');
    else fail(`setup: doctor still wants onboarding: ${JSON.stringify(doc)}`);

    if (run(NODE, ['validate-portals.mjs', '--file', join(tx, 'portals.yml')]) !== null) {
      pass('setup: the portals.yml it writes validates');
    } else fail('setup: validate-portals rejected the generated portals.yml');

    // Node readers: the scoring model and the location gate.
    const SM = await import(pathToFileURL(join(ROOT, 'score-model.mjs')).href);
    const cand = SM.loadCandidate(join(tx, 'config'));
    const prefs = SM.loadPrefs(join(tx, 'config'));
    if (cand.compFloorK === 150 && cand.firstName === 'Jane'
        && cand.pastEmployers.join() === 'Acme Corp' && SM.preference('Stripe', prefs) === 1) {
      pass('setup: score-model reads the floor, name, past employers and preferences');
    } else fail(`setup: score-model read ${JSON.stringify(cand)} prefs ${prefs.length}`);
    const LC = await import(pathToFileURL(join(ROOT, 'location-core.mjs')).href);
    const sig = LC.buildSignals(LC.locationFilterFromPolicy(
      JSON.parse(readFileSync(join(tx, 'config', 'location.json'), 'utf8'))));
    const lc = ['US, TX, Remote', 'US, CA, Remote', 'Round Rock, TX', 'Houston, TX']
      .map((o) => LC.classifyLocationOption(o, sig)).join(',');
    if (lc === 'accept,reject,accept,reject') pass('setup: the scanner gate reads the written location policy');
    else fail(`setup: scanner gate verdicts ${lc}`);

    // Python readers: comp targets, location policy and gate, lane scorer.
    const cfg = join(tx, 'config').replace(/\\/g, '/');
    const out = py(`import importlib.util, sys
sys.path.insert(0, "scripts")
spec = importlib.util.spec_from_file_location("ep", "scripts/eval-prep.py")
ep = importlib.util.module_from_spec(spec); spec.loader.exec_module(ep)
import _location, _lane
pol = _location.load("${cfg}/location.json")
_lane.configure(_lane.load_vocab("${cfg}/lane-vocab.json"))
print(ep.comp_targets("${cfg}/profile.yml"),
      ep.location_verdict("US, TX, Remote", False, pol)[0],
      ep.location_verdict("US, CA, Remote", False, pol)[0],
      ep.location_verdict("Round Rock, TX", False, pol)[0],
      _lane.lane_score("Senior Backend Engineer") > 0,
      _lane.lane_score("Sales Engineer") < _lane.lane_score("Senior Backend Engineer"))`);
    if (out === '(150000, 220000) pass fail pass True True') {
      pass('setup: eval-prep, the location policy and the lane scorer read the written config');
    } else fail(`setup: Python readers disagree: ${out.slice(0, 400)}`);

    // 2. It never overwrites the user's files without --force: it keeps what exists and
    // writes only what is missing, so a half-finished install can be completed by re-running
    // it. --force replaces, and backs each replaced file up.
    const before = readFileSync(join(tx, 'config', 'profile.yml'), 'utf8');
    const edited = before + '# edited by hand\n';
    writeFileSync(join(tx, 'config', 'profile.yml'), edited);
    rmSync(join(tx, 'portals.yml'));
    const r2 = sh(['--answers', ansFile, '--target', tx]);
    if (r2.code === 0 && /keep\s+config\/profile\.yml/.test(r2.out)
        && readFileSync(join(tx, 'config', 'profile.yml'), 'utf8') === edited
        && existsSync(join(tx, 'portals.yml'))) {
      pass('setup: keeps every existing file and writes only the missing one');
    } else fail(`setup: re-run exited ${r2.code}: ${r2.out.slice(0, 300)}`);
    const r3 = sh(['--answers', ansFile, '--target', tx, '--force']);
    if (r3.code === 0 && existsSync(join(tx, 'config', 'profile.yml.bak'))) {
      pass('setup: --force replaces and keeps a .bak of each file');
    } else fail(`setup: --force exited ${r3.code} or left no backup`);

    // 3. The techart preset with the California worked example.
    const ta = join(setupRoot, 'ta');
    const taAns = { ...answers, cv_path: '', lanes: { preset: 'techart-ai-tooling' },
      location: { preset: 'california-socal' } };
    writeFileSync(join(setupRoot, 'ta.json'), JSON.stringify(taAns));
    const r4 = sh(['--answers', join(setupRoot, 'ta.json'), '--target', ta]);
    const vocab = existsSync(join(ta, 'config', 'lane-vocab.json'))
      ? JSON.parse(readFileSync(join(ta, 'config', 'lane-vocab.json'), 'utf8')) : {};
    const preset = JSON.parse(readFileSync(join(ROOT, 'presets', 'lanes', 'techart-ai-tooling.json'), 'utf8'));
    const pmd = existsSync(join(ta, 'modes', '_profile.md')) ? readFileSync(join(ta, 'modes', '_profile.md'), 'utf8') : '';
    const locOut = existsSync(join(ta, 'config', 'location.json'))
      ? readFileSync(join(ta, 'config', 'location.json'), 'utf8') : '';
    if (r4.code === 0 && JSON.stringify(vocab) === JSON.stringify(preset)
        && locOut === JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'presets', 'locations',
          'california-socal.json'), 'utf8')), null, 2) + '\n') {
      pass('setup: a preset with no keywords is copied exactly, lanes and location both');
    } else fail(`setup: techart/california run exited ${r4.code} or did not copy the presets`);
    if (/Pipeline TA/.test(pmd) && /## Portfolio Evidence/.test(pmd)
        && !/AI Platform \/ LLMOps Engineer/.test(pmd) && /## Your Exit Narrative/.test(pmd)) {
      pass('setup: the preset profile replaces the template archetypes and keeps the rest');
    } else fail('setup: modes/_profile.md did not take the preset sections');

    // 4. Unusable answers write nothing; a dry run writes nothing.
    const bad = join(setupRoot, 'bad');
    writeFileSync(join(setupRoot, 'bad.json'), JSON.stringify({ ...answers, full_name: '',
      location: { preset: 'custom', home_state_code: 'Texas' } }));
    const r5 = sh(['--answers', join(setupRoot, 'bad.json'), '--target', bad]);
    if (r5.code !== 0 && /full_name/.test(r5.out) && /not a US state code/.test(r5.out) && !existsSync(bad)) {
      pass('setup: unusable answers are reported and nothing is written');
    } else fail(`setup: bad answers exited ${r5.code}: ${r5.out.slice(0, 200)}`);
    const dry = join(setupRoot, 'dry');
    const r6 = sh(['--answers', ansFile, '--target', dry, '--dry-run']);
    if (r6.code === 0 && /would create/.test(r6.out) && !existsSync(dry)) {
      pass('setup: --dry-run reports the plan and writes nothing');
    } else fail(`setup: --dry-run exited ${r6.code} or wrote files`);

    // 4b. The interactive path, fed through a pipe the way a script or an agent would.
    // readline's question() dropped every line that arrived before it was asked, so the
    // second prompt never resolved and Node exited on an unsettled await.
    const piped = join(setupRoot, 'piped');
    const pipedInput = ['Sam Rivera', 'sam@example.com', '', '', 'Senior Technical Artist',
      'Studio One', 'techart-ai-tooling', '', '', 'california-socal', 'USD 180K',
      'USD 200K-260K', 'Acme', ''].join('\n') + '\n';
    const r8 = sh(['--target', piped], { input: pipedInput, stdio: ['pipe', 'pipe', 'pipe'] });
    const pipedLoc = existsSync(join(piped, 'config', 'location.json'))
      ? JSON.parse(readFileSync(join(piped, 'config', 'location.json'), 'utf8')).name : null;
    const pipedCand = existsSync(join(piped, 'config')) ? SM.loadCandidate(join(piped, 'config')) : {};
    if (r8.code === 0 && pipedLoc === 'california-socal' && pipedCand.compFloorK === 180
        && pipedCand.firstName === 'Sam') {
      pass('setup: the interactive prompts work from piped input');
    } else fail(`setup: piped interactive run exited ${r8.code}, location=${pipedLoc}: ${r8.out.slice(-200)}`);

    // 5. Hostile but ordinary answers. Each of these was lost by a reader once: a name
    // holding an apostrophe, a colon and a '#'; company names with the same; keywords that
    // start or end with a symbol, which a \b-bounded pattern can never match.
    const odd = join(setupRoot, 'odd');
    writeFileSync(join(setupRoot, 'odd.json'), JSON.stringify({ ...answers, cv_path: '',
      full_name: "Zoë O'Brien: Senior # Engineer",
      // A value long enough that a YAML dumper would fold it into a `>-` block scalar,
      // which the no-PyYAML fallback reader then returned as the literal ">-".
      past_employers: ["McDonald's Games", 'Studio: Two',
        'The Extremely Long Legal Name Of An Interactive Entertainment Company, Incorporated, Doing Business As Something Else Entirely'],
      company_preference: { "O'Reilly Media": 1, 'Acme: Labs': 0.6 },
      lanes: { preset: 'general', target_keywords: ['C++', 'Engine (Runtime)', 'AI/ML'] } }));
    const r7 = sh(['--answers', join(setupRoot, 'odd.json'), '--target', odd]);
    const oc = SM.loadCandidate(join(odd, 'config'));
    const op = SM.loadPrefs(join(odd, 'config'));
    const ov = existsSync(join(odd, 'config', 'lane-vocab.json'))
      ? JSON.parse(readFileSync(join(odd, 'config', 'lane-vocab.json'), 'utf8')) : { _ranker: { lanes: [] } };
    const terms = (ov._ranker.lanes.at(-1)?.terms || []).map(([p]) => new RegExp(p, 'i'));
    const hits = ['Senior C++ Engineer', 'Engine (Runtime) Programmer', 'AI/ML Engineer']
      .every((title, i) => terms[i]?.test(title));
    const oddPy = py(`import sys, importlib.util
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, "scripts")
import _candidate, _lane
cfg = r"${join(odd, 'config')}"
c = _candidate.load(cfg + "/profile.yml")
fb = _candidate._parse_minimal(open(cfg + "/profile.yml", encoding="utf-8").read())
_lane.configure(_lane.load_vocab(cfg + "/lane-vocab.json"))
print(c["first_name"], len(_candidate.load_prefs(cfg + "/profile.yml")), _lane.lane_score("Senior C++ Engineer") > 0,
      fb["past_employers"][-1].startswith("The Extremely Long"))`);
    if (r7.code === 0 && oc.firstName === 'Zoë' && oc.pastEmployers.length === 3
        && SM.preference("O'Reilly Media", op) === 1 && SM.preference('Acme: Labs', op) === 0.6
        && hits && oddPy === 'Zoë 2 True True') {
      pass('setup: apostrophes, colons, "#" and symbol-edged keywords survive every reader');
    } else fail(`setup: hostile answers: exit ${r7.code} name=${oc.firstName} prefs=${op.length} ranker=${hits} py=${oddPy}`);
    // 5b. The general preset has no opinion. Any family, lane, gate or seniority
    // exclusion in it is a preference imposed on every user who picks "no tuning".
    const gen = JSON.parse(readFileSync(join(ROOT, 'presets', 'lanes', 'general.json'), 'utf8'));
    const opinions = [
      ...Object.keys(gen).filter((k) => !k.startsWith('_')).map((k) => `family ${k}`),
      ...(gen._ranker?.lanes?.length ? ['_ranker.lanes'] : []),
      ...['deprioritised', 'managerial', 'out_of_lane'].filter((k) => gen._ranker?.[k]).map((k) => `_ranker.${k}`),
      ...['title_up', 'title_down', 'body_up', 'body_down'].filter((k) => gen._lane?.[k]?.length).map((k) => `_lane.${k}`),
      ...(gen._role_gate ? ['_role_gate'] : []), ...(gen._triage?.gates?.length ? ['_triage.gates'] : []),
      ...(gen._board?.lanes?.length ? ['_board.lanes'] : []), ...(gen._sweep?.terms?.length ? ['_sweep.terms'] : []),
    ];
    if (!opinions.length) pass('the general preset carries no preference of any kind');
    else fail(`the general preset imposes preferences: ${opinions.join(', ')}`);

    // 6. No comp floor is a valid answer, and eval-assist must not divide by zero when
    // the floor and the target are the same number.
    const cs = py(`import importlib.util, sys
sys.path.insert(0, "scripts")
s = importlib.util.spec_from_file_location("a", "scripts/eval-assist.py")
a = importlib.util.module_from_spec(s); s.loader.exec_module(a)
a._prep.configured_comp_targets = lambda p=None: None
none = a.comp_score(200000)
a._prep.configured_comp_targets = lambda p=None: (200000, 200000)
print(none, a.comp_score(200000), a.comp_score(260000) > 4.0)`);
    if (cs === 'None 4.0 True') pass('eval-assist: no floor scores nothing, and floor == target does not divide by zero');
    else fail(`eval-assist comp_score edge cases: ${cs.slice(0, 300)}`);

    // 7. Self-tests never read installed configuration. Point every one of them at a
    // directory of BROKEN config files: a suite that still reads the user's files fails
    // here, which is the only way to see it, since a fresh clone has no config to break.
    const broken = join(setupRoot, 'broken-config');
    mkdirSync(broken);
    writeFileSync(join(broken, 'profile.yml'), 'candidate:\n  full_name: "unterminated\ncompensation: [\n'
      + '  minimum: "lots"\n  target_range: "more"\n');
    writeFileSync(join(broken, 'lane-vocab.json'), '{ not json');
    writeFileSync(join(broken, 'location.json'), '{ not json either');
    const envBroken = { ...process.env, CAREER_OPS_CONFIG_DIR: broken };
    const suites = [
      [NODE, 'score-model-tests.mjs'], [NODE, 'pipeline-audit.mjs', '--selftest'],
      [NODE, 'location-core.mjs', '--selftest'], ['python', 'scripts/_lane.py', '--selftest'],
      ['python', 'scripts/eval-prep.py', '--selftest'], ['python', 'scripts/_location.py', '--selftest'],
      ['python', 'scripts/nvidia-liveness.py', '--selftest'], ['python', 'scripts/triage-leads.py', '--selftest'],
    ];
    const leaked = [];
    for (const [cmd, ...a] of suites) {
      try {
        execFileSync(cmd, a, { cwd: ROOT, env: envBroken, encoding: 'utf-8', timeout: 300000,
          stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { leaked.push(a[0]); }
    }
    if (!leaked.length) pass(`self-tests ignore installed configuration (${suites.length} suites, broken config present)`);
    else fail(`these self-tests read the installed configuration: ${leaked.join(', ')}`);

    // ...and every loader HONOURS the seam. Without this the check above could pass on a
    // clean machine with a loader that simply ignores CAREER_OPS_CONFIG_DIR.
    const seam = join(setupRoot, 'seam-config');
    mkdirSync(seam);
    writeFileSync(join(seam, 'profile.yml'), 'candidate:\n  full_name: Seam Test\ncompensation:\n'
      + '  minimum: "USD 123K"\n  target_range: "USD 150K"\ncompany_preference:\n  Seamco: 1\n');
    writeFileSync(join(seam, 'lane-vocab.json'), JSON.stringify({ _preset: { name: 'seamtest' },
      _role_gate: { pattern: '\\bseamgate\\b' } }));
    writeFileSync(join(seam, 'location.json'), JSON.stringify({ name: 'seam', home_state: { code: 'NV', name: 'Nevada' } }));
    const envSeam = { ...process.env, CAREER_OPS_CONFIG_DIR: seam };
    const runIn = (cmd, args) => {
      try { return execFileSync(cmd, args, { cwd: ROOT, env: envSeam, encoding: 'utf-8', timeout: 60000 }).trim(); }
      catch (e) { return `ERROR ${(e.stderr || e.message).slice(0, 200)}`; }
    };
    const nodeSeam = runIn(NODE, ['--input-type=module', '-e',
      "const M = await import('./score-model.mjs'); const L = await import('./location-core.mjs');"
      + "console.log(M.MODEL.COMP_FLOOR, M.loadPrefs().length, M.MODEL.ROLE_GATE?.source, L.loadLocationPolicy().home_state.code)"])
      + ' ' + runIn(NODE, ['pipeline-audit.mjs', '--print-config']).split('\n').at(-1);
    const pySeam = runIn('python', ['-c',
      'import sys; sys.path.insert(0, "scripts"); import _location, _lane, _candidate;'
      + 'print(_location.load().home_code, _lane.VOCAB["_preset"]["name"], _candidate.load()["full_name"], len(_candidate.load_prefs()))']);
    if (nodeSeam === '123 1 \\bseamgate\\b NV seamtest' && pySeam === 'NV seamtest Seam Test 1') {
      pass('every config loader honours CAREER_OPS_CONFIG_DIR, in Node and in Python');
    } else fail(`config seam not honoured: node="${nodeSeam}" python="${pySeam}"`);

    // 8. What setup writes into the scanner's title filter and the vocabulary sections the
    // other tools read. validate-portals passes the template's own filter, so without these
    // a setup that dropped the user's keywords on the floor stayed green.
    {
      const yaml = (await import('js-yaml')).default;
      const tv = JSON.parse(readFileSync(join(tx, 'config', 'lane-vocab.json'), 'utf8'));
      const tf = yaml.load(readFileSync(join(tx, 'portals.yml'), 'utf8')).title_filter || {};
      const want = answers.lanes.target_keywords, avoid = answers.lanes.avoid_keywords;
      const inFilter = want.every((k) => (tf.positive || []).includes(k))
        && avoid.every((k) => (tf.negative || []).includes(k));
      const gate = (tv._triage?.gates || []).find(([l]) => l === 'avoided title');
      const gateRe = gate ? new RegExp(gate[1], 'i') : null;
      const target = (tv._board?.lanes || []).at(-1);
      const tRes = (target?.patterns || []).map((p) => new RegExp(p, 'i'));
      const assist = (tv._assist?.lane || []).map(([n]) => n);
      const boardPy = py(`import sys
sys.path.insert(0, "scripts")
import _lane
_lane.configure(_lane.load_vocab(r"${join(tx, 'config', 'lane-vocab.json')}"))
print(_lane.board_lane("Senior Backend Engineer")[0], _lane.board_lane("Retail Maintenance Lead")[0])`);
      if (inFilter && gateRe?.test('Senior Sales Engineer') && !gateRe.test('Senior Backend Engineer')
          && target?.name === 'Target' && tRes.some((r) => r.test('Senior Backend Engineer'))
          && !tRes.some((r) => r.test('Backend Engineering Manager'))
          && want.every((k) => assist.includes(k)) && boardPy === 'Target Other') {
        pass('setup: keywords reach the title filter, triage gates, board lane and eval-assist lanes');
      } else {
        fail(`setup: written sections wrong: filter=${inFilter} gate=${!!gateRe} board=${target?.name}/${boardPy} assist=${assist.join(';')}`);
      }
    }

    // 9. A second --force never overwrites the only backup of the user's original.
    {
      const bakBefore = readFileSync(join(tx, 'config', 'profile.yml.bak'), 'utf8');
      const r9 = sh(['--answers', ansFile, '--target', tx, '--force']);
      if (r9.code === 0 && readFileSync(join(tx, 'config', 'profile.yml.bak'), 'utf8') === bakBefore
          && existsSync(join(tx, 'config', 'profile.yml.bak.1'))) {
        pass('setup: a second --force writes a numbered backup and keeps the first');
      } else fail(`setup: second --force exited ${r9.code} or overwrote the backup`);
    }

    // 10. Answer handling: a bare state in a commute list is dropped out loud, a missing
    // target defaults to the floor, a trailing "*" is a stem, and a home-less location
    // preset takes the user's home state.
    {
      const e = join(setupRoot, 'edges');
      writeFileSync(join(setupRoot, 'edges.json'), JSON.stringify({ ...answers, cv_path: '',
        compensation: { currency: 'USD', minimum: 'USD 150K' },
        lanes: { preset: 'general', target_keywords: ['Agent*'] },
        location: { preset: 'custom', home_state_code: 'TX', home_state_name: 'Texas',
          commute_cities: ['Austin', 'TX', 'Texas'], same_state_out: ['Houston'] } }));
      const r10 = sh(['--answers', join(setupRoot, 'edges.json'), '--target', e]);
      const loc = existsSync(join(e, 'config', 'location.json'))
        ? JSON.parse(readFileSync(join(e, 'config', 'location.json'), 'utf8')) : {};
      const prof = existsSync(join(e, 'config', 'profile.yml'))
        ? readFileSync(join(e, 'config', 'profile.yml'), 'utf8') : '';
      const ev = existsSync(join(e, 'config', 'lane-vocab.json'))
        ? JSON.parse(readFileSync(join(e, 'config', 'lane-vocab.json'), 'utf8')) : {};
      const stem = (ev._ranker?.lanes?.at(-1)?.terms || []).map(([p]) => new RegExp(p, 'i'));
      if (r10.code === 0 && /whole state/.test(r10.out) && loc.commute?.signals?.join() === 'Austin'
          && /target_range: USD 150K/.test(prof) && /no comp target/.test(r10.out)
          && stem.some((r) => r.test('Agentic Systems Engineer')) && !stem.some((r) => r.test('Reagent Chemist'))) {
        pass('setup: bare states dropped with a warning, target defaults to the floor, "*" is a stem');
      } else fail(`setup: answer edges: exit ${r10.code} commute=${loc.commute?.signals} out=${r10.out.slice(0, 300)}`);

      const w = join(setupRoot, 'wa');
      writeFileSync(join(setupRoot, 'wa.json'), JSON.stringify({ ...answers, cv_path: '',
        location: { preset: 'remote-us', home_state_code: 'WA', home_state_name: 'Washington' } }));
      const rwa = sh(['--answers', join(setupRoot, 'wa.json'), '--target', w]);
      const wpol = existsSync(join(w, 'config', 'location.json'))
        ? JSON.parse(readFileSync(join(w, 'config', 'location.json'), 'utf8')) : {};
      const wsig = LC.buildSignals(LC.locationFilterFromPolicy(wpol));
      const nohome = join(setupRoot, 'nohome');
      writeFileSync(join(setupRoot, 'nohome.json'), JSON.stringify({ ...answers, cv_path: '',
        location: { preset: 'remote-us' } }));
      const rnh = sh(['--answers', join(setupRoot, 'nohome.json'), '--target', nohome]);
      if (rwa.code === 0 && wpol.home_state?.code === 'WA'
          && LC.classifyLocationOption('US, WA, Remote', wsig) === 'accept'
          && rnh.code === 0 && /names no home state/.test(rnh.out)) {
        pass('setup: the remote-us preset takes a home state when given and warns when not');
      } else fail(`setup: remote-us home state: exit ${rwa.code}/${rnh.code} home=${JSON.stringify(wpol.home_state)}`);
    }

    // 11. cv_path must be text. A PDF copied in as cv.md is mojibake every tailored CV is
    // then built from, and doctor would call the install ready.
    {
      const pdf = join(setupRoot, 'resume.pdf');
      writeFileSync(pdf, '%PDF-1.4\n%binary\n');
      const fake = join(setupRoot, 'resume.md');
      writeFileSync(fake, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00, 0x01]));
      const bad = [pdf, fake, setupRoot].map((p, i) => {
        writeFileSync(join(setupRoot, `cv${i}.json`), JSON.stringify({ ...answers, cv_path: p }));
        const t = join(setupRoot, `cvt${i}`);
        const r = sh(['--answers', join(setupRoot, `cv${i}.json`), '--target', t]);
        return r.code !== 0 && /cv_path/.test(r.out) && !existsSync(t);
      });
      if (bad.every(Boolean)) pass('setup: a PDF, a binary .md or a directory is refused as the CV');
      else fail(`setup: cv_path type checks: ${bad.join(',')}`);
    }

    // 12. Piped interactive answers split lists on ";", so a comma inside one answer
    // ("Acme, Inc.") stays one entry, and a bad answer is not re-asked (which would
    // consume the next line and shift every answer after it).
    {
      const p2 = join(setupRoot, 'piped2');
      const input = ['Lee Park', 'lee@example.com', '', '',
        'Senior Backend Engineer; Staff Platform Engineer', 'Acme, Inc.; Beta', 'general', '', '',
        'remote-us', 'WA', 'Washington', 'USD 150K', '', '', ''].join('\n') + '\n';
      const rp = sh(['--target', p2], { input, stdio: ['pipe', 'pipe', 'pipe'] });
      const pc = existsSync(join(p2, 'config')) ? SM.loadCandidate(join(p2, 'config')) : {};
      const pl = existsSync(join(p2, 'config', 'location.json'))
        ? JSON.parse(readFileSync(join(p2, 'config', 'location.json'), 'utf8')) : {};
      const yaml = (await import('js-yaml')).default;
      const ptf = existsSync(join(p2, 'portals.yml'))
        ? yaml.load(readFileSync(join(p2, 'portals.yml'), 'utf8')).title_filter?.positive || [] : [];
      const p3 = join(setupRoot, 'piped3');
      const badIn = ['Lee Park', 'lee@example.com', '', '', 'Engineer', '', 'no-such-preset', '', '',
        'remote-us', '', 'USD 150K', '', '', ''].join('\n') + '\n';
      const rb = sh(['--target', p3], { input: badIn, stdio: ['pipe', 'pipe', 'pipe'] });
      if (rp.code === 0 && pc.pastEmployers?.join('|') === 'Acme, Inc.|Beta' && pl.home_state?.code === 'WA'
          && ptf.includes('Backend Engineer') && ptf.includes('Platform Engineer')
          && rb.code !== 0 && /no-such-preset/.test(rb.out) && !existsSync(p3)
          && (rb.out.match(/Lane preset \[/g) || []).length === 1) {
        pass('setup: piped lists split on ";", seniority is stripped from default keywords, a bad answer stops the run');
      } else fail(`setup: piped lists: exit ${rp.code}/${rb.code} employers=${pc.pastEmployers} home=${pl.home_state?.code} filter=${ptf.join(';')}`);
    }

    // 13. eval-assist against the techart preset: the gates, the counted lane signals and
    // the "evaluate is an ordinary verb" trap the preset's eval pattern is written around.
    // Disposal is the destructive direction (--retire deletes the packet), so it is pinned
    // both ways: the flagged gate disposes under any label, and nothing else ever does.
    {
      const presetPath = join(ROOT, 'presets', 'lanes', 'techart-ai-tooling.json').replace(/\\/g, '/');
      const ea = py(`import importlib.util, json, sys
sys.path.insert(0, "scripts")
import _lane
def load(vocab):
    _lane.configure(vocab)
    s = importlib.util.spec_from_file_location("ea", "scripts/eval-assist.py")
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    return m
CLR = "An active TS/SCI security clearance is required."
v = _lane.load_vocab("${presetPath}")
a = load(v)
verb = a.annotate({"jd_full": "You will evaluate and rationalize third-party connectors. Evaluate vendors."})
llm = a.annotate({"jd_full": "Own the LLM evaluation harness. Grow agent evaluation quality."})
clr = a.annotate({"jd_full": CLR})
degree = a.annotate({"jd_full": "A PhD is required for this role. A master's degree is a plus."})
gates = [g for g in v["_assist"]["gates"]]
v["_assist"]["gates"] = [["clearance", g[1], "dispose"] if g[0] == "security clearance" else g for g in gates]
renamed = load(v).annotate({"jd_full": CLR})
v["_assist"]["gates"] = [g[:2] for g in gates]
unflagged = load(v).annotate({"jd_full": CLR})
v["_assist"]["gates"] = [["clearance", r"\\bclearance required\\b", "dispose"], ["clearance", r"\\bclearance preferred\\b"]]
shared = load(v).annotate({"jd_full": "An active clearance preferred but not needed."})
print(any(s.startswith("eval") for s in verb["lane_signals"]),
      any(s.startswith("eval") for s in llm["lane_signals"]),
      clr["suggested_disposition"], renamed["suggested_disposition"],
      bool(degree["detected_gates"]), degree["suggested_disposition"],
      unflagged["suggested_disposition"], shared["suggested_disposition"])`);
      if (ea === 'False True security clearance stated clearance stated True None None None') {
        pass('eval-assist: gates and lane signals match; only a flagged gate disposes, under any label');
      } else fail(`eval-assist annotate regression: ${ea.slice(0, 400)}`);
    }

    // 14. Every loader's DEFAULT path, with the seam unset and from another directory:
    // the path setup writes (<root>/config) must be the one each reader uses. Every other
    // test sets CAREER_OPS_CONFIG_DIR, so a loader that stopped reading config/ stayed green.
    {
      const envNone = { ...process.env };
      delete envNone.CAREER_OPS_CONFIG_DIR;
      const want = join(ROOT, 'config').replace(/\\/g, '/').toLowerCase();
      const norm = (s) => s.trim().replace(/\\/g, '/').toLowerCase().split(/\r?\n/).map((x) => x.trim());
      let nodePaths = [], pyPaths = [];
      try {
        nodePaths = norm(execFileSync(NODE, ['--input-type=module', '-e',
          ['score-model.mjs', 'location-core.mjs']
            .map((f, i) => `const m${i} = await import(${JSON.stringify(pathToFileURL(join(ROOT, f)).href)});`)
            .join('') + 'console.log([m0.CONFIG_DIR, m1.CONFIG_DIR].join("\\n"))'],
          { cwd: setupRoot, env: envNone, encoding: 'utf-8', timeout: 30000 }));
        // pipeline-audit runs on import, so it reports its own path.
        nodePaths.push(norm(execFileSync(NODE, [join(ROOT, 'pipeline-audit.mjs'), '--print-config'],
          { cwd: setupRoot, env: envNone, encoding: 'utf-8', timeout: 30000 }))[0]);
        pyPaths = norm(execFileSync('python', ['-c',
          `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))}); `
          + 'import _location, _lane, _candidate; '
          + 'print("\\n".join([_location.CONFIG_DIR, _lane.CONFIG_DIR, _candidate.CONFIG_DIR]))'],
          { cwd: setupRoot, env: envNone, encoding: 'utf-8', timeout: 30000 }));
      } catch (e) { nodePaths = [`ERROR ${e.message.slice(0, 200)}`]; }
      const all = [...nodePaths, ...pyPaths];
      if (all.length === 6 && all.every((p) => p === want)) {
        pass('every config loader defaults to <root>/config, from any working directory');
      } else fail(`config default paths: ${all.join(' | ')} (want ${want})`);
    }

    // 15. apply-model on a fresh install whose profile names no preferred companies: a
    // valid profile, so it must run, with every preference factor 1.0.
    {
      const am = join(setupRoot, 'apply-model');
      mkdirSync(join(am, 'data'), { recursive: true });
      mkdirSync(join(am, 'reports'));
      mkdirSync(join(am, 'config'));
      writeFileSync(join(am, 'config', 'profile.yml'), 'candidate:\n  full_name: Pat Doe\n');
      writeFileSync(join(am, 'reports', '001-fixtureco-2026-09-20.md'),
        '# 001 - Fixtureco - Platform Engineer\n\n**URL:** https://example.invalid/1\n\n'
        + '## Machine Summary\n\n```yaml\nnum: 1\ncompany: "Fixtureco"\nrole: "Platform Engineer"\n'
        + 'location_final: "Remote, US"\narrangement: remote\nscores:\n  match_w_cv: 4.0\n'
        + '  north_star: 4.0\n  comp: 4.0\n  cultural_signals: 4.0\n  red_flags_adj: 0\n'
        + 'final: 4.00\n```\n');
      writeFileSync(join(am, 'data', 'applications.md'), '# Applications Tracker\n\n'
        + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
        + '|---|------|---------|------|-------|--------|-----|--------|-------|\n'
        + '| 1 | 2026-09-20 | Fixtureco | Platform Engineer | 4.0/5 | Evaluated | x | [1](../reports/001-fixtureco-2026-09-20.md) | fixture |\n');
      let amOut = '', amCode = 0;
      try {
        amOut = execFileSync(NODE, [join(ROOT, 'apply-model.mjs')], { cwd: am, encoding: 'utf-8',
          timeout: 30000, env: { ...process.env, CAREER_OPS_CONFIG_DIR: join(am, 'config') } });
      } catch (e) { amCode = e.status ?? 1; amOut = `${e.stdout || ''}${e.stderr || ''}`; }
      if (amCode === 0 && /every preference factor is 1\.0/.test(amOut) && !/nothing to apply/.test(amOut)) {
        pass('apply-model runs on a tracker whose profile names no preferred companies');
      } else fail(`apply-model with no company_preference: exit ${amCode}: ${amOut.slice(0, 300)}`);
    }

    // 16. roleStem removes seniority tokens and nothing else, and falls back to the title
    // when the stem would not match it.
    {
      const S = await import(pathToFileURL(join(ROOT, 'setup.mjs')).href);
      const want = { 'Sr. Data Scientist': 'Data Scientist', 'Senior Front-End Engineer': 'Front-End Engineer',
        'Staff Engineer, Agent Platform': 'Engineer, Agent Platform', 'Senior Backend Engineer': 'Backend Engineer',
        'Senior Engineer': 'Senior Engineer', 'Principal ML Engineer II': 'ML Engineer',
        'Entry Level Software Engineer': 'Software Engineer', 'Mid Level Backend Engineer': 'Backend Engineer',
        // The fallbacks: a stem that no longer matches its title, or a leftover level word.
        'Senior Software Engineer (Level III)': 'Senior Software Engineer (Level III)',
        'Data Entry Specialist': 'Data Entry Specialist',
        // N32: a stem whose last word is a function word ("of") is a fragment left behind by
        // SENIORITY eating "Staff", not a real title stem, and must fall back to the source.
        'Chief of Staff': 'Chief of Staff',
        // N41: pins the untested leftover-level-word guard, so deleting it (setup.mjs, the
        // "level|grade" check just above the new function-word check) goes red.
        'Staff Level Engineer': 'Staff Level Engineer' };
      const got = Object.keys(want).map((t) => S.roleStem(t));
      const bad = Object.keys(want).filter((t, i) => got[i] !== want[t]
        || !new RegExp(S.kwPattern(got[i]), 'i').test(t));
      if (!bad.length) pass('setup: roleStem strips only seniority and every stem matches its own title');
      else fail(`setup: roleStem: ${bad.map((t) => `${t} -> ${S.roleStem(t)}`).join('; ')}`);
    }

    // 17. Answer shapes: a blank state name is the state's name, city-states are places,
    // a comma-joined list is called out, a ";" string is a list, and avoid words stay
    // out of eval-assist's body-wide anti list.
    {
      const run = (name, over) => {
        const t = join(setupRoot, name);
        writeFileSync(join(setupRoot, `${name}.json`), JSON.stringify({ ...answers, cv_path: '', ...over }));
        const r = sh(['--answers', join(setupRoot, `${name}.json`), '--target', t]);
        const read = (f) => (existsSync(join(t, 'config', f)) ? JSON.parse(readFileSync(join(t, 'config', f), 'utf8')) : {});
        return { r, loc: read('location.json'), vocab: read('lane-vocab.json') };
      };
      const noName = run('noname', { location: { preset: 'custom', home_state_code: 'TX', commute_cities: ['Austin'] } });
      const noNameSig = LC.buildSignals(LC.locationFilterFromPolicy(noName.loc));
      const ny = run('ny', { location: { preset: 'custom', home_state_code: 'NY', home_state_name: 'New York',
        commute_cities: ['New York', 'Brooklyn', 'Austin, Round Rock, Cedar Park'] } });
      const str = run('str', { location: { preset: 'custom', home_state_code: 'TX', commute_cities: 'Austin; Round Rock' } });
      const badType = run('badtype', { location: { preset: 'custom', home_state_code: 'TX', commute_cities: 42 } });
      const badCode = run('badcode', { location: { preset: 'custom', home_state_code: 'TC' } });
      const anti = (noName.vocab._assist?.anti || []).map(([n]) => n);
      const checks = {
        'blank name is the state name': noName.loc.home_state?.name === 'Texas',
        'Austin, Texas reads as home': LC.classifyLocationOption('Austin, Texas', noNameSig) === 'accept',
        'New York is written as the city': (ny.loc.commute?.signals || []).includes('New York City')
          && !(ny.loc.commute?.signals || []).includes('New York') && /"New York" was written as/.test(ny.r.out),
        'a comma-joined list is called out': /joined by commas/.test(ny.r.out),
        '"Austin, TX" is not called out': !/joined by commas/.test(noName.r.out),
        'a ";" string is a list': (str.loc.commute?.signals || []).join('|') === 'Austin|Round Rock',
        'a number is not a list': badType.r.code !== 0 && /commute_cities must be a list/.test(badType.r.out),
        'TC is not a state': badCode.r.code !== 0 && /not a US state code/.test(badCode.r.out),
        'avoid words stay title-only': !['Sales', 'Recruiter', 'Intern'].some((k) => anti.includes(k)),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      if (!failed.length) pass(`setup: answer shapes (${Object.keys(checks).length} checks)`);
      else fail(`setup: answer shapes failed: ${failed.join('; ')}`);
    }

    // 18. The Target board lane never takes a title from a tuned preset lane, and matches
    // on word boundaries only. The general preset has no lanes, so this needs a tuned one.
    {
      const tt = join(setupRoot, 'target-techart');
      writeFileSync(join(setupRoot, 'target-techart.json'), JSON.stringify({ ...answers, cv_path: '',
        lanes: { preset: 'techart-ai-tooling', target_keywords: ['Technical Artist', 'Retail Robotics'] } }));
      const rt = sh(['--answers', join(setupRoot, 'target-techart.json'), '--target', tt]);
      const tv = existsSync(join(tt, 'config', 'lane-vocab.json'))
        ? JSON.parse(readFileSync(join(tt, 'config', 'lane-vocab.json'), 'utf8')) : {};
      const last = (tv._board?.lanes || []).at(-1) || {};
      const lanes = py(`import sys
sys.path.insert(0, "scripts")
import _lane
_lane.configure(_lane.load_vocab(r"${join(tt, 'config', 'lane-vocab.json')}"))
print("|".join(_lane.board_lane(t)[0] for t in ["Senior Technical Artist", "Retail Robotics Lead", "Retail Operations Manager"]))`);
      if (rt.code === 0 && last.name === 'Target' && Array.isArray(last.words) && !last.words.length
          && lanes === 'Tech-Art / Craft|Target|Other') {
        pass('setup: the Target lane comes after the tuned lanes and matches whole words');
      } else fail(`setup: Target lane order: exit ${rt.code} last=${last.name} words=${JSON.stringify(last.words)} lanes=${lanes}`);
    }

    // 19. pipeline-audit --rank end to end: under a vocabulary with no positive terms the
    // default floor is 0, so the list is not empty, and setup's "avoided" tag is counted.
    {
      const pr = join(setupRoot, 'rank');
      mkdirSync(join(pr, 'data'), { recursive: true });
      writeFileSync(join(pr, 'data', 'pipeline.md'), '# Inbox\n\n'
        + '- [ ] https://example.invalid/jobs/1 | Acme | Senior Backend Engineer\n'
        + '- [ ] https://example.invalid/jobs/2 | Acme | Senior Sales Engineer\n'
        + '- [ ] https://example.invalid/jobs/3 | Beta | Platform Engineer\n');
      writeFileSync(join(pr, 'data', 'applications.md'), '# Applications Tracker\n\n'
        + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
        + '|---|------|---------|------|-------|--------|-----|--------|-------|\n');
      const avoidCfg = join(setupRoot, 'avoid-only');
      writeFileSync(join(setupRoot, 'avoid-only.json'), JSON.stringify({ ...answers, cv_path: '',
        lanes: { preset: 'general', target_keywords: [], avoid_keywords: ['Sales'] } }));
      sh(['--answers', join(setupRoot, 'avoid-only.json'), '--target', avoidCfg]);
      const rank = (cfg) => {
        try {
          return execFileSync(NODE, [join(ROOT, 'pipeline-audit.mjs'), '--rank'], { cwd: pr, encoding: 'utf-8',
            timeout: 30000, env: { ...process.env, CAREER_OPS_CONFIG_DIR: cfg } });
        } catch (e) { return `ERROR ${e.stdout || ''}${e.stderr || ''}`; }
      };
      const none = rank(join(setupRoot, 'broken-config-none'));
      const avoid = rank(join(avoidCfg, 'config'));
      if (/score 0\+ on title/.test(none) && /triage: 3 of 3/.test(none) && /no positive terms/.test(none)
          && /1 de-prioritised/.test(avoid) && /triage: 2 of 3/.test(avoid)) {
        pass('pipeline-audit --rank: no positive vocabulary floors at 0, and avoided titles are counted');
      } else fail(`pipeline-audit --rank: none=${none.slice(0, 300)} avoid=${avoid.slice(0, 300)}`);

      // 20. Both sweeps resolve --min-lane through the same default: none for an empty
      // vocabulary, 0 for penalties only, 2 with positive terms.
      const techCfg = join(setupRoot, 'tech-cfg');
      mkdirSync(techCfg, { recursive: true });
      writeFileSync(join(techCfg, 'lane-vocab.json'), readFileSync(join(ROOT, 'presets', 'lanes', 'techart-ai-tooling.json')));
      const floors = ['nvidia-sweep.py', 'workday-sweep.py'].map((f) => [join(setupRoot, 'broken-config-none'),
        join(avoidCfg, 'config'), techCfg].map((cfg) => {
        try {
          return execFileSync('python', [join(ROOT, 'scripts', f), '--print-min-lane'], { cwd: ROOT, encoding: 'utf-8',
            timeout: 60000, env: { ...process.env, CAREER_OPS_CONFIG_DIR: cfg } }).trim();
        } catch (e) { return 'ERROR'; }
      }).join(','));
      if (floors.every((f) => f === 'none,0,2')) pass('both sweeps default --min-lane from the vocabulary (none, 0, 2)');
      else fail(`sweep --min-lane defaults: ${floors.join(' / ')}`);
    }

    // 21. Round-3 answer handling: city-states rewritten, the state name must match the
    // code, a keyword needs a letter, codes are trimmed, and the comma warning tells a
    // title list from one title and a company list from "Acme, Inc.".
    {
      const S = await import(pathToFileURL(join(ROOT, 'setup.mjs')).href);
      const pe = S.placeEntries(['Arlington', 'Washington', 'DC', 'New York', 'LA', 'Texas'], 'VA');
      const peCa = S.placeEntries(['LA'], 'CA');
      const run = (name, over) => {
        const t = join(setupRoot, name);
        writeFileSync(join(setupRoot, `${name}.json`), JSON.stringify({ ...answers, cv_path: '', ...over }));
        return { t, r: sh(['--answers', join(setupRoot, `${name}.json`), '--target', t]) };
      };
      const badName = run('r3-badname', { location: { preset: 'custom', home_state_code: 'TX', home_state_name: 'Texsa' } });
      const star = run('r3-star', { lanes: { preset: 'general', target_keywords: ['*'] } });
      const padded = run('r3-padded', { location: { preset: 'custom', home_state_code: ' tx ', commute_cities: ['Austin'] } });
      const paddedLoc = existsSync(join(padded.t, 'config', 'location.json'))
        ? JSON.parse(readFileSync(join(padded.t, 'config', 'location.json'), 'utf8')) : {};
      const warns = run('r3-warn', { target_roles: ['Backend Engineer, Platform Engineer', 'Senior Engineer, Platform, Payments'],
        company_preference: { 'Stripe, Figma': 1, 'Acme, Inc.': 1 },
        location: { preset: 'custom', home_state_code: 'VA', commute_cities: ['Washington, D.C.', 'Arlington'] } });
      // warnAnswers reports only the FIRST comma-joined entry per key (see the "two joined
      // titles" check below), so the two target_keywords cases each need their own run.
      const warnsKeywords = (() => {
        const t = join(setupRoot, 'r5-warn-kw');
        writeFileSync(join(setupRoot, 'r5-warn-kw.json'), JSON.stringify({ ...answers, cv_path: '',
          lanes: { preset: 'general', target_keywords: ['Rigging, Animation, Pipeline'],
            avoid_keywords: ['Sales, Recruiter, Intern'] },
          target_roles: ['Engineering Manager, Developer Productivity'] }));
        return { t, r: sh(['--answers', join(setupRoot, 'r5-warn-kw.json'), '--target', t]) };
      })();
      const warnsKeywords2 = (() => {
        const t = join(setupRoot, 'r5-warn-kw2');
        writeFileSync(join(setupRoot, 'r5-warn-kw2.json'), JSON.stringify({ ...answers, cv_path: '',
          lanes: { preset: 'general', target_keywords: ['Python, C++'] } }));
        return { t, r: sh(['--answers', join(setupRoot, 'r5-warn-kw2.json'), '--target', t]) };
      })();
      const checks = {
        'city-states rewritten': pe.signals.join('|') === 'Arlington|Washington, DC|New York City|NYC|Manhattan|New York, NY'
          && pe.notes.length === 5,
        'LA is Los Angeles in California': peCa.signals.join() === 'Los Angeles',
        'a state name that is not the code is refused': badName.r.code !== 0 && /is not the name of TX/.test(badName.r.out),
        'a keyword with no letters is refused': star.r.code !== 0 && /no letters or digits/.test(star.r.out),
        'a padded code is trimmed': paddedLoc.home_state?.code === 'TX',
        'two joined titles are called out': /target_roles entry "Backend Engineer, Platform Engineer"/.test(warns.r.out),
        'one title with qualifiers is not': !/Senior Engineer, Platform, Payments/.test(warns.r.out),
        'two joined companies are called out': /company_preference entry "Stripe, Figma"/.test(warns.r.out),
        '"Acme, Inc." is one company': !/"Acme, Inc\."/.test(warns.r.out),
        '"Washington, D.C." is one place': !/Washington, D\.C\./.test(warns.r.out),
        'a comma-joined avoid_keywords entry warns (#N15/#N41)':
          /lanes\.avoid_keywords entry "Sales, Recruiter, Intern"/.test(warnsKeywords.r.out),
        'a comma-joined target_keywords entry warns (#N15)':
          /lanes\.target_keywords entry "Rigging, Animation, Pipeline"/.test(warnsKeywords.r.out),
        '"Python, C++" as a keyword warns too (#N41)':
          /lanes\.target_keywords entry "Python, C\+\+"/.test(warnsKeywords2.r.out),
        // #N19: a title ending in a role noun is what makes it a title; "Developer Productivity"
        // ends in a discipline, not a role noun, so this reads as ONE title, not two joined.
        '"Engineering Manager, Developer Productivity" is one title, not two (#N19)':
          !/target_roles entry "Engineering Manager, Developer Productivity"/.test(warnsKeywords.r.out),
        // District of Columbia rewrite, pinned directly against placeEntries (N35 M2: deleting
        // the 'district of columbia' key from CITY_STATE_REWRITES must go red here).
        '"District of Columbia" is rewritten to Washington, DC (N35)':
          S.placeEntries(['District of Columbia'], 'VA').signals.join() === 'Washington, DC',
        // placeEntries' OWN normalisation of a padded, lowercase home code, independent of any
        // caller trimming it first (N35 M7: this must not rely on buildLocation's own trim).
        'placeEntries(["LA"], " ca ") reads a padded lowercase home code (N35)':
          S.placeEntries(['LA'], ' ca ').signals.join() === 'Los Angeles',
        // avoid_keywords ["*"] refused through the SAME unattended path target_keywords already
        // has a case for in this test (N35: only target_keywords was pinned before).
        'avoid_keywords ["*"] is refused (N35)': (() => {
          const t = join(setupRoot, 'r5-avoid-star');
          writeFileSync(join(setupRoot, 'r5-avoid-star.json'), JSON.stringify({ ...answers, cv_path: '',
            lanes: { preset: 'general', avoid_keywords: ['*'] } }));
          const r = sh(['--answers', join(setupRoot, 'r5-avoid-star.json'), '--target', t]);
          return r.code !== 0 && /no letters or digits/.test(r.out) && !existsSync(t);
        })(),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      if (!failed.length) pass(`setup: round-3 answer handling (${Object.keys(checks).length} checks)`);
      else fail(`setup: round-3 answer handling failed: ${failed.join('; ')}`);
    }

    // 22. setup.mjs run through a symlinked or junctioned checkout still runs. argv[1]
    // keeps the link while import.meta.url is the real file, and a plain path comparison
    // made setup exit 0 having done nothing.
    {
      const { symlinkSync } = await import('fs');
      const link = join(setupRoot, 'linked-checkout');
      let made = true;
      try { symlinkSync(ROOT, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { made = false; }
      if (!made) {
        warn('setup through a linked checkout: NOT CHECKED, this platform refused the link');
      } else {
        let out = '';
        try {
          try { out = execFileSync(NODE, [join(link, 'setup.mjs'), '--example-answers'], { encoding: 'utf-8', timeout: 30000 }); }
          catch (e) { out = `ERROR ${e.message}`; }
        } finally {
          // Remove the LINK, never its target, and before the recursive cleanup of setupRoot
          // below could walk into it. unlink removes a symlink; rmdir removes a junction.
          const { unlinkSync, rmdirSync } = await import('fs');
          try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* reported below */ } }
        }
        let ok = false;
        try { ok = JSON.parse(out).full_name === 'Jane Smith'; } catch { ok = false; }
        if (ok && !existsSync(link)) pass('setup runs when invoked through a symlinked or junctioned checkout');
        else fail(`setup through a linked checkout printed: ${out.slice(0, 200)} (link removed: ${!existsSync(link)})`);
      }
    }

    // 23. The live NVIDIA sweep applies --min-lane (it used to apply only to --from-json).
    {
      const presetPath = join(ROOT, 'presets', 'lanes', 'techart-ai-tooling.json').replace(/\\/g, '/');
      const nv = py(`import importlib.util, sys
sys.path.insert(0, "scripts")
import _lane
_lane.configure(_lane.load_vocab("${presetPath}"))
s = importlib.util.spec_from_file_location("nvs", "scripts/nvidia-sweep.py")
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
rows = [dict(req="JR1", title="Senior Agentic AI Evaluation Engineer", live=True, home_remote=True),
        dict(req="JR2", title="Senior Accountant", live=True, home_remote=True)]
print(",".join(r["req"] for r in m.select(rows, 2)), len(m.select(rows, 2, show_all=True)))`);
      if (nv === 'JR1 2') pass('nvidia-sweep: the live path drops titles under the lane floor');
      else fail(`nvidia-sweep live floor: ${nv.slice(0, 300)}`);
    }

    // 24. N31: placeEntries is aware of the candidate's OWN home state, so a bare state
    // name that matches the home state is dropped as itself rather than rewritten to a
    // same-named city elsewhere, and dots are normalised before the lookup runs.
    {
      const S = await import(pathToFileURL(join(ROOT, 'setup.mjs')).href);
      const waHome = S.placeEntries(['Seattle', 'Bellevue', 'Redmond', 'Washington'], 'WA');
      const vaHome = S.placeEntries(['Arlington', 'Washington'], 'VA');
      const laDots = S.placeEntries(['L.A.', 'Irvine'], 'CA');
      const dcNoDot = S.placeEntries(['D.C'], 'VA');
      const checks = {
        // N31: for a Washington-STATE home, bare "Washington" is the home state itself and is
        // dropped as a whole state, never rewritten to the district on the other coast.
        'a WA home drops bare "Washington" as its own state, not DC':
          waHome.signals.join(',') === 'Seattle,Bellevue,Redmond'
          && !waHome.signals.includes('Washington, DC')
          && waHome.notes.some((n) => /"Washington" was dropped: it is a whole state/.test(n)),
        // The DC rewrite still fires for a non-Washington home, where the word is unambiguous.
        'a VA home still rewrites bare "Washington" to Washington, DC':
          vaHome.signals.includes('Washington, DC'),
        // N31: dots are normalised before the lookup, so "L.A." reads as LA and "D.C" (missing
        // its trailing dot) reads as DC, instead of falling to the generic bare-state drop.
        '"L.A." is Los Angeles for a California home, dots and all':
          laDots.signals.join('|') === 'Los Angeles|Irvine',
        '"D.C" without a trailing dot is still Washington, DC':
          dcNoDot.signals.join() === 'Washington, DC',
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      if (!failed.length) pass(`setup: placeEntries knows the home state (${Object.keys(checks).length} checks)`);
      else fail(`setup: placeEntries home-state checks failed: ${failed.join('; ')}`);
    }

    // 25. N40/N41: the shared check* predicates askValid uses interactively are unit-
    // testable directly with no TTY and no re-ask, since a piped test never exercises the
    // retry loop those predicates gate.
    {
      const S = await import(pathToFileURL(join(ROOT, 'setup.mjs')).href);
      const checks = {
        'checkFullName refuses a blank name': !!S.checkFullName(''),
        'checkFullName accepts a real name': S.checkFullName('Jane Smith') === null,
        'checkKeywordList refuses "*"': !!S.checkKeywordList(['*']),
        'checkKeywordList accepts an ordinary keyword': S.checkKeywordList(['Backend Engineer']) === null,
        'checkHomeStateCode requires a code when required': !!S.checkHomeStateCode('', true),
        'checkHomeStateCode allows blank when optional': S.checkHomeStateCode('', false) === null,
        'checkHomeStateCode refuses a bad code even when optional': !!S.checkHomeStateCode('XX', false),
        'checkHomeStateName flags a name that is not the code\'s': !!S.checkHomeStateName('Texsa', 'TX'),
        'checkHomeStateName accepts the code\'s real name': S.checkHomeStateName('Texas', 'TX') === null,
        'checkOnsiteOutsideCommute refuses anything but fail/unknown': !!S.checkOnsiteOutsideCommute('maybe'),
        'checkOnsiteOutsideCommute accepts fail and unknown': S.checkOnsiteOutsideCommute('fail') === null
          && S.checkOnsiteOutsideCommute('unknown') === null,
        'checkCompFloor refuses 3M (#N40)': !!S.checkCompFloor('USD 3M'),
        'checkCompFloor accepts a plausible floor': S.checkCompFloor('USD 150K') === null,
        'checkCompTarget refuses a target below the floor': !!S.checkCompTarget('USD 100K', 'USD 150K'),
        'checkCompTarget accepts a target above the floor': S.checkCompTarget('USD 200K', 'USD 150K') === null,
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      if (!failed.length) pass(`setup: shared answer-check predicates (${Object.keys(checks).length} checks, no TTY)`);
      else fail(`setup: shared answer-check predicates failed: ${failed.join('; ')}`);
    }

    // 26. #N40: validateAnswers plausibility guards, each previously correct but unpinned
    // (a mutation of validateAnswers survived it, per #N40's report), pinned through the
    // unattended --answers path the way test 4 already does.
    {
      const run = (name, over) => {
        const t = join(setupRoot, name);
        writeFileSync(join(setupRoot, `${name}.json`), JSON.stringify({ ...answers, cv_path: '', ...over }));
        return sh(['--answers', join(setupRoot, `${name}.json`), '--target', t]);
      };
      const floor3m = run('n40-floor3m', { compensation: { minimum: 'USD 3M', target_range: 'USD 4M' } });
      const floor15k = run('n40-floor15k', { compensation: { minimum: 'USD 15K' } });
      const competitive = run('n40-competitive', { compensation: { minimum: 'USD 150K', target_range: 'competitive' } });
      const badCode = run('n40-remote-xx', { lanes: { preset: 'general' },
        location: { preset: 'remote-us', home_state_code: 'XX' } });
      const checks = {
        'a 3M floor with a 4M target is refused as an implausible pair': floor3m.code !== 0 && /plausible pair/.test(floor3m.out),
        'a 15K floor with no target is refused (15K is below the 20K floor bound)':
          floor15k.code !== 0 && /plausible pair/.test(floor15k.out),
        'target_range "competitive" is refused as unreadable': competitive.code !== 0 && /holds no readable figure/.test(competitive.out),
        'a remote-us preset with home_state_code "XX" is refused': badCode.code !== 0 && /not a US state code/.test(badCode.out),
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      if (!failed.length) pass(`setup: validateAnswers plausibility guards (${Object.keys(checks).length} checks, #N40)`);
      else fail(`setup: validateAnswers plausibility guards failed: ${failed.join('; ')}`);
    }
  } catch (e) {
    fail(`setup harness test crashed: ${e.message}`);
  } finally {
    rmSync(setupRoot, { recursive: true, force: true });
  }
}

// ── THE TWO LOCATION GATES AGREE ────────────────────────────────
//
// location-core.mjs (the scanner) and scripts/eval-prep.py (evaluation packets) implement
// one policy in two languages. When they disagree, a role the scanner dropped reads READY
// downstream or the reverse, and each side's own selftest stays green. So run one table of
// real-world spellings through BOTH under the same policies and require the same answer.
// accept = pass, reject = fail, unknown = unknown.

console.log('\nLocation gates agree (Node scanner vs Python evaluation)');
{
  const cases = [
    'Hybrid in Irvine', 'Irvine or Remote', 'Remote in US', 'US, CA, Remote', 'US, TX, Remote',
    'USA - Remote, TX', 'Remote, Washington, USA', 'Remote - Texas', 'Remote (Oregon)',
    'Irvine, California', 'Glendale, Arizona', 'Walnut Creek, CA', 'Santa Clara, CA',
    'California - San Francisco Metro - Remote', 'California - Los Angeles Metro - Remote',
    'Toronto, Canada', 'Remote New York or anywhere nationwide', 'Remote - Washington, DC',
    'Dublin, OH', 'Round Rock, TX', 'Houston, TX', 'Glendale, AZ (Onsite)', 'Austin, TX (Hybrid)',
    // One place in a multi-city option must not cancel another.
    'Los Angeles, CA / San Francisco, CA', 'San Francisco, CA or Los Angeles, CA',
    'Los Angeles, CA, San Francisco, CA', 'Irvine, CA or Austin, TX', 'Austin, TX or Houston, TX',
    // Dash-written scopes, narrowed "anywhere", and exclusions.
    'USA - Remote - TX', 'US - Remote - GA', 'Remote, anywhere in Texas',
    'Remote - Anywhere in North America', 'Remote (anywhere in the US except Texas)',
    'Remote, anywhere in the US', 'US, TX (Remote)', 'US, CA (Remote)',
    // Codes that are not states here, and a Canadian CA.
    'Los Angeles (LA)', 'Irvine, CA (IN-PERSON)', 'Remote (Toronto, CA)', 'Remote (EST)',
    // Metro-scoped home-state remote, listed and unlisted, and unlisted home-state cities.
    'California - San Diego Metro - Remote', 'California - Sacramento Metro - Remote',
    'California - Inland Empire Metro - Remote', 'Riverside, CA', 'Pflugerville, TX',
    'San Diego, CA', 'Austin, Texas', 'Remote - Texas', 'Washington, DC', 'Arlington, VA',
    'Remote - Washington, DC', 'Remote - CA', 'Remote - TX',
    // Round 3: exclusions are not scopes, eligible-state lists are read whole, a city keeps
    // its own state, time zones are not states, alternatives are separate offers.
    'Remote US (excluding Hawaii and Alaska)', 'Remote, US (excl. AK, HI)',
    'US Remote, excluding Colorado and New York', 'Remote (US) not available in Colorado',
    'Remote - US (anywhere but California)', 'US Remote; excluding CA, NY', 'Remote - USA (CA excluded)',
    'Remote, US (some travel outside of California)', 'Remote - US (not in California office)',
    'Remote: CA, OR, WA', 'Remote - Eligible in CA, NY, TX', 'Remote (Eligible states: CA, OR, WA)',
    'Remote: TX, OK, LA', 'Glendale, AZ, US', 'Glendale, AZ, on-site', 'Glendale or Scottsdale, AZ',
    'Pasadena or Houston, TX', 'Pasadena, TX, US', 'Remote - US (CT)', 'Remote - US - Central Time (CT)',
    'Remote (US) or New York, NY', 'TX - Remote', 'US - GA - Remote', 'US - TX - Remote', 'USA - GA - Remote',
    'US, CA, Remote (Bay Area metro preferred)', 'Hybrid - LA', 'LA, on-site', 'US, LA, Remote',
    'Irvine, CA; Toronto, ON, Canada', 'US, DC, Washington', 'Washington, District of Columbia',
    'US, DC, Remote', 'Remote - DC', 'Remote: TX',
    // Round 5, from 3157 independently labelled (posting, policy) pairs: a code after
    // "excluding" / "in" / "of" is a state, a scope may be written "TX Remote" or
    // "Washington State (Remote)" or after "Remote: US (", a borrowed state only makes a
    // commute match a question, "New York" alone in a place list is the city, a foreign
    // place beside a commute name voids it, and hybrid remote is hybrid.
    'TX Remote', 'Washington State (Remote)', 'Remote: US (CA, NY, TX, WA only)',
    'Remote (Eligible: AZ, CA, CO, FL)', 'Remote, US (excluding CA)', 'Remote, US - not eligible in CA',
    'Remote US (excluding residents of CA)', 'Los Angeles, CA or Remote (excluding CA)',
    'Remote (US) - Must reside in CT', 'Remote (US) - Must reside in TX', 'Remote (US), except DC',
    'New York, Los Angeles', 'Los Angeles or Austin, TX', 'Irvine or Austin, TX',
    'Santa Clara, CA (Hybrid Remote)', 'Sacramento, CA (Remote)', 'San Francisco, CA (Remote)',
    'Portland, OR (Remote)', 'Remote - Seattle, WA or Austin, TX', 'Remote - EMEA',
    'Texas - we are fully remote', 'US, VA, Arlington', 'Arlington or Richmond, VA',
    'District of Columbia - Washington', 'Los Angeles or New York', 'Hybrid - New York',
    'Austin or New York', 'Remote - New York', 'Dublin, Ireland', 'Dublin', 'Dublin, OH',
    'Remote - MT (Mountain Time)', 'US, MT, Remote',
    // Round 5b, from a cross-review: a "City, ST" commute entry with a borrowed state is a
    // question too, travel is not a location, "(full time)" is not a time zone, "in OR" in
    // prose is not Oregon, a far metro in a home-state scope is a question, a preference or
    // a negation is not a scope, an unsettled alternative is a question, "&" splits places,
    // and the long spellings of the country do not split "United States, AZ, Glendale".
    'Carson or Austin, TX', 'Arlington or Austin, TX', 'Los Angeles (occasional travel to London)',
    'Hybrid remote - work from anywhere in the US - San Francisco, CA', 'Remote: MA, CT (full time)',
    'Remote: WY, MT (full time)', 'Onsite (experience in OR)', 'Onsite (experience in AR)',
    'ONSITE (KNOWLEDGE OF OR)', 'Onsite (experience in OR is required)', 'Remote, Dublin, California',
    'Remote: CA - San Francisco metro only', 'United States, AZ, Glendale', 'U.S., AZ, Glendale',
    'Remote - US (TX or CA preferred)', 'Remote - US (not required to reside in TX)',
    'New York City, NY or location to be confirmed', 'Los Angeles & Austin, TX',
    'Remote - US (TX, CA) - HQ in San Francisco', 'Los Angeles\u0085or Austin, TX',
    'San Fra\u1ab0ncisco, California', 'except CA', 'Sacramento (occasional travel to London)',
    // Round 6: a street address is not a state, a foreign city in a bare list of places is
    // another place while a foreign country (or a city in prose) qualifies it, a bare city
    // from a "City, ST" entry is a question, the New York fold stops before a country, a
    // bare work arrangement names no place, "Anywhere" and "remote within the US" ending an
    // option are nationwide, and inputs on which Python's Unicode-wide regex semantics and
    // JavaScript's ASCII ones used to disagree (one raised KeyError in Python).
    'Torrance 1450 W. Washington Ave (hybrid, 3 days on-site)', 'Torrance 1450 West Washington Avenue',
    'Los Angeles, London, Sydney', 'Seattle, Boston, Los Angeles, Berlin',
    'Santa Ana, San Jose, Costa Rica', 'Venice, Italy', 'Onsite in Singapore, reporting to Los Angeles',
    'Office - Ontario/Canada', 'Manitoba; Ontario; Nova Scotia', 'New York, USA - Remote',
    'New York, U.S.A. (Remote)', 'New York City', 'Chicago, IL | Hybrid', 'Hybrid', 'Anywhere',
    'Boston, MA, Chicago, IL, or Remote within Canada or United States',
    'Remote within the United States (Texas residents only)', 'Remote in US, restricted to Texas',
    'US Remote, must reside in one of 2 Texas counties',
    'Los Angeles \u0662 Texas', 'Ontario,\ufeffCA', 'Los Angeles, \u0131reland', 'Seattle; \ufeffHybrid',
    '\u4e2dRemote US', 'Remote, Texa\u017f',
    // Autodesk's Eightfold spelling puts a sales region before the country (26WD134728).
    // The grammar folds an Americas label away before a US marker; EMEA and APAC stay.
    'AMER - United States - Texas - Remote', 'AMER - United States - California - Remote',
    'AMER - United States - Texas - Remote | Texas, USA - Remote', 'AMER - United States - Texas',
    'AMER - United States - California - Los Angeles', 'AMER - Canada - Remote', 'AMER - Remote',
    'EMEA - United Kingdom - London - Remote', 'APAC - Australia - Sydney - Remote',
    'Americas - Remote', 'NA - Remote', 'Remote (Americas)', 'LATAM - Remote', 'Remote, Flexible',
    // EA writes a metro label over the city ("Los Angeles - Chatsworth"). One piece naming
    // two places is a hierarchy, so a far place beside the commute word voids it; a far
    // place named as a preference or an office does not.
    'Los Angeles - San Diego, CA', 'Los Angeles (San Francisco preferred)',
    'Los Angeles, CA - HQ in San Francisco', 'Santa Monica, CA (reporting to San Francisco)',
    'Los Angeles, CA (Remote, Bay Area OK)', 'San Diego - Los Angeles, CA',
    // A slash split an Americas label off its remote word, and the bare half passed.
    'AMER / Remote', 'Remote / NA',
  ];
  // Agreement alone would pass two gates that are wrong together, so the cases each
  // review round found are also pinned to the right answer.
  const expected = {
    ca: { 'Los Angeles, CA / San Francisco, CA': 'pass', 'San Francisco, CA or Los Angeles, CA': 'pass',
      'Irvine, CA or Austin, TX': 'pass', 'USA - Remote - TX': 'fail', 'Remote, anywhere in Texas': 'fail',
      'Remote - Anywhere in North America': 'pass', 'Los Angeles (LA)': 'pass',
      'Irvine, CA (IN-PERSON)': 'pass', 'Remote (Toronto, CA)': 'fail', 'Remote (EST)': 'unknown',
      'California - San Diego Metro - Remote': 'fail', 'California - Inland Empire Metro - Remote': 'unknown',
      'Riverside, CA': 'unknown', 'Remote - CA': 'pass', 'US, TX (Remote)': 'fail',
      'Remote, anywhere in the US': 'pass', 'Glendale, AZ (Onsite)': 'fail' },
    tx: { 'Austin, TX or Houston, TX': 'pass', 'Remote (anywhere in the US except Texas)': 'fail',
      'Remote - TX': 'pass', 'US, CA (Remote)': 'fail' },
    txcode: { 'Austin, Texas': 'pass', 'Remote - Texas': 'pass' },
    va: { 'Washington, DC': 'pass', 'Remote - Washington, DC': 'pass', 'Arlington, VA': 'pass',
      'US, DC, Washington': 'pass', 'Washington, District of Columbia': 'pass', 'US, DC, Remote': 'pass',
      'Remote - DC': 'pass' },
  };
  Object.assign(expected.ca, {
    'Remote US (excluding Hawaii and Alaska)': 'pass', 'Remote, US (excl. AK, HI)': 'pass',
    'US Remote, excluding Colorado and New York': 'pass', 'Remote (US) not available in Colorado': 'pass',
    'Remote - US (anywhere but California)': 'fail', 'US Remote; excluding CA, NY': 'fail',
    'Remote - USA (CA excluded)': 'fail', 'Remote, US (some travel outside of California)': 'pass',
    'Remote - US (not in California office)': 'pass', 'Remote: CA, OR, WA': 'pass',
    'Remote - Eligible in CA, NY, TX': 'pass', 'Remote (Eligible states: CA, OR, WA)': 'pass',
    'Glendale, AZ, US': 'fail', 'Glendale, AZ, on-site': 'fail', 'Glendale or Scottsdale, AZ': 'unknown',
    'Pasadena or Houston, TX': 'unknown', 'Remote - US (CT)': 'pass', 'Remote - US - Central Time (CT)': 'pass',
    'Remote (US) or New York, NY': 'pass', 'TX - Remote': 'fail', 'US - GA - Remote': 'fail',
    'US - TX - Remote': 'fail', 'USA - GA - Remote': 'fail', 'US, CA, Remote (Bay Area metro preferred)': 'pass',
    'Hybrid - LA': 'unknown', 'LA, on-site': 'unknown', 'US, LA, Remote': 'fail',
    'Irvine, CA; Toronto, ON, Canada': 'pass', 'Remote: TX': 'fail',
  });
  Object.assign(expected.tx, { 'Remote: TX, OK, LA': 'pass', 'US - TX - Remote': 'pass', 'TX - Remote': 'pass',
    'Pasadena, TX, US': 'unknown', 'Remote - US (anywhere but California)': 'pass', 'US Remote; excluding CA, NY': 'pass' });
  Object.assign(expected.ca, {
    'TX Remote': 'fail', 'Washington State (Remote)': 'fail', 'Remote: US (CA, NY, TX, WA only)': 'pass',
    'Remote (Eligible: AZ, CA, CO, FL)': 'pass', 'Remote, US (excluding CA)': 'fail',
    'Remote, US - not eligible in CA': 'fail', 'Remote US (excluding residents of CA)': 'fail',
    'Los Angeles, CA or Remote (excluding CA)': 'pass', 'Remote (US) - Must reside in CT': 'fail',
    'New York, Los Angeles': 'pass',
    // A borrowed state is the only thing against these, and the text cannot say whether
    // the first city is in California: a question, never a rejection.
    'Los Angeles or Austin, TX': 'unknown', 'Irvine or Austin, TX': 'unknown',
    'Santa Clara, CA (Hybrid Remote)': 'fail', 'Sacramento, CA (Remote)': 'pass',
    'San Francisco, CA (Remote)': 'unknown', 'Portland, OR (Remote)': 'unknown',
    'Remote - Seattle, WA or Austin, TX': 'unknown', 'Remote - EMEA': 'fail',
    'Texas - we are fully remote': 'unknown',
    'Carson or Austin, TX': 'unknown', 'Los Angeles (occasional travel to London)': 'pass',
    'Hybrid remote - work from anywhere in the US - San Francisco, CA': 'pass',
    'Onsite (experience in OR)': 'unknown', 'Onsite (experience in AR)': 'unknown',
    'ONSITE (KNOWLEDGE OF OR)': 'unknown', 'Onsite (experience in OR is required)': 'unknown',
    'Remote, Dublin, California': 'unknown', 'Remote: CA - San Francisco metro only': 'unknown',
    'United States, AZ, Glendale': 'fail', 'U.S., AZ, Glendale': 'fail',
    'Remote - US (TX or CA preferred)': 'pass', 'Remote - US (not required to reside in TX)': 'unknown',
    'New York City, NY or location to be confirmed': 'unknown', 'Los Angeles & Austin, TX': 'unknown',
    'Remote - US (TX, CA) - HQ in San Francisco': 'pass', 'Los Angeles\u0085or Austin, TX': 'unknown',
    'San Fra\u1ab0ncisco, California': 'fail', 'except CA': 'unknown',
    // No commute place here, so only the onsite foreign check can see the trip.
    'Sacramento (occasional travel to London)': 'unknown',
  });
  Object.assign(expected.ca, {
    'Torrance 1450 W. Washington Ave (hybrid, 3 days on-site)': 'pass',
    'Torrance 1450 West Washington Avenue': 'pass',
    'Los Angeles, London, Sydney': 'pass', 'Seattle, Boston, Los Angeles, Berlin': 'pass',
    'Santa Ana, San Jose, Costa Rica': 'fail', 'Venice, Italy': 'fail',
    'Onsite in Singapore, reporting to Los Angeles': 'fail', 'Office - Ontario/Canada': 'fail',
    'Manitoba; Ontario; Nova Scotia': 'unknown', 'New York, USA - Remote': 'fail',
    'New York, U.S.A. (Remote)': 'fail', 'New York City': 'fail', 'Chicago, IL | Hybrid': 'fail',
    'Hybrid': 'unknown', 'Anywhere': 'pass',
    'Boston, MA, Chicago, IL, or Remote within Canada or United States': 'pass',
    'Remote within the United States (Texas residents only)': 'unknown',
    'Remote in US, restricted to Texas': 'unknown',
    'US Remote, must reside in one of 2 Texas counties': 'unknown', 'Remote, Texa\u017f': 'unknown',
  });
  Object.assign(expected.tx, { 'TX Remote': 'pass', 'Remote (US) - Must reside in TX': 'pass',
    'Remote (US) - Must reside in CT': 'fail', 'Texas - we are fully remote': 'pass' });
  Object.assign(expected.ca, {
    'AMER - United States - Texas - Remote': 'fail', 'AMER - United States - California - Remote': 'pass',
    'AMER - United States - Texas - Remote | Texas, USA - Remote': 'fail', 'AMER - United States - Texas': 'fail',
    'AMER - United States - California - Los Angeles': 'pass', 'AMER - Canada - Remote': 'fail',
    'AMER - Remote': 'unknown', 'EMEA - United Kingdom - London - Remote': 'fail',
    'APAC - Australia - Sydney - Remote': 'fail', 'Americas - Remote': 'unknown', 'NA - Remote': 'unknown',
    'Remote (Americas)': 'unknown', 'LATAM - Remote': 'fail', 'Remote, Flexible': 'unknown',
    'Los Angeles - San Diego, CA': 'fail', 'Los Angeles (San Francisco preferred)': 'pass',
    'Los Angeles, CA - HQ in San Francisco': 'pass',
    'Santa Monica, CA (reporting to San Francisco)': 'pass',
    'Los Angeles, CA (Remote, Bay Area OK)': 'pass', 'San Diego - Los Angeles, CA': 'fail',
    'AMER / Remote': 'unknown', 'Remote / NA': 'unknown',
  });
  // A California home also passes the California form from a weak mention, so Texas is the
  // home that proves the region fold: there the California form is a scope it cannot use.
  Object.assign(expected.tx, { 'AMER - United States - California - Remote': 'fail',
    'AMER - United States - Texas - Remote': 'pass' });
  Object.assign(expected.va, { 'US, VA, Arlington': 'pass', 'Arlington or Richmond, VA': 'pass',
    'District of Columbia - Washington': 'pass', 'Remote (US), except DC': 'pass' });
  expected.none = { 'Remote (US) - Must reside in CT': 'unknown', 'Remote - US (not in California office)': 'pass',
    'Remote - Anywhere in North America': 'pass' };
  expected.nj = { 'Los Angeles or New York': 'pass', 'Hybrid - New York': 'pass', 'Austin or New York': 'pass',
    'Remote - New York': 'pass', 'Remote: US (CA, NY, TX, WA only)': 'pass' };
  expected.oh = { 'Dublin, Ireland': 'fail', 'Dublin': 'pass', 'Dublin, OH': 'pass' };
  expected.dchome = { 'Remote (US), except DC': 'fail', 'US, VA, Arlington': 'pass', 'Arlington or Austin, TX': 'unknown' };
  expected.mt = { 'Remote - MT (Mountain Time)': 'unknown', 'US, MT, Remote': 'pass', 'Remote: WY, MT (full time)': 'pass' };
  expected.ct = { 'Remote: MA, CT (full time)': 'pass' };
  const policies = {
    ca: 'presets/locations/california-socal.json',
    none: 'presets/locations/remote-us.json',
    tx: { home_state: { code: 'TX', name: 'Texas' },
      commute: { label: 'Austin', signals: ['Austin', 'Round Rock'] },
      same_state_out: { label: 'Houston', signals: ['Houston'] }, onsite_outside_commute: 'fail' },
    // A home state written only as its code: "Austin, Texas" must still read as home.
    txcode: { home_state: { code: 'TX', name: 'TX' },
      commute: { label: 'Austin', signals: ['Austin', 'Round Rock'] }, onsite_outside_commute: 'fail' },
    // A Virginia candidate whose commute includes DC.
    va: { home_state: { code: 'VA', name: 'Virginia' },
      commute: { label: 'DC area', signals: ['Arlington', 'Alexandria', 'Washington, DC'] }, onsite_outside_commute: 'fail' },
    // A New Jersey commuter into New York City, whose commute entries reach New York state.
    nj: { home_state: { code: 'NJ', name: 'New Jersey' },
      commute: { label: 'NYC', signals: ['New York City', 'NYC', 'Manhattan', 'New York, NY', 'Hoboken', 'Jersey City'] },
      onsite_outside_commute: 'fail' },
    // Dublin is in Ohio and in Ireland; Montana's MT is also Mountain Time.
    oh: { home_state: { code: 'OH', name: 'Ohio' }, commute: { label: 'Columbus', signals: ['Columbus', 'Dublin'] },
      onsite_outside_commute: 'fail' },
    mt: { home_state: { code: 'MT', name: 'Montana' }, commute: { label: 'Bozeman', signals: ['Bozeman'] },
      onsite_outside_commute: 'fail' },
    ct: { home_state: { code: 'CT', name: 'Connecticut' }, commute: { label: 'Hartford', signals: ['Hartford, CT'] },
      onsite_outside_commute: 'fail' },
    // DC as home, with commute entries written "City, ST".
    dchome: { home_state: { code: 'DC', name: 'District of Columbia' },
      commute: { label: 'DC area', signals: ['Washington, DC', 'Arlington, VA', 'Bethesda, MD'] }, onsite_outside_commute: 'fail' },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-gates-'));
  try {
    const LC = await import(pathToFileURL(join(ROOT, 'location-core.mjs')).href);
    const map = { accept: 'pass', reject: 'fail', unknown: 'unknown' };
    const disagree = [];
    for (const [name, pol] of Object.entries(policies)) {
      const policyPath = typeof pol === 'string' ? join(ROOT, pol) : join(tmp, `${name}.json`);
      if (typeof pol !== 'string') writeFileSync(policyPath, JSON.stringify(pol));
      const sig = LC.buildSignals(LC.locationFilterFromPolicy(LC.loadLocationPolicy(policyPath)));
      const node = cases.map((c) => map[LC.decideLocations(c, sig).verdict]);
      const script = join(tmp, `gate-${name}.py`);
      writeFileSync(script, `import importlib.util, json, sys
sys.path.insert(0, "scripts")
import _location
s = importlib.util.spec_from_file_location("ep", "scripts/eval-prep.py")
ep = importlib.util.module_from_spec(s); s.loader.exec_module(ep)
pol = _location.load(${JSON.stringify(policyPath)})
print(json.dumps([ep.location_verdict(c, False, pol)[0] for c in ${JSON.stringify(cases)}]))
`);
      let py = [];
      try { py = JSON.parse(execFileSync('python', [script], { cwd: ROOT, encoding: 'utf-8', timeout: 60000 })); }
      catch (e) { disagree.push(`${name}: python failed ${(e.stderr || e.message).slice(0, 200)}`); continue; }
      cases.forEach((c, i) => { if (node[i] !== py[i]) disagree.push(`${name} "${c}": node ${node[i]}, python ${py[i]}`); });
      for (const [c, want] of Object.entries(expected[name] || {})) {
        const i = cases.indexOf(c);
        if (i < 0) disagree.push(`${name} "${c}": expected case missing from the table`);
        else if (node[i] !== want || py[i] !== want) disagree.push(`${name} "${c}": want ${want}, node ${node[i]}, python ${py[i]}`);
      }
    }
    if (!disagree.length) pass(`both location gates agree on ${cases.length} spellings under ${Object.keys(policies).length} policies`);
    else fail(`the location gates disagree:\n      ${disagree.join('\n      ')}`);
  } catch (e) {
    fail(`gate agreement test crashed: ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── THE BOARD BUILDERS RENDER FROM THE PRESETS ──────────────────
//
// build-dashboard.py and build-all-ranked.py take their tiers, lanes, suggested CVs and
// filter buttons from config/location.json and config/lane-vocab.json. Nothing ran them,
// so a regression that emptied the commute tier or dropped the lane buttons passed every
// test. Build both pages in a temp copy under no configuration and under the techart and
// California presets, and read the rows back out of the emitted page.

console.log('\nBoard builders (tier, lane, CV and buttons from the presets)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-boards-'));
  try {
    const { cpSync } = await import('fs');
    cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true,
      filter: (p) => !/__pycache__/.test(p) });
    cpSync(join(ROOT, 'presets'), join(tmp, 'presets'), { recursive: true });
    for (const d of ['data', 'reports', 'output']) mkdirSync(join(tmp, d));
    // Stub templates: the page chrome is not under test, the data and buttons are.
    const stub = '<script id="data">__DATA__</script><nav>__LANE_BUTTONS__</nav>'
      + '<p id="commute">__COMMUTE_LABEL__</p>';
    writeFileSync(join(tmp, 'scripts', '_dashboard_template.html'), stub);
    writeFileSync(join(tmp, 'scripts', '_all_ranked_template.html'), stub);
    // A fresh install has no tracker yet: every builder says so and exits 0, where it
    // used to end in a FileNotFoundError traceback on the very first run.
    const bare = ['build-dashboard.py', 'build-all-ranked.py', 'build-home.py'].filter((b) => {
      try {
        const out = execFileSync('python', [join(tmp, 'scripts', b)], { cwd: tmp, encoding: 'utf-8', timeout: 60000 });
        return !/NOT BUILT: data\/applications\.md does not exist yet/.test(out);
      } catch { return true; }
    });
    if (!bare.length) pass('every board builder reports NOT BUILT, exit 0, before a tracker exists');
    else fail(`board builders without a tracker crashed or said nothing: ${bare.join(', ')}`);
    const rows = [
      ['1', 'Acme', 'Senior Technical Artist', 'Irvine, CA (Onsite)'],
      ['2', 'Beta', 'Agent Evaluation Engineer', 'Remote, US'],
      ['3', 'Gamma', 'Senior Technical Artist', 'Glendale, AZ (Onsite)'],
      ['4', 'Delta', 'Senior Technical Artist', 'Onsite: Los Angeles, CA or Mountain View, CA, pick one'],
      ['5', 'Echo', 'Senior Technical Artist', 'Onsite. ' + 'The posting lists several offices in no particular order. '.repeat(3)
        + 'Culver City, CA'],
    ];
    let tracker = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
      + '|---|------|---------|------|-------|--------|-----|--------|-------|\n';
    for (const [n, co, role, loc] of rows) {
      const f = `00${n}-${co.toLowerCase()}-2026-09-20.md`;
      writeFileSync(join(tmp, 'reports', f), `# ${co}\n\n**URL:** https://example.invalid/${n}\n**Location:** ${loc}\n`);
      tracker += `| ${n} | 2026-09-20 | ${co} | ${role} | 4.2/5 | Evaluated | x | [${n}](../reports/${f}) | fixture |\n`;
    }
    writeFileSync(join(tmp, 'data', 'applications.md'), tracker);

    const build = (cfgDir) => {
      const env = { ...process.env, CAREER_OPS_CONFIG_DIR: cfgDir };
      for (const b of ['build-dashboard.py', 'build-all-ranked.py']) {
        execFileSync('python', [join(tmp, 'scripts', b)], { cwd: tmp, env, encoding: 'utf-8', timeout: 60000 });
      }
      const page = readFileSync(join(tmp, 'output', 'prospects-dashboard.html'), 'utf8');
      const data = JSON.parse(page.match(/<script id="data">([\s\S]*?)<\/script>/)[1]);
      const ranked = readFileSync(join(tmp, 'output', 'all-companies-ranked.html'), 'utf8');
      return { byCo: Object.fromEntries(data.map((r) => [r.co, r])),
        buttons: [...page.matchAll(/data-lane="([^"]+)"/g)].map((m) => m[1]),
        commute: page.match(/<p id="commute">([^<]*)<\/p>/)[1], ranked };
    };

    // (a) No configuration: the neutral location preset has no commute area, and the
    // general lane preset has no lanes, so nothing is tiered Commute or bucketed.
    const none = mkdtempSync(join(tmpdir(), 'career-ops-boards-none-'));
    const a = build(none);
    rmSync(none, { recursive: true, force: true });
    const aOk = a.byCo.Acme?.tier === 'Check' && a.byCo.Beta?.tier === 'Remote-US'
      && a.byCo.Acme?.lane === 'Other' && a.byCo.Acme?.cv === 'CV' && a.buttons.length === 0
      && /Gamma/.test(a.ranked);
    if (aOk) pass('board builders: with no configuration nothing is tiered Commute or given a lane');
    else fail(`board builders, no config: ${JSON.stringify(Object.values(a.byCo).map((r) => [r.co, r.tier, r.lane, r.cv]))} buttons=${a.buttons}`);

    // (b) The techart lanes and the California commute area.
    const cfg = mkdtempSync(join(tmpdir(), 'career-ops-boards-cfg-'));
    writeFileSync(join(cfg, 'lane-vocab.json'), readFileSync(join(ROOT, 'presets', 'lanes', 'techart-ai-tooling.json')));
    writeFileSync(join(cfg, 'location.json'), readFileSync(join(ROOT, 'presets', 'locations', 'california-socal.json')));
    const b = build(cfg);
    rmSync(cfg, { recursive: true, force: true });
    const caLabel = JSON.parse(readFileSync(join(ROOT, 'presets', 'locations', 'california-socal.json'), 'utf8')).commute.label;
    const bOk = b.byCo.Acme?.tier === 'Commute' && b.byCo.Gamma?.tier === 'Check'
      && b.byCo.Delta?.tier === 'Commute' && b.byCo.Echo?.tier === 'Commute'
      && b.byCo.Beta?.tier === 'Remote-US' && b.byCo.Acme?.lane === 'Tech-Art / Craft'
      && b.byCo.Acme?.cv === 'TA CV' && b.byCo.Beta?.lane === 'Eval / Agentic'
      && b.buttons.includes('Tech-Art / Craft') && b.buttons.includes('Eval / Agentic')
      && b.commute === `${caLabel} commute`;
    if (bOk) pass('board builders: the presets decide tier, lane, CV, buttons and the commute label');
    else fail(`board builders, presets: ${JSON.stringify(Object.values(b.byCo).map((r) => [r.co, r.tier, r.lane, r.cv]))} buttons=${b.buttons} commute=${b.commute}`);
  } catch (e) {
    fail(`board builder test crashed: ${e.message.slice(0, 400)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── THE ISREMOTE UPGRADE NEVER LIFTS AN AMERICAS REGION ─────────
// eval-prep lets the ATS isRemote flag turn an `unknown` of kind 'unrecognised' into a
// pass. "AMER - Remote" used to be that kind, so the flag passed a role that may sit in
// Canada or Latin America, which is a false pass against a hard no-relocation constraint.
// Both engines now give it the kind 'region', which the upgrade does not read. The table
// above runs with the flag OFF and compares verdicts only, so it cannot see this: here both
// engines' KIND must match, and the evaluation verdict is taken with the flag ON.
console.log('\nisRemote upgrade spares Americas region labels (both engines)');
{
  const want = {
    'AMER - Remote': ['region', 'unknown'], 'Americas - Remote': ['region', 'unknown'],
    'NA - Remote': ['region', 'unknown'], 'Remote (Americas)': ['region', 'unknown'],
    'LATAM - Remote': ['foreign', 'fail'],
    // The upgrade itself must survive: a qualifier that names no region is still lifted.
    'Remote, Flexible': ['unrecognised', 'pass'],
  };
  const cases = Object.keys(want);
  const policyPath = join(ROOT, 'presets/locations/california-socal.json');
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-region-'));
  try {
    const LC = await import(pathToFileURL(join(ROOT, 'location-core.mjs')).href);
    const sig = LC.buildSignals(LC.locationFilterFromPolicy(LC.loadLocationPolicy(policyPath)));
    const script = join(tmp, 'region.py');
    writeFileSync(script, `import importlib.util, json, sys
sys.path.insert(0, "scripts")
import _location
s = importlib.util.spec_from_file_location("ep", "scripts/eval-prep.py")
ep = importlib.util.module_from_spec(s); s.loader.exec_module(ep)
pol = _location.load(${JSON.stringify(policyPath)})
print(json.dumps([[pol.decide(c)[2], ep.location_verdict(c, True, pol)[0]] for c in ${JSON.stringify(cases)}]))
`);
    const py = JSON.parse(execFileSync('python', [script], { cwd: ROOT, encoding: 'utf-8', timeout: 60000 }));
    const bad = [];
    cases.forEach((c, i) => {
      const [kind, flagged] = want[c];
      const nodeKind = LC.decideLocations(c, sig).kind;
      if (nodeKind !== kind || py[i][0] !== kind || py[i][1] !== flagged) {
        bad.push(`"${c}": want ${kind}/${flagged}, node kind ${nodeKind}, python kind ${py[i][0]}, flag-on verdict ${py[i][1]}`);
      }
    });
    if (!bad.length) pass(`both engines give ${cases.length} region and control spellings the same kind, and the flag lifts only the unrecognised one`);
    else fail(`the isRemote upgrade and the region kind disagree:\n      ${bad.join('\n      ')}`);
  } catch (e) {
    fail(`region-kind test crashed: ${(e.stderr || e.message).slice(0, 200)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── THE SCANNER'S LOCATION FILTER IS THE POLICY PLUS OVERRIDES ──
//
// scan.mjs and scan-ats-full.mjs build their filter from effectiveLocationFilter(), so a
// portals.yml `allow`/`block` block no longer reaches buildLocationFilter's generic branch.
// Section 15 above tests that exported helper directly; this is the path the scanners run.
console.log('\nScanner location filter (policy plus portals.yml overrides)');
try {
  const { buildLocationFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const LC = await import(pathToFileURL(join(ROOT, 'location-core.mjs')).href);
  const warned = [];
  const eff = LC.effectiveLocationFilter({ allow: ['austin', 'toronto'], block: ['remote - us'] },
    LC.loadLocationPolicy(join(ROOT, 'presets', 'locations', 'remote-us.json')), (m) => warned.push(m));
  const f = buildLocationFilter(eff);
  if (f('Remote - US') === true && f('Toronto, Canada') === false && f('Austin, TX (Onsite)') === false
      && warned.length === 1 && /allow/.test(warned[0]) && /block/.test(warned[0])) {
    pass('the scanner ignores generic allow/block keys out loud and applies the policy');
  } else fail(`scanner filter: remote=${f('Remote - US')} toronto=${f('Toronto, Canada')} austin=${f('Austin, TX (Onsite)')} warned=${warned}`);
  // Both scanners must reach the policy through effectiveLocationFilter, never hand the raw
  // portals.yml block to the decider, or the scan gate and eval-prep's gate are two gates.
  const raw = ['scan.mjs', 'scan-ats-full.mjs'].filter((f2) => {
    const src = readFileSync(join(ROOT, f2), 'utf8');
    return !/build(?:LocationDecider|LocationFilter)\(effectiveLocationFilter\(config\??\.location_filter\)\)/.test(src);
  });
  if (!raw.length) pass('both scanners decide location through effectiveLocationFilter (the policy)');
  else fail(`these scanners hand portals.yml's location_filter straight to the decider: ${raw.join(', ')}`);
} catch (e) {
  fail(`scanner filter test crashed: ${e.message}`);
}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
