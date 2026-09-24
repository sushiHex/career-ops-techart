#!/usr/bin/env python
"""_lane.py — how well does a req fit the candidate's converting lanes?

Shared by every board sweep, and the one loader of the lane vocabulary for the Python
tools (eval-assist, triage-leads and the board builders read their sections through it).
It takes a title and a body and returns a number, so every Workday tenant in portals.yml
ranks on the same scale and a fix to the scorer reaches all of them at once.

WHAT counts as in-lane is DATA, not code: config/lane-vocab.json, written by
`node setup.mjs` from a preset in presets/lanes/. With no config it falls back to
presets/lanes/general.json, which has no opinion and scores everything 0. This module
supplies the mechanism; the preset supplies the preference.

The one rule worth restating up front: SCORE THE BODY, NOT JUST THE TITLE. Both directions
of that mistake have already cost real roles. See lane_score for the two worked examples.

Three spelling traps the techart-ai-tooling preset's patterns are written around, all
found against a 593-req backlog and all silent zeros rather than small errors: `agent(ic)?`
does not match "Agents", `tool(ing|chain)?` does not match "Tools", and `\\bUSD\\b` does not
match "OpenUSD" because there is no boundary inside the word. The selftest asserts each as
an equality, so a preset edit that reintroduces one goes red.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# USER LAYER: every entry in it is a statement about one candidate's preferences, which
# the data contract keeps out of System Layer files. It sits in config/ beside profile.yml.
# Where configuration lives. CAREER_OPS_CONFIG_DIR overrides it, which is how the test
# suite runs against no configuration at all regardless of whose files are installed.
CONFIG_DIR = os.environ.get("CAREER_OPS_CONFIG_DIR") or os.path.join(ROOT, "config")
VOCAB_PATH = os.path.join(CONFIG_DIR, "lane-vocab.json")
PRESETS = os.path.join(ROOT, "presets", "lanes")
FALLBACK = os.path.join(PRESETS, "general.json")


def load_vocab(path=None):
    """The configured vocabulary, or the neutral preset when none is configured."""
    p = path or (VOCAB_PATH if os.path.exists(VOCAB_PATH) else FALLBACK)
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def configure(vocab):
    """Build this module's tables from a vocabulary. Called once at import with the
    configured one; the selftest calls it again with the preset it asserts against."""
    global VOCAB, FAMILIES, SHARED_WEIGHTS, LANE_UP, LANE_DOWN, BODY_UP, BODY_DOWN
    VOCAB = vocab
    FAMILIES = [f for f in vocab if not f.startswith("_")]
    lane = vocab.get("_lane") or {}
    LANE_UP = [(p, w) for p, w in lane.get("title_up", [])]
    LANE_DOWN = [(p, w) for p, w in lane.get("title_down", [])]
    BODY_UP = [(p, w) for p, w in lane.get("body_up", [])]
    BODY_DOWN = [(p, w) for p, w in lane.get("body_down", [])]
    # The shared anti-lane families, read by the Node ranker too. Both the VOCABULARY and
    # its weights live in the file: the phrases say what the candidate does not want and
    # the numbers say how much. They differ per consumer (-8 here, -12 in the ranker)
    # because a penalty has to be sized against the bonus it answers.
    SHARED_WEIGHTS = {f: vocab[f]["weight"]["lane"] for f in FAMILIES
                      if "lane" in vocab[f].get("weight", {})}
    LANE_DOWN += [(p, w) for fam, w in SHARED_WEIGHTS.items() for p in vocab[fam]["patterns"]]


def has_positive():
    """Can this vocabulary score anything ABOVE zero? A lane floor only means
    something when it can; with none, every title scores 0 and any positive floor
    silently empties a sweep."""
    return bool(LANE_UP or BODY_UP)


def default_min_lane():
    """The sweeps' default lane floor: 2 with positive vocabulary; 0 with penalties only,
    which drops exactly the titles the vocabulary says to avoid and nothing else, since
    every other title scores 0; none for a vocabulary that can score nothing at all."""
    if has_positive():
        return 2
    return 0 if (LANE_DOWN or BODY_DOWN) else None


def resolve_min_lane(value):
    """A sweep's --min-lane: the value given, else default_min_lane(). Both sweeps call
    this, and --print-min-lane reports it, so the default is tested where it is used."""
    return default_min_lane() if value is None else value


def section(name):
    """One consumer's section of the vocabulary (`_assist`, `_triage`, `_board`...)."""
    return VOCAB.get(name) or {}


