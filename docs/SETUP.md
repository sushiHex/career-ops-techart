# Setup Guide

## Prerequisites

- An AI coding CLI: [Claude Code](https://claude.ai/code) is the primary target; Gemini CLI, Codex, Qwen Code and OpenCode read the same `AGENTS.md`
- [Node.js](https://nodejs.org) 18+ and `git`
- Python 3 (the resolver, liveness and evaluation tools; tested on 3.14)
- (Optional) Go 1.24+ for the dashboard TUI

## Install

```bash
git clone https://github.com/sushiHex/career-ops-techart.git
cd career-ops-techart
npm install
npx playwright install chromium   # PDF rendering and liveness checks
pip install pyyaml                # optional; a minimal built-in parser is used without it
```

Confirm the system half is healthy before adding any data of your own:

```bash
node test-all.mjs --quick
```

It should pass on a fresh clone. The self-tests run against fixtures and never read your
profile, tracker or portal list.

## First run

Run the first-install harness. It asks who you are, what you are looking for and where
you can work, and writes `config/profile.yml`, `config/location.json`,
`config/lane-vocab.json`, `portals.yml` and `modes/_profile.md` from presets:

```bash
node setup.mjs                # interactive
node setup.mjs --list-presets # the lane and location presets
node doctor.mjs               # confirm
```

Or open your AI CLI in the folder: with no configuration it runs setup with you from an
answers file (`node setup.mjs --example-answers` shows the shape), then helps you build
`cv.md`. Setup never overwrites a file you already have unless you pass `--force`, and
then it keeps a `.bak` of each.

Presets to choose from:

- **Lanes:** `techart-ai-tooling` (senior technical art plus AI tooling) or `general`,
  with your own target and avoid keywords layered on either.
- **Location:** `california-socal`, `remote-us`, or `custom` for any US state (home
  state, commute cities, metros too far to commute). See `presets/README.md`.

Leave the comp floor blank and the scoring model applies no comp gate at all.

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-ops scan` |
| Process pending URLs | `/career-ops pipeline` |
| Generate a PDF | `/career-ops pdf` |
| Batch evaluate | `/career-ops batch` |
| Check tracker status | `/career-ops tracker` |
| Fill application form | `/career-ops apply` |

## Verify Setup

```bash
node doctor.mjs              # Prerequisites
node cv-sync-check.mjs       # CV and profile consistency
node verify-pipeline.mjs     # Pipeline integrity
```

## Build Dashboard (Optional)

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..  # Opens TUI pipeline viewer
```
