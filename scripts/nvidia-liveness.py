# -*- coding: utf-8 -*-
"""Reliable NVIDIA Workday liveness check by req ID (JRxxxxxxx).

THREE states, and NEVER a false "closed":
  LIVE    - req is in NVIDIA's active CXS search index (the search only returns OPEN reqs)
  CLOSED  - the search DEFINITIVELY succeeded (HTTP 200 + valid body) but the req is absent
  UNKNOWN - the search API was unavailable / rate-limited; status undetermined -> verify manually

Design notes (learned the hard way):
- NVIDIA's CXS DETAIL endpoint 403s on a slightly-wrong job-path slug, so we resolve the canonical
  path via the CXS SEARCH endpoint first.
- Presence in the search index == LIVE. The detail fetch is best-effort enrichment
  (canApply/location/endDate) and must NEVER downgrade a search-confirmed hit to closed.
- A failed/throttled search is UNKNOWN, not CLOSED (the old bug: it cried "closed" on live gems).

Usage:  python scripts/nvidia-liveness.py JR2231011 JR2508244 [--json]
"""
import sys, json, time, random, os, re, urllib.request, urllib.error
from _httpctx import CTX, is_tls_failure

# Repo root, so the stored-slug fallback works from any working directory.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import _location  # noqa: E402  (the home state comes from config/location.json)

BASE = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
HDRS = {"User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json",
        "Referer": "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"}


def _req(url, data=None, tries=5):
    """Return (ok, status, body). ok=True ONLY on a real 200 with parsed JSON.
    Retries transient failures (403/429/5xx/network) with exponential backoff + jitter."""
    last = 0
    for i in range(tries):
        try:
            r = urllib.request.Request(
                url, data=(json.dumps(data).encode() if data is not None else None),
                headers=HDRS, method=("POST" if data is not None else "GET"))
            with urllib.request.urlopen(r, timeout=25, context=CTX) as resp:
                return True, resp.status, json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            last = e.code
            if e.code in (403, 429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(min(1.2 * (2 ** i) + random.uniform(0, 0.6), 10))
                continue
            return False, e.code, None
        except Exception as exc:
            last = 0
            # A TLS trust failure is deterministic. Retrying it with backoff spends
            # the whole sleep budget to reach the same error, which is what made a
            # single-req check take over two minutes.
            if is_tls_failure(exc):
                return _req_curl(url, data)
            if i < tries - 1:
                time.sleep(min(1.2 * (2 ** i), 8))
                continue
            # urllib can fail at the transport layer in environments where curl
            # succeeds against the same URL (proxy and TLS handling differ). That
            # is not rate-limiting, and reporting it as such made every check
            # return UNKNOWN with a wrong explanation. Try curl before giving up.
            return _req_curl(url, data)
    return False, last, None


def _req_curl(url, data=None):
    """Transport fallback. Returns the same (ok, status, body) triple as _req."""
    import subprocess, tempfile
    cmd = ["curl", "-s", "-o", "-", "-w", "\n%{http_code}", "--max-time", "25"]
    for k, v in HDRS.items():
        cmd += ["-H", "%s: %s" % (k, v)]
    tmp = None
    if data is not None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, tmp); tmp.close()
        cmd += ["-X", "POST", "-d", "@" + tmp.name]
    cmd.append(url)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=40).stdout
        body_txt, _, code = out.rpartition("\n")
        status = int(code.strip() or 0)
        if status != 200:
            return False, status, None
        return True, status, json.loads(body_txt)
    except Exception:
        return False, 0, None
    finally:
        if tmp:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass


def resolve(jr):
    """Return (externalPath, title, search_ok). search_ok=False => the search API failed (UNKNOWN)."""
    ok, status, body = _req(BASE + "/jobs",
                            data={"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": jr})
    if not ok or body is None:
        return None, None, False
    j = jr.lower()
    for p in body.get("jobPostings", []):
        if j in (p.get("externalPath", "") or "").lower() or j in json.dumps(p).lower():
            return p.get("externalPath", ""), p.get("title", ""), True
    return None, None, True  # search worked, req genuinely absent => closed


