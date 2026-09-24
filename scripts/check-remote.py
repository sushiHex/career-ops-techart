#!/usr/bin/env python
"""check-remote.py — does a posting's own body agree that it is remote?

The most expensive recurring failure of the 2026-08-24 sweeps was not a missing role, it
was a role that looked reachable and was not. Six of roughly forty verified leads carried a
Remote chip that the posting itself contradicted:

  Ambral        board said "US Remote"     -> employer ATS says On-site, New York or SF
  Socure        board said "US Remote"     -> application form gates on living within 45
                                              miles of SF, NYC or Seattle
  interface.ai  board said "Remote"        -> SF onsite five days a week
  People In AI  board said "US Remote"     -> San Francisco hybrid with relocation support
  Hercules      board said "US Remote"     -> failed the location gate on inspection
  Pragmatike    board said "LA (Remote)"   -> staffing intermediary publishing false chips

Under a hard no-relocation constraint that is the failure that wastes the most time, and
every one of them was detectable from text the resolver already fetches. So: resolve the
req, then read the body for language that contradicts the chip, and say so plainly.

This does not decide whether the candidate should apply. It answers one question, which is whether
the location claim survives contact with the posting.

  python scripts/check-remote.py <url> [<url> ...]
  python scripts/check-remote.py --stdin < urls.txt
  python scripts/check-remote.py <url> --json
  python scripts/check-remote.py --selftest
"""
import argparse, importlib.util, json, os, re, sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

_spec = importlib.util.spec_from_file_location("reqresolve",
                                               os.path.join(HERE, "req-resolve.py"))
_rr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rr)

CLAIMS_REMOTE = re.compile(r"\bremote\b|\bwork from home\b|\bwfh\b|\bfully distributed\b|"
                           r"\banywhere\b|\btelecommut", re.I)

# Each pattern is a way a posting takes the remote claim back. Weight is how decisively.
CONTRADICTIONS = [
    (r"\b(\d+)\+?\s*days?\s*(?:per|a|each)\s*week\s*(?:in|at)\s*(?:the\s*)?office", 5,
     "states a required number of office days per week"),
    (r"\bin[- ]office\s*(\d+)\+?\s*days?", 5, "states a required number of office days"),
    (r"\bdefault\s*together\b", 5, "uses a default-together in-office policy"),
    (r"\bmust (?:reside|live|be located|be based)\b", 5, "requires residence in a named place"),
    (r"\bwithin\s*\d+\s*miles?\b", 5, "gates on distance from an office"),
    (r"\bthis (?:role|position|job) is (?:an?\s*)?(?:in[- ]person|onsite|on[- ]site)\b", 5,
     "states the role is in person"),
    # The declarative form is decisive where a bare mention of "hybrid" is not. A posting
    # that says "this is a hybrid position" has stated its arrangement, and weighting it
    # the same as an incidental mention let a hybrid-plus-headquarters req score 4 and
    # escape as merely unclear.
    (r"\bthis (?:is|role is|position is|job is) (?:an?\s*)?hybrid\b", 5,
     "declares the role hybrid outright"),
    (r"\brelocat(?:e|ion) (?:is\s*)?(?:required|expected)\b", 5, "requires relocation"),
    (r"\bhybrid\b", 3, "describes the role as hybrid"),
    (r"\bon[- ]?site\b", 2, "uses onsite language"),
    (r"\bcommut(?:e|able|ing)\b", 2, "refers to commuting"),
    (r"\bhq\b|\bheadquarters\b", 1, "anchors on a headquarters"),
    (r"\brelocation (?:assistance|support|package)\b", 2, "offers relocation support"),
]
# Language that legitimately co-occurs with genuine remote roles and must not count.
# The last three entries were added after auditing a batch of actionable rows, where the
# tool raised several flags and most were its own fault:
#   #LI-Hybrid / #LI-Remote are LinkedIn TRACKING TAGS. Some boards stamp #LI-Hybrid on
#   postings that are explicitly CA-remote, so reading it as an arrangement made the tool
#   cry wolf on postings that were never actually hybrid.
#   "resolve critical onsite issues" at TRM is CUSTOMER-site incident response, not where
#   the employee sits. Onsite next to issue/customer/client/incident is about the work.
INNOCENT = re.compile(
    r"remote[- ]first|fully remote|remote friendly|distributed team|"
    r"occasional(?:ly)? (?:travel|visit|onsite)|travel (?:to|for) (?:offsites?|team)|"
    r"quarterly (?:onsite|offsite)|team offsites?|as needed for offsites?|"
    r"#\s*LI[- ](?:hybrid|remote|onsite)|"
    r"on[- ]?site\s+(?:issues?|incidents?|support|visits?|deployments?|installations?)|"
    r"(?:customer|client|partner|field)\s+(?:site|onsite)", re.I)