def board_lane(role):
    """(lane name, suggested CV) for a title, from the `_board` section: the FIRST lane
    whose words appear in ' <lowercased title> ', else the fallback."""
    board = section("_board")
    r = " " + str(role or "").lower() + " "
    for ln in board.get("lanes", []):
        # `words` are substrings of ' <title> ' (a preset pads short ones itself, ' ai ');
        # `patterns` are word-bounded regexes, which is what setup writes for your keywords.
        if (any(w in r for w in ln.get("words", []))
                or any(re.search(p, str(role or ""), re.I) for p in ln.get("patterns", []))):
            return ln["name"], ln.get("cv", "")
    fb = board.get("fallback") or {}
    return fb.get("name", "Other"), fb.get("cv", "")


# A selftest never reads the user's vocabulary, not even at import: a malformed config
# must not be able to break the suite that checks the rules.
import sys as _sys  # noqa: E402
configure(load_vocab(FALLBACK if "--selftest" in _sys.argv else None))

def lane_score(title, body=""):
    """Fit of a req to the candidate's converting lanes. Higher is better; negative is out.

    Scores the BODY as well as the title, and that is not a refinement, it is the whole
    point. Title-only ranking discarded an NVIDIA req at zero: "AI Automation Engineer,
    Security" scores one point for automation and one for security and says nothing about
    agents. Its body opens with "autonomous AI tools" inside "an AI-native, agent-enabled
    security organization built from the ground up", squarely in lane. The same sweep ranked a telemetry req top on the word
    "Agent" in its title, where the body revealed telemetry daemons for GPU fleet health.
    Titles mislead in both directions; the body is where the lane actually lives.

    Body matches are capped so a long JD cannot out-shout a decisively wrong title.
    """
    t = str(title or "")
    s = (sum(w for p, w in LANE_UP if re.search(p, t, re.I))
         + sum(w for p, w in LANE_DOWN if re.search(p, t, re.I)))
    if body:
        b = str(body)
        s += min(8, sum(w for p, w in BODY_UP if re.search(p, b, re.I)))
        s += sum(w for p, w in BODY_DOWN if re.search(p, b, re.I))
    return s


# ---------------------------------------------------------------- selftest

# Bodies below are SYNTHETIC, built to carry the signals the real JDs carried. Their exact
# numbers are not the real reqs' numbers and must not be read as such: the real telemetry req
# scored -28, this stand-in scores lower because it packs more anti-lane phrasing into
# fewer words. What is asserted here is the PROPERTY that matters, which is the ordering,
# plus fixed values so a regression in the tables shows up as a diff.
_AGENTIC_SECURITY = ("autonomous AI tools inside an AI-native, agent-enabled security "
                     "organization built from the ground up, partnering with domain "
                     "experts who help shape evals")
_TELEMETRY_DAEMON = ("agent-side systems that collect GPU health, host telemetry, "
                     "inventory and attestation evidence across the DGX Cloud fleet; a "
                     "daemon on every node, cloud-scale node health")
_REAL_AGENT_WORK = ("design agent architecture and the evaluation harness, MCP tooling "
                    "and orchestration for internal tools built from the ground up")

