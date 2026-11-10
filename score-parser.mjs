// Shared report score parsing for the model, writers and audits.
// Field names drifted across ~400 reports. Accept the observed variants rather than
// treating a rename as missing data: `comp_score` and `score` alone accounted for dozens
// of reports being written off as unparseable.
const ALIASES = {
  match_w_cv: ['match_w_cv', 'match'],
  north_star: ['north_star', 'northstar', 'north star'],
  comp: ['comp_score', 'comp'],
  cultural_signals: ['cultural_signals', 'cultural', 'culture'],
  red_flags_adj: ['red_flags_adj', 'red_flags', 'red flags'],
  global: ['global', 'global_score', 'score'],
};
const FIELDS = Object.keys(ALIASES);
export const DIMS = ['match_w_cv', 'north_star', 'comp', 'cultural_signals'];

// Dimensions decide first: a parse missing a dimension cannot compute a base at all, so
// three dimensions plus `global` must never outrank four without it. Among parses with
// the SAME dimension count, one that also carries `global` wins, since the audit compares
// the stated global with the recomputed one. Before that tie-break, a CRLF report's YAML
// block failed to match (see below), the markdown table tied on four dimensions, was
// pushed first, and won.
const completeness = (c) =>
  2 * DIMS.filter((k) => c && c[k] !== null && c[k] !== undefined).length
  + (c && c.global !== null && c.global !== undefined ? 1 : 0);

/**
 * Reports use several shapes for the score block. Rather than committing to whichever
 * shape matches first, extract a candidate from EVERY shape and keep the most complete.
 * The old precedence-based version silently returned a half-filled YAML match and never
 * fell through to a perfectly good table further down the same file.
 */
export function parseScores(text) {
  const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };
  const pick = (form, get) => {
    const o = { form };
    for (const f of FIELDS) {
      let v = null;
      for (const a of ALIASES[f]) { v = get(a); if (v !== null && v !== undefined) break; }
      o[f] = v ?? null;
    }
    return o;
  };
  const candidates = [];

  // 1. YAML block:  scores:\n  match_w_cv: 4.2
  // Trailing `# comment` must be tolerated: the provenance markers written by the
  // re-derivation passes carry one, and a stricter pattern terminated the block early
  // and silently dropped every field below the first annotated line.
  // Line endings are `\r?\n`: 307 of 1389 reports on disk are CRLF (2026-11-08), and a
  // bare `\n` here made every one of them read as having no machine score block.
  for (const m of text.matchAll(/scores:[ \t]*\r?\n((?:[ \t]*[\w ]+:\s*-?[\d.]+[ \t]*(?:#[^\r\n]*)?\r?\n)+)/g)) {
    const b = m[1];
    candidates.push(pick('yaml', (k) => {
      const x = b.match(new RegExp(`^[ \\t]*${k}:\\s*(-?[\\d.]+)`, 'im')); return x ? num(x[1]) : null;
    }));
  }

  // 2. Inline dict:  scores: {match_w_cv: 3.3, ...}
  for (const m of text.matchAll(/scores:\s*\{([^}]*)\}/g)) {
    const b = m[1];
    candidates.push(pick('inline', (k) => {
      const x = b.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*(-?[\\d.]+)`, 'i')); return x ? num(x[1]) : null;
    }));
  }

  // 3. Markdown table:  | match_w_cv | 4.2 |
  candidates.push(pick('table', (k) => {
    const x = text.match(new RegExp(`\\|\\s*\\**${k}\\**[^|]*\\|\\s*\\**\\s*(-?[\\d.]+)`, 'i')); return x ? num(x[1]) : null;
  }));

  // 4. Loose key/value anywhere:  match_w_cv: 4.2   (outside any scores: block)
  candidates.push(pick('loose', (k) => {
    const x = text.match(new RegExp(`^[ \\t]*${k}:\\s*(-?[\\d.]+)`, 'im')); return x ? num(x[1]) : null;
  }));

  // 5. Prose run:  match 4.2 · North Star 4.6 · comp 4.6 · cultural 4.7 · red flags -0.3
  candidates.push(pick('prose', (k) => {
    const x = text.match(new RegExp(`\\b${k}\\b[^\\d\\n-]{0,12}(-?[\\d.]+)`, 'i')); return x ? num(x[1]) : null;
  }));

  candidates.sort((a, b) => completeness(b) - completeness(a));
  return candidates[0] || null;
}

export { computeBase as computeGlobal } from './score-model.mjs';

