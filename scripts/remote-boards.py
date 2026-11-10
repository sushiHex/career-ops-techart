#!/usr/bin/env python
"""Read the remote-only job boards' public APIs for in-lane, US-eligible roles.

Himalayas and Jobicy aggregate remote postings from thousands of employers, most of which
no portals.yml entry polls, and both publish JSON with the posting's location restriction
and often its salary. This is employer DISCOVERY first: a hit at a company portals.yml does
not poll is listed so `scripts/find-ats.py` can turn it into a board entry, after which the
daily sweeps read that employer directly. A hit at a polled company is counted, not
printed, since scan.mjs and body-sweep.py already read its board.

Remotive's free API was probed on 2026-11-09 and returns a truncated 12-row sample, so it is
not read. RemoteOK returns its latest 100 with no filters and is not worth a request.

  python scripts/remote-boards.py                  # default lane queries
  python scripts/remote-boards.py --q "agent evals" --q "forward deployed"
  python scripts/remote-boards.py --pages 3 --min 5
  python scripts/remote-boards.py --selftest
"""
import argparse, concurrent.futures as cf, datetime, html, os, re, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _sweepkit as kit  # noqa: E402
from _sweepkit import company_key as norm_co, html_text as _text  # noqa: E402

# The default search terms are the candidate's, so they live in config/sweep-gates.json
# (`remote_queries`); --q overrides them for one run.


def _get(url):
    return kit.get_json(url, timeout=40)


# A posted ANNUAL maximum below config/sweep-gates.json `annual_max_floor` cannot reach the
# total floor even with a bonus; a missing salary is not evidence and never drops a row.
PER_YEAR = {"hour": 2080, "day": 260, "week": 52, "fortnight": 26, "biweek": 26, "month": 12, "year": 1, "annual": 1}


def annual_max(amount, period, currency=None):
    """A posted maximum as US dollars a year, or None when it cannot be read as one.
    A non-USD or unrecognised period is None, never a small number, because None never
    drops a row and a wrongly small number does (Codex: $4,000/week read as $4,000)."""
    if not amount or (currency and str(currency).upper() not in ("USD", "US$", "$")):
        return None
    p = (period or "year").lower()
    mult = next((m for k, m in PER_YEAR.items() if p.startswith(k)), None)
    return amount * mult if mult else None


US_WORDS = ("usa", "us", "united states", "americas", "north america", "worldwide", "anywhere")


def _names(restrictions, keys):
    """Restrictions arrive as strings in the feed and as objects in the documented schema;
    this reads both, taking `keys` from an object."""
    out = []
    for x in restrictions or []:
        out += [str(x.get(k) or "") for k in keys] if isinstance(x, dict) else [str(x)]
    return [o for o in out if o]


def us_eligible(restrictions):
    """True when a location restriction admits a US resident. Himalayas documents an EMPTY
    list as "no country restriction", so empty is worldwide; the search also passes country=US."""
    r = [x.lower() for x in _names(restrictions, ("name", "alpha2", "code", "country"))]
    return not r or any(x in US_WORDS for x in r)


def _where(restrictions):
    out = (str(x.get("name") or x.get("alpha2") or "") if isinstance(x, dict) else str(x) for x in restrictions or [])
    return ", ".join(o for o in out if o) or "worldwide"


def himalayas(q, pages):
    """(rows, status): status is "ok", "partial" (a later page failed) or "truncated"
    (the page cap was reached on a full page), so a short read never passes as whole."""
    rows = []
    for page in range(1, pages + 1):
        d = _get("https://himalayas.app/jobs/api/search?" + urllib.parse.urlencode(
            {"q": q, "country": "US", "limit": 20, "page": page}))
        if not isinstance(d, dict) or not isinstance(d.get("jobs"), list):
            return rows, ("unread" if page == 1 else "partial")
        for j in d["jobs"]:
            rows.append({"source": "himalayas", "company": j.get("companyName", ""), "title": j.get("title", ""),
                         "url": j.get("guid") or j.get("applicationLink", ""),
                         "where": _where(j.get("locationRestrictions")),
                         "eligible": us_eligible(j.get("locationRestrictions")),
                         "max": annual_max(j.get("maxSalary"), j.get("salaryPeriod"), j.get("currency")),
                         "pay": f"{j.get('minSalary')}-{j.get('maxSalary')} {j.get('currency') or ''} {j.get('salaryPeriod')}"
                                if j.get("maxSalary") else "",
                         "body": _text(j.get("description") or j.get("excerpt"))})
        if len(d["jobs"]) < 20:
            return rows, "ok"
    return rows, "truncated"


def jobicy():
    d = _get("https://jobicy.com/api/v2/remote-jobs?count=100&geo=usa&industry=dev")
    if not isinstance(d, dict) or "jobs" not in d:
        return [], False
    return [{"source": "jobicy", "company": j.get("companyName", ""), "title": j.get("jobTitle", ""),
             "url": j.get("url", ""), "where": j.get("jobGeo", ""), "eligible": True,
             "max": annual_max(j.get("salaryMax"), j.get("salaryPeriod"), j.get("salaryCurrency")),
             "pay": f"{j.get('salaryMin')}-{j.get('salaryMax')} {j.get('salaryPeriod')}" if j.get("salaryMax") else "",
             "body": _text(j.get("jobDescription") or j.get("jobExcerpt"))} for j in d["jobs"]], True