_CASES = [
    # (title, body, expected) — title-only scores first
    ("AI Automation Engineer, Security", "", 0),
    ("Fleet Intelligence Agent Systems Engineer", "", 4),
    ("Agent Architecture and Evaluation", "", 8),
    # the body is what actually separates them
    ("AI Automation Engineer, Security", _AGENTIC_SECURITY, 8),
    ("Fleet Intelligence Agent Systems Engineer", _TELEMETRY_DAEMON, -33),
    ("Agent Architecture and Evaluation", _REAL_AGENT_WORK, 16),
    # a decisively wrong title is not rescued by a long enthusiastic body: the body's
    # positive side is capped at 8 and the title's penalties are not.
    ("Principal ASIC Physical Design Engineer", _REAL_AGENT_WORK, 2),
    # A human support agent must never outrank real AI work on the word "Agent" alone.
    ("Trust & Safety Agent", "", -3),
    ("Fraud Agent", "", -4),
    # -4 not -3: "Trust & Safety" collects the +1 from the `safety` term in LANE_UP and
    # "Trust & Risk" does not. Same shape of role, one point apart for an unrelated reason.
    ("Trust & Risk Agent", "", -4),
    ("Warehouse Agent - FTC", "", -4),
    ("Customer Experience Agent", "", -4),
    # -20: customer-experience (-8), the agent-new-grad form (-8) and the standalone
    # new-grad term (-8), against the +4 for the word "Agent". Stacked deliberately; a
    # consumer-support new-grad req is as far from the lane as a title gets.
    ("Customer Experience Agent, 2026 New Grad", "", -20),
    ("AI Tooling Engineer", "", 2),
    ("Recruiter, Technical", "", -6),
    # Defense Test & Evaluation shares one word with the eval specialty and nothing else.
    # Seven Anduril T&E reqs topped a candidate list on that word alone.
    ("Senior Test & Evaluation Engineer, Titan", "", -4),
    ("Test and Evaluation Engineer, Air Defense", "", -4),
    # De-prioritised titles must not outrank the IC engineering roles the profile targets.
    # -10, not the -3 this scored until 2026-09-20. "Forward deployed" was penalised by the
    # Node ranker and not here, and sharing the customer-facing vocabulary settled the
    # disagreement in the direction the profile's stated preference points: customer-facing and
    # forward-deployed titles are de-prioritised, an IC AI/ML engineer title is the goal.
    # Two families now fire, product/programme management and customer-facing, against the
    # +4 for Agent.
    ("Forward Deployed Product Manager, AI Agent", "", -10),
    ("Solutions Engineer, AI Agent", "", -3),
    # The singular spelling NVIDIA actually uses, which the Node copy of this family
    # missed entirely while this file had it right.
    ("Deep Learning Solution Architect - Agentic Performance", "", -3),
    # Programme management, which this file had and the Node copy did not. -3 rather than
    # -7 because the plural "Agents" now earns the lane bonus; before that fix this title
    # scored nothing at all for the word the lane is built on.
    ("Technical Program Manager - Local AI Agents", "", -3),
    # The families neither scorer had before the 593-req backlog was triaged.
    ("Principal Cyber Security Engineer - Agentic Identity and Security", "", -10),
    ("Agentic Operations Consultant", "", -3),
    ("Agent Standards Specialist, Global Affairs", "", -3),
    # ...and the counter-checks. AI safety is a wanted lane, and standards work on
    # OpenUSD is the profile's own specialty, so neither may be caught by the families above.
    # GPU kernel work wearing agentic vocabulary. This file has penalised the family since
    # it was written and had no case for it, which a mutation of the shared pattern found:
    # the Node suite went red and this one stayed green.
    ("Senior System Software Engineer, Agentic Kernel Development", "", 0),
    ("Research Engineer, AI Safety Evaluations", "", 5),
    ("Senior Engineer, OpenUSD Standards and Tooling", "", 5),
    # -12: the internship term (-8) and the Ph.D. credential bar (-6) against the +2 that
    # "Graphics" earns. Both anti-terms had a boundary bug: "interns?" does not match
    # "Internships", and \bPhD\b does not match "Ph.D.", so this scored POSITIVE and led a
    # candidate list.
    ("NVIDIA 2027 Internships: Ph.D. Research Graphics", "", -12),
    # ...while the IC engineering titles keep their score.
    ("Sr. AI Agent Developer (Remote)", "", 4),
    ("Senior Software Engineer, CoPilot Agent Platform", "", 4),
]


