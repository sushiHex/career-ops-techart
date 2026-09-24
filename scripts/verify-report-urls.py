#!/usr/bin/env python
"""verify-report-urls.py — check that every report's URL actually resolves.

verify-pipeline.mjs checks that report LINKS inside the tracker point at files that
exist. Nothing checked that the **URL** inside a report points at a real posting, so
a hand-typed or reconstructed slug could sit in a report indefinitely, sending the candidate
to a dead page for a role that is genuinely live.

That is not hypothetical: two reports were written with constructed Workday slugs
whose req ids did not exist, while the real postings were live under different ids.

A 403 from Workday means a stale slug, not a closed job, so it is reported as
STALE-SLUG rather than a closure. Only a resolver verdict of live=False is a
closure, and closures are informational here: this tool checks reachability, not
whether a role is still open.

Run:
  python scripts/verify-report-urls.py                 # last 40 reports
  python scripts/verify-report-urls.py --all
  python scripts/verify-report-urls.py --from 440
"""
import importlib.util, os, re, sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "rr", os.path.join(ROOT, "scripts", "req-resolve.py"))
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)

REPORTS = os.path.join(ROOT, "reports")
URL_RE = re.compile(r"^\*\*URL:\*\*\s*(\S+)", re.M)


def is_bare_host(url):
    """Is this URL a careers ROOT rather than a posting address?

    The host match stops at `?` and `#` as well as `/`. With `[^/]+` alone it swallowed a
    query too, so a URL whose posting identity is entirely in its query read as a bare
    host and was skipped by a check whose whole purpose is to notice unverifiable rows.
    """
    return not re.sub(r"^https?://[^/?#]+", "", url or "").strip("/")


if "--selftest" in sys.argv:
    CASES = [
        ("https://careers.unity.com/", True),
        ("https://jobs.mayoclinic.org", True),
        ("https://experian.wd2.myworkdayjobs.com", True),
        # Identity entirely in the query. Not a root, and must not be skipped.
        ("https://careers.example.com?job=123", False),
        ("https://www.sentinelone.com/jobs/?gh_jid=7505468003", False),
        ("https://job-boards.greenhouse.io/cresta/jobs/4233080640", False),
        # A fragment is no more a path than a query is.
        ("https://careers.example.com#job-123", False),
    ]
    _bad = 0
    for _u, _want in CASES:
        _got = is_bare_host(_u)
        if _got != _want:
            _bad += 1
            print(f"  FAIL is_bare_host({_u!r}) = {_got}, want {_want}")
    print(f"verify-report-urls selftest: {len(CASES)} bare-host cases, {_bad} failure(s)")
    sys.exit(1 if _bad else 0)

files = sorted(f for f in os.listdir(REPORTS) if f.endswith(".md"))
if "--from" in sys.argv:
    lo = int(sys.argv[sys.argv.index("--from") + 1])
    files = [f for f in files if f[:3].isdigit() and int(f[:3]) >= lo]
elif "--all" not in sys.argv:
    files = files[-40:]

bad, closed, unsupported, rootonly = [], [], [], []
print(f"checking {len(files)} reports\n")
for fn in files:
    txt = open(os.path.join(REPORTS, fn), encoding="utf-8", errors="replace").read()
    m = URL_RE.search(txt)
    if not m:
        print(f"  NO-URL     {fn}")
        bad.append((fn, "no **URL:** header"))
        continue
    url = m.group(1).strip().rstrip(")")
    if not url.startswith("http"):
        continue
    # A bare host with no path is not a posting address, and resolving it is worse than
    # not trying: the answer would be about the careers ROOT, which stays up long after
    # the req is gone, so the check would come back reassuring and mean nothing. Such a
    # report is also unjoinable by requisition identity, which is how AGBO's packet sat
    # in the eval queue indefinitely while its report had existed since June: nothing
    # could match them, and nothing said so. Counted and named, not failed, because the
    # real URL is often no longer recoverable and a permanently red gate gets ignored.
    if is_bare_host(url):
        print(f"  NO-PATH    {fn}  ({url})")
        rootonly.append(fn)
        continue
    r = rr.resolve(url)
    note = r.get("note") or ""
    # A checker that reports its own coverage gaps as defects trains you to ignore
    # it. Three outcomes are NOT report defects and are counted separately:
    #   - unsupported host: this tool cannot check, which says nothing about the URL
    #   - live=False: the posting closed, which is normal for an older report
    #   - stale ATS: the company left that ATS entirely
    if r.get("live") is True:
        continue
    # live=False is read BEFORE ats=="unsupported", which is the order it used to be in
    # the other way round. An adapterless host can now return a real closure, from the
    # posting URL answering 404 or 410 or from a Workday tenant recorded in portals.yml,
    # and counting that as "this tool cannot check" hides the one verdict those rows
    # were finally given.
    if r.get("live") is False:
        closed.append(fn); continue
    if r.get("ats") == "unsupported":
        unsupported.append(fn); continue
    if r.get("stale_ats"):
        unsupported.append(fn); continue
    print(f"  UNRESOLVED {fn}  ({note or r.get('ats')})\n             {url}")
    bad.append((fn, note or "unresolved"))

print(f"\n{len(bad)} report(s) with a URL that should resolve and does not")
for fn, why in bad:
    print(f"   {fn}: {why}")
print(f"{len(closed)} report(s) point at a closed posting (expected for older reports)")
print(f"{len(unsupported)} report(s) on hosts this tool cannot check")
print(f"{len(rootonly)} report(s) whose URL is a bare host, so the posting can never be "
      f"re-checked or matched to a packet")
sys.exit(1 if bad else 0)
