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
 * \d{7,} would swallow ids from other boards. reqLabel() below composes that one
 * alternative on top for the role-cell LABEL, which is the sanctioned way to need
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
 * its own extra alternatives for the P###### and REQ-#### forms, and the role-cell
 * definitions at the end of this file add the bare numeric one; all of them sit
 * BESIDE this pattern rather than replacing it. What must never happen again is a copy silently omitting a form another
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

/*
 * THE TRACKER ROLE CELL. A requisition id travels beside the title, "Senior
 * Engineer (JR2508244)", and three tools touch it, each with a different job:
 *
 *   - eval-write WRITES it, with reqLabel() below.
 *   - role-matcher READS it as IDENTITY, with REQ_ID_SRC alone. A bare number
 *     stays a label and never becomes identity: as a dedup key a loose \d{7,}
 *     would swallow ids from other boards.
 *   - scan.mjs STRIPS it to compare titles, with ROLE_ID_TOKEN_SRC below.
 *
 * The stripper must cover everything the writer puts there and everything the
 * reader finds there, or a role already on the tracker comes back as new on
 * every scan. Both definitions live here, beside the pattern they compose, and
 * test-all.mjs asserts both inclusions over the real tracker and reports.
 */

// A UUID is cut out before the bare-number alternative runs: an Ashby or Lever posting
// id ends in a twelve-hex group that is often all digits, and "...-113241621221" was
// labelled Prefect's requisition on 2026-10-13.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REQ_LABEL_RE = new RegExp(`${REQ_ID_SRC}|[_/-](\\d{7,})(?![0-9])`, 'gi');

/**
 * The requisition label eval-write puts in the role cell, e.g. "... (JR2508244)".
 *
 * The shared pattern, plus a bare number of seven or more digits after a separator,
 * which is the only thing that labels a "..._17372837" Workday row. As a label the
 * looser form costs nothing. Query and fragment are cut first, the rule jobKey()
 * follows: a tracking parameter carrying a req-shaped token is not this posting's
 * requisition. Last match wins, because the requisition sits at the end of an ATS path.
 *
 * @param {string} url - The posting URL.
 * @returns {string|null}
 */
export const reqLabel = (url) => {
  const path = String(url || '').trim().replace(/[?#].*$/, '').replace(UUID_RE, '');
  let last = null;
  for (const m of path.matchAll(REQ_LABEL_RE)) {
    last = m[1] || m[2];
  }
  return last;
};

/**
 * One requisition token as scan.mjs canonicalRole() strips it from a role cell:
 * the shared pattern, plus REQ-####, Zillow's P###### and a bare number of five
 * or more digits (how a Greenhouse gh_jid or a Riot or Disney id is recorded,
 * "(5349405250)"). A trailing "-1" facet suffix belongs to the id before it, or
 * "JR2292444-1" leaves a "1". Exported as a STRING, to be composed.
 */
export const ROLE_ID_TOKEN_SRC = String.raw`(?:(?:${REQ_ID_SRC}|(?<![A-Za-z0-9])(?:REQ[-_ ]?\d{4,}|P\d{5,}|\d{5,})(?![A-Za-z0-9]))(?:-\d{1,2}(?![A-Za-z0-9]))?)`;