def analyse(loc, jd, remote_flag):
    """(verdict, score, reasons). verdict in consistent / CONTRADICTED / unclear / not-claimed."""
    loc = loc or ""
    jd = jd or ""
    claims = bool(CLAIMS_REMOTE.search(loc)) or bool(remote_flag)
    if not claims:
        return "not-claimed", 0, ["the posting does not claim to be remote"]
    body = INNOCENT.sub(" ", jd)
    hits, score = [], 0
    for pat, w, why in CONTRADICTIONS:
        m = re.search(pat, body, re.I)
        if m:
            score += w
            frag = " ".join(body[max(0, m.start() - 60):m.start() + 90].split())
            hits.append(f"{why} ({w}): ...{frag}...")
    if score >= 5:
        return "CONTRADICTED", score, hits
    if score >= 2:
        return "unclear", score, hits
    return "consistent", score, hits or ["nothing in the body contradicts the remote claim"]


CASES = [
    # (location, jd, remote_flag, expected verdict, why this case exists)
    ("Los Angeles, CA", "We take a default together approach and expect our team members "
     "to work in an office 4+ days per week.", False, "not-claimed",
     "Snap: no remote claim at all, so there is nothing to contradict"),
    ("US Remote", "We take a default together approach and expect our team members to work "
     "in an office 4+ days per week.", True, "CONTRADICTED",
     "a remote chip over a 4-days-in-office policy is the core failure"),
    ("Remote - United States", "We are a fully distributed company. Home office "
     "reimbursements. Choose where you work.", True, "consistent",
     "Panorama: genuinely remote, and 'distributed' must not read as a contradiction"),
    ("US Remote", "Candidates must reside within 45 miles of San Francisco, New York City "
     "or Seattle.", True, "CONTRADICTED",
     "Socure: the residency gate that a board chip hides"),
    ("Remote", "Occasional travel to team offsites, roughly quarterly.", True, "consistent",
     "occasional offsite travel is normal for remote roles and must not trip the check"),
    ("US Remote", "This is a hybrid position based out of our New York headquarters.",
     True, "CONTRADICTED", "explicit hybrid plus an HQ anchor"),
    ("US, CA, Remote", "If you are creative and autonomous, we want to hear from you! "
     "#LI-Hybrid Your base salary will be determined based on your location.", True,
     "consistent",
     "a LinkedIn tracking tag is not an arrangement: this shape has flagged several "
     "genuinely CA-remote reqs on a board audit"),
    ("United States", "TRM Engineers identify and resolve critical onsite issues in "
     "minutes to hours. We create virtual war rooms.", True, "consistent",
     "onsite here is customer-site incident response, not where the employee sits"),
    ("Remote-Friendly (Travel-Required) | San Francisco, CA", "Location-based hybrid "
     "policy: Currently, we expect all staff to be in one of our offices at least 25% of "
     "the time.", True, "unclear",
     "a real hybrid policy on a remote-friendly req MUST still surface"),
    ("Remote (EMEA/East Coast)", "", True, "consistent",
     "a geography outside the candidate's reach does not make the body contradict "
     "remote; that is the location gate's job, not this tool's"),
]


def selftest():
    bad = 0
    for loc, jd, flag, want, why in CASES:
        got, score, _ = analyse(loc, jd, flag)
        if got != want:
            bad += 1
            print(f"FAIL  loc={loc!r}\n      got {got} (score {score}), expected {want}\n      {why}")
    print(f"{bad} of {len(CASES)} remote-contradiction cases failed" if bad
          else f"all {len(CASES)} remote-contradiction cases pass")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urls", nargs="*")
    ap.add_argument("--stdin", action="store_true", help="read URLs from stdin")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true",
                    help="check the contradiction rules without touching the network")
    a = ap.parse_args()
    if a.selftest:
        return 1 if selftest() else 0
    urls = a.urls + ([l.strip() for l in sys.stdin if l.strip()] if a.stdin else [])
    if not urls:
        ap.error("give one or more URLs, --stdin, or --selftest")

    out, bad = [], 0
    for u in urls:
        r = _rr.resolve(u) or {}
        verdict, score, reasons = analyse(r.get("location"), r.get("jd"), r.get("remote_txt"))
        if verdict == "CONTRADICTED":
            bad += 1
        rec = dict(url=u, ats=r.get("ats"), live=r.get("live"), title=r.get("title"),
                   location=r.get("location"), remote_flag=bool(r.get("remote_txt")),
                   verdict=verdict, score=score, reasons=reasons)
        out.append(rec)
        if not a.json:
            mark = {"CONTRADICTED": "!!", "unclear": "??", "consistent": "ok",
                    "not-claimed": "--"}[verdict]
            print(f"\n[{mark}] {str(r.get('title') or '(unresolved)')[:66]}")
            print(f"     ats={r.get('ats')} live={r.get('live')} remote_flag={bool(r.get('remote_txt'))}")
            print(f"     location: {str(r.get('location'))[:96]}")
            print(f"     VERDICT : {verdict} (weight {score})")
            for why in reasons[:4]:
                print(f"       - {why[:150]}")
    if a.json:
        print(json.dumps(out, indent=1))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
