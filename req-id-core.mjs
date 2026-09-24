/**
 * req-id-core.mjs holds the one Workday requisition pattern every Node tool uses.
 *
 * WHY THIS FILE EXISTS. The pattern was written out four separate times, in four
 * different spellings, and every divergence was a SILENT miss rather than an
 * error:
 *
 *   - pipeline-audit.mjs omitted Autodesk's year-prefixed \d{2}WD\d{5,} form, so
 *     every 26WD161146 row keyed as its own URL and two spellings of one req
 *     counted as two pending jobs.
 *   - scripts/workday-sweep.py demanded six digits after JR, so Netflix's real
 *     JR48085 matched nothing there and every Netflix req reported itself
 *     untracked.
 *   - role-matcher.mjs had no 26WD branch either, so Autodesk _26WD161146 and
 *     _26WD91231-1 returned null. A null id is not a conflict, so merge-tracker
 *     and dedup-tracker lost the job-id guard and fell back to fuzzy titles,
 *     which can merge two distinct Autodesk requisitions or duplicate one.
 *   - eval-write.mjs used (JR[-_]?\d{4,}|R\d{5,}|\d{7,}): a four-digit floor
 *     after JR, which is the exact bug removed from pipeline-audit because four
 *     digits also matches the DATE in a report filename slug
 *     ("...-agentic-systems-jr-2026-07-07.md" minted the id JR2026).
 *
 * The previous round unified two of the four and added a test asserting those
 * two were byte-identical. A test that DETECTS drift is strictly worse than a
 * structure in which drift cannot happen, and three of the four are Node, and
 * Node can import. So the three Node consumers now read REQ_ID_SRC from here.
 * Only the Python copy stays a hand port, and pipeline-audit's --selftest still
 * asserts it is character-for-character equal to this one.
 *
 * WHY THE FLOORS ARE WHAT THEY ARE. Widened from the once-documented
 * (JR\d{6,}|R-?\d{5,}) to the spellings actually on the tracker: Netflix writes
 * JR48085 and Sony writes JR-103209, so a six-digit floor after a bare JR reads
 * neither. Five digits is the floor rather than four because four also matches
 * the date in a report filename slug. The bare numeric Workday id
 * ("..._17372837") is deliberately NOT here: no inbox row needs it and a bare
 * \d{7,} would swallow ids from other boards. eval-write composes that one
 * alternative on top for its own label, which is the sanctioned way to need
 * more than this pattern gives.
 *
 * WHY IT IS ANCHORED ON A NON-ALPHANUMERIC RATHER THAN \b. A Workday path ends
 * "..._JR2508244" and underscore is a word character, so a leading \b never
 * fires. Measured against the real inbox on 2026-09-19 a \b-anchored pattern hit
 * 0 of 401 Workday rows.
 *
 * Tenant forms seen so far: NVIDIA JR2620896, Netflix JR48085, Sony JR-103209,
 * CrowdStrike R26710 and R23555-1, Blizzard R021430, Autodesk 26WD161146 and
 * 26WD91231-1.
 *
 * A CONSUMER THAT NEEDS MORE MUST COMPOSE, NEVER REDEFINE. role-matcher keeps
 * its own extra alternatives for the P###### and REQ-#### forms and eval-write
 * keeps the bare numeric one; both sit BESIDE this pattern rather than replacing
 * it. What must never happen again is a copy silently omitting a form another
 * copy has, and test-all.mjs asserts no Node consumer holds a literal
 * requisition alternation of its own.
 */

/** The shared source text. Exported as a STRING so consumers can compose it. */
export const REQ_ID_SRC =
  String.raw`(?<![A-Za-z0-9])(JR[-_]?\d{5,}|\d{2}WD\d{5,}|R[-_]?\d{5,})(?![A-Za-z0-9])`;

/** Case-insensitive, one match. */
export const REQ_ID = new RegExp(REQ_ID_SRC, 'i');

/** A fresh global regex per call: a shared /g regex carries lastIndex between
 *  callers, which makes the second caller's first match silently disappear. */
export const reqIdGlobal = () => new RegExp(REQ_ID_SRC, 'gi');

/** One req, one id: JR-103209, JR_103209 and jr103209 are the same requisition. */
export const canonId = (id) => String(id).toUpperCase().replace(/[-_]/g, '');
