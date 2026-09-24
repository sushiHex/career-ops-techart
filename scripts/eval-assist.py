#!/usr/bin/env python
"""eval-assist.py — do the parts of an evaluation that are not judgement.

Four dimensions are scored per req. One of them, comp, is not a judgement at all:
it is a function of the posted band, the floor and the target. Scoring it by hand
produced real inconsistency, the same achievable point was scored 3.6 in
one report and 2.4 in another. A curve fixes that and removes a quarter of the work.

The other three stay human, but the evidence that drives them can be extracted:
hard gates a posting states outright (a required degree, a years-of-experience
threshold, a security clearance) and how much of the body is in the candidate's lane
versus the axes that have historically screened them out.

Nothing here writes a score into a report. It annotates packets so the judgement is
made against evidence instead of against a skim, and flags the packets where the
posting itself has already decided the answer.

Run:
  python scripts/eval-assist.py                 # annotate every queued packet
  python scripts/eval-assist.py --report        # summary, ranked
"""
import glob, importlib.util, json, math, os, re, sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE = os.path.join(ROOT, "batch", "eval-queue")

# The floor and target are candidate facts and live in config/profile.yml. This file
# carried its own FLOOR and TARGET literals, a SECOND copy of the pair eval-prep
# also had, and this copy shapes the comp DIMENSION score that goes into reports. Two
# hardcoded copies of a User Layer number drift independently and neither says so, and
# the floor has already been renormalised once (one figure per track to a single
# shared floor). eval-prep owns the reader; this imports it rather than re-implementing it.
_spec = importlib.util.spec_from_file_location(
    "evalprep", os.path.join(ROOT, "scripts", "eval-prep.py"))
_prep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_prep)


def comp_score(achievable):
    """Map an achievable total-comp figure onto the 0-5 comp dimension.

    Anchored, not invented: the floor scores 2.5 because a role that merely meets
    the minimum is mediocre on this axis rather than failing it, the target scores
    4.0, and everything above rises toward 5 with diminishing returns so a $1M band
    does not swamp the other three dimensions. Below floor it falls off on the same
    1.5 exponent the scoring model already uses for its sub-floor gate, so the
    dimension and the gate agree about how bad sub-floor is.
    """
    targets = _prep.configured_comp_targets()
    if achievable is None or targets is None:
        # No figure, or no floor configured: the evaluator scores comp on evidence.
        return None
    FLOOR, TARGET = targets
    if achievable < FLOOR:
        return round(min(2.5, 2.5 * (achievable / FLOOR) ** 1.5), 1)
    # A single number given as both floor and target has no band to interpolate over;
    # meeting it scores as meeting the target.
    if achievable <= TARGET and TARGET > FLOOR:
        return round(2.5 + 1.5 * (achievable - FLOOR) / (TARGET - FLOOR), 1)
    return round(min(5.0, 4.0 + (1 - math.exp(-(achievable - TARGET) / 250_000))), 1)


# Gates a posting states outright, and the lane and anti-lane signals it is weighted on.
# All three tables are DATA: the `_assist` section of config/lane-vocab.json (see
# presets/lanes/). Gates do not decide the score; they are the requirements most likely to
# screen a candidate out, so they belong in front of the reader. The lane signals are
# counted, not merely detected: see annotate() for why frequency matters.
#
# Two traps the techart-ai-tooling patterns are written around. "Evaluate" is an ordinary
# English verb and every posting uses it, so the eval signal requires the AI sense nearby;
# matching it bare ranked a Salesforce and RevOps integration role top of the queue on the
# strength of "evaluate and rationalize third-party connectors".
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import _lane  # noqa: E402
_ASSIST = _lane.section("_assist")
# A gate is [label, pattern] or [label, pattern, "dispose"]. The flag, never the label,
# is what retires a packet: labels are display text in a user-editable file, and a gate
# renamed from "security clearance" to "clearance" silently stopped disposing.
# The flag travels with its own compiled gate: a set of disposing LABELS let a second,
# non-disposing gate that shared a label retire packets too.
GATES = [(g[0], re.compile(g[1], re.I), len(g) > 2 and g[2] == "dispose")
         for g in _ASSIST.get("gates", [])]
LANE = [(n, re.compile(p, re.I), w) for n, p, w in _ASSIST.get("lane", [])]
ANTI = [(n, re.compile(p, re.I), w) for n, p, w in _ASSIST.get("anti", [])]


