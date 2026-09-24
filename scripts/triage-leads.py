#!/usr/bin/env python
"""triage-leads.py — turn a pasted LinkedIn job feed into a short list worth checking.

The candidate pastes a LinkedIn "Jobs based on your preferences" feed in bulk. On 2026-08-24 that
was ten batches, roughly 900 listings, and the whole of it was transcribed into TSV by
hand before anything could be decided. That transcription was the bottleneck and it is
also where errors enter, so this parses the raw paste directly.

What it does, in order:
  1. Parse the feed. LinkedIn doubles every job title and appends a duplicated relative
     date, which is what makes the format recognisable without any HTML.
  2. Drop what is already on the tracker.
  3. Drop what a cheap, certain gate settles: de-prioritised title, sub-floor posted comp,
     onsite outside the commute ceiling.
  4. Print what actually needs a live check, so agent time goes only there.

Two failure modes it is deliberately built against, both observed:

  A ONE-WORD TITLE DIFFERENCE IS NOT A DUPLICATE. NVIDIA JR2620896 "Agent Architecture and
  Evaluation" and JR2301525 "Agent Simulation and Evaluation" are different requisitions
  with opposite location verdicts. A token-overlap matcher merged them and would have
  buried the higher-scoring one. Same for "Level 4" against "Level 5" and "Researcher 4"
  against "Researcher 5". So a match requires either subset containment (the tracker row
  carries a parenthetical the lead lacks) or near-identity. A substitution is never a
  match.

  A MISSING CITY IS A SILENT DISCARD. The first commute filter lacked "Manhattan Beach"
  and threw away an in-ceiling AI-plus-technical-artist role without printing anything.
  Under a hard no-relocation constraint the expensive error is discarding something the candidate
  could take, so the city list errs toward inclusion and every gated row is printed with
  its reason rather than dropped quietly.

  python scripts/triage-leads.py feed.txt
  python scripts/triage-leads.py --stdin < feed.txt
  python scripts/triage-leads.py feed.txt --json
  python scripts/triage-leads.py feed.txt --show-gated
"""
import argparse, importlib.util, json, os, re, sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- gates -----------------------------------------------------------------
# Which titles to set aside, and where the candidate can work, are both DATA: the `_triage`
# section of config/lane-vocab.json (see presets/lanes/) and config/location.json (see
# presets/locations/). The patterns that used to sit here are in the techart-ai-tooling
# preset unchanged, and the commute list is presets/locations/california-socal.json.
#
# A MISSING CITY IS STILL A SILENT DISCARD, which is why the California commute list was
# reconciled as the UNION of the four lists that had drifted apart across the tools; this
# one alone had Manhattan Beach and Redondo.
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import _lane, _location  # noqa: E402
TITLE_GATES = [(label, re.compile(p, re.I))
               for label, p in _lane.section("_triage").get("gates", [])]
