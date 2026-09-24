# Presets

A preset is a starting configuration. `node setup.mjs` copies the ones you choose into
`config/`, where they become yours to edit; nothing reads a preset directly at runtime
except the self-tests, which pin their cases to a preset so they test the rules and not
your configuration.

```bash
node setup.mjs --list-presets
```

With no configuration at all, every tool falls back to `lanes/general.json` and
`locations/remote-us.json`: no field-specific tuning, and a location policy that passes
nationwide remote, asks about state-scoped remote and fails onsite work. Configuration
is read from `config/`, or from the directory named by `CAREER_OPS_CONFIG_DIR`.

## Lane presets (`lanes/`)

What a search is looking for and what it is not. Copied to `config/lane-vocab.json`.

| Preset | For |
|---|---|
| `techart-ai-tooling` | Senior technical art (rigging, pipeline, tools, digital humans) plus AI tooling, agentic and evaluation engineering. The tuning this fork was built and regression-tested with |
| `general` | No tuning at all, not even a seniority exclusion. Setup layers your target and avoid keywords onto it. With no terms at all the sweeps apply no lane floor; with only avoid terms the floor is 0, which drops exactly the avoided titles |

Each file has one section per consumer, each marked with a `_comment` naming it:

| Section | Read by | What it holds |
|---|---|---|
| `_ranker` | `pipeline-audit.mjs --rank` | Title lanes and weights, the de-prioritised and managerial penalties, the out-of-lane list |
| `_lane` | `scripts/_lane.py` (board sweeps) | Title and BODY terms, both directions |
| `_assist` | `scripts/eval-assist.py` | Lane and anti-lane signals, and the stated requirements shown as gates |
| `_triage` | `scripts/triage-leads.py` | Title gates for a pasted lead feed |
| `_role_gate` | `score-model.mjs` | Titles whose company preference is damped to 25% |
| `_board` | the board builders | Lane buckets, filter buttons, and the CV variant each suggests |
| `_sweep` | `scripts/nvidia-sweep.py` | The search terms it sends to the board; falls back to the title filter's positives |
| `_title_filter` | `setup.mjs`, into `portals.yml` | The scanner's first gate |
| every other key | both title scorers | A shared anti-lane FAMILY with one weight per scorer |

A preset can ship a companion `<name>.profile.md`. Setup merges its `##` sections into
`modes/_profile.md`: the archetype table, per-archetype framing, portfolio rules, comp
sources and red-flag questions the evaluation prompts read.

Patterns in shared families are read by JavaScript AND Python, so keep them to syntax both
accept: no named groups, no inline flags, and only fixed-width lookbehind such as
`(?<![A-Za-z0-9])`. Every section is matched case-insensitively.

## Location presets (`locations/`)

Where a candidate can work. Copied to `config/location.json`. Both location gates read
it: `location-core.mjs` for the scanner and `scripts/eval-prep.py` for evaluation, plus
triage, the Workday and NVIDIA sweeps and the dashboard through `scripts/_location.py`.

| Preset | For |
|---|---|
| `california-socal` | Southern California: Orange County and greater Los Angeles, about a 40 mile commute, plus remote-US not scoped to another state. The policy the gates were built and tested against, and the worked example for adding your own |
| `remote-us` | Remote anywhere in the US, no commute area |

`_base-us.json` is the US-wide vocabulary every policy shares (state names and codes,
territories, foreign places) and the `grammar` both gates compile. It is not personal.

### Adding a location

Copy `california-socal.json` and change four things. Setup's `custom` option does exactly
this from your answers.

1. **`home_state`**: the code and name a state-scoped remote offer must match. `US, TX,
   Remote`, `Texas - Remote`, `Remote Texas` and `Texas, USA - Remote` are all parsed.
2. **`commute.signals`**: every place inside your commute, onsite or hybrid. Err long: a
   city missing from this list is a silent discard, the one error that costs a job without
   anyone seeing it. The California list was reconciled from four lists that had drifted
   apart across the tools, and the union was what held.
3. **`same_state_out.signals`**: metros in YOUR state that are outside the commute. For
   California that is the Bay Area. They veto an onsite option and a remote-flagged one,
   and a metro qualifier such as `Texas - Houston Metro - Remote` narrows a state-wide
   remote offer to that metro.
4. **`onsite_outside_commute`**: `fail` if you will not relocate, `unknown` if an onsite
   role elsewhere should come to you as a question instead.

Two optional keys. **`hard_out_metro`** lists metros in OTHER states that are out for
onsite work; both gates read it, and it narrows a metro-scoped remote offer the same way
`same_state_out` does. **`review_metro_companies`** is scanner-only: at a listed employer an
out-of-range metro comes back as a question rather than a rejection, because some
employers post an HQ metro on reqs whose team is distributed. The evaluation gate still
judges the location it is given.

