# career-ops-techart: agent instructions

This is the cross-tool entry point for Claude Code, Codex, OpenCode, Gemini and Qwen.
**`CLAUDE.md` holds the full engineering conventions**; this file is the short version,
and where the two disagree, `CLAUDE.md` wins.

## First Run

On a fresh clone, ask the one deterministic source what is missing instead of
hand-checking files:

```bash
npm install
npx playwright install chromium     # PDF generation and liveness checks
node doctor.mjs --json              # {"onboardingNeeded": bool, "missing": [...]}
```

Do not restate the prerequisite list anywhere else. It drifts.

## Onboarding

If `doctor.mjs` reports `onboardingNeeded`, configure the install with **`setup.mjs`**, the
first-install harness. It writes every User Layer file the tools read, from presets. It
never overwrites a file that already exists unless told to with `--force`; it writes only
what is missing, so re-running it finishes a partial install.

**The user can run it themselves**, interactively: `node setup.mjs`.

**Or you can drive it for them.** Ask the questions conversationally, write the answers to
a JSON file in a scratch location (never the repo root), and run it unattended:

```bash
node setup.mjs --example-answers > /tmp/answers.json   # the shape to fill in
node setup.mjs --list-presets                          # lane and location presets
node setup.mjs --answers /tmp/answers.json --dry-run   # show the plan first
node setup.mjs --answers /tmp/answers.json             # write it
```

What to ask, in order:

1. **Identity:** full name, email, LinkedIn and portfolio, past employers.
2. **Target roles**, and a **lane preset**: `techart-ai-tooling` (senior technical art plus
   AI tooling, the tuning this fork was built with) or `general`. Either way, ask for title
   keywords they want and keywords to avoid; setup layers those onto the preset.
3. **Location:** a preset, or `custom` with a two-letter home state, the cities within
   their commute (err long: a missing city is a silent discard), metros in their state that
   are too far, and whether an onsite role elsewhere should fail (no relocation) or be asked
   about. `california-socal` is the worked example.
4. **Compensation floor**, total comp. It gates scoring, so it must be the user's real
   walk-away number. Leave it out and there is no comp gate at all.
5. **Companies they most want**, which become `company_preference`.
6. **A CV:** point `cv_path` at an existing markdown CV, or build `cv.md` with them
   afterwards. Every tailored PDF is generated from it.

Then have them replace the starter companies in `portals.yml` with their own
(`python scripts/find-ats.py "Company"` finds a company's real board), review
`modes/_profile.md`, and confirm with `node doctor.mjs`.

## Update Check

**This fork does not use the upstream updater, and there is no `update-system.mjs` here.**
The original project's updater applies ITS System Layer over yours, which would overwrite
the scoring model, resolver, location gate and ranker that make this fork what it is.
Update with `git pull`. Personal files are gitignored, so a pull never touches them.

## Data Contract

**User Layer**, never overwritten, all personalisation lives here: `cv.md`,
`config/profile.yml`, `config/location.json`, `config/lane-vocab.json`,
`modes/_profile.md`, `article-digest.md`, `portals.yml`, `data/*`, `reports/*`,
`output/*`, `interview-prep/*`, `research/*`.

**System Layer:** `modes/` except `_profile.md`, `CLAUDE.md`, `AGENTS.md`, `*.mjs`,
`scripts/*.py`, `templates/*`, `presets/*`, `batch/*`, `test-fixtures/*`.

Candidate-specific facts (comp targets, location policy, lanes, narrative) go in the User
Layer, never in a System Layer file. The test suite enforces part of this structurally:
`score-model.mjs` may read a comp floor and may never hard-code one.

## Ethical Use

- **Never submit an application.** Draft, fill, generate, then stop for the user's review.
- **Discourage low-fit applications.** Below 4.0 the default is a recommendation against.
- **Never fabricate** a URL, requisition id, company, or metric. Reports are written from
  resolver output, not from recall.

## Offer Verification

Confirm a posting is live with Playwright (`browser_navigate`, then `browser_snapshot`),
not WebSearch or WebFetch. In headless batch mode, fall back to WebFetch and mark the
report `**Verification:** unconfirmed (batch mode)`.

For Workday requisitions, never hand-build a detail URL from a job title. A wrong slug
returns **403, not 404**, and reads as a false closure. Use `scripts/req-resolve.py`.

## Headless / Batch Mode

`batch/batch-runner.sh` starts one headless `claude -p` worker per posting and is Claude
Code-specific. To run a single headless evaluation from another CLI, the equivalent
command is:

| CLI | Command |
|-----|---------|
| Claude Code | `claude -p "prompt"` |
| OpenCode | `opencode run "prompt"` |
| Codex | `codex exec "prompt"` |
| Qwen | `qwen -p "prompt"` |
| Copilot CLI | `copilot -p "prompt"` |
| Antigravity CLI | `agy -p "prompt"` |

## TSV Format

Nine tab-separated columns, written to `batch/tracker-additions/` and merged by
`merge-tracker.mjs`. Never hand-add a row to `data/applications.md`.

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf}\t[{num}](reports/{file})\t{note}
```

Status precedes score here and follows it in the tracker; the merge swaps them. Strip `|`
from every field. The report link is written root-relative and rewritten on merge.

## Canonical States

`Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`,
`SKIP`. Source of truth is `templates/states.yml`. No bold, no dates, no extra text in
the status column.
