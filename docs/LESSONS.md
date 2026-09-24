# Confident wrong answers

A job-search pipeline rarely crashes. It returns an answer that looks like every other
answer and happens to be wrong: a live posting marked closed, a reachable role discarded
by the location gate, a board reported as holding forty jobs because the loop stopped
early. Nobody investigates a plausible result, so these failures persist.

Everything below was found in this fork's own pipeline during a real search, measured,
fixed, and then pinned with a test that goes red if the fix is reverted. The figures are
the measurements recorded at the time.

The through-line is one rule: **"not checked" and "checked and fine" are different
answers, and a tool must never report the second when it only knows the first.**

---

## Discovery

### The first gate was rejecting the best roles

The portal scan drops about 97% of everything it sees by title keyword, and it logged
nothing about what it dropped. Replaying it over every role that had already been
evaluated showed it **rejecting 224 of 392**, including one that reached interview. The
highest-scoring role of the entire run was rejected at this gate because the positive
list lacked the word "Harness", while the lane scorer downstream weighted that same word
at +4.

*Fix:* a title audit (`_titleaudit.mjs`) replays the filter over every evaluated role and
names proven false negatives directly. Adding the missing vocabulary took false negatives from **six to three**. The
remaining three are internal product names, which a word list can never see; those roles
are reached by the board sweeps instead, which score the posting body.

### Search is the weak half of discovery

| Path | Companies | Ever produced a lead |
|---|---|---|
| Pollable ATS API (`careers_url`) | 140 | **58%** |
| Web search hand-off | 73 | **10%** |

**65 of 73** search-only companies never produced a single lead. The fix for weak
discovery is therefore never a better query. It is `scripts/find-ats.py`, which recovers a
company's real ATS board so it can be polled directly.

### A provider's 404 is a statement about the endpoint

Ashby's posting API is opt-in per organisation. An organisation with it disabled answers
**404 forever** while its board is live. One board recorded as missing held **131
postings**. `find-ats.py` and the Ashby provider now fall back to parsing the board page
the way a browser would before recording absence.

---

## Board sweeps

### A page cap is not a board size

A sweep bounded at 40 pages of 20 reported one employer as holding exactly **800**
postings, which is 40 × 20. The real board held **2,000**, so the sweep had been seeing
**40%** of it. The sweep now returns a truncation flag and prints `TRUNCATED`; the inbox
checker treats a truncated walk as **not read** rather than as a list of closures.

### `total` is only trustworthy on the first page

One Workday tenant answers `total: 436` at offset 0 and `total: 0` at every offset after.
A loop that re-reads `total` stops on page three and reports 40 jobs, which looks like a
small employer rather than a bug. It cost **18 live in-lane roles** before it was found.
`total` is now latched from the first page only, in every walker.

### `\b` does not anchor a Workday requisition id

Workday paths end `..._R26710`. There is no word boundary between `_` and `R`, so a
`\b`-anchored pattern extracts nothing and every row reports itself untracked. That
pattern had been written **four times in four spellings** across the toolchain, and every
divergence was a silent miss. It now has one source (`req-id-core.mjs`), and the one
necessary Python port is asserted character-for-character equal to it.

---

## Liveness

### Provenance decides who may close a row

The resolver had a fallback that guessed a Greenhouse board from a hostname and ran
first. For one company-hosted careers site, the guessed board existed, every one of the
site's ids 404'd inside it, and "the board exists" was accepted as proof the posting was
gone. **Every live posting on that site resolved as closed**, deterministically.

The fix is a rule rather than another exclusion list: **an inferred claim may close a row
only when the board's own listing links back to the host the URL came from.** Measured
across real boards, the separation is total: the impostor board linked back **0 of 2**
times, the genuine boards **155 of 155**, **168 of 168**, **217 of 217** and **273 of 273**.

### An empty board is not an absence

`{"jobs": []}` parses cleanly, so "the posting is not on the board" is trivially true of
an empty list. A wrong board slug returns exactly that. Every reader now treats an empty
board, an unreadable board and a truncated board as **not read**, never as closed.

### Every liveness verdict is tri-state

`live`, `closed` and `unknown`. A timeout, a 429, a WAF page or a response missing the
fields that make it a posting is `unknown`, and `unknown` settles nothing. Before this,
six code paths spelled the rule `live = (status != 404)`, which turned a timeout into
"live" and certified postings nobody had read.

### A redirect's status is evidence about the redirect

A click-tracking URL wrapping a posting was being probed, and the tracker's own 404 closed
the row. Tracking links expire on their own schedule while the posting they point at is
untouched. Wrapper URLs are now refused outright, including ones that carry the
destination without a scheme, in a query parameter, or percent-encoded.

### Result: every inbox row carries a real verdict

Reading boards instead of individual URLs (each board read once, so a 340-row inbox costs
about fifty board reads rather than several hundred page loads) plus a per-row resolver fallback took the **unknown** bucket from
**220 rows to 0**, and the pending inbox from **637 to 432**, with no row closed on
evidence the tool could not stand behind.

---

## Location

### The gate fails in both directions, silently

**Too strict** discards a role the candidate can take: Ashby hides remote options in
`secondaryLocations` and Lever in `categories.allLocations`, and reading only the primary
location discarded **three** reachable roles in one run.

**Too loose** promotes a role the candidate cannot take: `US, GA, Remote` is remote, and it
is not remote from California. Boards spell state-scoped remote at least five different
ways (`US, PA, Remote`, `Pennsylvania, USA - Remote`, `Remote Massachusetts`,
`Indiana - Remote`, `Texas - Dallas Metro - Remote`), and each spelling originally passed
as plain remote-US.

### The posting's own body is a second witness

**6 of 40** verified leads carried a "Remote" chip that their own posting text
contradicted. `scripts/check-remote.py` reads the body and flags the contradiction.

---

## Scoring and integrity

### One formula, one writer

The score lived in four hand-tuned places and was written into the tracker by two
different scripts. A dry run of the second writer showed it would have changed **234
rows** (114 raised, 120 lowered), and both sanctioned integrity gates called the result
clean. There is now one implementation (`score-model.mjs`), one pass that writes
(`apply-model.mjs`), an audit (`score-audit.mjs`) that fails on any disagreement between
a tracker row and its report, and a board verifier that fails any actionable row whose
report carries no machine-readable score.

### A timestamp is not evidence about contents

The board-rebuild hook fingerprinted inputs by `(size, mtime)`. On NTFS, **137 of 200**
back-to-back same-size rewrites produced an identical key, so a score change from `3.7` to
`3.8` left the board stale for good. The hook now hashes content. The test forces the
collision with `os.utime` rather than racing for it, because a race that lands five times
in six is not a guard.

### A case that cannot fail is not a case

Every guard in the fork's additions is **mutation-verified**: the code is deliberately
broken and the matching test must go red. Several first-draft tests stayed green under
mutation. One asserted against two titles that could never fold at any threshold; one
checked a list of known hosts and was blind to exactly the new host it existed for; two
guards masked each other so that removing either left the suite green. Each was rewritten
until it could fail.

### A system test must not read the user's data

Several self-tests passed only because the author's own tracker, inbox and portal list
existed on disk. On a fresh clone they crashed. They now run against fixtures, and a
missing profile is reported as **not checked** rather than failing or passing silently.

---

## Review

One pull request in this fork went through **17 rounds** of adversarial review by an
independent model, with **28 findings** fixed across the first 16 and a clean 17th. Each
fix landed with a test that was mutation-verified before it merged. Most findings shared a single shape: a rule written
down for one branch or one file and not applied to its sibling. That pattern is now
recorded as a failure mode in its own right.
