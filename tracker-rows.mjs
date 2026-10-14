/**
 * tracker-rows.mjs — Reading and rewriting applications.md table rows.
 *
 * merge-tracker, verify-pipeline, dedup-tracker and normalize-statuses each held
 * their own copy of these helpers, and a copy that drifts reads the same tracker
 * differently from its neighbours. One module, so they cannot.
 */

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
 * A score cell (`4.3/5`, `**4.3/5**`) as a number, or 0 when it holds none.
 *
 * @param {string} s
 * @returns {number}
 */
export function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
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
