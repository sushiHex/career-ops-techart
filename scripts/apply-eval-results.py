"""apply-eval-results.py: write an eval-packets workflow result back into its packets.

The eval-packets workflow (.claude/workflows/eval-packets.js) returns, per packet, the
evaluator's dimensions and prose and, for the strong ones, an adversarial refuter's
corrected dimensions. Nothing carried that back into batch/eval-queue/, so every run ended
in a hand copy of forty fields, which is where a refuted dimension gets lost and the
evaluator's number ships instead.

    python scripts/apply-eval-results.py <workflow-output.json>            # dry run
    python scripts/apply-eval-results.py <workflow-output.json> --write
    python scripts/apply-eval-results.py --selftest

The input is the task output file the workflow writes ({"result": [...]}) or the bare
result list. Then: node eval-write.mjs <packets> --date=YYYY-MM-DD.

Rules, each one a way the hand copy went wrong:
  * The REFUTER's dimensions win whenever a refutation ran, refuted or not; it returns the
    full set either way, and a refutation must move a dimension, never a bare base.
  * A packet whose judgement is already filled is refused, never overwritten, unless
    --force: a second run must not silently replace a first one a person may have edited.
  * A hard-gate closure is written in the shape eval-write records as an unscored SKIP:
    in_bounds false, the gate, every dimension null. Never zeros.
  * Prose carrying an em-dash is refused (the house style forbids the character), so
    it is recast by a person rather than having the character swapped here.
"""
import html
import json
import os
import sys
import tempfile

DIMS = ("match_w_cv", "north_star", "comp_score", "cultural_signals")
EMDASH = chr(8212)


def load_results(path):
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    return d.get("result", []) if isinstance(d, dict) else d


def filled(p):
    return any(isinstance(p.get(k), (int, float)) for k in DIMS)


def merge(p, item):
    """The packet with this result written in. Returns (packet, problems)."""
    e, r = item.get("eval") or {}, item.get("refute")
    problems = [k for k in ("body", "gate", "recommendation") if EMDASH in str(e.get(k) or "")]
    if problems:
        return p, [f"em-dash in {', '.join(problems)}"]
    q = dict(p)
    for k in ("status", "arrangement", "gate", "recommendation", "body", "comp_total_est"):
        q[k] = e.get(k)
    ov = e.get("location_verdict_override")
    if ov in ("pass", "fail"):
        q["location_verdict"] = ov
    if e.get("gate_closed") or e.get("match_w_cv") is None:
        q.update({k: None for k in DIMS})
        q["red_flags_adj"] = 0
        q["status"] = "SKIP"
        q["in_bounds"] = False
        return q, []
    src = r if r else e
    for k in DIMS + ("red_flags_adj",):
        q[k] = src.get(k)
    if r and r.get("refuted"):
        # The refuter's note arrives HTML-escaped at times ("3.5 -&gt; 3.7", 2026-10-28).
        q["body"] = (q["body"] or "").rstrip() + "\n\n**Adversarial review.** " + html.unescape(str(r.get("moved") or ""))
        if EMDASH in q["body"]:
            return p, ["em-dash in the refuter's note"]
    return q, []


def base_of(q):
    if any(not isinstance(q.get(k), (int, float)) for k in DIMS):
        return None
    return sum(q[k] for k in DIMS) / 4 + (q.get("red_flags_adj") or 0)


def write_packet(path, p):
    """Same shape eval-prep writes: UTF-8, one-space indent."""
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(p, fh, indent=1, ensure_ascii=False)


def run(results, root, write, force):
    bad = 0
    for item in results:
        f = item.get("file") or ""
        path = os.path.join(root, f)
        if not os.path.exists(path):
            print(f"MISSING  {f}")
            bad += 1
            continue
        with open(path, encoding="utf-8") as fh:
            p = json.load(fh)
        if filled(p) and not force:
            print(f"FILLED   {f}  (judgement already set; --force to replace)")
            continue
        q, problems = merge(p, item)
        if problems:
            print(f"REFUSED  {f}  ({'; '.join(problems)})")
            bad += 1
            continue
        b = base_of(q)
        moved = " refuted" if (item.get("refute") or {}).get("refuted") else ""
        dims = " ".join(f"{q[k]}" for k in DIMS) if b is not None else "gate-closed"
        print(f"{'WROTE' if write else 'WOULD'}    {os.path.basename(f)[:60]:60} {dims:22} "
              f"base {b if b is None else round(b, 3)}{moved}")
        if write:
            write_packet(path, q)
    return bad


def selftest():
    fails = []

    def check(c, m):
        if not c:
            fails.append(m)
    p = {"title": "X", "match_w_cv": None, "north_star": None, "comp_score": None,
         "cultural_signals": None, "red_flags_adj": 0}
    e = {"gate_closed": False, "location_verdict_override": "pass", "status": "Evaluated",
         "match_w_cv": 4.0, "north_star": 4.0, "comp_score": 4.0, "cultural_signals": 4.0,
         "red_flags_adj": 0, "arrangement": "remote", "comp_total_est": None,
         "gate": "g", "recommendation": "r", "body": "b"}
    r = {"refuted": True, "match_w_cv": 3.0, "north_star": 4.0, "comp_score": 4.0,
         "cultural_signals": 4.0, "red_flags_adj": -0.1, "moved": "match down"}
    q, pr = merge(p, {"eval": e, "refute": r})
    check(not pr and q["match_w_cv"] == 3.0 and q["red_flags_adj"] == -0.1,
          "the refuter's dimensions must win")
    check("Adversarial review" in q["body"], "a refutation is recorded in the body")
    check(q["location_verdict"] == "pass", "a location override is written")
    q, _ = merge(p, {"eval": e, "refute": None})
    check(q["match_w_cv"] == 4.0, "with no refutation the evaluator's dimensions stand")
    q, _ = merge(p, {"eval": dict(e, gate_closed=True), "refute": None})
    check(q["in_bounds"] is False and q["status"] == "SKIP" and q["match_w_cv"] is None,
          "a gate closure is unscored, never zeros")
    _, pr = merge(p, {"eval": dict(e, body="a " + EMDASH + " b"), "refute": None})
    check(bool(pr), "an em-dash is refused, not swapped")
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "q"))
        write_packet(os.path.join(d, "q", "a.json"), dict(p, match_w_cv=3.3))
        run([{"file": "q/a.json", "eval": e, "refute": None}], d, True, False)
        with open(os.path.join(d, "q", "a.json"), encoding="utf-8") as fh:
            check(json.load(fh)["match_w_cv"] == 3.3, "a filled packet is never overwritten without --force")
    for m in fails:
        print("FAIL", m)
    print(f"apply-eval-results selftest: {len(fails)} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if "--selftest" in a:
        sys.exit(selftest())
    files = [x for x in a if not x.startswith("--")]
    unknown = [x for x in a if x.startswith("--") and x not in ("--write", "--force")]
    if len(files) != 1 or unknown:
        print(__doc__.strip().split("\n\n")[1])
        sys.exit(2)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.exit(1 if run(load_results(files[0]), root, "--write" in a, "--force" in a) else 0)
