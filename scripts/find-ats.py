#!/usr/bin/env python
"""find-ats.py — find a company's real ATS board so the scan can poll it instead of searching.

portals.yml has two populations and they perform nothing alike. Companies with a pollable
careers_url reached the inbox 58% of the time. Companies marked scan_method: websearch
reached it 10% of the time, and 65 of 73 had produced nothing ever, large studios and
AI labs among them. The handoff bucket is a to-do list nobody executes.

The fix is not better search. It is finding the ATS slug once and never searching again.

Two traps this is built around, both observed on 2026-08-24:

  A CAREERS PAGE IS NOT EVIDENCE ABOUT ITS ATS. genesis.ai/careers reports 0 openings while
  its Ashby board carries 49. Skild's page renders "Current Openings 00" against 61 on
  Greenhouse. Never conclude from the rendered page; resolve to the API.

  THE OBVIOUS SLUG CAN BE A DECOY. Patronus is on Greenhouse as `patronusaiinc`; the bare
  Ashby board `patronus` exists and returns an empty jobs array, which reads as "they have
  no openings" when they had nine. So an empty board is reported as EMPTY, never as absent,
  and the search keeps going.

  A WORKDAY BOARD CANNOT BE GUESSED FROM A NAME. Tenant, data centre and site are all
  arbitrary (Target is target/wd5/targetcareers, Autodesk's site is literally `Ext`), so a
  Workday or SmartRecruiters board is converted from a URL instead: any posting or board
  URL on that host. The tenant, data centre and site are READ from it and confirmed with one
  request to the API the scan will poll.

  python scripts/find-ats.py "Frost Giant Studios" "Dreamhaven"
  python scripts/find-ats.py --handoff          # every websearch-only company in portals.yml
  python scripts/find-ats.py --handoff --json
  python scripts/find-ats.py --url https://target.wd5.myworkdayjobs.com/en-US/targetcareers/job/X_R123
  python scripts/find-ats.py --url https://jobs.smartrecruiters.com/MattelInc/744000012345
"""
import argparse, json, os, re, subprocess, sys, time, urllib.parse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

PROVIDERS = [
    ("ashby", "https://api.ashbyhq.com/posting-api/job-board/{s}", "jobs"),
    ("greenhouse", "https://boards-api.greenhouse.io/v1/boards/{s}/jobs", "jobs"),
    ("lever", "https://api.lever.co/v0/postings/{s}?mode=json", None),
    ("workable", "https://apply.workable.com/api/v1/widget/accounts/{s}?details=true", "jobs"),
    ("breezy", "https://{s}.breezy.hr/json", None),
    # The API is case-insensitive about the company id (`mattelinc`, `MattelInc` and
    # `MATTELINC` are one board, measured 2026-10-29), so the lowercase slugs below reach it.
    ("smartrecruiters", "https://api.smartrecruiters.com/v1/companies/{s}/postings?limit=100",
     "content"),
]
# Where a provider states its board size, when a page of postings is not all of it.
# SmartRecruiters pages at 100, so len(content) read Mattel's 334 postings as 100.
COUNT_KEY = {"smartrecruiters": "totalFound"}
RETRYABLE = {0, 429, 500, 502, 503, 504}
BOARD_PAGE = "https://jobs.ashbyhq.com/{s}"
import _ashby_embed  # noqa: E402  (same directory; see ashby_embedded below)
# Providers that answer 404 for an unknown account, so an empty board from them is a
# real finding. Breezy serves an empty JSON list with HTTP 200 for ANY subdomain and
# Workable serves a non-JSON body, so their empties prove nothing: probing them
# manufactured boards for meta-careers, amazon and apple-careers that do not exist.
# SmartRecruiters is the same: `nosuchcompanyxyz98765` answers 200 with totalFound 0, and
# so does `Mattel`, whose real board is `MattelInc` with 334 postings (2026-10-29).
EMPTY_IS_EVIDENCE = {"ashby", "greenhouse", "lever"}
# Providers that answer HTTP 200 with their JSON shape for EVERY account, real or not:
# SmartRecruiters did for all of `nosuchcompanyxyz98765`, `frost-giant-studios`, `a-b` and
# `abc123-careers` (2026-10-29). So any OTHER answer from one (a 403, a WAF's HTML at 200,
# a body without its postings list) is a request that was not answered, and it leaves the
# company unsettled rather than vanishing into "every provider answered".
ALWAYS_JSON_200 = {"smartrecruiters"}

# Rate limits are per host, so the only spacing that matters is between requests to the
# SAME provider. Without this a full --handoff run trips Workable's limit inside the first
# few companies and everything after it reports UNCHECKED.
_LAST_HIT = {}
_MIN_INTERVAL = 0.45   # seconds between two requests to one provider


def _pace(provider):
    import time as _t
    now = _t.monotonic()
    wait = _MIN_INTERVAL - (now - _LAST_HIT.get(provider, 0.0))
    if wait > 0:
        _t.sleep(wait)
    _LAST_HIT[provider] = _t.monotonic()


# A provider can be blocked at the IP level for a whole run rather than merely throttled.
# Workable answers 429 in 50ms to every request regardless of headers, user agent or
# pacing, which is a WAF decision that will not decay inside one run. Retrying it for every
# slug of every company costs minutes and changes nothing, and reporting every company as
# "not settled" because of it means the tool stops answering the question it was asked.
#
# So: count consecutive hard failures per provider, drop the provider for the rest of the
# run once it is clearly blocked, and NAME it in the output. The coverage gap stays
# visible, which is the part that matters. It is the difference between "I did not check
# Workable" and "there is no board".
_STRIKES = {}
_BLOCKED = set()
_STRIKE_LIMIT = 6


def _note_result(provider, status):
    if status in RETRYABLE:
        _STRIKES[provider] = _STRIKES.get(provider, 0) + 1
        if _STRIKES[provider] >= _STRIKE_LIMIT:
            _BLOCKED.add(provider)
    else:
        _STRIKES[provider] = 0
STOP = {"inc", "llc", "ltd", "corp", "the", "studios", "studio", "games", "technologies",
        "technology", "labs", "group", "company", "co", "ai", "entertainment"}


def slugs(name):
    """Plausible board slugs, most likely first. Real boards use more forms than one."""
    base = re.split(r"[(—–-]", name)[0].strip().lower()
    words = [w for w in re.findall(r"[a-z0-9]+", base) if w]
    core = [w for w in words if w not in STOP] or words
    out = ["".join(words), "-".join(words), "".join(core), "-".join(core)]
    if core:
        out += [core[0], core[0] + "ai", core[0] + "inc", core[0] + "-careers",
                core[0] + "careers", "".join(core) + "inc", "".join(core) + "careers"]
    if len(words) > 1:
        out.append("".join(words[:2]))
    seen, uniq = set(), []
    for s in out:
        if s and len(s) > 2 and s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq[:8]