def home_remote_ok(locs, policy=None):
    """Can a resident of the configured home state work this req fully remote?

    NVIDIA sets remote eligibility per req, and spells it two different ways:
      "US, CA, Remote"  - remote, restricted to one state (here California)
      "US, Remote"      - remote anywhere in the US, which includes every state
    Matching only the first string reported a false NO on the second, which is the
    more permissive of the two. A country-level remote entry with no narrower state
    qualifier counts; a remote entry for a different state does not.

    Returns True, False, or None. None means the answer depends on a home state nobody
    configured: the req has a state-scoped remote entry and no home state to compare it
    with. That is a question for a human, not a no, so callers keep it and flag it.
    """
    pol = policy or _location.load()
    code = (pol.home_code or "").upper()
    # A commute-reached state is workable in person, and a remote entry scoped to that same
    # state is therefore also workable: a Virginia policy whose commute reaches Washington,
    # DC accepts "US, DC, Remote" on the same reasoning it accepts a DC onsite req. Reading
    # only home_code missed this and hid a req both location gates already pass.
    commute = {c.upper() for c in (getattr(pol, "commute_states", None) or ())}
    scoped_seen = False
    for x in locs:
        s = (x or "").lower().strip()
        if not re.search(r"\bremote\b", s):
            continue
        if s in ("remote", "us, remote", "usa, remote", "united states, remote") or re.search(
                r"^(us|usa|united states)\b[^,]*,\s*remote$", s):
            return True
        # A state scope, in the two orders boards write it: "US, TX, Remote" and
        # "USA - Remote, TX". Anchored to the country marker on purpose. The old test was a
        # substring, f"{code}, remote" in s, so under a California home "Costa Rica, Remote"
        # read as California remote, and under Iowa "India, Remote" did.
        m = (re.match(r"(?:us|usa|united states)\s*,\s*([a-z]{2})\s*,\s*remote\b", s)
             or re.match(r"(?:us|usa|united states)\s*[-\u2013,]\s*remote\s*[-\u2013,]\s*([a-z]{2})\s*$", s))
        if m:
            seen = m.group(1).upper()
            if (code and seen == code) or seen in commute:
                return True
            scoped_seen = True
    return None if (scoped_seen and not code) else False


def local_path(jr):
    """Find this req's canonical CXS path in files the project already stores.

    The search endpoint rate-limits, and when it does the whole check goes blind.
    But scan.mjs already wrote the exact posting URL into data/pipeline.md, and
    reports carry it too. The slug is the only thing the search was needed for,
    so a locally-known slug removes the dependency entirely.

    Only an EXACT stored slug is used. Building one from a title is what makes the
    detail endpoint 403, which then reads as a false closure.
    """
    pat = re.compile(r"/NVIDIAExternalCareerSite(/job/[^\s|\"'>)]*" + re.escape(jr) + r"[^\s|\"'>)]*)",
                     re.I)
    for path in ("data/pipeline.md", "data/scan-history.tsv"):
        p = os.path.join(ROOT, path)
        if not os.path.exists(p):
            continue
        m = pat.search(open(p, encoding="utf-8", errors="replace").read())
        if m:
            return m.group(1)
    rep = os.path.join(ROOT, "reports")
    if os.path.isdir(rep):
        for fn in sorted(os.listdir(rep), reverse=True):
            if not fn.endswith(".md"):
                continue
            m = pat.search(open(os.path.join(rep, fn), encoding="utf-8", errors="replace").read())
            if m:
                return m.group(1)
    return None


def check(jr):
    ep, title, search_ok = resolve(jr)
    if not search_ok:
        # Fall back to a slug this repo already recorded, rather than reporting blind.
        ep2 = local_path(jr)
        if ep2:
            ok, status, body = _req(BASE + ep2)
            info = (body or {}).get("jobPostingInfo", {}) if ok else {}
            if ok and info:
                al = info.get("additionalLocations", []) or []
                home_remote = home_remote_ok([info.get("location", "")] + al)
                return {"req": jr, "state": "LIVE" if info.get("canApply") else "CLOSED",
                        "live": bool(info.get("canApply")), "title": info.get("title", ""),
                        "location": info.get("location", "?"), "additionalLocations": al,
                        "home_remote": home_remote, "remote": info.get("remoteType", "?"),
                        "endDate": info.get("endDate", "(none)"),
                        "canApply": info.get("canApply", "?"), "path": ep2,
                        "detail": "search throttled; resolved via stored slug"}
            if status == 404:
                return {"req": jr, "state": "CLOSED", "live": False,
                        "detail": "search throttled; stored slug returns 404"}
            # 403 means the slug is wrong, NOT that the req is closed. 0 means the
            # request never completed, which says nothing about the req at all.
            why = {403: "403 = wrong slug, not a closure",
                   0: "transport failure, not a closure"}.get(status, "unexpected status")
            return {"req": jr, "state": "UNKNOWN", "live": None,
                    "detail": "search throttled; stored slug gave HTTP %s (%s)" % (status, why)}
        return {"req": jr, "state": "UNKNOWN", "live": None,
                "detail": "search API unavailable/rate-limited and no stored slug; verify manually"}
    if not ep:
        return {"req": jr, "state": "CLOSED", "live": False, "detail": "not in NVIDIA active search index"}
    # Present in the active search index => LIVE. Detail fetch is enrichment only; failure does not un-live it.
    ok, status, body = _req(BASE + ep)
    info = (body or {}).get("jobPostingInfo", {}) if ok else {}
    al = info.get("additionalLocations", []) or []
    # NVIDIA sets remote-eligible states PER REQ. "US, CA, Remote" in the location list means a
    # California resident can work it fully remote; its absence means the CA entry is Santa
    # Clara onsite. The same holds for whichever home state is configured.
    home_remote = home_remote_ok([info.get("location", "")] + al)
    return {"req": jr, "state": "LIVE", "live": True, "title": info.get("title", title),
            "location": info.get("location", "?"), "additionalLocations": al,
            "home_remote": home_remote, "remote": info.get("remoteType", "?"),
            "endDate": info.get("endDate", "(none)"),
            "canApply": info.get("canApply", "?" if ok else "detail-unavailable"), "path": ep}


