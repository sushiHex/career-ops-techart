/**
 * tracker-rows.mjs — Reading and rewriting applications.md table rows.
 *
 * Every tool that reads or writes the tracker used to hold its own copy of these
 * helpers, most of them reading cells by fixed position and ignoring the header,
 * and a copy that drifts reads the same tracker differently from its neighbours.
 * One module, mapping columns by header name, so they cannot.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * The tracker file under `root`: CAREER_OPS_TRACKER when set (tests and
 * non-standard layouts), else data/applications.md, else the original
 * root-level applications.md.
 *
 * @param {string} root - The career-ops directory.
 * @returns {string}
 */
export function trackerPath(root) {
  if (process.env.CAREER_OPS_TRACKER) return process.env.CAREER_OPS_TRACKER;
  const data = join(root, 'data', 'applications.md');
  return existsSync(data) ? data : join(root, 'applications.md');
}

// The original 9-column layout, indexed as `line.split('|')` indexes it (the
// leading empty cell before the first pipe is index 0).
export const LEGACY_COLMAP = { num: 1, date: 2, company: 3, role: 4, score: 5, status: 6, pdf: 7, report: 8, notes: 9 };

const HEADER_ALIASES = {
  '#': 'num', 'num': 'num', 'date': 'date', 'company': 'company', 'empresa': 'company',
  'role': 'role', 'puesto': 'role', 'location': 'location', 'score': 'score',
  'status': 'status', 'pdf': 'pdf', 'report': 'report', 'notes': 'notes',
};

/**
 * Map columns by header NAME, so a tracker with an extra column (a Location
 * column after Role) reads correctly; fixed positions would read Location where
 * Score is expected. Returns null unless the essential columns are all present,
 * so a stray pipe line cannot yield a bogus mapping; callers then fall back to
 * LEGACY_COLMAP.
 *
 * @param {string[]} lines - The tracker's lines.
 * @returns {Record<string, number>|null}
 */
export function detectColumns(lines) {
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('role')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (['num', 'company', 'role', 'score', 'status'].every(k => map[k] != null)) return map;
  }
  return null;
}

/** The tracker's column layout: by header name when it has one, else the legacy layout. */
export function columnsOf(lines) {
  return detectColumns(lines) || LEGACY_COLMAP;
}

/**
 * True for a markdown separator row, which is pipes, dashes, colons and spaces
 * ONLY. Testing `includes('---')` instead skipped any DATA row with three dashes
 * anywhere, which report links have whenever a role like "Engineer 5 - Model
 * Runtime" slugifies to "engineer-5---model-runtime": two live rows were invisible
 * to merge-tracker that way, so a re-evaluation would have been appended as a
 * duplicate.
 */
export const isSeparatorRow = (line) => /^\s*\|[\s:|-]*\|\s*$/.test(line);

/**
 * One table row as a tracker object, or null for a header, separator or short
 * row. The raw line is kept so a writer can find and replace it exactly.
 *
 * @param {string} line - One line from applications.md.
 * @param {Record<string, number>} colmap - From detectColumns, or LEGACY_COLMAP.
 * @returns {object|null}
 */
export function parseRow(line, colmap) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length <= Math.max(...Object.values(colmap))) return null;
  const num = parseInt(parts[colmap.num]);
  if (isNaN(num)) return null;
  return {
    num,
    date: parts[colmap.date],
    company: parts[colmap.company],
    role: parts[colmap.role],
    location: colmap.location != null ? parts[colmap.location] : '',
    score: parts[colmap.score],
    status: parts[colmap.status],
    pdf: parts[colmap.pdf],
    report: parts[colmap.report],
    notes: colmap.notes != null ? (parts[colmap.notes] || '') : '',
    raw: line,
  };
}

/**
 * Every data row of a tracker, parsed by header name and tagged with its line
 * index (`row.line`), so a writer replaces lines[row.line] rather than searching
 * for a raw string that an earlier write in the same run may have changed.
 *
 * @param {string[]} lines - The tracker's lines.
 * @param {Record<string, number>} [colmap] - Defaults to columnsOf(lines).
 * @returns {object[]}
 */
