// Audit the title filter against ground truth: every role the candidate has actually
// evaluated. A role they researched, applied to, or are interviewing for that the
// scanner's title filter REJECTS is a proven false negative: the scanner would
// never have shown them the job they are currently pursuing.
//
// This matters more than the location filter did. Title rejections are counted
// but never recorded, so a silent loss here has been invisible since day one.
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { buildTitleFilter } from './scan.mjs';

for (const f of ['portals.yml', 'data/applications.md']) {
  if (!existsSync(f)) {
    console.log(`NOT CHECKED: ${f} does not exist yet (onboarding required).`);
    process.exit(2);
  }
}

const cfg = yaml.load(readFileSync('portals.yml', 'utf8'));
const passes = buildTitleFilter(cfg.title_filter);

const rows = readFileSync('data/applications.md', 'utf8').split('\n')
  .filter(l => l.trim().startsWith('|') && !/^\|\s*[-:]+/.test(l.trim()));

const seen = new Map();
for (const line of rows) {
  const c = line.split('|').map(s => s.trim());
  // | # | Date | Company | Role | Score | Status | ...
  const [, num, , company, role, score, status] = c;
  if (!role || role === 'Role' || !/^\d+$/.test(num || '')) continue;
  const n = Number(String(score).replace(/\/5.*$/, '')) || 0;
  if (!seen.has(role)) seen.set(role, { company, score: n, status: status || '' });
}

const rejected = [];
for (const [role, meta] of seen) {
  if (!passes(role)) rejected.push({ role, ...meta });
}

const neg = (cfg.title_filter?.negative || []).map(k => k.toLowerCase());
const pos = (cfg.title_filter?.positive || []).map(k => k.toLowerCase());
const why = (role) => {
  const l = role.toLowerCase();
  const hit = neg.find(k => l.includes(k));
  if (hit) return `negative "${hit}"`;
  return pos.length && !pos.some(k => l.includes(k)) ? 'no positive keyword matched' : '?';
};

console.log(`distinct evaluated roles: ${seen.size}`);
console.log(`rejected by title filter:  ${rejected.length}\n`);

const serious = rejected.filter(r => r.score >= 4.0
  || /applied|interview|offer|responded/i.test(r.status));
console.log('=== PROVEN FALSE NEGATIVES (scored 4.0+, or applied/interviewed) ===');
if (!serious.length) console.log('  none');
for (const r of serious.sort((a, b) => b.score - a.score)) {
  console.log(`  ${String(r.score || '-').padEnd(4)} ${r.status.padEnd(10)} ${why(r.role).padEnd(28)} ${r.role}`);
  console.log(`       ${r.company}`);
}

console.log('\n=== other rejected evaluated roles (sample) ===');
for (const r of rejected.filter(r => !serious.includes(r)).slice(0, 25)) {
  console.log(`  ${String(r.score || '-').padEnd(4)} ${why(r.role).padEnd(28)} ${r.role}`);
}

// Which negative keywords are doing the damage?
const blame = new Map();
for (const r of rejected) {
  const l = r.role.toLowerCase();
  for (const k of neg) if (l.includes(k)) blame.set(k, (blame.get(k) || 0) + 1);
}
console.log('\n=== negative keywords by evaluated-role kills ===');
for (const [k, n] of [...blame.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  "${k}"`);
}