def portal_companies():
    """Employers some daily sweep actually READS: enabled portals.yml entries that are not
    websearch handoffs. Naming every entry treated a disabled or handoff company (Unity,
    Cartwheel, Latitude) as covered and hid its postings (Codex)."""
    return {norm_co(name) for name, block in kit.portal_entries(kit.portals_text())
            if not re.search(r"^\s*scan_method:\s*websearch\b", block, re.M)
            and re.search(r"^\s*(careers_url|api):", block, re.M)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--q", action="append", help="a Himalayas query (repeatable); default: remote_queries in config/sweep-gates.json")
    ap.add_argument("--pages", type=int, default=2, help="Himalayas pages of 20 per query")
    ap.add_argument("--min", type=int, default=8, help="lane_score floor over title and body")
    ap.add_argument("--all", action="store_true", help="also print rows at companies portals.yml polls")
    ap.add_argument("--show-seen", action="store_true")
    ap.add_argument("--no-record", action="store_true")
    ap.add_argument("--companies-out", help="write the unpolled employers here, one per line, for find-ats.py")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return _selftest()

    queries = a.q or kit.remote_queries()
    if not queries:
        print("no queries: set remote_queries in config/sweep-gates.json or pass --q")
        return 2
    with cf.ThreadPoolExecutor(len(queries) + 1) as ex:   # latency-bound: every query at once
        hj = ex.submit(jobicy)
        hima = list(ex.map(lambda q: himalayas(q, a.pages), queries))
    rows, unread = [], []
    for q, (got, status) in zip(queries, hima):
        rows += got
        if status != "ok":
            unread.append(f"himalayas:{q} ({status})")
    got, ok = hj.result()
    rows += got
    if not ok:
        unread.append("jobicy (unread)")

    wd = kit.workday()
    seen, polled, tracked = wd.load_seen(), portal_companies(), kit.tracker_companies()
    floor = kit.max_floor()
    today = datetime.date.today().isoformat()
    out, dup, folded = [], set(), set()
    counts = {"rows": len(rows), "place": 0, "pay": 0, "lane": 0, "polled": 0, "seen": 0}
    for r in rows:
        # The same posting returned by two queries is one row, keyed by its URL. A second,
        # DIFFERENT posting with the same title is folded only after it has passed every
        # filter, so a seen or rejected first copy cannot hide a new second one (Codex).
        sk = wd.seen_key(r["url"])
        if sk in dup:
            continue
        dup.add(sk)
        if not r["eligible"]:
            counts["place"] += 1
            continue
        if not kit.tech_role(r["title"]):
            counts["lane"] += 1
            continue
        if r["max"] is not None and r["max"] < floor:
            counts["pay"] += 1
            continue
        r["score"], keep = kit.lane_keeps(r["title"], r["body"], a.min)
        if not keep:
            counts["lane"] += 1
            continue
        co = norm_co(r["company"])
        if co in polled and not a.all:
            counts["polled"] += 1
            continue
        if sk in seen and not a.show_seen:
            counts["seen"] += 1
            continue
        if (co, r["title"].lower()) in folded:
            continue
        folded.add((co, r["title"].lower()))
        r["history"] = kit.history(r["company"], tracked)
        out.append(r)
    out.sort(key=lambda r: -r["score"])
    print(f"{counts['rows']} rows; dropped {counts['place']} not US-eligible, {counts['pay']} max under "
          f"${floor:,}, {counts['lane']} not a technical role or below lane {a.min}, "
          f"{counts['polled']} at polled companies, "
          f"{counts['seen']} printed before")
    for r in out:
        print(f"{r['score']:>3} {r['company'][:26]:<26} | {r['title'][:70]} | {r['where'][:24]} | {r['pay']} "
              f"{r['history']}\n      {r['url']}")
    new_cos = sorted({r["company"] for r in out})
    if new_cos:
        print(f"\nEMPLOYERS NOT POLLED ({len(new_cos)}); run `python scripts/find-ats.py \"<name>\"` on the in-lane ones:")
        print("  " + "; ".join(new_cos))
    if unread:
        print("NOT READ:", ", ".join(unread))
    if a.companies_out:
        with open(a.companies_out, "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(html.unescape(c) + "\n" for c in new_cos))
    if not a.no_record:
        wd.record_seen(out, today, seen)
    return 0


def _selftest():
    bad = 0

    def check(name, got, want):
        nonlocal bad
        if got != want:
            bad += 1
            print(f"FAIL {name}: got {got!r}, want {want!r}")

    check("worldwide", us_eligible([]), True)
    check("usa", us_eligible(["USA", "Canada"]), True)
    check("india only", us_eligible(["India"]), False)
    check("hourly annualised", annual_max(100, "hourly"), 208000)
    check("weekly annualised", annual_max(4000, "weekly"), 208000)
    check("annual", annual_max(180000, "annual"), 180000)
    check("non-USD is unknown, not small", annual_max(120000, "annual", "GBP"), None)
    check("unknown period is unknown", annual_max(5000, "per sprint"), None)
    check("no salary", annual_max(None, "annual"), None)
    check("object-form US restriction", us_eligible([{"name": "United States", "alpha2": "US"}]), True)
    check("object-form non-US", us_eligible([{"name": "India", "alpha2": "IN"}]), False)
    check("object-form where", _where([{"name": "United States"}]), "United States")
    check("company norm", norm_co("Initech Analytics, Inc."), norm_co("initech analytics"))
    check("company norm parens", norm_co("Initech AI (Labs)"), "initechai")
    check("company norm domain suffix", norm_co("Globex.io"), norm_co("Globex"))
    print("remote-boards selftest:", "OK" if not bad else f"{bad} FAILED")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