def get(url, tries=3):
    """(status, body). Retries anything that is not a clean HTTP answer.

    A transient curl failure returns status 0, and treating that as "no board here" is the
    same silent false negative this whole tool exists to prevent: a first run reported
    Panorama Education as having no public board when its Workable widget answers 200 with
    seven jobs, purely because one 47KB fetch did not finish inside the timeout. A 404 is
    an answer and needs no retry; a 0 is the absence of one.
    """
    for attempt in range(tries):
        try:
            out = subprocess.run(
                ["curl", "-s", "-w", "\n%{http_code}", "--max-time", "20",
                 "-H", "Accept: application/json", "-A", "Mozilla/5.0", url],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=40).stdout
            body, _, code = out.rpartition("\n")
            st = int(code.strip() or 0)
            # 429 and 5xx are "ask me later", not "no board here". Probing every slug
            # against five providers rate-limits Workable within one run, and treating a
            # 429 as an answer made the tool report Panorama Education as having no public
            # board when its widget serves seven jobs. Back off and ask again.
            if st in RETRYABLE and attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            if st or attempt == tries - 1:
                return st, body
        except Exception:
            if attempt == tries - 1:
                return 0, ""
            time.sleep(1.0)
    return 0, ""


def owns(name, slug, payload):
    """Does this board plausibly belong to `name`, or did a generic slug collide?

    Probing "Frost Giant Studios" reached workable/frost and "Digital Domain" reached
    workable/digital, both 200 with zero jobs. Neither is that company; they are unrelated
    accounts sitting on a common English word. Reporting them as "board exists but empty"
    is worse than reporting nothing, because it closes the question wrongly.

    A multi-word or company-specific slug is self-evidencing. A short single word is not,
    so it has to be corroborated by a company name in the payload.
    """
    # Derive the core words from the SAME base slugs() uses, which is the text before the
    # first dash or bracket. portals.yml labels carry descriptive suffixes ("Whatnot —
    # Marina del Rey / Remote (AI Dev Tools)"), and reading the whole label made the
    # multi-word rule below count "marina", "del", "rey" and "tools" as part of the company
    # name. That made the bare slug "whatnot" look like a first-word collision and rejected
    # a board with 131 live postings, including two in-lane roles.
    base = re.split(r"[(—–-]", name)[0].strip().lower()
    core = [w for w in re.findall(r"[a-z0-9]+", base) if w not in STOP]
    # A bare first word is the collision case and cannot be corroborated from the payload.
    # "Applied Medical" produced slug "applied", which is Applied INTUITION's board: 299
    # jobs in Sunnyvale doing Physical AI for defense. Searching that blob for "applied"
    # and "medical" found both by chance, because at 299 postings almost any common word
    # appears somewhere. So when a company name has two or more significant words, its
    # first word alone is never accepted as its slug.
    if len(core) >= 2 and slug == core[0]:
        return False
    if "-" in slug or len(slug) >= 10 or len(core) < 2:
        return True
    blob = json.dumps(payload).lower() if payload is not None else ""
    return all(w[:6] in blob for w in core[:2]) if blob else False


def generic_slug(name, slug):
    """True when the board was found under the company's ONE significant word, bare.

    owns() accepts such a slug as self-evidencing, and on 2026-10-28 that was wrong twice
    in one run: "Moonshot Games" (stop word dropped) reached Ashby `moonshot`, a fintech
    consumer app, and "Promise" (the LA AI film studio) reached Ashby `promise`, a
    government-tech company. Nothing in a posting payload names the employer, so this
    cannot be settled here; it is reported as CHECK, with the board to open, and kept out
    of the list to paste into portals.yml.
    """
    # The same word with a suffix slugs() adds is no more specific: Ashby `jellyfishcareers`
    # was a marketing agency, not Jellyfish the animation studio (2026-10-28), and its length
    # alone made owns() call it self-evidencing.
    base = re.split(r"[(\u2014–-]", name)[0].strip().lower()
    core = [w for w in re.findall(r"[a-z0-9]+", base) if w not in STOP]
    if len(core) != 1:
        return False
    bare = re.sub(r"-?(careers|inc|ai|hq|jobs)$", "", slug)
    return bare == core[0] and "-" not in bare


def ashby_embedded(slug):
    """Postings from an Ashby board page whose posting-api is switched off, or None.

    The posting API is opt-in per organisation. When it is off it answers 404, which is
    indistinguishable from "no such company", and that is precisely how Whatnot came to be
    filed as an unconvertible websearch handoff: portals.yml still carries the note
    "Ashby (slug 404'd on probe)". The slug was correct. The board was live, with 131
    postings embedded in the page, including an AI Tooling Engineer and an LLM Platform
    Engineer that both list Los Angeles.

    So an Ashby 404 is not evidence of absence until the board PAGE has also been checked.
    """
    st, body = get(BOARD_PAGE.format(s=urllib.parse.quote(slug)))
    if st != 200 or not body:
        return None
    try:
        rows = _ashby_embed.postings(body, slug)
    except Exception:
        return None
    return rows or None


def probe(name):
    """(provider, slug, count, dirty) for the best board found, or None.

    `dirty` is the SET of providers that never gave a clean answer for this company. It is
    per-provider on purpose. The first version tracked one boolean for all five, and when
    Workable started hard-429ing every request, every company in a 73-company run reported
    UNCHECKED even though Ashby and Greenhouse had answered definitively for all of them.
    One rate-limited provider poisoning four good answers is not caution, it is a tool that
    stops reporting anything.

    So: a company with no board is reported as absent from the providers that ANSWERED,
    naming the ones that did not. Reporting absence you did not verify is still the failure
    mode this tool exists to stop, and it has bitten three times (a timed-out 47KB fetch,
    then two rounds of Workable 429s), but the fix is to be specific, not silent.
    """
    best, dirty = None, set()
    for slug in slugs(name):
        for prov, tmpl, key in PROVIDERS:
            if prov in _BLOCKED:
                dirty.add(prov)
                continue
            _pace(prov)
            st, body = get(tmpl.format(s=urllib.parse.quote(slug)))
            _note_result(prov, st)
            if st in RETRYABLE:
                dirty.add(prov)
            if prov == "ashby" and st == 404:
                # Opt-in API, live board. Check the page before believing the 404.
                rows = ashby_embedded(slug)
                if rows and owns(name, slug, rows):
                    return prov + "-embedded", slug, len(rows), dirty
            if st != 200 or not body.strip():
                if prov in ALWAYS_JSON_200:
                    dirty.add(prov)
                continue
            try:
                d = json.loads(body)
            except Exception:
                if prov in ALWAYS_JSON_200:
                    dirty.add(prov)
                continue
            jobs = d.get(key, []) if (key and isinstance(d, dict)) else d
            if prov in ALWAYS_JSON_200 and not isinstance(jobs, list):
                dirty.add(prov)
                continue
            n = len(jobs) if isinstance(jobs, list) else 0
            # Only a provider with a NAMED count field is asked for one. A default of ""
            # looked up the payload's empty-string key, so `{"jobs": [{}], "": 9000000}`
            # from any other provider read as nine million postings (Codex, 2026-10-29).
            ck = COUNT_KEY.get(prov)
            stated = d.get(ck) if (ck and isinstance(d, dict)) else None
            if n and isinstance(stated, int) and not isinstance(stated, bool) and stated > n:
                n = stated
            if not owns(name, slug, d):
                continue
            if n > 0:
                return prov, slug, n, dirty
            # An existing but empty board is a real finding ONLY from a provider that
            # answers 404 for an unknown account. Ashby, Greenhouse and Lever do. Breezy
            # serves an empty JSON list with HTTP 200 for ANY subdomain, so probing it
            # manufactured "boards" for meta-careers, amazon and applied-medical that do
            # not exist; Workable returns 200 with a non-JSON body for unknown accounts.
            # Recording those as "board exists but empty" closes the question wrongly,
            # which is worse than reporting nothing.
            if prov in EMPTY_IS_EVIDENCE and best is None:
                best = (prov, slug, 0)
    return (best + (dirty,)) if best else (None, None, None, dirty)