def _selftest():
    """home_remote_ok against fixed policies, never the user's. No network."""
    ca = _location.preset("california-socal")
    tx = _location.Policy({"home_state": {"code": "TX", "name": "Texas"}}, "fixture:texas")
    none = _location.preset("remote-us")
    # A commute-reached state is workable in person, so a remote entry scoped to that same
    # state is workable too. Reading only home_code hid "US, DC, Remote" from a Virginia
    # sweep whose commute already reaches Washington, DC, though both location gates pass it.
    va_dc = _location.Policy({"home_state": {"code": "VA", "name": "Virginia"},
                              "commute": {"signals": ["Washington, DC"]}}, "fixture:va-dc-commute")
    cases = [
        (["US, CA, Santa Clara", "US, CA, Remote"], ca, True, "the home state's remote entry"),
        (["US, CA, Santa Clara"], ca, False, "an onsite home-state entry is not remote"),
        (["US, TX, Remote"], ca, False, "another state's remote entry"),
        (["US, Remote"], ca, True, "nationwide remote includes every state"),
        (["US, TX, Remote"], tx, True, "the home state comes from the policy, not from code"),
        (["US, CA, Remote"], tx, False, "California remote is out of reach from Texas"),
        (["US, CA, Remote"], none, None, "no home state: a scoped entry is a question, not a no"),
        (["US, CA, Santa Clara"], none, False, "no home state and no remote entry is still a no"),
        (["United States, Remote"], none, True, "no home state: nationwide remote still counts"),
        # Foreign countries whose names end in the home code are not the home state.
        (["Costa Rica, Remote"], ca, False, "Costa Rica ends in 'ca' and is not California"),
        (["India, Remote"], _location.Policy({"home_state": {"code": "IA", "name": "Iowa"}}, "f"),
         False, "India ends in 'ia' and is not Iowa"),
        # The other order a board writes a state scope in.
        (["USA - Remote, TX"], tx, True, "the reordered scope form names the home state"),
        (["USA - Remote, TX"], none, None, "the reordered form is a scope, so no home means a question"),
        (["US, DC, Remote"], va_dc, True, "a remote entry scoped to a commute-reached state is workable too"),
    ]
    bad = 0
    for locs, pol, want, why in cases:
        got = home_remote_ok(locs, pol)
        if got != want:
            bad += 1
            print(f"  FAIL {locs} under {pol.name}: got {got}, want {want} ({why})")
    print(f"nvidia-liveness selftest: {len(cases)} home-remote cases, {bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    results = []
    for idx, jr in enumerate(args):
        if idx:
            time.sleep(1.6)  # polite gap so multi-req checks do not trip NVIDIA rate limits
        results.append(check(jr))
    if as_json:
        print(json.dumps(results, ensure_ascii=False))
    else:
        mark = {"LIVE": "LIVE  ", "CLOSED": "CLOSED", "UNKNOWN": "UNKNWN"}
        for r in results:
            print("[%s] %s  %s" % (mark.get(r["state"], "?"), r["req"], r.get("title", "") or r.get("detail", "")))
            if r["state"] == "LIVE":
                print("        loc=%s  canApply=%s  end=%s"
                      % (r.get("location", "?"), r.get("canApply", "?"), r.get("endDate", "?")))
                home = _location.load().home_display
                hr = r.get("home_remote")
                print("        HOME-REMOTE: %s  | all locations: %s"
                      % ("YES (workable remotely from %s)" % home if hr
                         else "UNKNOWN (state-scoped remote; set a home state in config/location.json)"
                         if hr is None else "NO (no remote option covering %s)" % home,
                         ", ".join([r.get("location", "?")] + (r.get("additionalLocations") or [])) or "?"))
            elif r["state"] == "UNKNOWN":
                print("        %s" % r.get("detail", ""))
