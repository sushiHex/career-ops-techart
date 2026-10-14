#!/usr/bin/env python
"""workday-peek.py — resolve any Workday posting URL to the facts that gate a role.

The repo had a liveness checker for NVIDIA only, but Adobe, Intel, Autodesk,
Blizzard, Sony and Netflix all run Workday too, and every one of them was being
checked by hand. The CXS JSON endpoint carries exactly what the location and comp
gates need, so this reads it for any tenant.

Built on req-resolve's Workday pieces rather than a copy of them. It used to parse the
URL with a LENGTH test for the locale, which reads `en` as the site on a locale-only URL
and fabricates a CXS path whose 404 then closed the row, and it read `canApply` off
whatever came back, so a `{}` at HTTP 200 read CLOSED. req-resolve had fixed both.

Rules encoded here:
  - A 403 means the job-path slug is wrong, NOT that the posting closed. Only a
    404 or a 410 is a closure. Treating 403 as closed has produced false closures before.
  - A 200 that does not carry jobPostingInfo.canApply was never read: unknown, not closed.
  - additionalLocations matters as much as location. A req that lists a hub city
    can still carry a remote entry, and that entry is the whole verdict.

Run:
  python scripts/workday-peek.py <posting-url> [<posting-url> ...] [--json] [--jd]
  python scripts/workday-peek.py --selftest
"""
import importlib.util, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location("reqresolve", os.path.join(HERE, "req-resolve.py"))
rr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rr)


def peek(url):
    m = rr.WD_POSTING_URL.match((url or "").split("?")[0])
    if not m:
        return {"url": url, "state": "UNPARSEABLE", "detail": "not a Workday posting URL"}
    tenant, wd, site, path = m.groups()
    if rr.WD_LOCALE_ONLY.match(site):
        return {"url": url, "state": "UNKNOWN", "live": None,
                "detail": f"a locale ({site}) sits where the Workday SITE belongs, so there is "
                          f"no board to ask; a CXS path built from it would be fabricated"}
    status, body = rr.fetch(f"{rr.cxs_base(tenant, wd, site)}/{path}")
    if status == 403:
        return {"url": url, "state": "UNKNOWN", "live": None,
                "detail": "403 = wrong job-path slug, NOT a closure; re-resolve the slug"}
    if status != 200:
        live = rr.unresolved(status)
        return {"url": url, "state": "CLOSED" if live is False else "UNKNOWN", "live": live,
                "detail": f"CXS returns HTTP {status}"}
    d = rr.jload(body, need=("jobPostingInfo.canApply",)) if body else rr.UNREADABLE
    if d is rr.UNREADABLE:
        return {"url": url, "state": "UNKNOWN", "live": None,
                "detail": "HTTP 200 without a readable jobPostingInfo.canApply; never read, not closed"}
    info = d["jobPostingInfo"]
    locs = [l for l in [info.get("location", "")] + (info.get("additionalLocations") or []) if l]
    txt = rr.clean(info.get("jobDescription", ""))
    return {
        "url": url, "state": "LIVE" if info.get("canApply") else "CLOSED",
        "live": bool(info.get("canApply")), "title": info.get("title", ""),
        "locations": locs,
        "remote_flagged": rr.says_remote(*locs),
        "remoteType": info.get("remoteType", ""),
        "posted": info.get("startDate", ""), "end": info.get("endDate", ""),
        "pay": rr.pays(txt),
        "canApply": info.get("canApply"),
        "jd": txt,
    }


def _selftest():
    """peek() against served responses. No network."""
    rec = {"jobPostingInfo": {"title": "Senior TA", "canApply": True, "location": "US, CA, Santa Clara",
                              "additionalLocations": ["US, CA, Remote"],
                              "jobDescription": "<p>Pay 184,000 USD - 287,500 USD</p>"}}
    URL = "https://nvidia.wd5.myworkdayjobs.com/{}/job/US-CA-Remote/X_JR2620896"
    seen = []

    def serve(st, body):
        def fake(u, *a, **k):
            seen.append(u)
            return st, body
        return fake

    cases = [
        (URL.format("NVIDIAExternalCareerSite"), (200, json.dumps(rec)), "LIVE", "a full record is live"),
        (URL.format("Ext"), (200, json.dumps(rec)), "LIVE", "a three-letter site is a site, not a locale"),
        (URL.format("en"), (404, ""), "UNKNOWN", "a locale-only url must not close on a fabricated path"),
        (URL.format("S"), (200, "{}"), "UNKNOWN", "an empty object at 200 was never read"),
        (URL.format("S"), (200, '{"jobPostingInfo": {}}'), "UNKNOWN", "an empty record was never read"),
        (URL.format("S"), (200, '{"jobPostingInfo": {"canApply": false}}'), "CLOSED", "canApply false is read"),
        (URL.format("S"), (403, ""), "UNKNOWN", "403 is a wrong slug"),
        (URL.format("S"), (404, ""), "CLOSED", "404 is a closure"),
        (URL.format("S"), (410, ""), "CLOSED", "410 is a closure"),
        (URL.format("S"), (500, ""), "UNKNOWN", "500 was never read"),
    ]
    bad, real = 0, rr.fetch
    try:
        for url, served, want, why in cases:
            rr.fetch = serve(*served)
            try:
                got = peek(url)
            except Exception as e:
                got = {"state": f"RAISED {type(e).__name__}", "detail": str(e)}
            if got["state"] != want:
                bad += 1
                print(f"  FAIL {why}: {url} -> {got['state']}, want {want} ({got.get('detail')})")
        rr.fetch = serve(200, json.dumps(rec))
        r = peek(URL.format("S"))
        if r.get("locations") != ["US, CA, Santa Clara", "US, CA, Remote"] or not r.get("remote_flagged"):
            bad += 1
            print(f"  FAIL additionalLocations must be folded in: {r.get('locations')}")
        if not r.get("pay"):
            bad += 1
            print("  FAIL a USD band with no dollar sign must still read as pay")
    finally:
        rr.fetch = real
    if any("/wday/cxs/nvidia/en/" in u for u in seen):
        bad += 1
        print("  FAIL a CXS path was built from a locale")
    print(f"workday-peek selftest: {len(cases) + 2} cases, {bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    urls = [a for a in sys.argv[1:] if not a.startswith("--")]
    res = [peek(u) for u in urls]
    if "--json" in sys.argv:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        for r in res:
            print(f"[{r['state']:7s}] {r.get('title') or r['url'][:80]}")
            if r.get("locations") is not None and r["state"] in ("LIVE", "CLOSED"):
                print(f"          locations: {', '.join(r['locations']) or '?'}"
                      f"   remote-listed={r['remote_flagged']}  remoteType={r.get('remoteType') or '-'}")
                print(f"          pay: {r['pay'] or 'not stated'}   posted={r.get('posted') or '?'}"
                      f"  end={r.get('end') or '(none)'}")
            if r.get("detail"):
                print(f"          {r['detail']}")
            if "--jd" in sys.argv and r.get("jd"):
                print("\n" + r["jd"] + "\n")
