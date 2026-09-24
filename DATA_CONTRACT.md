# Data Contract

Every file in this repository belongs to one of two layers. The split decides what may
hold personal facts and what may be replaced by a `git pull`.

## User Layer

Your data, your configuration and your work product. Nothing in the System Layer may
modify these, and everything personal in this list is gitignored, which
`test-all.mjs` asserts path by path.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp floor, past employers, preferred companies |
| `config/location.json` | Where you can work: home state, commute area, metros that are out. Written by `setup.mjs` from `presets/locations/` |
| `config/lane-vocab.json` | What counts as in-lane, for every scorer. Written by `setup.mjs` from `presets/lanes/` |
| `modes/_profile.md` | Your archetypes, narrative and negotiation posture |
| `portals.yml` | Your company list and title filter. Written by `setup.mjs` from `templates/portals.example.yml` |
| `voice-dna.md` | Optional writing-voice guardrail |
| `article-digest.md` | Your proof points |
| `interview-prep/*` | Story bank and per-company prep |
| `data/applications.md` | The application tracker (source of truth) |
| `data/applications.db` | Derived SQLite index over the tracker, safe to delete |
| `data/pipeline.md` | The URL inbox |
| `data/scan-history.tsv` | Scan history |
| `data/follow-ups.md` | Follow-up history, including recruiter contacts |
| `reports/*` | Evaluation reports |
| `output/*` | Generated PDFs and rendered boards |
| `jds/*` | Saved job descriptions |
| `research/*` | Your notes |
| `writing-samples/*` | Samples for style calibration, except its README |

## System Layer

Logic, templates and instructions. These must hold no candidate-specific fact: a name,
a floor, a commute radius or an employer is always read from the User Layer.

| File | Purpose |
|------|---------|
| `modes/*` except `_profile.md` | Prompt for each task (evaluate, compare, scan, apply, ...) |
| `*.mjs` | Node tools: scoring model, scanners, tracker integrity, PDF generation |
| `scripts/*.py` | Python tools: resolver, liveness, eval pipeline, board builders |
| `scripts/hooks/*` | The board-rebuild hook |
| `templates/*` | CV, cover letter, portals and states templates |
| `presets/*` | Lane and location presets `setup.mjs` copies into `config/` |
| `test-fixtures/*` | Fixtures the self-tests read instead of your files |
| `batch/*` | Batch runner and worker prompt |
| `dashboard/*` | Go TUI dashboard |
| `fonts/*` | Self-hosted fonts for PDF output |
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `OPENCODE.md` | Agent instructions |
| `.claude/`, `.opencode/`, `.qwen/`, `.agents/`, `.antigravitycli/` | Skill definitions per CLI |
| `docs/*` | Documentation |
| `DATA_CONTRACT.md` | This file |

## The rule

**A System Layer file never encodes a fact about the candidate.** If a tool needs one,
it reads it from `config/profile.yml` or `modes/_profile.md`, and when that fact is
absent it does less rather than assuming a default. With no `compensation.minimum`, for
example, the scoring model applies no comp gate at all.