Then check it:

```bash
python scripts/_location.py            # prints the policy it loaded
python scripts/eval-prep.py --selftest # the rules, on the California and Texas fixtures
```

## How a location is read

Written once here and implemented twice, step for step: `location-core.mjs` for the
scanner and `scripts/_location.py` for everything in Python. Every pattern that reads the
meaning of location text is data in `_base-us.json` (`grammar`), compiled by both regex
engines; the tokeniser's own mechanics are written the same way in each; and
`test-all.mjs` runs both over the same pinned table and fails if they disagree or if either
disagrees with the answer written there.

The answer is `pass`, `fail` or `unknown`. A false fail hides a job for good and a false
pass costs one line of triage, so when the text does not settle the question the answer is
`unknown`, never `fail`.

1. **Options.** A posting has one or more options (split at `|`, `;`, `·`, `•`, a new line,
   or given as a list). It passes if any option passes, is `unknown` if any is unknown, and
   fails only when every option fails. An exclusion standing in an option of its own ("US
   Remote; excluding CA, NY") applies to the posting's remote options, and a bare "Remote"
   beside options that are all foreign is `unknown`: it could be that country's.
2. **States become tokens first.** Every state the text names is replaced by a token such as
   `<TX>` before any pattern reads it, so a code can never be mistaken for a word. A name
   counts unless it is part of a city name ("New York City", "Kansas City", "Washington,
   PA"); a code counts only in capitals and in a field position ("Irvine, CA", "US, TX,
   Remote", "Remote - TX", "Remote: CA, OR, WA", "CA/TX"). "LA" and "IN" count only after a
   comma or in a list of codes; "CT" and "MT" are time zones beside a time-zone word or in
   "US (CT)", even for someone who lives in Connecticut or Montana; "CA" and "IN" beside a
   foreign place are Canada and India. DC and New York City have one spelling each after
   folding, and DC is one city, so any DC place is Washington, DC.
3. **Exclusions come out.** A state list after "except", "excluding", "not available in",
   "residents of" and the like, or before "excluded" / "not eligible", names states that are
   OUT: the home state among them fails that remote offer, and the rest are removed before
   anything reads scope. Prose that is not a state list ("travel outside of California") is
   not an exclusion.
4. **A commute place passes.** If one place in the option is in the commute list, the option
   passes, unless a far metro overlaps the match ("Walnut" inside "Walnut Creek"), a foreign
   place stands beside it ("Dublin, Ireland" for a Dublin, Ohio commuter), or that place
   names a state the policy does not reach ("Glendale, AZ"). A commute entry written "City,
   ST" also meets the city alone wherever the place's state is that state ("US, VA,
   Arlington"). In a list of onsite places, "New York" on its own is the city. A place with
   no state takes the state of the next "City, ST" in the same or/and/slash list, never of a
   remote alternative or a bare state name; when that borrowed state is the only thing
   against a commute match, the answer is `unknown`, because "Glendale or Scottsdale, AZ"
   and "Irvine or Austin, TX" have the same shape and only one of them is two Arizona
   cities.
5. **A remote offer is judged by its SCOPE.** Nationwide wording passes ("anywhere in the
   US", and "anywhere in North America", which contains it). An "or"
   alternative that passes on its own carries the option. A state named in a scope position
   ("US, TX, Remote", "TX - Remote", "Remote - Texas", "Remote (TX)", "Remote: CA, OR, WA",
   "must reside in Texas", "Texas - Dallas Metro - Remote") decides it: reachable (home, or a
   state a commute entry names, such as DC for a Virginia commuter) passes, anything else
   fails, and with no home state it is a question. A state named anywhere else is a weak
   mention and can only make the answer `unknown`; one in a preference or travel phrase
   ("Colorado preferred", "travel to Austin, TX", "the California office") is ignored. When
   every state an offer names is reachable it passes, whether that state is a scope or an
   office, unless the place is a far metro, which may mean remote from that metro only. With
   no state at all, a US marker or a bare "Remote" passes, and a remote offer that names
   only foreign places ("Remote - EMEA") fails. "Remote-friendly" and "hybrid remote" are
   not remote offers: both are hybrid policies, read as onsite at the place named. A city
   with its state and a remote word ("Portland, OR (Remote)") is a weak mention, not a
   scope: it may be an office that allows remote work.
6. **Onsite elsewhere.** A foreign place fails; a far metro or a state the policy does not
   reach takes `onsite_outside_commute`; an unlisted city in a reached state, a bare
   country, a placeholder or anything unread is `unknown`.
