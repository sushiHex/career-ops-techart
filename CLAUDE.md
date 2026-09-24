# career-ops-techart

A fork of [santifer/career-ops](https://github.com/santifer/career-ops) (MIT), retargeted
for senior technical-art and AI-tooling job searches. This file holds the engineering
conventions for agents working in the repo. **`AGENTS.md` is the cross-tool entry point**
(first run, onboarding, data contract, ethics) and applies here too.

## 1. Updates come from `git pull`, never from the upstream updater

This fork's System Layer (scoring model, evaluation pipeline, resolver, location gate,
ranker, board builders) has no upstream equivalent, and the original project's updater
would overwrite it. There is no `update-system.mjs` in this repo. Do not add one.

## 2. Data contract

**User Layer** (personal, gitignored; `DATA_CONTRACT.md` has the full table): `cv.md`,
`config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`, `data/*`,
`reports/*`, `output/*`, `interview-prep/*`, `research/*`, and the generated
`config/location.json` and `config/lane-vocab.json`. None of these is tracked: `setup.mjs`
writes them from `presets/`, and they are edited in place after that.

**System Layer:** `modes/` except `_profile.md`, `CLAUDE.md`, `AGENTS.md`, `*.mjs`,
`scripts/*.py`, `templates/*`, `batch/*`.

**Never encode a candidate fact in a System Layer file.** Identity, comp and company
preference come from `config/profile.yml`; where the candidate can work comes from
`config/location.json` (loaded by `scripts/_location.py` and `location-core.mjs`); what
counts as in-lane comes from `config/lane-vocab.json` (loaded by `scripts/_lane.py` and
`pipeline-audit.mjs`). All three are written by `setup.mjs` from `presets/`. A tool that
needs a new preference adds a section to the preset and reads it; it never grows a list.

**Self-tests pin themselves to a preset or a fixture**, never to the user's config:
`presets/lanes/techart-ai-tooling.json`, `presets/locations/california-socal.json` and
`test-fixtures/portals.yml`. The California and tech-art cases are regression suites for
the rules, and they must keep running whatever a user configures.

**Every config loader honours `CAREER_OPS_CONFIG_DIR`** (Node and Python alike), and
`test-all.mjs` points it at an empty directory for its whole run. A module that loads
config at import skips it under `--selftest`. Both properties are tested against a
directory of deliberately broken config files, and a new loader must honour both.

## 3. The toolchain

### Scoring: one model, one writer

| Tool | Role |
|---|---|
| `score-model.mjs` | **The only implementation of the rubric.** `final = min(5, base × compFactor × prefFactor × arrFactor)`, `base = avg(match_w_cv, north_star, comp, cultural_signals) + red_flags_adj` |
| `apply-model.mjs` | The only pass that RECOMPUTES tracker scores. No flags is a dry run. `score-audit.mjs --fix` may only restore a report's own stated final |
| `score-audit.mjs` | Tracker row vs report. Joins rows to reports by the markdown **link**, never by row number |
| `verify-board.mjs` | Exits non-zero on any actionable row whose report has no machine-readable score block |
| `score-model-tests.mjs` | `npm run model:test`. Mutation-test any case you add |

Tracker scores are **final**, not base. Never compare one against `base`.

### Evaluation pipeline

`scan.mjs` → `pipeline-audit.mjs --rank` → `scripts/eval-prep.py` → `scripts/eval-assist.py`
→ fill judgement → `eval-write.mjs --date=YYYY-MM-DD` → `merge-tracker.mjs` →
`verify-pipeline.mjs`.

| Tool | Role |
|---|---|
| `scripts/req-resolve.py` | Resolves a posting URL across 13 ATS families to a tri-state live / closed / unknown verdict, with location, pay and JD |
| `scripts/inbox-liveness.py` | Finds dead inbox rows by reading each BOARD once (paged where the ATS pages), then asks the resolver about the residue |
| `scripts/eval-prep.py` | Builds a packet per requisition with the mechanical half done and judgement fields null |
| `scripts/eval-assist.py` | Annotates packets with lane signals, anti-signals and a suggested comp score. Not optional |
| `scripts/eval-blockers.py` | Says what is stopping each packet. `--prune` moves finished ones, never deletes |
| `scripts/workday-sweep.py` | Sweeps any Workday tenant in `portals.yml`, resolving each requisition's detail record |
| `scripts/find-ats.py` | Recovers a company's real ATS board so it can be polled instead of searched |
| `scripts/check-remote.py` | Checks whether a posting's own body agrees it is remote |
| `scripts/triage-leads.py` | Turns a pasted LinkedIn feed into a deduplicated shortlist |
| `scripts/_lane.py` + `pipeline-audit.mjs` | The two title/body scorers. They share `config/lane-vocab.json` |