def annotate(p):
    # Full body when the packet carries it. Gates appear anywhere in a posting, so
    # scanning only the requirements excerpt under-reports them badly.
    jd = p.get("jd_full") or p.get("requirements_excerpt") or ""
    c = p.get("comp") or {}
    p["suggested_comp_score"] = comp_score(c.get("achievable"))
    hit = [(n, dispose) for n, r, dispose in GATES if r.search(jd)]
    p["detected_gates"] = [n for n, _ in hit]
    # Weight by how OFTEN a signal appears, not merely whether it does. A posting
    # that says "agentic" once in six thousand characters is not an agentic role,
    # and presence-scoring ranked a Salesforce and RevOps integration job top of the
    # queue on exactly three single mentions. One mention is a passing reference and
    # earns a third; two or more is a theme and earns full weight.
    def strength(rx):
        c = len(rx.findall(jd))
        return 0.0 if c == 0 else (1.0 if c >= 2 else 0.35)

    lane = sum(w * strength(r) for _, r, w in LANE)
    anti = sum(w * strength(r) for _, r, w in ANTI)
    p["lane_signals"] = [f"{n}x{len(r.findall(jd))}" for n, r, _ in LANE if r.search(jd)]
    p["anti_signals"] = [f"{n}x{len(r.findall(jd))}" for n, r, _ in ANTI if r.search(jd)]
    p["lane_balance"] = round(lane - anti, 1)
    # A posting that states a disqualifying requirement has decided the answer already.
    disposing = [n for n, dispose in hit if dispose]
    if disposing:
        p["suggested_disposition"] = f"{disposing[0]} stated"
    # A suggested_disposition is NOT a suggestion. __main__ writes every one of them
    # straight into dispositions.json, and --retire deletes the packet, so this line has
    # the same authority eval-prep's hard gate does and it had the same bug: it read
    # `clears_floor is False` and threw away any req whose posted range missed the floor,
    # whatever that range measured. Most postings publish BASE, and the floor is a
    # TOTAL-comp number, so a $170K base carried over the floor by bonus and equity was
    # disposed of permanently. comp_verdict now records `floor_gate`, which is true only
    # when the posting itself calls the sub-floor range total comp. An older packet has no
    # such key, and a missing key means the basis was never established, so it is not a
    # disposal either; `python scripts/eval-prep.py --recomp` refreshes those.
    elif c.get("floor_gate"):
        p["suggested_disposition"] = "below floor on stated total comp"
    else:
        p["suggested_disposition"] = None
    return p


if __name__ == "__main__":
    files = sorted(glob.glob(os.path.join(QUEUE, "*.json")))
    rows = []
    for f in files:
        p = json.load(open(f, encoding="utf-8"))
        if not isinstance(p, dict):
            # Score dumps (batch/eval-queue/_*-scores.json) are lists, not packets.
            continue
        p = annotate(p)
        json.dump(p, open(f, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        rows.append((p, f))

    auto = [r for r in rows if r[0].get("suggested_disposition")]
    rest = [r for r in rows if not r[0].get("suggested_disposition")]
    rest.sort(key=lambda r: (r[0].get("lane_balance", 0),
                             r[0].get("suggested_comp_score") or 0), reverse=True)

    print(f"annotated {len(rows)} packet(s)")
    print(f"  {len(auto)} have a stated gate that already decides them")
    print(f"  {len(rest)} need judgement, ranked by lane balance\n")
    print(f"{'comp':>5} {'lane':>5}  {'gates':<34} title")
    print("-" * 96)
    for p, f in rest[:28]:
        g = ",".join(p["detected_gates"])[:33]
        print(f"{str(p['suggested_comp_score'] or '-'):>5} {p['lane_balance']:>5}  {g:<34} "
              f"{(p.get('title') or '')[:44]}")
    if auto:
        print(f"\nalready decided by a stated gate:")
        for p, f in auto[:12]:
            print(f"   {p['suggested_disposition']:26s} {(p.get('title') or '')[:52]}")
        # Retire them from the inbox and remove the packets, so a decided req does
        # not sit in the judgement queue and does not come back in the next triage.
        out = os.path.join(ROOT, "dispositions.json")
        prev = json.load(open(out, encoding="utf-8")) if os.path.exists(out) else []
        seen = {d["url"] for d in prev}
        for p, f in auto:
            if p["url"] not in seen:
                prev.append({"url": p["url"], "disposition": p["suggested_disposition"]})
        json.dump(prev, open(out, "w", encoding="utf-8"), indent=1)
        if "--retire" in sys.argv:
            for _, f in auto:
                os.remove(f)
            print(f"\nremoved {len(auto)} decided packet(s) from the queue")
        print(f"dispositions.json now holds {len(prev)} entries")
        print("   retire from the inbox with:")
        print("   node pipeline-audit.mjs --prune --dispositions=dispositions.json")
