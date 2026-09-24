#!/usr/bin/env python
"""nvidia-sweep.py — enumerate every live NVIDIA req in the candidate's lanes and keep the
ones the configured home state can reach.

Why this exists as its own tool rather than a scan adapter.

NVIDIA is the highest-yield employer on this board by a wide margin, and it is the one
where the location gate is invisible from outside. Their Workday board renders a bare
"N Locations" for roughly forty percent of postings, so neither the portal scan nor a
human reading the careers page can tell whether a req is Santa Clara onsite or carries a
per-req remote entry that makes it workable from the candidate's configured home state.
The only way to know is to resolve each requisition's detail record.

The gap is not theoretical. A full agentic sweep once recorded a requisition titled
"Agent Architecture and Evaluation" as Santa Clara only and set it aside; it was in fact
CA-remote. One requisition away sat "Agent SIMULATION and Evaluation", which genuinely
was Santa Clara only. Two reqs, one word apart, opposite verdicts on the gate that
decides everything.

So: search by lane vocabulary, resolve every hit's real location list, keep only what the
configured home state can actually reach, and subtract what is already on the tracker.

  python scripts/nvidia-sweep.py                 # lane keywords, home-remote only, untracked only
  python scripts/nvidia-sweep.py --all           # include tracked and non-remote
  python scripts/nvidia-sweep.py --json          # machine-readable
  python scripts/nvidia-sweep.py --terms eval,agent
  python scripts/nvidia-sweep.py --selftest      # select() against fixture rows, no network
"""
import argparse, importlib.util, json, os, re, sys, time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# nvidia-liveness.py owns the CXS transport, the retry policy and the CA-remote rule.
# Import it rather than restating any of that: a second copy of home_remote_ok would drift,
# and its two spellings ("US, CA, Remote" vs the broader "US, Remote") are exactly the
# kind of detail that gets simplified wrongly on a rewrite.
#
# scripts/ has to go on sys.path first. nvidia-liveness does `from _httpctx import ...`,
# which resolves only because sys.path[0] is the script's own directory when it is run
# directly. Loading it through importlib from anywhere else, a test or another module,
# raises ModuleNotFoundError on _httpctx instead.
if HERE not in sys.path:
    sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("nvliveness",
                                               os.path.join(HERE, "nvidia-liveness.py"))
_nv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_nv)

# Search terms are the lane preset's `_sweep` section (config/lane-vocab.json), falling
# back to the title filter's positives. NVIDIA's titles rarely say "eval"; they say "Agent
# Architecture and Evaluation", so search broad and let the location and tracker filters cut.
def default_terms():
    import _lane as _lane_mod
    return (_lane_mod.section("_sweep").get("terms")
            or _lane_mod.section("_title_filter").get("positive") or [])
JR = re.compile(r"(JR\d{6,})", re.I)

from _lane import lane_score, LANE_UP, LANE_DOWN, BODY_UP, BODY_DOWN


def search(term, limit=20, pages=3):
    """Every jobPosting the CXS search returns for `term`, across `pages` pages."""
    out = []
    for page in range(pages):
        ok, _st, body = _nv._req(
            _nv.BASE + "/jobs",
            data={"appliedFacets": {}, "limit": limit, "offset": page * limit,
                  "searchText": term})
        if not ok or not body:
            break
        posts = body.get("jobPostings", []) or []
        out += posts
        if len(posts) < limit:
            break
        time.sleep(0.35)          # the search endpoint rate-limits; pace it
    return out


def tracked_jrs():
    """Every JR id already on the tracker or in a report filename."""
    seen = set()
    p = os.path.join(ROOT, "data", "applications.md")
    if os.path.exists(p):
        seen |= {m.upper() for m in JR.findall(open(p, encoding="utf-8", errors="replace").read())}
    rd = os.path.join(ROOT, "reports")
    if os.path.isdir(rd):
        for f in os.listdir(rd):
            seen |= {m.upper() for m in JR.findall(f)}
    return seen


def select(rows, floor, show_all=False):
    """The rows worth printing: live, not ruled out by location, untracked, and at or above
    the lane floor. The floor used to apply only to --from-json, so on a live sweep an
    avoided title printed as workable whatever --min-lane said."""
    for r in rows:
        r["lane"] = lane_score(r.get("title"), r.get("body", ""))
    if show_all:
        return list(rows)
    return [r for r in rows if r.get("live") and r.get("home_remote") is not False
            and not r.get("tracked") and r["lane"] >= floor]