### Boards

`scripts/build-dashboard.py`, then `scripts/build-all-ranked.py`, then
`scripts/build-home.py` (home scrapes the dashboard, so order matters). A PostToolUse hook
(`scripts/hooks/rebuild_boards_hook.py`, configured in `.claude/settings.json`) rebuilds
them whenever the data they read changes, fingerprinted by content hash.

## 4. Engineering rules

These are the rules the fork's bugs taught. `docs/LESSONS.md` has the measurements.

1. **Liveness is tri-state.** `unknown` settles nothing. A timeout, a 429, a WAF page or a
   body missing the fields that make it a posting is `unknown`, never `live` or `closed`.
2. **Provenance decides who may close a row.** A closure needs evidence the posting
   declared. When both halves of a key were inferred (a board slug guessed from a
   hostname and an id read from a path), the board's own listing must link back to the
   URL's host before its 404 can close anything.
3. **A guess never runs before a lookup.** Recorded configuration (`portals.yml`) is asked
   before any identifier is derived from a hostname.
4. **An empty or small result is a claim.** An empty board, an unreadable board and a
   truncated walk are all *not read*. A page cap is not a board size.
5. **A redirect's status is evidence about the redirect.** Wrapper URLs are refused,
   including scheme-less, query-borne and percent-encoded destinations.
6. **Join by identity, not position.** Rows join reports by link; requisitions dedup by
   requisition id scoped to the company, never by title.
7. **A self-test must not read the user's data.** Suites run on a fresh clone against
   fixtures. A check that needs user data reports *not checked* when it is absent.
8. **A case that cannot fail is not a case.** Mutation-verify every guard: break the code
   deliberately and confirm the test goes red.
9. **A rule written for one branch applies to its siblings.** Most review findings in this
   fork were a correct rule applied in one place and not the next.
10. **A timestamp is not evidence about contents.** Hash the bytes.

## 5. Verification gates

```bash
node test-all.mjs          # integration suite; must be green on a fresh clone
npm run model:test         # scoring model, then mutation-test any new case
npm run verify:board       # 0 non-verifiable actionable rows
node apply-model.mjs       # dry run; a second pass must move 0 rows
node score-audit.mjs       # 0 disagreements
node verify-pipeline.mjs
```

The Python tools listed in `.github/workflows/test.yml` each have `--selftest`; the
board builders and `eval-assist.py` do not, and run for real when invoked.

## 6. Pipeline integrity

1. Never hand-add a tracker row. Write a TSV to `batch/tracker-additions/` and merge.
2. Hand-edit `data/applications.md` only to update a status or note.
3. One report per requisition.
4. Every report needs `**URL:**` in its header and a `## Machine Summary` YAML block.
5. Statuses are canonical, per `templates/states.yml`.
6. A tracker row number is not its report's file number. Follow the link.

## 7. Non-negotiables

- **Never submit an application.** Draft, fill, generate, then stop for review.
- **Below 4.0 the default is a recommendation against.**
- **Verify liveness with Playwright** before treating a posting as open.
- **Never fabricate** a URL, requisition id, company or metric.

## 8. Cold start

Setup state has one deterministic source. Ask it rather than checking files by hand:

```bash
node doctor.mjs --json
```

It returns `{"onboardingNeeded": <bool>, "missing": [...], "warnings": [...]}`. When
onboarding is needed, run `node setup.mjs` with the user, or drive it from an answers file
as `AGENTS.md` describes. Never duplicate the prerequisite list anywhere else; it drifts.

## 9. Environment

Node `.mjs` plus Python 3. Playwright for PDFs and liveness. YAML config, Markdown data.
On Windows, write files with an editor or the file tools rather than shell heredocs.
