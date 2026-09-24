#!/usr/bin/env python
"""workday-peek.py — resolve any Workday posting URL to the facts that gate a role.

The repo had a liveness checker for NVIDIA only, but Adobe, Intel, Autodesk,
Blizzard, Sony and Netflix all run Workday too, and every one of them was being
checked by hand. The CXS JSON endpoint carries exactly what the location and comp
gates need, so this reads it for any tenant.

Two hard-won rules are encoded here:
  - A 403 means the job-path slug is wrong, NOT that the posting closed. Only a
    404 is a closure. Treating 403 as closed has produced false closures before.
  - additionalLocations matters as much as location. A req that lists a hub city
    can still carry a remote entry, and that entry is the whole verdict.

Transport falls back to curl, because urllib fails at the TLS layer in some
environments while curl against the same URL succeeds.

Run:
  python scripts/workday-peek.py <posting-url> [<posting-url> ...] [--json]
"""
import json, os, re, subprocess, sys, urllib.request, urllib.error
from _httpctx import CTX, is_tls_failure

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
HDRS = {"User-Agent": UA, "Accept": "application/json"}
PAY = re.compile(r"\$\s?[\d,]{5,}(?:\s*(?:-|to|–)\s*\$?\s?[\d,]{5,})?")


def cxs_url(url):
    """Rewrite a human Workday URL into its CXS JSON URL.

    https://<tenant>.wdN.myworkdayjobs.com/<site>/job/<path>
      -> https://<tenant>.wdN.myworkdayjobs.com/wday/cxs/<tenant>/<site>/job/<path>
    Also accepts the en-US locale segment some tenants insert.
    """
    m = re.match(r"https://([\w-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:([\w-]{2,5})/)?([^/]+)/(job/.+)$", url)
    if not m:
        return None
    tenant, wd, _loc, site, path = m.groups()
    path = path.split("?")[0]
    return f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/{path}"


def get(url):
    try:
        r = urllib.request.Request(url, headers=HDRS)
        with urllib.request.urlopen(r, timeout=25, context=CTX) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        pass
    try:
        cmd = ["curl", "-s", "-w", "\n%{http_code}", "--max-time", "30"]
        for k, v in HDRS.items():
            cmd += ["-H", f"{k}: {v}"]
        # encoding must be explicit: text=True decodes with the locale codec, which
        # on Windows is cp1252 and dies on the first non-latin byte in a JD.
        out = subprocess.run(cmd + [url], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=45).stdout
        body, _, code = out.rpartition("\n")
        status = int(code.strip() or 0)
        return status, (json.loads(body) if status == 200 and body.strip() else None)
    except Exception:
        return 0, None


def peek(url):
    cu = cxs_url(url)
    if not cu:
        return {"url": url, "state": "UNPARSEABLE", "detail": "not a Workday posting URL"}
    status, body = get(cu)
    if status == 404:
        return {"url": url, "state": "CLOSED", "live": False, "detail": "CXS returns 404"}
    if status == 403:
        return {"url": url, "state": "UNKNOWN", "live": None,
                "detail": "403 = wrong job-path slug, NOT a closure; re-resolve the slug"}
    if not body:
        return {"url": url, "state": "UNKNOWN", "live": None,
                "detail": f"no JSON body (HTTP {status})"}
    info = body.get("jobPostingInfo", {}) or {}
    locs = [info.get("location", "")] + (info.get("additionalLocations") or [])
    locs = [l for l in locs if l]
    txt = re.sub(r"<[^>]+>", " ", info.get("jobDescription", "") or "")
    txt = re.sub(r"\s+", " ", txt)
    return {
        "url": url, "state": "LIVE" if info.get("canApply") else "CLOSED",
        "live": bool(info.get("canApply")), "title": info.get("title", ""),
        "locations": locs,
        "remote_flagged": any(re.search(r"\bremote\b", l, re.I) for l in locs),
        "remoteType": info.get("remoteType", ""),
        "posted": info.get("startDate", ""), "end": info.get("endDate", ""),
        "pay": list(dict.fromkeys(PAY.findall(txt)))[:4],
        "canApply": info.get("canApply"),
        "jd": txt,
    }


if __name__ == "__main__":
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