def handoff_companies():
    p = os.path.join(ROOT, "portals.yml")
    if not os.path.exists(p):
        sys.exit("find-ats: no portals.yml yet. Copy templates/portals.example.yml first.")
    t = open(p, encoding="utf-8", errors="replace").read()
    out = []
    for b in re.split(r"\n  - name:", t)[1:]:
        if "scan_method: websearch" in b:
            n = b.split("\n")[0].strip()
            if n:
                out.append(n)
    return out


# ---------------------------------------------------------------- --url: Workday, SmartRecruiters

_WS = None


def _workday():
    """scripts/workday-sweep.py, loaded on first use and only by --url and --selftest.

    It is the composition point for three things this file must not restate: the CXS
    transport and its retry policy (`_nv._req`, which also carries the certifi TLS context
    every *.myworkdayjobs.com host needs on this machine), the locale-by-shape test and
    the hyphen-to-underscore tenant rule (both in req-resolve, reached as `_prep.rr`), and
    the facet-sum cap estimate (`facet_total`). It costs about a second to load, which is
    why the name probe never touches it.
    """
    global _WS
    if _WS is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "workdaysweep", os.path.join(_HERE, "workday-sweep.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _WS = m
    return _WS


def _rr():
    return _workday()._prep.rr


# The HOST is read and nothing else. CLAUDE.md records the same hole four times over in
# this repo: a pattern searched across a whole URL lets a click-tracker carrying a Workday
# address in its path or query pass for that board. Here that would print a portals.yml
# entry for whatever tenant the wrapper happened to mention, so the parsed hostname has to
# BE the tenant host, matched whole.
WD_HOST = re.compile(r"^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.(wd\d+)\.myworkdayjobs\.com$")
WD_SITE = re.compile(r"^[A-Za-z0-9_-]+$")
# What follows the site in a posting path. Read where the site belongs, it means the URL
# carried a locale and no site (`.../en/job/US-CA-Remote/X_JR2620896`), and a CXS base
# built from it would address no board.
WD_POSTING_WORDS = {"job", "details"}
# One CXS search hands over at most this many postings and reports `total` as this number:
# NVIDIA (facets 2734, 2026-10-18) and Target (country facet 14208, 2026-10-29) both read
# exactly 2000. Target's smallest flat facet sums to 25, so facet_total() alone calls that
# board whole; the round number is the signal, and a round board size is a limit until
# shown otherwise.
WD_RESULT_CAP = 2000
SR_HOSTS = {"jobs.smartrecruiters.com", "careers.smartrecruiters.com"}
SR_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


def board_from_url(url):
    """The board a Workday or SmartRecruiters posting or board URL belongs to. Offline.

    Returns a dict with provider, careers_url (the portals.yml form the scan detects) and
    api (what to confirm against), or {"refused": why}. Workday's locale segment is
    stripped by SHAPE through req-resolve's WD_LOCALE_ONLY, never by length: Autodesk's
    site is `Ext`, and a length floor cost eight live Autodesk rows. The careers_url keeps
    the hostname's hyphen while the CXS path takes the tenant's underscore (host
    `osv-a10networks`, tenant `osv_a10networks`), through req-resolve's cxs_base().
    """
    raw = (url or "").strip()
    # Parsers disagree about these two, so neither may decide the host. In
    # `https://tracker.example\@target.wd5.myworkdayjobs.com/Ext` Python's urlsplit reads
    # Target as the host while a WHATWG parser (Node's URL, a browser) reads the backslash
    # as a path separator and the host as tracker.example (Codex, 2026-10-29). A real board
    # URL carries neither a backslash nor credentials, so both are refused outright. The
    # backslash refusal is defence in depth: every shape tried also fails the `@` refusal
    # below or the whole-host match, so the selftest pins its REASON rather than its effect.
    if "\\" in raw:
        return dict(url=url, refused="a backslash in a URL is read differently by different "
                                     "parsers, so its host is not knowable")
    # Scheme-less input is routed on purpose elsewhere in this toolchain, so it is here.
    if not re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.I):
        raw = "https://" + raw
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or "").lower()
    except ValueError:
        return dict(url=url, refused="not a URL")
    if parts.scheme.lower() not in ("http", "https"):
        return dict(url=url, refused=f"scheme {parts.scheme!r} is not a web address")
    if "@" in parts.netloc:
        return dict(url=url, refused="a URL carrying credentials before its host is a "
                                     "redirect trick, not a board")
    segs = [s for s in parts.path.split("/") if s]
    m = WD_HOST.match(host)
    if m:
        tenant, wd = m.groups()
        if [s.lower() for s in segs[:2]] == ["wday", "cxs"]:
            # A CXS API URL names the tenant in its path too, in the underscore form.
            if len(segs) < 4:
                return dict(url=url, refused="a Workday CXS URL with no site in its path")
            if segs[2].lower().replace("_", "-") != tenant:
                return dict(url=url, refused=f"the CXS path names tenant {segs[2]!r} under "
                                             f"the host of tenant {tenant!r}")
            site = segs[3]
            # Printed bare as `.../en-US`, a locale-shaped site reads as a locale to every
            # tool that strips one by shape, this one included, so it cannot round-trip.
            if _rr().WD_LOCALE_ONLY.match(site):
                return dict(url=url, refused=f"the CXS site {site!r} has a locale's shape and "
                                             f"would not survive as a careers_url")
        else:
            if segs and _rr().WD_LOCALE_ONLY.match(segs[0]):
                segs = segs[1:]
            site = segs[0] if segs else ""
            if (not site or site.lower() in WD_POSTING_WORDS
                    or _rr().WD_LOCALE_ONLY.match(site)):
                return dict(url=url, refused="the URL carries no Workday SITE (a locale or "
                                             "nothing sits where it belongs), so there is "
                                             "no board to name; open it in a browser and "
                                             "copy the address it settles on")
        if not WD_SITE.match(site):
            return dict(url=url, refused=f"{site!r} is not a Workday site name")
        return dict(url=url, provider="workday", tenant=tenant, wd=wd, site=site,
                    careers_url=f"https://{tenant}.{wd}.myworkdayjobs.com/{site}",
                    api=_rr().cxs_base(tenant, wd, site) + "/jobs")
    if host in SR_HOSTS or host == "api.smartrecruiters.com":
        if host == "api.smartrecruiters.com":
            ok = [s.lower() for s in segs[:2]] == ["v1", "companies"] and len(segs) > 2
            cid = segs[2] if ok else ""
        else:
            cid = segs[0] if segs else ""
        if not SR_ID.match(cid):
            return dict(url=url, refused="no SmartRecruiters company id in the path")
        return dict(url=url, provider="smartrecruiters", company_id=cid,
                    careers_url=f"https://jobs.smartrecruiters.com/{cid}",
                    api=f"https://api.smartrecruiters.com/v1/companies/{cid}/postings")
    return dict(url=url, refused=(
        f"host {host or '(none)'} is neither a Workday tenant "
        f"(<tenant>.<wdN>.myworkdayjobs.com) nor SmartRecruiters. Only the host is read, "
        f"never an address carried inside the URL; Greenhouse, Ashby, Lever, Workable and "
        f"Breezy are found from the company name"))


