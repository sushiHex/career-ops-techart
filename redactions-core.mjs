// @ts-check
/**
 * redactions-core.mjs — CIIAA codename scrub (shared)
 *
 * Mechanical last-resort denylist pass that strips confidential former-employer
 * project codenames from candidate-facing output. The PRIMARY guard is
 * instruction-level (voice-dna.md §0, modes/_shared.md Global Rules, the
 * generic descriptors in cv.md / article-digest.md). This module is
 * defense-in-depth: even if a codename slips into generated text, it never
 * reaches a PDF/cover/report.
 *
 * Wired into: generate-pdf.mjs (renderHtmlToPdf — covers CV *and* cover-letter
 * PDFs, since the cover letter renders through the same function) and
 * gemini-eval.mjs (the secondary scorer's report).
 *
 * Reads redactions.yml (User Layer, gitignored). Codenames may be either a
 * plain string or an object with a custom replacement:
 *
 *   codenames:
 *     - "Project Foo"                                          # → default replacement
 *     - codename: "Project Bar"
 *       replacement: "an internal avatar system"
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPLACEMENT = 'a confidential project';

let _cache = null;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Load and normalize redaction rules from redactions.yml.
 * Returns [] when the file is absent, empty, or unparseable (never throws on
 * those — a missing denylist must not break PDF/report generation).
 * @param {string} [rootDir]
 * @returns {{codename: string, replacement: string, pattern: RegExp}[]}
 */
export function loadRedactions(rootDir = ROOT) {
  const path = join(rootDir, 'redactions.yml');
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  let doc;
  try {
    doc = yaml.load(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(doc && doc.codenames) ? doc.codenames : [];
  const rules = [];
  for (const entry of list) {
    let codename;
    let replacement;
    if (typeof entry === 'string') {
      codename = entry.trim();
      replacement = DEFAULT_REPLACEMENT;
    } else if (entry && typeof entry === 'object') {
      codename = String(entry.codename ?? entry.name ?? '').trim();
      replacement = String(entry.replacement ?? DEFAULT_REPLACEMENT).trim() || DEFAULT_REPLACEMENT;
    } else {
      continue;
    }
    if (!codename) continue;
    const esc = escapeRegExp(codename);
    // Word-boundary only where the codename edge is itself a word char, so
    // "Project Foo" matches "Project Foo." but a short name won't match inside
    // an unrelated word.
    const left = /^\w/.test(codename) ? '\\b' : '';
    const right = /\w$/.test(codename) ? '\\b' : '';
    rules.push({ codename, replacement, pattern: new RegExp(`${left}${esc}${right}`, 'gi') });
  }
  return rules;
}

function getRules(rootDir) {
  if (rootDir && rootDir !== ROOT) return loadRedactions(rootDir);
  if (_cache === null) _cache = loadRedactions(ROOT);
  return _cache;
}

/**
 * Replace every configured codename in `text` with its generic descriptor.
 * No-op when there are no rules or `text` is empty/non-string.
 * @param {string} text
 * @param {{rootDir?: string, warn?: boolean, label?: string}} [opts]
 * @returns {string}
 */
export function scrubCodenames(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text;
  const rules = getRules(opts.rootDir);
  if (!rules.length) return text;
  let out = text;
  let hits = 0;
  for (const rule of rules) {
    out = out.replace(rule.pattern, () => {
      hits++;
      return rule.replacement;
    });
  }
  if (hits > 0 && opts.warn !== false) {
    const where = opts.label ? ` (${opts.label})` : '';
    // Report that a scrub fired, but never echo the codename itself.
    process.stderr.write(
      `⚠️  CIIAA scrub${where}: replaced ${hits} confidential codename occurrence(s) with a generic descriptor. Review the output.\n`,
    );
  }
  return out;
}

export default { loadRedactions, scrubCodenames };