def _selftest():
    """select() against fixture rows, no network. main() calls select() directly (line
    ~190), so this exercises the same function the live path runs, rather than a second
    inline filter that could drift from it unseen.

    A prior test only ever ran two live, home-remote, untracked rows through select(),
    so main()'s own predicates (live, home_remote, tracked) and the floor comparison could
    each be deleted without turning anything red: the live sweep silently stopped applying
    --min-lane and nothing here noticed. Every filter select() applies gets its own row."""
    import _lane as _lane_mod
    bad = 0

    def check(rows, floor, want_reqs, why, show_all=False):
        nonlocal bad
        kept = {r["req"] for r in select([dict(r) for r in rows], floor, show_all=show_all)}
        if kept != set(want_reqs):
            bad += 1
            print(f"  FAIL {why}: kept {sorted(kept)}, want {sorted(want_reqs)}")

    # The fallback vocabulary (general.json) scores every title and body 0, which is what
    # makes floor 0 and floor 1 an exact boundary test: the same row must survive `>= 0`
    # and be dropped by `>= 1`, pinning that select() uses >= and not > (round-4 N26: a `>
    # floor` mutation drops a row exactly at the floor and nothing here saw it).
    base = dict(req="R1", live=True, home_remote=True, tracked=False, title="", body="")
    check([base], 0, ["R1"], "a live, home-remote, untracked row at exactly the floor is kept")
    check([base], 1, [], "the same row one point under a raised floor is dropped")
    check([dict(base, live=False)], 0, [], "a dead req is dropped even at floor 0")
    check([dict(base, home_remote=False)], 0, [],
          "a req the home state cannot reach is dropped")
    check([dict(base, home_remote=None)], 0, ["R1"],
          "an undetermined home-remote answer is a question, not a no, so it is kept")
    check([dict(base, tracked=True)], 0, [], "an already-tracked req is dropped")
    check([dict(base, live=False, home_remote=False, tracked=True)], 0, ["R1"],
          "--all (show_all) bypasses every filter above", show_all=True)

    # The body rescue needs a vocabulary that has an opinion about the body at all, which
    # the fallback deliberately does not, so this one case reconfigures to the real preset
    # and puts it back before returning.
    real_vocab = os.path.join(os.path.dirname(HERE), "presets", "lanes",
                              "techart-ai-tooling.json")
    _lane_mod.configure(_lane_mod.load_vocab(real_vocab))
    try:
        rescued = dict(req="R2", live=True, home_remote=True, tracked=False,
                       title="Senior Software Engineer",
                       body="Own the agentic evaluation harness for LLM tool-use work.")
        check([rescued], 2, ["R2"],
              "a title scoring 0 is rescued by an in-lane body (CLAUDE.md's body-rescue rule)")
    finally:
        _lane_mod.configure(_lane_mod.load_vocab(_lane_mod.FALLBACK))

    print(f"nvidia-sweep selftest: 7 select() cases, {bad} failure(s)")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true",
                    help="keep tracked reqs and reqs the home state can't reach too")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--terms", help="comma-separated search terms, overriding the lane list")
    ap.add_argument("--pages", type=int, default=3, help="search pages per term (default 3)")
    ap.add_argument("--from-json", metavar="PATH",
                    help="re-rank a saved --json sweep instead of hitting the network")
    ap.add_argument("--min-lane", type=int, default=None,
                    help="drop titles scoring below this on lane fit (default 2; 0 when the "
                         "vocabulary has only penalties; none when it is empty)")
    ap.add_argument("--print-min-lane", action="store_true",
                    help="print the lane floor this run would use, then exit")
    ap.add_argument("--selftest", action="store_true",
                    help="run select() against fixture rows, no network, then exit")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    import _lane as _lane_mod
    a.min_lane = _lane_mod.resolve_min_lane(a.min_lane)
    if a.print_min_lane:
        print("none" if a.min_lane is None else a.min_lane)
        return 0
    floor = a.min_lane if a.min_lane is not None else -10**9

    if a.from_json:
        saved = json.load(open(a.from_json, encoding="utf-8"))
        rows = saved.get("rows", [])
        for r in rows:
            r["lane"] = lane_score(r.get("title"), r.get("body", ""))
        keep = sorted([r for r in rows if r["lane"] >= floor],
                      key=lambda r: (-r["lane"], r["req"]))
        if a.json:
            print(json.dumps({"kept": len(keep), "rows": keep}, indent=1))
            return 0
        print(f"{len(rows)} swept rows -> {len(keep)} at lane >= "
              f"{a.min_lane if a.min_lane is not None else 'any'}")
        print("=" * 96)
        for r in keep:
            print(f"\n[lane {r['lane']:+d}]  {r['req']}  {str(r.get('title'))[:66]}")
            print(f"   loc : {r.get('location')}")
            if r.get("additional"):
                print(f"   also: {', '.join(r['additional'])}")
            print(f"   url : {r.get('url')}")
        return 0

    terms = [t.strip() for t in a.terms.split(",")] if a.terms else default_terms()
    if not terms:
        print("nvidia-sweep: no search terms. Pass --terms, or give the lane vocabulary "
              "a _sweep.terms list or title_filter positives (node setup.mjs).",
              file=sys.stderr)
        return 2
    known = tracked_jrs()

    # id -> (title, externalPath). Search hits overlap heavily across terms.
    found = {}
    for t in terms:
        posts = search(t, pages=a.pages)
        for p in posts:
            ep = p.get("externalPath", "") or ""
            m = JR.search(ep) or JR.search(json.dumps(p))
            if m:
                found.setdefault(m.group(1).upper(), (p.get("title", ""), ep))
        if not a.json:
            print(f"  searched {t!r:26s} -> {len(posts):3d} hits, {len(found)} distinct reqs so far",
                  file=sys.stderr)

    rows = []
    for i, (jr, (title, ep)) in enumerate(sorted(found.items())):
        ok, _st, body = _nv._req(_nv.BASE + ep)
        info = (body or {}).get("jobPostingInfo", {}) if ok else {}
        if not info:
            rows.append(dict(req=jr, title=title, live=None, home_remote=None,
                             location="?", additional=[], note="detail fetch failed"))
            continue
        al = info.get("additionalLocations", []) or []
        rows.append(dict(
            req=jr, title=info.get("title", title), live=bool(info.get("canApply")),
            body=re.sub(r"<[^>]+>", " ", info.get("jobDescription", "") or "")[:4000],
            home_remote=_nv.home_remote_ok([info.get("location", "")] + al),
            location=info.get("location", "?"), additional=al,
            end=info.get("endDate") or "(none)",
            url=f"https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite{ep}",
            tracked=jr in known))
        if not a.json and (i + 1) % 15 == 0:
            print(f"  resolved {i + 1}/{len(found)}", file=sys.stderr)
        time.sleep(0.2)

    keep = select(rows, floor, show_all=a.all)
    keep.sort(key=lambda r: r["req"])

    if a.json:
        print(json.dumps({"searched": len(found), "kept": len(keep), "rows": keep}, indent=1))
        return 0

    print(f"\n{len(found)} distinct reqs across {len(terms)} terms; "
          f"{sum(1 for r in rows if r.get('live'))} live, "
          f"{sum(1 for r in rows if r.get('home_remote'))} remote-eligible from home, "
          f"{sum(1 for r in rows if r.get('tracked'))} already tracked")
    # Workable and "needs a home-state call" are different answers, so they never share a
    # heading: an unknown row printed under WORKABLE reads as a yes.
    home = _nv._location.load().home_display.upper()
    groups = ([("ALL REQS", keep)] if a.all else
              [(f"NEW, LIVE, AND WORKABLE FROM {home}", [r for r in keep if r.get("home_remote")]),
               ("NEW AND LIVE, STATE-SCOPED REMOTE: SET A HOME STATE IN config/location.json TO JUDGE",
                [r for r in keep if r.get("home_remote") is None])])
    for heading, group in groups:
        if not group and heading != groups[0][0]:
            continue
        print("=" * 96)
        print(heading)
        print("=" * 96)
        for r in group:
            flag = "" if not r.get("tracked") else "  [tracked]"
            print(f"\n{r['req']}  {str(r['title'])[:74]}{flag}")
            print(f"   live={r.get('live')}  home_remote={r.get('home_remote')}  end={r.get('end')}")
            print(f"   loc : {r.get('location')}")
            if r.get("additional"):
                print(f"   also: {', '.join(r['additional'])}")
            print(f"   url : {r.get('url')}")
    if not keep:
        # "Nothing new" can mean two different things, and printing the wrong one sends
        # someone to raise --min-lane when every home-remote req is already tracked, or to
        # check the tracker when the real gate is the lane floor. select() has already
        # scored every row (it sets r["lane"] before filtering), so both counts come
        # straight off `rows` rather than being guessed from `keep` being empty.
        live_home = [r for r in rows if r.get("live") and r.get("home_remote") is not False]
        below_floor = sum(1 for r in live_home if not r.get("tracked") and r.get("lane", 0) < floor)
        already_tracked = sum(1 for r in live_home if r.get("tracked"))
        print(f"\n  (nothing new at lane >= {floor}; {below_floor} home-remote req(s) below "
              f"the floor, {already_tracked} already tracked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