def confirm(board, post=None, fetch=None):
    """One request to the API the scan will poll, read as a verdict. Never a closure.

    BOARD      the API answered with postings
    CHECK      it answered, but nothing in the answer ties it to this URL's company
    EMPTY      a Workday site that exists and holds nothing right now
    NOT CHECKED  rate-limited, refused, or a 200 whose body is not a board (a WAF's `{}`)
    UNSETTLED  any other answer, a 404 included: Workday 404s an unknown SITE and 422s an
               unknown TENANT (both measured 2026-10-29), which is a statement about this
               URL and not about whether the company has a board

    `post` and `fetch` are injectable so the selftest can drive every branch offline.
    """
    out = dict(board)
    if board["provider"] == "workday":
        if post is None:
            post = _workday()._nv._req
            _pace("workday")
        ok, st, body = post(board["api"], data={"appliedFacets": {}, "limit": 20,
                                                "offset": 0, "searchText": ""})
        out["status"] = st
        # `ok` alone is not a 200: the urllib path returns True for any response it could
        # parse, while its curl fallback demands 200, so the guarantee depended on which
        # transport ran (Codex, 2026-10-29). Only a 200 can be a board.
        if not ok or st != 200:
            if st in RETRYABLE or st == 403:
                return dict(out, verdict="NOT CHECKED",
                            note=f"HTTP {st}: no answer; re-run this one later")
            why = {404: "Workday answers 404 for a site the tenant does not serve",
                   422: "Workday answers 422 for a tenant it does not know, and some tenants "
                        "422 an empty search"}.get(st, "an answer that is not a board")
            return dict(out, verdict="UNSETTLED",
                        note=f"HTTP {st}: {why}. Not evidence the company has no board")
        posts = body.get("jobPostings") if isinstance(body, dict) else None
        total = body.get("total") if isinstance(body, dict) else None
        # Both fields, or the response was not read: `{}` and an error object both arrive
        # as HTTP 200 and parse cleanly, and an unread response is never an empty board.
        if not isinstance(posts, list) or not isinstance(total, int) or isinstance(total, bool):
            return dict(out, verdict="NOT CHECKED",
                        note="HTTP 200 without jobPostings and total: not a board response")
        if not total and not posts:
            return dict(out, verdict="EMPTY", live=0,
                        note="the site exists and lists nothing now, which is not proof the "
                             "company has no openings; check the site against a live posting")
        # Two cap signals, and the scan only has the second. workday-sweep.py and
        # providers/workday.mjs walk a capped board by facet when the SMALLEST flat-facet
        # sum exceeds `total`. Target's smallest is remoteType at 25 against 14208 by
        # country (2026-10-29), so neither walker sees its cap: both read 2000 postings and
        # report the board whole. Say which case this is rather than promise a facet walk.
        # Seeing the cap is not walking past it: both walkers also need a flat facet whose
        # values each sit under the cap, and without one they print TRUNCATED and keep the
        # first walk (Codex, 2026-10-29).
        facets = _workday().facet_total(body)
        capped = total >= WD_RESULT_CAP or facets > total
        r = dict(out, verdict="BOARD", live=max(total, len(posts)), capped=capped,
                 at_least=capped, scan_sees_cap=facets > total, facet_floor=facets,
                 scan_splits=facets > total
                 and _workday().partition_facet(body, total) is not None)
        if not total:
            # `total` is trusted on the first page only (CrowdStrike reads 0 after it), and
            # a first page that lists postings under total 0 has stated no size at all.
            r.update(at_least=True, note="the first page lists postings under total 0, so "
                                         "the count is a floor, not the board's size")
        return r

    if fetch is None:
        fetch = get
        _pace("smartrecruiters")
    st, text = fetch(board["api"] + "?limit=10")
    out["status"] = st
    if st in RETRYABLE:
        return dict(out, verdict="NOT CHECKED", note=f"HTTP {st}: no answer; re-run later")
    if st != 200:
        return dict(out, verdict="UNSETTLED", note=f"HTTP {st} from the postings API")
    try:
        d = json.loads(text)
    except Exception:
        d = None
    content = d.get("content") if isinstance(d, dict) else None
    found = d.get("totalFound") if isinstance(d, dict) else None
    if not isinstance(content, list) or not isinstance(found, int) or isinstance(found, bool):
        return dict(out, verdict="NOT CHECKED",
                    note="HTTP 200 without content and totalFound: not a postings response")
    if not content:
        return dict(out, verdict="CHECK", live=0,
                    note="SmartRecruiters answers an empty board for ANY company id, so this "
                         "proves nothing; take the id from a live posting URL")
    # The nested fields are checked as carefully as the outer ones: `company: "broken"` or
    # a numeric identifier used to raise here and end the whole --url batch.
    co = content[0].get("company") if isinstance(content[0], dict) else None
    ident = co.get("identifier") if isinstance(co, dict) else None
    if not isinstance(ident, str) or not ident:
        return dict(out, verdict="NOT CHECKED",
                    note="the postings carry no company identifier, so the board's owner "
                         "was not read")
    name = co.get("name") if isinstance(co.get("name"), str) and co.get("name") else None
    # Finding a board is not finding THIS company's board: the payload names its owner,
    # so it has to be the company the URL named.
    if ident.lower() != board["company_id"].lower():
        return dict(out, verdict="CHECK", live=max(found, len(content)), name=name,
                    note=f"the API answered as company {ident!r}, not "
                         f"{board['company_id']!r}")
    return dict(out, verdict="BOARD", live=max(found, len(content)), name=name,
                company_id=ident, careers_url=f"https://jobs.smartrecruiters.com/{ident}")


SR_DECLARED = re.compile(r"^\s*(?:careers_url|api|url):\s*https?://"
                         r"(?:jobs|careers|api)\.smartrecruiters\.com/(?:v1/companies/)?"
                         r"([A-Za-z0-9][A-Za-z0-9_-]*)", re.M)