def _selftest():
    # The cases are the techart-ai-tooling preset's regression suite. Run them on that
    # preset, never on the user's config/lane-vocab.json, so they test the rules and
    # not whatever happens to be configured.
    configure(load_vocab(os.path.join(PRESETS, "techart-ai-tooling.json")))
    bad = 0
    for title, body, want in _CASES:
        got = lane_score(title, body)
        if got != want:
            bad += 1
            print(f"  FAIL {title[:44]:46s} body={'y' if body else 'n'} "
                  f"want {want:4d} got {got:4d}")

    with open(os.path.abspath(__file__), encoding="utf-8") as _fh:
        _SRC = _fh.read()
    _FAMILIES = FAMILIES

    # The orderings are the point of the scorer, so assert them as orderings too, not just
    # as numbers that happen to differ.
    checks = [
        ("body rescues a flat security title",
         lane_score("AI Automation Engineer, Security", _AGENTIC_SECURITY)
         > lane_score("AI Automation Engineer, Security")),
        ("body sinks an infrastructure req that says 'agent' in its title",
         lane_score("Fleet Intelligence Agent Systems Engineer", _TELEMETRY_DAEMON)
         < lane_score("Fleet Intelligence Agent Systems Engineer")),
        ("a real agent req outranks an infra req that borrowed the word",
         lane_score("Agent Architecture and Evaluation", _REAL_AGENT_WORK)
         > lane_score("Fleet Intelligence Agent Systems Engineer", _TELEMETRY_DAEMON)),
        ("a rescued body still ranks below a genuine agent req",
         lane_score("AI Automation Engineer, Security", _AGENTIC_SECURITY)
         < lane_score("Agent Architecture and Evaluation", _REAL_AGENT_WORK)),
        ("a human support agent ranks below an AI tooling role",
         lane_score("Trust & Safety Agent") < lane_score("AI Tooling Engineer")),
        ("a support agent ranks below an LLM platform role",
         lane_score("Customer Experience Agent") < lane_score("LLM Platform Engineer")),
        # The shared file is the SOURCE. Drift is not prevented by asking two files to
        # agree, which is what the comment here used to do and what failed; it is prevented
        # by there being one copy and a check that every consumer reads all of it. Two
        # things have to hold: this file holds no literal copy of a shared pattern, and it
        # weights every family the file defines, so a family added for the Node ranker
        # cannot silently do nothing here.
        ("no shared pattern is also written out literally in this file",
         not [p for f in _FAMILIES for p in VOCAB[f]["patterns"] if p in _SRC]),
        # The same for this scorer's own lane terms: they are the preset's, and a copy
        # written back here would be a second source that drifts.
        ("no lane term of the preset is written out literally in this file",
         not [p for p, _ in LANE_UP + BODY_UP + BODY_DOWN if len(p) > 8 and p in _SRC]),
        ("every family in the preset is weighted here",
         set(SHARED_WEIGHTS) == set(_FAMILIES)),
        # And the weights are READ, never restated. A number written back into this file
        # puts half the preference in the System Layer again, which is the shape found in
        # review: the phrases had moved out and the calibration had not.
        ("no anti-lane weight is hard-coded in this file",
         all(f'"{f}":' not in _SRC and f"'{f}':" not in _SRC for f in _FAMILIES)),
        # The plural and compound forms that were silent zeros until 2026-09-20, asserted
        # as the properties they are rather than as three more numbers.
        ("the plural 'Agents' earns the lane bonus, as the singular always did",
         lane_score("AI Agents Engineer") == lane_score("AI Agent Engineer")),
        ("'Tools' earns the tooling bonus, as 'Tooling' always did",
         lane_score("AI Tools Engineer") == lane_score("AI Tooling Engineer")),
        ("OpenUSD earns the USD bonus, as the bare spelling always did",
         lane_score("OpenUSD Pipeline Engineer") == lane_score("USD Pipeline Engineer")),
    ]
    # A lane floor only means something when the vocabulary can score above zero. The
    # general preset cannot, and a floor of 2 there silently emptied every sweep.
    configure(load_vocab(FALLBACK))
    checks.append(("with no vocabulary at all there is no default lane floor",
                   not has_positive() and not LANE_DOWN and default_min_lane() is None))
    # Penalties alone (setup's avoid keywords on the general preset) floor at 0, so the
    # avoided titles drop out of a sweep instead of being kept at -6.
    configure(dict(load_vocab(FALLBACK), _lane={"title_down": [[r"\bSales\b", -6]]}))
    checks.append(("penalties alone give a floor of 0 that drops the avoided title",
                   default_min_lane() == 0 and lane_score("Sales Engineer") < 0
                   and lane_score("Platform Engineer") >= 0))
    configure(dict(load_vocab(FALLBACK), _lane={"body_down": [[r"\bquota\b", -3]]}))
    checks.append(("body penalties alone also give a floor of 0", default_min_lane() == 0))
    checks.append(("an explicit --min-lane wins over the default",
                   resolve_min_lane(5) == 5 and resolve_min_lane(None) == 0))
    configure(load_vocab(os.path.join(PRESETS, "techart-ai-tooling.json")))
    checks.append(("with positive vocabulary the default lane floor is 2",
                   has_positive() and default_min_lane() == 2))
    # An explicit 0 must win over the default even here, where the default itself is 2.
    # `value or default_min_lane()` would read a caller's 0 as falsy and silently promote
    # it back to 2, which is exactly the shape that reopened round-3's --min-lane 0 bug;
    # this pins it under the one vocabulary where the wrong answer and the right answer
    # differ.
    checks.append(("an explicit --min-lane 0 is kept even with positive vocabulary",
                   resolve_min_lane(0) == 0))
    for label, ok in checks:
        if not ok:
            bad += 1
            print(f"  FAIL ordering: {label}")

    print(f"_lane selftest: {len(_CASES)} scores + {len(checks)} orderings, "
          f"{bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
