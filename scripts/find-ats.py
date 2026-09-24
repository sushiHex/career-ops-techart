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

  python scripts/find-ats.py "Frost Giant Studios" "Dreamhaven"
  python scripts/find-ats.py --handoff          # every websearch-only company in portals.yml
  python scripts/find-ats.py --handoff --json
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
]
RETRYABLE = {0, 429, 500, 502, 503, 504}
BOARD_PAGE = "https://jobs.ashbyhq.com/{s}"
import _ashby_embed  # noqa: E402  (same directory; see ashby_embedded below)
# Providers that answer 404 for an unknown account, so an empty board from them is a
# real finding. Breezy serves an empty JSON list with HTTP 200 for ANY subdomain and
# Workable serves a non-JSON body, so their empties prove nothing: probing them
# manufactured boards for meta-careers, amazon and apple-careers that do not exist.
EMPTY_IS_EVIDENCE = {"ashby", "greenhouse", "lever"}

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
                continue
            try:
                d = json.loads(body)
            except Exception:
                continue
            jobs = d.get(key, []) if (key and isinstance(d, dict)) else d
            n = len(jobs) if isinstance(jobs, list) else 0
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


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*")
    ap.add_argument("--handoff", action="store_true",
                    help="probe every scan_method: websearch company in portals.yml")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="stop after N companies")
    if "--selftest" in sys.argv:
        return _selftest()
    a = ap.parse_args()
    names = a.names + (handoff_companies() if a.handoff else [])
    if not names:
        ap.error("give company names or --handoff")
    if a.limit:
        names = names[:a.limit]

    found, empty, none_, unchecked = [], [], [], []
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
        if prov and live:
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
            "empty": [dict(company=c, provider=p, slug=s) for c, p, s, _n in empty],
            "none": none_, "unchecked": unchecked}, indent=1))
        return 0
    print(f"\n{len(found)} convertible, {len(empty)} board exists but empty, "
          f"{len(none_)} no board on the providers tried, {len(unchecked)} NOT CHECKED "
          f"(rate-limited; re-run those individually)")
    if _BLOCKED:
        print(f"\n  COVERAGE GAP: {', '.join(sorted(_BLOCKED))} blocked this entire run "
              f"after {_STRIKE_LIMIT} consecutive failures, so rows marked none* were "
              f"settled without it.\n  Re-run those against that provider later; a WAF "
              f"block does not decay inside one run.")
    if found:
        print("\nAdd these to portals.yml:")
        for c, p, s, n in found:
            url = {"ashby": f"https://jobs.ashbyhq.com/{s}",
                   # Same board URL; the label records that the jobs came from the page
                   # rather than the posting API, because a scan adapter has to know to
                   # parse __appData instead of calling the API that answers 404.
                   "ashby-embedded": f"https://jobs.ashbyhq.com/{s}",
                   "greenhouse": f"https://job-boards.greenhouse.io/{s}",
                   "lever": f"https://jobs.lever.co/{s}",
                   "workable": f"https://apply.workable.com/{s}",
                   "breezy": f"https://{s}.breezy.hr"}[p]
            print(f"  {c}: provider {p}, {url}  ({n} live)")
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
    for prov in ("breezy", "workable"):
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

    print(f"find-ats selftest: {len(OWNS)} ownership cases + slug, provider and status "
          f"rules, {bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