def tracked_as(board, portals_text=None):
    """The portals.yml label already polling this board, or None.

    Matched on the board's whole identity for its OWN provider. req-resolve's `boards`
    set mixes Ashby, Lever, Workable and SmartRecruiters slugs, so a Greenhouse or Ashby
    `acme` read a new SmartRecruiters `acme` as tracked and suppressed its entry (Codex,
    2026-10-29). Workday compares data centre too. Both compare ids without case because
    both APIs were measured treating them that way on 2026-10-29: SmartRecruiters
    `mattelinc` and `MattelInc` are one board, and Pacific Life's CXS answered
    `PacificLifeCareers` and `pacificlifecareers` with the same 125 postings.
    """
    if board["provider"] == "workday":
        want = (board["tenant"], board["wd"], board["site"].lower())
        for e in _rr().portals_index():
            wd = e.get("workday")
            if wd and (wd[0].lower(), wd[1].lower(), wd[2].lower()) == want:
                return e["label"]
        return None
    if portals_text is None:
        try:
            portals_text = open(os.path.join(ROOT, "portals.yml"), encoding="utf-8",
                                errors="replace").read()
        except OSError:
            return None
    for block in re.split(r"\n  - name:", portals_text)[1:]:
        ids = {i.lower() for i in SR_DECLARED.findall(block)}
        if board["company_id"].lower() in ids:
            return block.split("\n")[0].strip()
    return None


_CONFIRMED = {}   # one request per board, however many of its postings are given


def convert_url(url):
    board = board_from_url(url)
    if "refused" in board:
        return dict(board, verdict="REFUSED", note=board["refused"])
    # Case is kept: the scan builds its endpoint with the site's case as written, and
    # nothing here establishes that `/Ext` and `/ext` are one board.
    key = board["api"]
    if key not in _CONFIRMED:
        _CONFIRMED[key] = confirm(board)
    r = dict(_CONFIRMED[key], url=url)
    if r["verdict"] in ("BOARD", "EMPTY", "CHECK"):
        r["tracked"] = tracked_as(r)
    return r


def url_line(r):
    where = (f"{r['tenant']}/{r['wd']}/{r['site']}" if r.get("provider") == "workday"
             else r.get("company_id") or "")
    if r["verdict"] == "REFUSED":
        return f"  REFUSED     {r['url'][:70]}\n              {r['note']}"
    live = r.get("live")
    count = (f"{live}+" if r.get("at_least") else str(live)) if live is not None else "-"
    verdict = "TRACKED" if r.get("tracked") and r["verdict"] == "BOARD" else r["verdict"]
    line = f"  {verdict:11s} {r['provider']:15s} {where:42s} {count:>6s} live"
    if r.get("tracked"):
        line += f"  (already in portals.yml as {r['tracked']!r})"
    if r.get("capped") and r.get("scan_splits"):
        line += (f"\n              one search stops at {r['live']}; the facets count "
                 f"{r['facet_floor']}, so the scan walks this board by facet")
    elif r.get("capped") and r.get("scan_sees_cap"):
        line += (f"\n              WARNING: one search stops at {r['live']} and the facets "
                 f"count {r['facet_floor']}, but no facet splits the board under that cap, "
                 f"so the scan reads {r['live']} postings and prints TRUNCATED")
    elif r.get("capped"):
        line += (f"\n              WARNING: {r['live']} is Workday's search cap, not the board's "
                 f"size. The scan's cap test reads the smallest facet sum "
                 f"({r.get('facet_floor', 0)} here), so it will read {r['live']} postings "
                 f"and report this board whole, with no TRUNCATED line")
    if r.get("note"):
        line += f"\n              {r['note']}"
    return line


def print_url_entries(rows):
    add = [r for r in rows if r["verdict"] == "BOARD" and not r.get("tracked")]
    if add:
        print("\nAdd these to portals.yml:")
    seen = set()
    for r in add:
        if r["careers_url"] in seen:
            continue
        seen.add(r["careers_url"])
        # Strings are written as JSON, which YAML reads as a double-quoted scalar: an
        # employer the ATS names `Acme: Robotics` printed bare was not valid YAML.
        if r["provider"] == "workday":
            print(f"  - name: EMPLOYER   # fill in: Workday states no employer name "
                  f"(tenant {r['tenant']})")
            notes = (f"Workday (tenant {r['tenant']}, {r['wd']}, site {r['site']}), "
                     f"zero-token CXS scan. Converted by find-ats --url.")
        else:
            name = r.get("name")
            print(f"  - name: {json.dumps(name, ensure_ascii=False)}" if name
                  else "  - name: EMPLOYER   # fill in: the postings named no employer")
            notes = (f"SmartRecruiters (company id {r['company_id']}), zero-token postings "
                     f"API. Converted by find-ats --url.")
        print(f"    careers_url: {r['careers_url']}")
        print(f"    provider: {r['provider']}")
        print(f"    notes: {json.dumps(notes, ensure_ascii=False)}")
        print(f"    enabled: true")
    check = [r for r in rows if r["verdict"] in ("CHECK", "EMPTY") and not r.get("tracked")]
    if check:
        print("\nConfirm by hand before adding:")
        for r in check:
            print(f"  {r['careers_url']}  ({r['verdict']}: {r.get('note', '')})")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*")
    ap.add_argument("--handoff", action="store_true",
                    help="probe every scan_method: websearch company in portals.yml")
    ap.add_argument("--url", action="append", default=[], metavar="URL",
                    help="a Workday or SmartRecruiters posting or board URL to convert "
                         "(repeatable); those boards cannot be guessed from a name")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="stop after N companies")
    if "--selftest" in sys.argv:
        return _selftest()
    a = ap.parse_args()
    names = a.names + (handoff_companies() if a.handoff else [])
    if not names and not a.url:
        ap.error("give company names, --url or --handoff")
    if a.limit:
        names = names[:a.limit]

    url_rows = []
    for u in a.url:
        url_rows.append(convert_url(u))
        if not a.json:
            print(url_line(url_rows[-1]), flush=True)
    if not names:
        if a.json:
            print(json.dumps({"urls": url_rows}, indent=1))
        else:
            print_url_entries(url_rows)
        return 0

    found, empty, none_, unchecked, check = [], [], [], [], []
    for i, n in enumerate(names, 1):
        prov, slug, live, dirty = probe(n)
        # Absence is only evidence from a provider that 404s for an unknown account.
        # Workable and Breezy answer 200 for anything, so their being rate-limited costs
        # nothing: they could not have proven absence even if they had answered.
        # Two different questions, and conflating them reported a board that exists as
        # absent. PROVING ABSENCE needs the providers that 404 for unknown accounts.
        # FINDING A BOARD needs every provider, because Workable and Breezy can still
        # answer 200 with real jobs. Panorama Education is the worked example: nothing on
        # Ashby, Greenhouse or Lever, and seven live jobs on a throttled Workable widget.
        # So any throttled provider at all leaves the company unsettled.
        # A provider that is blocked for the WHOLE run is a known, named coverage gap, not
        # a reason to withhold a verdict on every company. A provider that failed for THIS
        # company alone is a transient miss and is worth re-running. Separating them is
        # what keeps the run useful when one provider is down: the four that answered still
        # settle the question they can settle, and the gap is stated once at the end.
        blind = sorted(dirty - _BLOCKED)
        gap = sorted(dirty & _BLOCKED)
        if prov and live and generic_slug(n, slug):
            check.append((n, prov, slug, live))
            line = (f"  CHECK  {n[:34]:36s} {prov:11s} {slug:24s} {live:4d} live  "
                    f"(one bare word: open the board and confirm the employer)")
        elif prov and live:
            found.append((n, prov, slug, live))
            line = f"  BOARD  {n[:34]:36s} {prov:11s} {slug:24s} {live:4d} live"
        elif prov:
            empty.append((n, prov, slug))
            line = f"  EMPTY  {n[:34]:36s} {prov:11s} {slug:24s}    0 live"
        elif blind:
            unchecked.append(n)
            line = (f"  ?????  {n[:34]:36s} nothing found, but {', '.join(blind)} "
                    f"never answered. NOT settled; re-run this one alone.")
        elif gap:
            none_.append(n)
            line = (f"  none*  {n[:34]:36s} no board on the "
                    f"{len(PROVIDERS) - len(gap)} providers reachable this run")
        else:
            none_.append(n)
            line = (f"  none   {n[:34]:36s} no public board on any of "
                    f"{len(PROVIDERS)} providers, all of which answered")
        if not a.json:
            print(line, flush=True)

    if a.json:
        print(json.dumps({
            "found": [dict(company=c, provider=p, slug=s, live=n) for c, p, s, n in found],
            "check": [dict(company=c, provider=p, slug=s, live=n) for c, p, s, n in check],
            "empty": [dict(company=c, provider=p, slug=s) for c, p, s, _n in empty],
            "none": none_, "unchecked": unchecked,
            **({"urls": url_rows} if url_rows else {})}, indent=1))
        return 0
    print(f"\n{len(found)} convertible, {len(check)} to confirm by hand, "
          f"{len(empty)} board exists but empty, "
          f"{len(none_)} no board on the providers tried, {len(unchecked)} NOT CHECKED "
          f"(rate-limited; re-run those individually)")
    if _BLOCKED:
        print(f"\n  COVERAGE GAP: {', '.join(sorted(_BLOCKED))} blocked this entire run "
              f"after {_STRIKE_LIMIT} consecutive failures, so rows marked none* were "
              f"settled without it.\n  Re-run those against that provider later; a WAF "
              f"block does not decay inside one run.")
    for title, rows in (("Add these to portals.yml:", found),
                        ("Confirm the employer before adding (a one-word slug can be another "
                         "company's board):", check)):
        if not rows:
            continue
        print("\n" + title)
        for c, p, s, n in rows:
            url = {"ashby": f"https://jobs.ashbyhq.com/{s}",
                   # Same board URL; the label records that the jobs came from the page
                   # rather than the posting API, because a scan adapter has to know to
                   # parse __appData instead of calling the API that answers 404.
                   "ashby-embedded": f"https://jobs.ashbyhq.com/{s}",
                   "greenhouse": f"https://job-boards.greenhouse.io/{s}",
                   "lever": f"https://jobs.lever.co/{s}",
                   "workable": f"https://apply.workable.com/{s}",
                   "breezy": f"https://{s}.breezy.hr",
                   "smartrecruiters": f"https://jobs.smartrecruiters.com/{s}"}[p]
            print(f"  {c}: provider {p}, {url}  ({n} live)")
    print_url_entries(url_rows)
    return 0