export function trackerRows(lines, colmap = columnsOf(lines)) {
  const rows = [];
  lines.forEach((line, i) => {
    const row = line.startsWith('|') ? parseRow(line, colmap) : null;
    if (row) rows.push(Object.assign(row, { line: i }));
  });
  return rows;
}

/**
 * A tracker row written in header order: the inverse of parseRow. An
 * unrecognised header BETWEEN named columns is written empty; one after the
 * last named column is not written at all, since the map does not record it.
 *
 * @param {object} o - num, date, company, role, location, score, status, pdf, report, notes.
 * @param {Record<string, number>} colmap - From columnsOf.
 * @returns {string} `| a | b | ... |`
 */
export function buildRow(o, colmap) {
  const cells = Array(Math.max(...Object.values(colmap))).fill('');
  for (const [key, i] of Object.entries(colmap)) cells[i - 1] = String(o[key] ?? '');
  return '| ' + cells.join(' | ') + ' |';
}

/**
 * `line` with one named cell's text replaced and its padding kept, so a rewrite
 * of one value touches nothing else on the row.
 *
 * @param {string} line
 * @param {Record<string, number>} colmap
 * @param {string} key - e.g. 'score'.
 * @param {string} text
 * @returns {string}
 */
export function setCell(line, colmap, key, text) {
  const c = line.split('|');
  const old = c[colmap[key]];
  // An EMPTY cell has no text to replace, and the replace() was then a silent no-op
  // (Codex, 2026-10-29: a rescore note never landed on a row with blank notes).
  c[colmap[key]] = /\S/.test(old) ? old.replace(/\S(?:[\s\S]*\S)?/, () => text) : ` ${text} `;
  return c.join('|');
}

/**
 * A score cell (`4.3/5`, `**4.3/5**`) as a number, or 0 when it holds none.
 *
 * @param {string} s
 * @returns {number}
 */
export function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/** A valid score cell: `4.2/5`, `N/A` or `DUP`. */
export const SCORE_CELL = /^(?:\d+\.?\d*\/5|N\/A|DUP)$/;

/**
 * The report FILE a tracker line links to, `[n](../reports/<file>)`, or null.
 * This is the join every score gate makes between a row and its report; it keys
 * on the link and never on the row number, which is a separate sequence.
 *
 * @param {string} line
 * @returns {string|null}
 */
export function reportFileOf(line) {
  const m = String(line ?? '').match(/\((?:\.\.\/)?reports\/([^)]+)\)/);
  return m ? m[1].split('/').pop() : null;
}

/**
 * The bracketed number of a report link, `[123](../reports/123-...md)`, or null.
 *
 * @param {string} cell
 * @returns {number|null}
 */
export function reportNumOf(cell) {
  const m = String(cell ?? '').match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Rebuild a row from the cells `line.split('|').map(s => s.trim())` produced.
 *
 * The split yields a leading empty cell, and a trailing one only when the row
 * ends with a pipe. A row written without the trailing pipe is still a valid row
 * whose last real cell is the notes, so only an EMPTY trailing cell is dropped;
 * `slice(1, -1)` used to drop the notes of such rows.
 *
 * @param {string[]} parts
 * @returns {string} `| a | b | ... |`
 */
export function rebuildRow(parts) {
  const cells = parts.slice(1);
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return '| ' + cells.join(' | ') + ' |';
}

export const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip',
];

// Legacy and Spanish spellings, each mapped onto a canonical status.
const STATUS_ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

/**
 * A status cell as a lowercase status: bold and a trailing date stripped, an
 * alias mapped. Anything unrecognised comes back cleaned but unmapped, so
 * `CANONICAL_STATUSES.includes(normalizeStatus(x))` is the canonical test.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return Object.hasOwn(STATUS_ALIASES, clean) ? STATUS_ALIASES[clean] : clean;
}