LOCATION = _location.load()
REMOTE = re.compile(r"\bremote\b|\bwork from home\b|\bdistributed\b", re.I)
ONSITE = re.compile(r"on-?site|hybrid", re.I)
def _profile_floor():
    """The comp floor from config/profile.yml, through eval-prep's reader (the one Python
    implementation of it). None when there is no profile: this cheap gate is then
    skipped rather than applied at somebody else's number."""
    try:
        spec = importlib.util.spec_from_file_location(
            "_evalprep", os.path.join(os.path.dirname(os.path.abspath(__file__)), "eval-prep.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        t = mod.configured_comp_targets()
        return t[0] if t else None
    except Exception:
        return None


FLOOR = _profile_floor()

STOP = {"the", "and", "of", "for", "a", "an", "to", "in", "at", "on", "or",
        "us", "usa", "inc", "llc", "ltd", "corp", "co", "remote", "verified", "job"}


def toklist(s):
    """Significant tokens IN ORDER. Digits are KEPT: they distinguish levels."""
    return [w for w in re.findall(r"[a-z0-9]+", str(s).lower())
            if w not in STOP and (len(w) > 2 or w.isdigit())]


def toks(s):
    return set(toklist(s))


def same_role(a, b):
    """True only when two titles are the same requisition.

    The test is PREFIX containment, not subset containment. Both shapes look like
    "one title's tokens are inside the other's", but only one of them is a real
    duplicate:

      "Staff AI VFX Engineer"  vs  "Staff AI VFX Engineer (Firefly Foundry)"
          the tracker row appends a team or ATS id -> same req, prefix holds

      "Agent Engineer"         vs  "Agent Architecture Engineer"
          a qualifier is inserted mid-title -> different req, prefix fails

    Subset alone accepted both and would keep merging distinct reqs. Anything that is
    neither a prefix nor near-identical is a substitution, which is what separates
    "Agent Architecture and Evaluation" from "Agent Simulation and Evaluation" and
    "Level 4" from "Level 5".
    """
    la, lb = toklist(a), toklist(b)
    if not la or not lb:
        return False
    short, long_ = (la, lb) if len(la) <= len(lb) else (lb, la)
    if long_[:len(short)] == short:
        return True
    sa, sb = set(la), set(lb)
    union = len(sa | sb)
    return bool(union) and (len(sa & sb) / union) >= 0.85


# --- LinkedIn feed parser --------------------------------------------------
POSTED = re.compile(r"^\s*(?:Posted\s+)?(\d+\s+\w+\s+ago|Be an early applicant)", re.I)
COMP = re.compile(r"\$[\d.,]+\s*(?:K|M)?\s*/?\s*(?:yr|hr|year|hour)?"
                  r"(?:\s*-\s*\$[\d.,]+\s*(?:K|M)?\s*/?\s*(?:yr|hr|year|hour)?)?", re.I)
LOCLINE = re.compile(
    r"^(.*(?:United States|Remote|,\s*[A-Z]{2}\b|Metropolitan Area|"
    r"California|New York|Texas|Washington).*)$")
NOISE = re.compile(
    r"^\s*(?:·|•|Easy Apply|Actively reviewing applicants|Be an early applicant|"
    r"Viewed|Saved|Promoted|\d+\s+(?:school alumni|company alumni|connections?)\b.*|"
    r"Medical|Vision|Dental|401\(k\)|[+,\s]*\d*\s*benefits?|How promoted jobs are ranked|"
    r"\d+\+?\s*results?)\s*$", re.I)


def dedupe_doubled(line):
    """LinkedIn renders each title twice, sometimes with a "(Verified job)" between.

    "Senior AI Engineer (Verified job)Senior AI Engineer" -> "Senior AI Engineer"

    Dates double the same way but carry a "Posted " prefix that breaks the symmetry
    ("Posted 1 week ago1 week ago"), so strip the prefix before halving and put it back.
    """
    s = line.strip()
    m = re.match(r"^(Posted\s+)(.*)$", s, re.I)
    if m:
        return (m.group(1) + dedupe_doubled(m.group(2))).strip()
    s = re.sub(r"\s*\(Verified job\)\s*", "|", s)
    if "|" in s:
        head, _, tail = s.partition("|")
        if head.strip() and tail.strip():
            return (head if len(head) >= len(tail) else tail).strip()
    n = len(s)
    for half in range(n // 2, max(n // 2 - 4, 0) - 1, -1):
        if s[:half].strip() and s[:half].strip() == s[half:].strip():
            return s[:half].strip()
    return s


def parse_feed(text):
    """Best-effort parse of a pasted feed into {company, role, location, comp, age}.

    The feed has no delimiters, so the anchor is the doubled relative date that closes
    every card. Walk the lines, buffer, and close a record when that date appears.
    """
    rows, buf = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or NOISE.match(line):
            continue
        if POSTED.match(dedupe_doubled(line)) or POSTED.match(line):
            if buf:
                rows.append(_close(buf, dedupe_doubled(line)))
                buf = []
            continue
        buf.append(line)
    if buf:
        rows.append(_close(buf, ""))
    return [r for r in rows if r and r["company"] and r["role"]]


def _close(buf, age):
    clean = [dedupe_doubled(b) for b in buf]
    clean = [c for c in clean if c and not NOISE.match(c)]
    if len(clean) < 2:
        return None
    role, company = clean[0], clean[1]
    loc, comp = "", ""
    for c in clean[2:]:
        if not loc and LOCLINE.match(c) and not COMP.search(c):
            loc = c
        if not comp and COMP.search(c):
            comp = COMP.search(c).group(0) + (
                "".join(COMP.findall(c)[1:]) if len(COMP.findall(c)) > 1 else "")
            m = re.findall(r"\$[\d.,]+\s*[KM]?", c)
            comp = " - ".join(m[:2]) if m else comp
    return dict(company=company, role=role, location=loc, comp=comp, age=age)


# --- tracker ---------------------------------------------------------------
def load_tracker():
    rows = []
    p = os.path.join(ROOT, "data", "applications.md")
    for line in open(p, encoding="utf-8", errors="replace"):
        if not line.strip().startswith("|"):
            continue
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(c) < 8 or not re.fullmatch(r"\d+", c[0]):
            continue
        si = [i for i, x in enumerate(c) if re.fullmatch(r"[\d.]+/5", x)]
        rows.append(dict(num=c[0], co=c[2], role=c[3],
                         score=(c[si[0]] if si else "?"),
                         status=(c[si[0] + 1] if si and len(c) > si[0] + 1 else "?")))
    return rows


def comp_top(comp):
    """Top of a posted band in dollars per year, or None."""
    if not comp:
        return None
    if re.search(r"/\s*hr|per hour|/hour", comp, re.I):
        n = [float(x.replace(",", "")) for x in re.findall(r"\$([\d.,]+)", comp)]
        return max(n) * 2080 if n else None
    vals = []
    for num, suf in re.findall(r"\$([\d.,]+)\s*([KM]?)", comp, re.I):
        try:
            v = float(num.replace(",", ""))
        except ValueError:
            continue
        vals.append(v * {"k": 1e3, "m": 1e6}.get(suf.lower(), 1 if v > 5000 else 1e3))
    return max(vals) if vals else None


def gate(r):
    why = []
    for label, rx in TITLE_GATES:
        if rx.search(r["role"]):
            why.append(label)
    top = comp_top(r["comp"])
    if top is not None and FLOOR and top < FLOOR:
        why.append(f"sub-floor top {r['comp']}")
    loc = r["location"]
    if ONSITE.search(loc) and not LOCATION.in_commute_area(loc) and not REMOTE.search(loc):
        why.append("onsite outside ceiling")
    elif loc and not REMOTE.search(loc) and not LOCATION.in_commute_area(loc) \
            and re.search(r",\s*[A-Z]{2}\b", loc):
        why.append("out-of-area city")
    return why


ROLE_CASES = [
    # (lead title, tracker title, should_match, why this case exists)
    ("Senior Software Engineer, Agent Architecture and Evaluation",
     "Senior Software Engineer, Agent Simulation and Evaluation", False,
     "JR2620896 vs JR2301525: one word apart, opposite location verdicts. Merging these "
     "hides a live req behind its sibling."),
    ("Staff AI VFX Engineer", "Staff AI VFX Engineer (Firefly Foundry)", True,
     "the tracker row carries a parenthetical the lead lacks; subset containment"),
    ("Machine Learning Engineer, Generative ML, Level 4",
     "Machine Learning Engineer, Generative ML, Level 5", False,
     "level digits distinguish two real reqs at different bands"),
    ("Creative Tech Researcher 5", "Creative Tech Researcher 4", False,
     "same, with a bare trailing level number"),
    ("AI Engineer 6 - AI Foundation & Tooling, Ads Platform",
     "AI Engineer 6 - AI Foundation and Tooling", True,
     "ampersand vs and, plus a trailing org name; still one req"),
    ("Senior AI Solutions Engineer", "Senior AI Solutions Engineer", True, "identical"),
    ("Applied AI Engineer", "Applied AI Engineer (4324894061)", True,
     "tracker rows often append the ATS id"),
    ("Agent Engineer", "Agent Architecture Engineer", False,
     "an inserted qualifier is a substitution, not containment"),
    ("Technical Artist", "Technical Artist (Expression of Interest)", True,
     "evergreen pipeline reqs carry a suffix"),
    ("Staff Machine Learning Engineer", "Senior Machine Learning Engineer", False,
     "seniority words are stripped as generic, so guard that this still separates"),
]


def selftest():
    """Guard the dedup rule that decides whether a real req gets seen at all."""
    bad = 0
    for lead, tracked, want, why in ROLE_CASES:
        got = same_role(lead, tracked)
        if got != want:
            bad += 1
            print(f"FAIL  {lead[:52]!r}\n      vs {tracked[:52]!r}\n"
                  f"      got {got}, expected {want}\n      {why}")
    print(f"{bad} of {len(ROLE_CASES)} role-matching cases failed" if bad
          else f"all {len(ROLE_CASES)} role-matching cases pass")
    return bad + gate_selftest()


# (policy, title, location, comp, expected reasons as label substrings; [] means kept)
GATE_CASES = [
    ("ca", "Senior Technical Artist", "Irvine, CA (Onsite)", "", []),
    ("ca", "Senior Technical Artist", "Glendale, AZ (Onsite)", "", ["onsite outside ceiling"]),
    ("ca", "Senior Technical Artist", "Walnut Creek, CA (Hybrid)", "", ["onsite outside ceiling"]),
    ("ca", "Senior Technical Artist", "Austin, TX", "", ["out-of-area city"]),
    ("ca", "Senior Technical Artist", "Remote, US", "", []),
    ("ca", "Senior Sales Engineer", "Remote, US", "", ["de-prioritised title"]),
    ("ca", "AI Research Scientist", "Remote, US", "", ["research ladder"]),
    ("ca", "Technical Artist", "Remote, US", "$120K - $150K", ["sub-floor top"]),
    ("ca", "Technical Artist", "Remote, US", "$180K - $240K", []),
    ("tx", "Senior Technical Artist", "Round Rock, TX (Onsite)", "", []),
    ("tx", "Senior Technical Artist", "Houston, TX (Onsite)", "", ["onsite outside ceiling"]),
    # A namesake in another state is not the commute area.
    ("tx", "Senior Technical Artist", "Austin, MN (Onsite)", "", ["onsite outside ceiling"]),
]


def gate_selftest():
    """gate() against the techart preset's triage gates and two policies. Its inputs are
    module globals read from configuration, so each case swaps them in and restores them;
    without this nothing exercised gate() at all."""
    global TITLE_GATES, LOCATION, FLOOR
    saved = TITLE_GATES, LOCATION, FLOOR
    vocab = _lane.load_vocab(os.path.join(ROOT, "presets", "lanes", "techart-ai-tooling.json"))
    policies = {
        "ca": _location.preset("california-socal"),
        "tx": _location.Policy({"home_state": {"code": "TX", "name": "Texas"},
                                "commute": {"label": "Austin", "signals": ["Austin", "Round Rock"]},
                                "same_state_out": {"label": "Houston", "signals": ["Houston"]}},
                               "selftest"),
    }
    bad = 0
    try:
        TITLE_GATES = [(label, re.compile(p, re.I))
                       for label, p in vocab["_triage"]["gates"]]
        FLOOR = 160_000
        for pol, role, loc, comp, want in GATE_CASES:
            LOCATION = policies[pol]
            got = gate({"role": role, "location": loc, "comp": comp})
            ok = len(got) == len(want) and all(any(w in g for g in got) for w in want)
            if not ok:
                bad += 1
                print(f"FAIL  gate [{pol}] {role!r} @ {loc!r} {comp!r}: got {got}, want {want}")
    finally:
        TITLE_GATES, LOCATION, FLOOR = saved
    print(f"{bad} of {len(GATE_CASES)} gate cases failed" if bad
          else f"all {len(GATE_CASES)} gate cases pass")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true",
                    help="check the role-matching rule without touching the network")
    ap.add_argument("path", nargs="?", help="file holding the pasted feed")
    ap.add_argument("--stdin", action="store_true", help="read the feed from stdin")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--show-gated", action="store_true",
                    help="also print every gated row with its reason")
    a = ap.parse_args()
    if a.selftest:
        return 1 if selftest() else 0
    if not a.path and not a.stdin:
        ap.error("give a file path, --stdin, or --selftest")
    text = sys.stdin.read() if a.stdin else open(a.path, encoding="utf-8",
                                                 errors="replace").read()

    leads = parse_feed(text)
    tracker = load_tracker()
    covered, gated, check = [], [], []
    for r in leads:
        cn = re.sub(r"[^a-z0-9]", "", r["company"].lower())
        hit = None
        for t in tracker:
            tn = re.sub(r"[^a-z0-9]", "", t["co"].lower())
            if (cn == tn or cn in tn or tn in cn) and same_role(r["role"], t["role"]):
                hit = t
                break
        if hit:
            covered.append((r, hit))
            continue
        why = gate(r)
        (gated if why else check).append((r, "; ".join(why)))

    if a.json:
        print(json.dumps({
            "parsed": len(leads),
            "covered": [{**r, "tracker": t} for r, t in covered],
            "gated": [{**r, "why": w} for r, w in gated],
            "check": [r for r, _ in check]}, indent=1))
        return 0

    print(f"parsed {len(leads)} listings from the feed\n")
    print("=" * 96)
    print(f"ALREADY ON THE TRACKER ({len(covered)})")
    print("=" * 96)
    for r, t in covered:
        print(f"  {r['company'][:22]:24s} {r['role'][:42]:44s} -> #{t['num']:<4} "
              f"{t['score']:>6} {t['status']}")
    if a.show_gated:
        print("\n" + "=" * 96)
        print(f"GATED ({len(gated)})")
        print("=" * 96)
        for r, w in gated:
            print(f"  {r['company'][:22]:24s} {r['role'][:40]:42s} {w}")
    print("\n" + "=" * 96)
    print(f"WORTH A LIVE CHECK ({len(check)})")
    print("=" * 96)
    for r, _ in sorted(check, key=lambda x: (x[0]["comp"] == "", x[0]["company"])):
        print(f"  {r['company'][:24]:26s} {r['role'][:44]:46s} "
              f"{r['location'][:26]:28s} {r['comp'][:15]:16s} {r['age']}")
    print(f"\n{len(leads)} parsed -> {len(covered)} covered, {len(gated)} gated, "
          f"{len(check)} to check"
          + ("" if a.show_gated else "   (--show-gated to see why each was gated)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