# ---------------------------------------------------------------- selftest

def _selftest():
    """Offline. Pins the slug and ownership rules, which is where every false negative
    this tool has produced actually lived."""
    bad = 0

    # owns() must derive its core words from the SAME base slugs() uses: the text before
    # the first dash or bracket. portals.yml labels carry descriptive suffixes, and reading
    # the whole label made "Whatnot - Marina del Rey / Remote (AI Dev Tools)" look like a
    # multi-word company, so the correct bare slug "whatnot" was rejected as a first-word
    # collision and a board with 131 live postings was recorded as absent.
    OWNS = [
        ("Whatnot — Marina del Rey / Remote (AI Dev Tools)", "whatnot", None, True,
         "descriptive suffix must not make the bare slug look like a collision"),
        # ...while a genuinely multi-word company still cannot claim its first word alone.
        # "Applied Medical" produced slug "applied", which is Applied INTUITION's board:
        # 299 postings doing Physical AI for defense. The payload here matters. With
        # payload=None the function returns False anyway, for an unrelated reason, so such
        # a case cannot detect the guard being removed. This payload deliberately CONTAINS
        # both "applied" and "medical", which is what a 299-posting blob does by chance,
        # and it is the only shape that exercises the first-word rule.
        ("Applied Medical", "applied",
         {"jobs": [{"title": "Applied ML Engineer"},
                   {"title": "Medical Device Systems Engineer"}]}, False,
         "a two-word company cannot own its first word, even when a large payload happens "
         "to contain both of its words"),
        ("Frost Giant Studios", "frost-giant-studios", None, True,
         "a multi-word slug is self-evidencing"),
    ]
    for name, slug, payload, want, why in OWNS:
        got = owns(name, slug, payload)
        if got != want:
            bad += 1
            print(f"  FAIL owns({name!r}, {slug!r}) -> {got}, want {want}")
            print(f"       {why}")

    # A one-word name found under that bare word is CHECK, not BOARD (2026-10-28: Ashby
    # `moonshot` and `promise` were other companies). Multi-word and hyphenated slugs are not.
    for name, slug, want in (("Moonshot Games", "moonshot", True), ("Promise", "promise", True),
                             ("Jellyfish", "jellyfishcareers", True), ("The Mill", "mill", True),
                             ("TRM Labs", "trm-labs", False), ("Frost Giant Studios", "frostgiant", False),
                             ("Theorycraft Games", "theorycraftgames", False)):
        if generic_slug(name, slug) != want:
            bad += 1
            print(f"  FAIL generic_slug({name!r}, {slug!r}) -> {not want}, want {want}")

    # slugs() must offer the bare core word, since real boards use it, but must not run
    # away: every extra candidate costs one request against every provider.
    cands = slugs("Whatnot — Marina del Rey / Remote (AI Dev Tools)")
    if "whatnot" not in cands:
        bad += 1
        print(f"  FAIL slugs() did not offer the bare company word: {cands}")
    if len(cands) > 8:
        bad += 1
        print(f"  FAIL slugs() returned {len(cands)} candidates, capped at 8")

    # Breezy and Workable answer 200 for ANY account, so an empty board from them proves
    # nothing. Probing them once manufactured boards for meta-careers and amazon.
    for prov in ("breezy", "workable", "smartrecruiters"):
        if prov in EMPTY_IS_EVIDENCE:
            bad += 1
            print(f"  FAIL {prov} must not be in EMPTY_IS_EVIDENCE: it answers 200 for any account")
    for prov in ("ashby", "greenhouse", "lever"):
        if prov not in EMPTY_IS_EVIDENCE:
            bad += 1
            print(f"  FAIL {prov} 404s for an unknown account, so its empty board IS evidence")

    # A 429 is "ask me later", not "no board here". Treating it as an answer reported
    # Panorama Education as having no public board while its widget served seven jobs.
    for code in (0, 429, 500, 503):
        if code not in RETRYABLE:
            bad += 1
            print(f"  FAIL status {code} must be retryable, not read as an answer")
    if 404 in RETRYABLE:
        bad += 1
        print("  FAIL 404 is an answer and must not be retried")

    # --url parsing. Each expectation is (careers_url, cxs or postings api) or None for a
    # refusal. The locale is read by SHAPE: `en-US` and `en` are locales, `Ext` is a site.
    WD = "https://{}.myworkdayjobs.com"
    URLS = [
        ("https://target.wd5.myworkdayjobs.com/en-US/targetcareers/job/"
         "Lead-ML-Engineer_R0000476991",
         (WD.format("target.wd5") + "/targetcareers",
          WD.format("target.wd5") + "/wday/cxs/target/targetcareers/jobs"),
         "a locale before the site is stripped"),
        ("https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/X_26WD161146",
         (WD.format("autodesk.wd1") + "/Ext",
          WD.format("autodesk.wd1") + "/wday/cxs/autodesk/Ext/jobs"),
         "a three-letter SITE is not a locale (a length floor cost eight Autodesk rows)"),
        ("https://autodesk.wd1.myworkdayjobs.com/en-US/Ext",
         (WD.format("autodesk.wd1") + "/Ext",
          WD.format("autodesk.wd1") + "/wday/cxs/autodesk/Ext/jobs"),
         "a board URL, locale then a short site"),
        ("https://nvidia.wd5.myworkdayjobs.com/en/job/US-CA-Remote/X_JR2620896", None,
         "a locale-only posting URL has no site; reading `en` or `job` as one fabricates a "
         "board"),
        ("https://osv-a10networks.wd503.myworkdayjobs.com/en-US/A10CareerSite/job/X_R10001",
         (WD.format("osv-a10networks.wd503") + "/A10CareerSite",
          WD.format("osv-a10networks.wd503") + "/wday/cxs/osv_a10networks/A10CareerSite/jobs"),
         "a hyphenated host keeps its hyphen in careers_url and takes the underscore in "
         "the CXS path, which answers 422 hyphenated"),
        ("https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs",
         (WD.format("nvidia.wd5") + "/NVIDIAExternalCareerSite",
          WD.format("nvidia.wd5") + "/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs"),
         "a CXS API URL reads its site from the path, not `wday`"),
        ("https://nvidia.wd5.myworkdayjobs.com/wday/cxs/target/targetcareers/jobs", None,
         "a CXS path naming another tenant than its host contradicts itself"),
        ("target.wd5.myworkdayjobs.com/en-US/targetcareers",
         (WD.format("target.wd5") + "/targetcareers",
          WD.format("target.wd5") + "/wday/cxs/target/targetcareers/jobs"),
         "a scheme-less URL still converts"),
        # Wrappers: the host is a tracker's, whatever Workday address it carries.
        ("https://tracker.example/r/https://target.wd5.myworkdayjobs.com/targetcareers/job/X",
         None, "a Workday URL inside a tracker's PATH is not this board"),
        ("tracker.example/r/target.wd5.myworkdayjobs.com/targetcareers", None,
         "a scheme-less wrapper is still a wrapper"),
        ("https://tracker.example/c?u=https%3A%2F%2Ftarget.wd5.myworkdayjobs.com%2Ftargetcareers",
         None, "a Workday URL in a tracker's QUERY is not this board"),
        ("https://target.wd5.myworkdayjobs.com.evil.example/targetcareers", None,
         "a host that merely starts like a tenant is not one"),
        ("https://jobs.lever.co/magnopus/abc", None, "a non-Workday ATS is refused"),
        ("https://www.target.com/careers", None, "a company page is refused"),
        ("https://jobs.smartrecruiters.com/Experian/postings/757675447924470",
         ("https://jobs.smartrecruiters.com/Experian",
          "https://api.smartrecruiters.com/v1/companies/Experian/postings"),
         "a SmartRecruiters posting names its company first"),
        ("https://jobs.smartrecruiters.com/fusefx",
         ("https://jobs.smartrecruiters.com/fusefx",
          "https://api.smartrecruiters.com/v1/companies/fusefx/postings"),
         "a SmartRecruiters board URL"),
        ("https://api.smartrecruiters.com/v1/companies/MattelInc/postings?limit=1",
         ("https://jobs.smartrecruiters.com/MattelInc",
          "https://api.smartrecruiters.com/v1/companies/MattelInc/postings"),
         "the SmartRecruiters API URL itself"),
        ("https://t.example.com/r/jobs.smartrecruiters.com/acme/744000012345", None,
         "a SmartRecruiters URL inside a tracker's path is not this board"),
        # Python reads Target as this host; a WHATWG parser reads tracker.example.
        ("https://tracker.example\\@target.wd5.myworkdayjobs.com/Ext", None,
         "a backslash makes the host parser-dependent"),
        ("https://tracker.example@target.wd5.myworkdayjobs.com/targetcareers", None,
         "credentials before a host are a redirect trick"),
        ("https://target.wd5.myworkdayjobs.com@evil.example/targetcareers", None,
         "a tenant host written as credentials is not the host"),
        ("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/en-US/jobs", None,
         "a locale-shaped CXS site cannot round-trip as a careers_url"),
    ]
    for url, want, why in URLS:
        b = board_from_url(url)
        got = None if "refused" in b else (b["careers_url"], b["api"])
        if got != want:
            bad += 1
            print(f"  FAIL board_from_url({url!r})\n       -> {got}\n       want {want}"
                  f"\n       {why}")
    if "backslash" not in board_from_url(
            "https://tracker.example\\@target.wd5.myworkdayjobs.com/Ext").get("refused", ""):
        bad += 1
        print("  FAIL a backslash must be refused for itself, before any parser reads the host")

    # The locale test is req-resolve's WD_LOCALE_ONLY, never a copy. Assembled at runtime
    # so the check cannot match itself, as inbox-liveness does for the same needle.
    src = open(os.path.abspath(__file__), encoding="utf-8").read()
    if "[a-z]{2}(?:-" + "[a-z]{2})?" in src:
        bad += 1
        print("  FAIL this file restates the Workday locale test; read req-resolve's")

    # confirm(), offline: every answer that is not a board must stay short of BOARD and
    # EMPTY, because the line after BOARD is a portals.yml entry.
    wd = board_from_url("https://pacificlife.wd1.myworkdayjobs.com/en-US/PacificLifeCareers")
    sr = board_from_url("https://jobs.smartrecruiters.com/mattelinc/744000012345")
    page = [{"externalPath": f"/job/X/Y_R{i}"} for i in range(20)]

    def wpost(ok, st, body):
        return lambda url, data=None, tries=5: (ok, st, body)

    def sfetch(st, body):
        return lambda url, tries=3: (st, body if isinstance(body, str) else json.dumps(body))

    mattel = {"identifier": "MattelInc", "name": "Mattel"}
    VERDICTS = [
        (wd, wpost(True, 200, {}), None, "NOT CHECKED",
         "a WAF's {} at HTTP 200 is unread, never an empty board"),
        (wd, wpost(True, 200, {"jobPostings": [], "total": 0}), None, "EMPTY",
         "a site that lists nothing is EMPTY, not absent"),
        # A `{}` cannot tell the two required fields apart, since it lacks both: requiring
        # jobPostings alone kept it NOT CHECKED and let an empty list with no total read as
        # EMPTY. That mutant stayed green until this case (2026-10-29).
        (wd, wpost(True, 200, {"jobPostings": []}), None, "NOT CHECKED",
         "an empty list with no total is an unread response, not an empty site"),
        (wd, wpost(True, 200, {"jobPostings": page, "total": True}), None, "NOT CHECKED",
         "a boolean total is not a count"),
        (wd, wpost(True, 200, {"jobPostings": page, "total": 125}), None, "BOARD",
         "a board"),
        (wd, wpost(False, 429, None), None, "NOT CHECKED", "a rate limit is not an answer"),
        (wd, wpost(False, 404, None), None, "UNSETTLED",
         "a 404 is about the URL's site, not the company"),
        (wd, wpost(False, 422, None), None, "UNSETTLED", "a 422 settles nothing"),
        (sr, None, sfetch(200, {"content": [], "totalFound": 0, "offset": 0, "limit": 10}),
         "CHECK", "SmartRecruiters' empty board is served for any id"),
        (sr, None, sfetch(200, {"content": [{"company": mattel}], "totalFound": 334}),
         "BOARD", "a board whose payload names the URL's company"),
        (sr, None, sfetch(200, {"content": [{"company": {"identifier": "OtherCo"}}],
                                "totalFound": 9}),
         "CHECK", "a board answering as another company is not this one"),
        (sr, None, sfetch(429, ""), "NOT CHECKED", "a rate limit is not an answer"),
        (sr, None, sfetch(200, "<html>blocked</html>"), "NOT CHECKED",
         "a 200 that is not JSON is unread"),
        (wd, wpost(True, 201, {"jobPostings": page, "total": 125}), None, "UNSETTLED",
         "only a 200 is a board, whichever transport parsed the body"),
        (sr, None, sfetch(200, {"content": [{"company": "broken"}], "totalFound": 3}),
         "NOT CHECKED", "a malformed company field is unread, and must not crash the batch"),
        (sr, None, sfetch(200, {"content": [{"company": {"identifier": 7}}], "totalFound": 3}),
         "NOT CHECKED", "a non-string identifier is unread"),
    ]
    for board, post, fetch, want, why in VERDICTS:
        got = confirm(board, post=post, fetch=fetch)
        if got["verdict"] != want:
            bad += 1
            print(f"  FAIL confirm({board['careers_url']}) -> {got['verdict']}, want {want}"
                  f"\n       {why}")
    # Target's shape: total at the cap, smallest facet far below it. The scan cannot see
    # that cap, so the line must say so instead of promising a facet walk.
    few = {"facets": [{"facetParameter": "remoteType", "values": [{"id": "r", "count": 25}]}]}
    capped = confirm(wd, post=wpost(True, 200, dict(few, jobPostings=page, total=WD_RESULT_CAP)))
    line = url_line(dict(capped, url="u"))
    if not capped.get("capped") or "2000+" not in line or "no TRUNCATED line" not in line:
        bad += 1
        print(f"  FAIL a total at the search cap must print as a floor, with a warning that "
              f"the scan will not see the cap:\n{line}")
    # NVIDIA's shape: the facets exceed the total, which the scan does see.
    many = {"facets": [{"facetParameter": "jobFamilyGroup",
                        "values": [{"id": "a", "count": 1500}, {"id": "b", "count": 1234}]}]}
    seen = url_line(dict(confirm(wd, post=wpost(True, 200, dict(
        many, jobPostings=page, total=WD_RESULT_CAP))), url="u"))
    if "walks this board by facet" not in seen or "WARNING" in seen:
        bad += 1
        print(f"  FAIL a cap the facets reveal is one the scan walks:\n{seen}")
    # Seen but not splittable: one facet value over the cap leaves both walkers truncated.
    lump = {"facets": [{"facetParameter": "jobFamilyGroup",
                        "values": [{"id": "a", "count": 2734}]}]}
    stuck = url_line(dict(confirm(wd, post=wpost(True, 200, dict(
        lump, jobPostings=page, total=WD_RESULT_CAP))), url="u"))
    if "walks this board by facet" in stuck or "TRUNCATED" not in stuck:
        bad += 1
        print(f"  FAIL a cap no facet splits must not promise a facet walk:\n{stuck}")

    # tracked_as() reads a SmartRecruiters id from SmartRecruiters lines only: an Ashby
    # `acme` must not suppress a new SmartRecruiters `acme`.
    yml = ("\n  - name: Acme Ashby\n    careers_url: https://jobs.ashbyhq.com/acme\n"
           "\n  - name: Mattel\n    careers_url: https://jobs.smartrecruiters.com/MattelInc\n")
    for cid, want in (("acme", None), ("mattelinc", "Mattel")):
        got = tracked_as(dict(provider="smartrecruiters", company_id=cid), portals_text=yml)
        if got != want:
            bad += 1
            print(f"  FAIL tracked_as(smartrecruiters {cid}) -> {got!r}, want {want!r}")

    # probe(), with the transport replaced: an unread SmartRecruiters answer leaves the
    # company unsettled, and a provider with no count field is never asked for one.
    def fake_get(answers):
        def g(url, tries=3):
            for host, ans in answers.items():
                if host in url:
                    return ans
            return 404, ""
        return g
    real_get, real_gap = get, _MIN_INTERVAL
    globals().update(_MIN_INTERVAL=0)
    try:
        globals()["get"] = fake_get({"smartrecruiters": (200, "<html>blocked</html>")})
        _p, _s, _n, dirty = probe("Zyxwvut")
        if "smartrecruiters" not in dirty:
            bad += 1
            print(f"  FAIL an unread SmartRecruiters answer must leave the company unsettled, "
                  f"got dirty={dirty}")
        globals()["get"] = fake_get({"greenhouse": (200, json.dumps({"jobs": [{}], "": 9000000}))})
        _p, _s, n, _d = probe("Zyxwvut")
        if n != 1:
            bad += 1
            print(f"  FAIL a provider with no count field read {n} postings from one")
    finally:
        globals().update(get=real_get, _MIN_INTERVAL=real_gap)
        _STRIKES.clear()
    named = confirm(sr, fetch=sfetch(200, {"content": [{"company": mattel}], "totalFound": 334}))
    if (named.get("careers_url"), named.get("live")) != (
            "https://jobs.smartrecruiters.com/MattelInc", 334):
        bad += 1
        print(f"  FAIL SmartRecruiters must print the API's own id and totalFound: {named}")

    print(f"find-ats selftest: {len(OWNS)} ownership cases + {len(URLS)} url cases + "
          f"{len(VERDICTS) + 4} verdict cases + 2 tracked + 2 probe cases + slug, provider "
          f"and status rules, "
          f"{bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
