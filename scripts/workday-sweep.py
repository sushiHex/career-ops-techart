#!/usr/bin/env python
"""workday-sweep.py — enumerate any Workday tenant's board, rank by lane, gate on location.

nvidia-sweep.py exists because NVIDIA's board hides its location gate behind a bare
"N Locations" label, and resolving each req's detail record was the only way to tell a
Santa Clara onsite from a CA-remote one. That is not an NVIDIA problem. portals.yml
carries twelve Workday tenants (Adobe, Autodesk, Blizzard, CrowdStrike, Disney, Intel,
Mazda, Snap, Sony, Tencent and more) and every one of them renders the same way, so every
one of them has been searched with the same blind spot.

This is nvidia-sweep generalised: same lane scorer (scripts/_lane.py, shared so a fix
reaches both), same detail-resolution step, but the tenant comes from portals.yml and the
location gate is the general three-way verdict from eval-prep rather than NVIDIA's
house spellings of "US, CA, Remote".

Two things it does NOT do, on purpose:

  It does not trust the search endpoint's location string. That string is the "N Locations"
  label. The verdict comes from the detail record's `location` plus `additionalLocations`,
  which is the lesson nvidia-sweep.py records: two reqs one word apart, opposite verdicts.

  It does not rank on title alone. A title-only sweep discarded a req at lane zero whose
  body was squarely in lane. See scripts/_lane.py for why the body decides.

  python scripts/workday-sweep.py --list
  python scripts/workday-sweep.py --tenant crowdstrike
  python scripts/workday-sweep.py --all-tenants --min-lane 4
  python scripts/workday-sweep.py --tenant autodesk --json
  python scripts/workday-sweep.py --selftest
"""
import argparse
import importlib.util
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from _lane import lane_score  # noqa: E402


def _load(mod_name, filename):
    """Import a hyphenated script by path. scripts/ is already on sys.path above, which
    those modules need for their own `from _httpctx import ...` lines."""
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(HERE, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_nv = _load("nvliveness", "nvidia-liveness.py")      # owns CXS transport + retry policy
_prep = _load("evalprep", "eval-prep.py")            # owns the general location gate
_HOME = _prep.LOCATION                               # the configured location policy

# https://{tenant}.wd{n}.myworkdayjobs.com/{site}
TENANT_URL = re.compile(
    r"https://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)")


def portals_path():
    """The user's portals.yml, or CAREER_OPS_PORTALS when set. The selftests point that at
    test-fixtures/portals.yml: portals.yml is User Layer and absent on a fresh clone,
    so a suite that read it passed only on a machine that already had one."""
    return os.environ.get("CAREER_OPS_PORTALS") or os.path.join(ROOT, "portals.yml")


def tenants():
    """Every Workday tenant in portals.yml, as (label, tenant, wd, site, cxs_base)."""
    t = open(portals_path(), encoding="utf-8", errors="replace").read()
    out, seen = [], set()
    for block in re.split(r"\n  - name:", t)[1:]:
        label = block.split("\n")[0].strip()
        m = TENANT_URL.search(block)
        if not m:
            continue
        tenant, wd, site = m.group(1), m.group(2), m.group(3)
        base = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
        if base in seen:
            continue
        seen.add(base)
        out.append(dict(label=label, tenant=tenant, wd=wd, site=site, base=base))
    return out


def enumerate_board(base, pages=150, limit=20, quiet=False):
    """Every posting the tenant will hand over, walking the CXS search endpoint.

    Some tenants reject the plain empty-search payload with 422 (Cloud Imperium does), so a
    422 is reported rather than swallowed: an empty result list from a refused query is not
    the same as a board with no jobs, and recording it as the latter is the silent false
    negative this whole toolchain keeps having to design against.
    """
    # `total` is trustworthy ONLY on the first page. CrowdStrike's tenant answers
    # total=436 at offset 0 and total=0 at every offset after it, so a loop that re-reads
    # total each page terminates on page three and reports 40 of 436 jobs as the whole
    # board. That is the silent truncation this toolchain keeps having to design against:
    # it does not look like an error, it looks like a small employer. Latch the first
    # page's value and let only a short chunk end the walk.
    posts, offset, total, truncated = [], 0, None, False
    for page in range(pages):
        # The page bound is a runaway guard, not a size estimate. Reaching it means the
        # board is bigger than the walk, and saying nothing there is the same silent
        # truncation as the total=0 bug, just with my own number instead of the tenant's:
        # a 40-page cap reported NVIDIA as exactly 800 postings, which is the cap, not the
        # board. If this fires, the caller is told.
        #
        # The bound was still 40 as of 2026-09-20, which means it had been firing on every
        # NVIDIA sweep since: measured that day, NVIDIA's board is 2000 postings, so 40
        # pages saw 40 percent of it and printed TRUNCATED each time. The flag worked and
        # nobody raised the number. It is 150 now, comfortably past the largest tenant
        # known, and the full walk costs about 80 seconds. limit stays 20 because the CXS
        # endpoint refuses limit=100 with an HTTP 400.
        if page == pages - 1:
            truncated = True
        # _req takes the payload as a dict and encodes it itself, in both its urllib and
        # its curl path. Handing it pre-encoded bytes works on the urllib path and then
        # blows up in the curl fallback, which is the path that runs under a TLS failure.
        payload = {"appliedFacets": {}, "limit": limit, "offset": offset, "searchText": ""}
        ok, st, body = _nv._req(base + "/jobs", data=payload)
        if not ok:
            if not quiet:
                print(f"    search failed at offset {offset}: HTTP {st}", file=sys.stderr)
            return posts, st, True
        chunk = (body or {}).get("jobPostings", []) or []
        posts.extend(chunk)
        if total is None:
            total = (body or {}).get("total", 0) or 0
        offset += limit
        if len(chunk) < limit:
            truncated = False
            break
        if total and offset >= total:
            truncated = False
            break
    return posts, 200, truncated


def detail(base, external_path):
    """The req's real location, additional locations and body, or None."""
    ok, _st, body = _nv._req(base + external_path)
    if not ok:
        return None
    info = (body or {}).get("jobPostingInfo", {}) or {}
    return info or None


# Requisition ids as they appear in BOTH a Workday externalPath and a tracker note.
#
# The leading boundary cannot be \b. Workday ends its paths with "..._R26710", and \b does
# not match between "_" and "R" because both are word characters, so a \b-anchored pattern
# silently extracted NOTHING from every externalPath. The visible symptom was an empty req
# column and, worse, tracked=False on every row: the sweep re-reported CrowdStrike's
# already-evaluated GTM Lead AI Engineer as a new find. A dedup key that quietly matches
# nothing is indistinguishable from a board with no duplicates.
# Tenants do not share a requisition format, and a pattern that covers only the ones you
# have seen fails silently on the next tenant rather than loudly. Seen so far:
#   NVIDIA      JR2620896
#   Netflix     JR48085                   <- five digits. A JR-?\d{6,} floor read NOTHING
#                                            here, so every Netflix row was untracked.
#   CrowdStrike R26710, R23555-1
#   Blizzard    R021430
#   Autodesk    26WD161146, 26WD91231-1   <- year-prefixed, matched nothing until added
#   Sony        JR-103209                 <- hyphenated. The R-?\d{5,} branch cannot save
#                                            this one: the lookbehind sees the leading "J"
#                                            and refuses to start matching at the "R".
# Hyphens and underscores are stripped when comparing, so JR-103209, JR_103209 and
# JR103209 are one key. That matches canonId() in the twin named below.
#
# TWIN: pipeline-audit.mjs REQ_ID_SRC holds this same pattern, character for character,
# and the two must be edited together. Python and Node cannot import one another, exactly
# as with the two lane scorers (scripts/_lane.py and rankTitle there), so the only thing
# keeping them equal is this note plus the equality case in that file's --selftest.
#
# They had already drifted in BOTH directions and each half was a silent miss. This file
# knew Autodesk's \d{2}WD form and Node did not, so every 26WD row there fell back to URL
# identity. Node had widened to five digits after JR for the real Netflix id and this file
# had not, so every Netflix req here reported itself untracked and was re-offered as a new
# find. Neither file's floor was the safe one; the pattern below is the union.
REQ_ID = re.compile(
    r"(?<![A-Za-z0-9])(JR[-_]?\d{5,}|\d{2}WD\d{5,}|R[-_]?\d{5,})(?![A-Za-z0-9])")


def canon_req(s):
    """One req, one id. Mirrors canonId() in pipeline-audit.mjs."""
    return s.upper().replace("-", "").replace("_", "")


# A bare Workday "R#####" does not identify a req on its own.
#
# Tenants number from INDEPENDENT counters, so two of them landing on the same number is
# a matter of time rather than a hypothetical: several Workday tenants in portals.yml
# issue bare R##### ids from independent counters, and nothing about the number itself
# says which one a given req belongs to. This sweep compared a swept req id against a set
# built from the WHOLE tracker with no idea which tenant either side came from, so one
# company's tracked id marked another company's live posting `tracked=True` and dropped
# it out of the actionable results. That is the destructive direction: a real lead reads
# as already done and is never looked at again.
#
# Same collision class, same reasoning and the same threshold as jobKey() in
# pipeline-audit.mjs, which was fixed after the same shape of bare-R collision marked an
# unrelated row done at another tenant. A JR or year-prefixed WD id keeps its bare key:
# those ranges are long and tenant-distinctive (NVIDIA JR20xxxxx, Netflix JR4xxxx, Sony
# JR-11xxxx, Autodesk 26WDxxxxx), and that is pre-existing behaviour here and there.
#
# TWIN: pipeline-audit.mjs AMBIGUOUS_ID holds this same pattern, and its --selftest
# reads this file and asserts the two SOURCES are equal, exactly as it already does for
# REQ_ID above. Python and Node cannot import one another, so nothing else notices.
AMBIGUOUS_REQ = re.compile(r"^R\d")

# Company-name normalisation, hand-ported from normCo()/srcCo() in pipeline-audit.mjs
# and kept in that order: strip a trailing parenthetical, fold to alphanumerics, drop the
# seniority words, then drop the corporate suffixes. The tracker has no Workday tenant in
# it, so the company cell is the ONLY disambiguator available on that side, and the two
# sides spell it differently: portals.yml labels append a note ("CrowdStrike <dash>
# Applied / Agentic AI (Remote / LA)", "Adobe (Firefly)", "Blizzard Entertainment") while
# the tracker carries the bare name. Without this the join would fail on every tenant and
# every tracked req would be re-offered as a new find, which is the cheap direction of
# the error but still noise.
_CO_SUFFIX = re.compile(
    r"\b(inc|llc|ltd|limited|corp|corporation|co|company|holdings|group|technologies|"
    r"technology|labs|lab|studios|studio|games|gaming|entertainment|interactive|"
    r"industries|systems|software|ai|io)\b")
_NAME_NOISE = re.compile(r"\b(senior|sr|staff|principal|lead|the|a|an|of|and|for)\b")
# Built by code point rather than typed: nothing in this repository may contain that
# character literally. Same reason pipeline-audit.mjs builds its copy with fromCharCode.
_EM_DASH = chr(0x2014)


def norm_co(s):
    """A company name as a comparable token. Mirrors normCo() in pipeline-audit.mjs."""
    s = re.sub(r"[^a-z0-9]+", " ", str(s or "").split("(")[0].lower())
    s = _NAME_NOISE.sub(" ", s)
    s = _CO_SUFFIX.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def src_co(s):
    """The company as portals.yml spells it. Mirrors srcCo() in pipeline-audit.mjs.

    Both dashes are cut, because a label whose annotation survives normalisation reads as
    a different company from the tracker's and the join then fails in silence.
    """
    head = str(s or "").split(_EM_DASH)[0].split(" -- ")[0].split("|")[0]
    return norm_co(re.sub(r"\\?\[.*?\\?\]", "", head))


def tracked_key(req, company):
    """The dedup key for one requisition, scoped by company when the id needs it.

    An ambiguous id is only ever a key when something else pins it down. On this side
    that is the company, because neither the tracker row nor the portals.yml label
    carries a Workday tenant. Both sides call this, so they cannot key differently.
    """
    rid = canon_req(req)
    return f"{rid}@{src_co(company)}" if AMBIGUOUS_REQ.match(rid) else rid


def tracked_urls(path=None):
    """Job ids already on the tracker, so the sweep reports only what is new.

    Read ROW BY ROW rather than as one blob of text, because an ambiguous id means
    nothing without the company cell sitting beside it on the same line. All 147 req ids
    in the tracker today live inside numbered rows, so nothing is lost by it.
    """
    p = path or os.path.join(ROOT, "data", "applications.md")
    if not os.path.exists(p):
        return set()
    keys = set()
    for line in open(p, encoding="utf-8", errors="replace"):
        if not line.startswith("|"):
            continue
        cells = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(cells) < 4 or not re.fullmatch(r"\d+", cells[0]):
            continue
        for m in REQ_ID.finditer(line):
            keys.add(tracked_key(m.group(1), cells[2]))
    return keys


def remote_type_says_remote(value):
    """Workday's remoteType label, read as a remote signal only when it says remote:
    'Fully Remote' and 'Remote Customer-Based' do; 'Fully On-Site', 'Office - Flexible'
    and 'Primarily On-Site / Occasionally from Home' do not."""
    return bool(re.match(r"\s*(?:fully\s+)?remote\b", str(value or ""), re.I))


def sweep(entry, min_lane=2, pages=150, quiet=False, keep_all=False,
          prefilter=0):
    base, label = entry["base"], entry["label"]
    posts, st, truncated = enumerate_board(base, pages=pages, quiet=quiet)
    if not quiet:
        # A failed request and a hit page-cap are both "incomplete", but the fix differs:
        # Cloud Imperium answers 422 to the standard empty-search payload, and telling
        # someone to raise --pages there sends them the wrong way entirely.
        warn = ("  <-- REQUEST REFUSED, this tenant needs a different search payload"
                if (truncated and st != 200)
                else "  <-- TRUNCATED, board is larger; raise --pages" if truncated else "")
        print(f"  {label[:44]:46s} {len(posts):4d} postings (HTTP {st}){warn}",
              file=sys.stderr)
    if not posts:
        return [], st

    # Cheap prefilter so the detail fetches stay bounded. One detail fetch per posting
    # across fifteen tenants is thousands of requests, but the bar has to stay at ZERO
    # rather than anything positive: a req titled "AI Automation Engineer, Security"
    # scored exactly 0 on its title and its body was squarely in lane. A prefilter of +1
    # would have discarded it, which is the original mistake with a cheaper excuse.
    # Titles scoring below the floor are the decisively wrong ones: sales, quota, ASIC.
    known = tracked_urls()
    cands = []
    for p in posts:
        title = p.get("title", "") or ""
        if not keep_all and lane_score(title) < prefilter:
            continue
        cands.append(p)

    rows = []
    for p in cands:
        ep = p.get("externalPath", "") or ""
        info = detail(base, ep)
        if not info:
            continue
        body_txt = re.sub(r"<[^>]+>", " ", info.get("jobDescription", "") or "")[:6000]
        title = info.get("title", p.get("title", ""))
        lane = lane_score(title, body_txt)
        if min_lane is not None and lane < min_lane and not keep_all:
            continue
        extra = info.get("additionalLocations", []) or []
        loc = info.get("location", "") or ""
        # remote_flag is meant to be the ATS's own structured signal, used only to settle
        # a location string the policy cannot otherwise read. Deriving it from the same
        # string location_verdict is judging makes it true whenever the word "remote"
        # appears at all, which turns every unrecognised region ("Remote - Latin America",
        # "Remote - Africa") into an automatic pass instead of a question. Workday's detail
        # record carries its own remoteType field; trust that, or nothing. It is a label,
        # not a boolean, and most tenants fill it for every posting ("Fully On-Site",
        # "Office - Flexible"), so only a label that SAYS remote counts.
        verdict, why = _prep.location_verdict(
            " | ".join([loc] + list(extra)), remote_type_says_remote(info.get("remoteType")))
        m = REQ_ID.search(ep) or REQ_ID.search(json.dumps(info)[:2000])
        req = canon_req(m.group(1)) if m else ""
        rows.append(dict(
            company=label, req=req, title=title, lane=lane,
            live=bool(info.get("canApply")), location=loc, additional=list(extra),
            # Scoped by company: a bare R number is one tenant's counter, and matching
            # it across tenants marked a live posting as already done.
            verdict=verdict, why=why,
            tracked=bool(req and tracked_key(req, label) in known),
            url=f"https://{entry['tenant']}.{entry['wd']}.myworkdayjobs.com/"
                f"{entry['site']}{ep}"))
    return rows, st


def partition(rows):
    """Split swept rows into what the candidate can act on and what still needs a location call.

    PASS and UNKNOWN are different answers and must never share a list. The per-tenant
    output already separated them, and then the closing summary merged them straight back
    with a single `verdict != "fail"` filter, printed under the heading "not
    location-blocked" and counted as one number. An unrecognised city (Lehi, Seattle,
    Austin) returns "unknown", which means "someone look at this", not "the candidate can work here",
    so a Utah role read exactly like a remote-US one in the list that is actually worked.

    Returns (actionable, needs_call). Both are live and untracked; a "fail" is in neither.
    """
    live_new = [r for r in rows if r["live"] and not r["tracked"]]
    return ([r for r in live_new if r["verdict"] == "pass"],
            [r for r in live_new if r["verdict"] == "unknown"])


def _print_row(r, raw=False):
    """One swept row. `raw` prints every location string rather than the first six."""
    print(f"\n[lane {r['lane']:+d}]  {r['company'][:34]}  {r['req']}")
    print(f"   {r['title'][:78]}")
    print(f"   loc : {r['location']}  [{r['verdict']}] {r['why'][:50]}")
    if r["additional"]:
        # Show the count, and never silently hide the tail. The verdict is computed
        # over EVERY additional location, so truncating the display to six made an
        # "unknown" look unexplainable: the Canadian entry that caused it sat at
        # position seven and the row read as a clean US-remote list. An unknown row is
        # printed so that a human can SETTLE it, and the string that settles it is as
        # likely to be the twelfth as the first, so that section truncates nothing.
        extra = r["additional"]
        shown = extra if raw else extra[:6]
        more = f"  (+{len(extra) - len(shown)} more, all of which the verdict used)" \
            if len(extra) > len(shown) else ""
        print(f"   also ({len(extra)}): {', '.join(shown)}{more}")
    print(f"   url : {r['url']}")


def _selftest():
    """Routing and parsing only. No network."""
    # Parse the test fixture, never the user's own file: see portals_path().
    os.environ["CAREER_OPS_PORTALS"] = os.path.join(ROOT, "test-fixtures", "portals.yml")
    bad = 0
    cases = [
        ("https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers",
         ("crowdstrike", "wd5", "crowdstrikecareers")),
        ("https://autodesk.wd1.myworkdayjobs.com/Ext", ("autodesk", "wd1", "Ext")),
        ("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite",
         ("nvidia", "wd5", "NVIDIAExternalCareerSite")),
        ("https://xboxgaming.wd1.myworkdayjobs.com/Blizzard_External_Careers",
         ("xboxgaming", "wd1", "Blizzard_External_Careers")),
        ("https://sonyglobal.wd1.myworkdayjobs.com/SonyGlobalCareers",
         ("sonyglobal", "wd1", "SonyGlobalCareers")),
        ("https://boards.greenhouse.io/anthropic", None),
    ]
    for url, want in cases:
        m = TENANT_URL.search(url)
        got = (m.group(1), m.group(2), m.group(3)) if m else None
        if got != want:
            bad += 1
            print(f"  FAIL url parse {url}\n       want {want} got {got}")

    found = tenants()
    if len(found) < 8:
        bad += 1
        print(f"  FAIL portals.yml yielded only {len(found)} Workday tenants, expected 8+")
    labels = " ".join(e["tenant"] for e in found)
    for must in ("nvidia", "crowdstrike", "autodesk"):
        if must not in labels:
            bad += 1
            print(f"  FAIL tenant {must} not discovered in portals.yml")
    # Every discovered base must be a CXS path, not the human-facing board URL. Sweeping
    # the human URL returns HTML and reads as an empty board.
    for e in found:
        if "/wday/cxs/" not in e["base"]:
            bad += 1
            print(f"  FAIL {e['tenant']} base is not a CXS endpoint: {e['base']}")

    # Requisition-id extraction. The underscore case is the one that shipped broken and
    # made every row look untracked, so it leads.
    req_cases = [
        ("/job/USA---Remote-CA/Lead-AI-Engineer--GTM-Applications--Remote-_R26710", "R26710"),
        ("/job/Santa-Clara-CA/Senior-Engineer_JR2620896", "JR2620896"),
        ("/job/USA---Remote/Data-Scientist--Remote-_R23555-1", "R23555"),
        ("Lead AI Engineer, GTM Applications (Remote) — R26710", "R26710"),
        ("requisition JR2778170 is live", "JR2778170"),
        # Autodesk's year-prefixed format. Matched nothing until it was added, so every
        # Autodesk row reported itself untracked.
        ("/job/Toronto-ON-CAN/Principal-MCP-AI-Developer_26WD91231-1", "26WD91231"),
        ("/job/Toronto-ON-CAN/Software-Developer--MCP-AI_26WD93101-1", "26WD93101"),
        ("/job/Toronto-ON-CAN/Principal-MCP-AI-Developer_26WD161146", "26WD161146"),
        # Netflix writes five digits after JR. The old JR-?\d{6,} floor here read
        # nothing at all, so every Netflix req reported itself untracked and was
        # re-offered as a new find on every sweep. pipeline-audit.mjs had already
        # widened for this one and this file had not; that is the drift the TWIN
        # note above exists to stop.
        ("/job/USA---Remote/Member-of-Technical-Staff--Agentic-Systems---Games_JR48085",
         "JR48085"),
        ("Netflix req JR48085 is already on the tracker", "JR48085"),
        # Underscore-separated, which canon_req must fold the same way as a hyphen.
        ("/job/NA--Culver-City/Sr-Software-Engineer_JR_103209", "JR103209"),
        # Four digits is the DATE inside a report filename slug, not a requisition.
        # Dropping the floor to four to catch a short id would mint the key JR2026
        # off every report written in 2026.
        ("Report 268-acme-agentic-systems-JR-2026-07-07.md", None),
        ("/job/Irvine---Blizzard/Senior-Program-Manager_R021430", "R021430"),
        # Sony's hyphenated form. The R-?\d{5,} branch cannot rescue it, because the
        # lookbehind sees the leading "J" and will not begin matching at the "R".
        ("/job/NA--Culver-City/Sr-Software-Engineer--AI-Native_JR-103209", "JR103209"),
        ("no requisition here at all", None),
        # must not match a longer alphanumeric token that merely contains a digit run
        ("/job/x/Some-Role-ABCR123456XYZ", None),
    ]
    for text, want in req_cases:
        m = REQ_ID.search(text)
        got = canon_req(m.group(1)) if m else None
        if got != want:
            bad += 1
            print(f"  FAIL req id from {text[:56]!r}\n       want {want} got {got}")

    # The tracker must actually yield ids, or dedup silently passes everything through.
    # Run against a FIXTURE tracker, never the user's own data/applications.md, and with
    # fictional employers: the property under test is company-scoped keying, which needs
    # only that two tenants land on the same bare number, not which real employers do.
    import tempfile
    fx = os.path.join(tempfile.mkdtemp(prefix="wdsweep-"), "applications.md")
    with open(fx, "w", encoding="utf-8") as fh:
        fh.write("| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n"
                 "|---|---|---|---|---|---|---|---|---|\n")
        for n, (co, role) in enumerate([
                ("Acme", "Lead AI Engineer, GTM Applications (R26710)"),
                ("Acme", "Staff Engineer (R25523)"),
                ("Initech", "Principal Engineer (R14095)"),
                ("Globex", "Senior AI Engineer (R11095)"),
                ("Umbrella Corp", "Senior Technical Artist (R012018)"),
                ("Massive Dynamic", "Senior Software Engineer (JR2620896)"),
                ("Stark Industries", "Senior ML Engineer (26WD161146)")], start=1):
            fh.write(f"| {n} | 2026-08-01 | {co} | {role} | 4.0/5 | Evaluated | x | "
                     f"[{n}](reports/{n:03d}.md) | fixture |\n")
    known = tracked_urls(fx)
    if len(known) < 5:
        bad += 1
        print(f"  FAIL tracked_urls returned only {len(known)} req ids; dedup would be a no-op")
    if tracked_key("R26710", "Acme") not in known:
        bad += 1
        print("  FAIL tracked_urls missed R26710 at Acme, which is on the fixture")
    # ...and the same id must NOT read as tracked under another employer. This is the
    # whole finding: the set was built from the whole tracker with no company on it, so
    # one tenant's R26710 would have retired an unrelated tenant's posting numbered the
    # same, and several real Workday tenants do land on shared bare numbers this way.
    if tracked_key("R26710", "Umbrella Corp") in known:
        bad += 1
        print("  FAIL an Acme req id marks an Umbrella Corp posting as already tracked")

    # Requisition keying. The costs are not symmetric: a wrong `tracked` hides a live
    # role for good, while a missed one only re-offers a known req.
    key_cases = [
        # An ambiguous bare R id carries its company; two employers sharing a number do
        # not collide. Named rather than merely compared, because two different strings
        # are unequal even with the scoping deleted, and a case that cannot fail is not
        # a case.
        ("R26710 at Acme is company-scoped",
         tracked_key("R26710", "Acme") == "R26710@acme"),
        ("Globex and Initech R11095 are different keys",
         tracked_key("R11095", "Globex") == "R11095@globex"
         and tracked_key("R11095", "Initech") == "R11095@initech"),
        # portals.yml labels append a location and a focus area after the name; the
        # tracker carries the bare name. Both must land on one key or the join fails
        # for every tenant at once.
        ("a portals.yml label keys the same as the tracker's bare name",
         tracked_key("R26710", f"Acme {_EM_DASH} Applied / Agentic AI (Remote / LA)")
         == tracked_key("R26710", "Acme")),
        ("the ASCII double-dash label form keys the same too",
         tracked_key("R26710", "Acme -- Applied / Agentic AI")
         == tracked_key("R26710", "Acme")),
        ("Acme (Special Projects) keys the same as Acme",
         tracked_key("R169734", "Acme (Special Projects)") == tracked_key("R169734", "Acme")),
        ("Umbrella Corp Entertainment keys the same as Umbrella Corp",
         tracked_key("R012018", "Umbrella Corp Entertainment")
         == tracked_key("R012018", "Umbrella Corp")),
        ("Globex (Hardware) keys the same as Globex",
         tracked_key("R0135336", "Globex (Hardware)")
         == tracked_key("R0135336", "Globex")),
        # A JR or year-prefixed WD id keeps its bare key. Those ranges are long and
        # tenant-distinctive, and this is pre-existing behaviour on both sides.
        ("a JR id keeps a bare, company-free key",
         tracked_key("JR2620896", "Massive Dynamic") == "JR2620896"
         and tracked_key("JR2620896", "Some Other Co") == "JR2620896"),
        ("a 26WD id keeps a bare key",
         tracked_key("26WD161146", "Stark Industries") == "26WD161146"),
        # The canonicalisation is canon_req's, not a second one: hyphen, underscore and
        # bare spellings of one req are one key on both halves.
        ("hyphen and bare spellings of an R id share a key",
         tracked_key("R-11295", "Initech") == tracked_key("R11295", "Initech")),
    ]
    for label, ok in key_cases:
        if not ok:
            bad += 1
            print(f"  FAIL req key: {label}")

    # Pagination, offline. CrowdStrike's tenant reports total=436 on the first page and
    # total=0 on every page after, which once truncated a 436-job board to its first 40
    # and read as a small employer rather than as a bug. The walk must survive that.
    def fake_board(board_size, total_after_first=0, limit=20):
        calls = []

        def _fake(url, data=None, tries=5):
            off = (data or {}).get("offset", 0)
            lim = (data or {}).get("limit", limit)
            calls.append(off)
            chunk = [{"title": f"Job {i}", "externalPath": f"/job/x/J{i}"}
                     for i in range(off, min(off + lim, board_size))]
            total = board_size if off == 0 else total_after_first
            return True, 200, {"total": total, "jobPostings": chunk}
        return _fake, calls

    real_req = _nv._req
    try:
        for label, size, after, want_pages in [
            ("total drops to 0 after page 1", 436, 0, 436),
            ("total stays honest", 55, 55, 55),
            ("board smaller than one page", 7, 7, 7),
            ("total lies high, chunks run out", 30, 999, 30),
        ]:
            _nv._req, _calls = fake_board(size, after)
            got, _st, trunc = enumerate_board("https://x/wday/cxs/t/s", pages=40,
                                              limit=20, quiet=True)
            if len(got) != want_pages:
                bad += 1
                print(f"  FAIL pagination [{label}]: got {len(got)} postings, "
                      f"want {want_pages}")
            if trunc:
                bad += 1
                print(f"  FAIL pagination [{label}]: reported truncated when the "
                      f"whole board fit")
        # A board bigger than the page bound MUST announce itself. NVIDIA came back as
        # exactly 800 postings (40 pages x 20) and that read as a board size.
        _nv._req, _ = fake_board(5000, 5000)
        got, _st, trunc = enumerate_board("https://x/wday/cxs/t/s", pages=5, limit=20,
                                          quiet=True)
        if not trunc or len(got) != 100:
            bad += 1
            print(f"  FAIL page-cap truncation not reported: got {len(got)} "
                  f"postings, truncated={trunc}; want 100 and True")
    finally:
        _nv._req = real_req

    # PASS and UNKNOWN are different answers and must never share a list. The per-tenant
    # output separated them correctly and then the closing summary merged them back with
    # `verdict != "fail"`, so a Lehi row was counted and printed as though the gate had
    # cleared it. Asserted on the partition rather than on the printing, because the
    # printing is where it LOOKED right.
    def _row(verdict, live=True, tracked=False, why="location not recognised"):
        return dict(company="Acme", req="R1", title="Agent Engineer", lane=3, live=live,
                    location="Lehi, Utah", additional=[], verdict=verdict, why=why,
                    tracked=tracked, url="https://x/job/1")

    part_rows = [_row("pass"), _row("unknown"), _row("fail"),
                 _row("pass", live=False), _row("pass", tracked=True),
                 _row("unknown", live=False), _row("unknown", tracked=True),
                 _row("fail", live=False)]
    act, maybe = partition(part_rows)
    part_checks = 0
    for label, got, want in (("actionable", act, 1), ("needs-a-call", maybe, 1)):
        part_checks += 1
        if len(got) != want:
            bad += 1
            print(f"  FAIL partition: {label} held {len(got)} row(s), want {want}")
    part_checks += 1
    if any(r["verdict"] != "pass" for r in act):
        bad += 1
        print("  FAIL partition: a non-pass reached the actionable list; 'unknown' means "
              "someone look at this, not the candidate can work here")
    part_checks += 1
    if any(r["verdict"] != "unknown" for r in maybe):
        bad += 1
        print("  FAIL partition: a pass or a fail reached the needs-a-location-call list")
    part_checks += 1
    if any(not r["live"] or r["tracked"] for r in act + maybe):
        bad += 1
        print("  FAIL partition: a dead or already-tracked row reached a work list")
    # A sweep with nothing unknown must still behave, since that is the common case and
    # the one where an off-by-one in the split would go unnoticed.
    act, maybe = partition([_row("pass"), _row("fail")])
    part_checks += 1
    if (len(act), len(maybe)) != (1, 0):
        bad += 1
        print(f"  FAIL partition: all-pass sweep split to {len(act)}/{len(maybe)}, want 1/0")

    # remoteType is a label every posting carries on some tenants, on-site ones included.
    # Read as a truthy string it promoted every "Fully On-Site" req on a bare "United
    # States" location to a remote-US pass.
    remote_cases = [("Fully Remote", True), ("Remote Customer-Based", True), ("Fully On-Site", False),
                    ("Office - Flexible", False), ("Primarily On-Site / Occasionally from Home", False),
                    (None, False), ("", False)]
    for label, want in remote_cases:
        if remote_type_says_remote(label) != want:
            bad += 1
            print(f"  FAIL remoteType {label!r} read as remote={not want}")
    onsite = _prep.location_verdict("United States", remote_type_says_remote("Fully On-Site"))[0]
    if onsite == "pass":
        bad += 1
        print("  FAIL a Fully On-Site posting on a bare 'United States' location passed as remote")
    # sweep() needs the network to exercise, so its call site is checked in the source: the
    # label must go through the reader above, never straight into a truthiness test.
    src = open(os.path.abspath(__file__), encoding="utf-8").read()
    body = src[src.index("def sweep("):src.index("def partition(")]
    if "remote_type_says_remote(info.get(\"remoteType\"))" not in body or "bool(info.get(\"remoteType\"))" in body:
        bad += 1
        print("  FAIL sweep() does not read remoteType through remote_type_says_remote()")

    print(f"workday-sweep selftest: {len(cases)} url cases + "
          f"{len(found)} discovered tenants + {len(req_cases)} req-id cases + "
          f"{len(key_cases)} req-key cases + 4 pagination "
          f"cases + 1 page-cap case + {part_checks} partition cases + "
          f"{len(remote_cases) + 1} remoteType cases, {bad} failure(s)")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tenant", help="sweep one tenant by its Workday tenant name")
    ap.add_argument("--all-tenants", action="store_true", help="sweep every tenant found")
    ap.add_argument("--skip", default="",
                    help="comma-separated tenants to skip (nvidia has its own "
                         "dedicated sweeper and is the slowest board by far)")
    ap.add_argument("--list", action="store_true", help="list discovered tenants and exit")
    ap.add_argument("--min-lane", type=int, default=None,
                    help="lane floor (default 2; 0 when the vocabulary has only penalties; "
                         "none when it is empty, since every title would then score 0)")
    # 40 pages x 20 = 800 postings, which covers every tenant here (CrowdStrike, the
    # largest, carries 436). A page bound that is lower than the board silently truncates
    # in exactly the way the total=0 bug did, so it is set above the real boards rather
    # than at a round-looking number.
    ap.add_argument("--pages", type=int, default=150, help="search pages per tenant")
    ap.add_argument("--keep-all", action="store_true", help="no lane or location filtering")
    ap.add_argument("--prefilter", type=int, default=0,
                    help="title-lane floor for spending a detail fetch "
                         "(default 0, which KEEPS zero-scoring titles; use "
                         "-4 for a deeper, slower sweep)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--print-min-lane", action="store_true",
                    help="print the lane floor this run would use, then exit")
    a = ap.parse_args()
    import _lane as _lane_mod
    a.min_lane = _lane_mod.resolve_min_lane(a.min_lane)
    if a.print_min_lane:
        print("none" if a.min_lane is None else a.min_lane)
        return 0

    if a.selftest:
        return _selftest()

    found = tenants()
    if a.list:
        print(f"{len(found)} Workday tenants in portals.yml")
        for e in found:
            print(f"  {e['tenant']:18s} {e['wd']:5s} {e['site'][:30]:32s} {e['label'][:40]}")
        return 0

    if a.tenant:
        found = [e for e in found if e["tenant"] == a.tenant]
        if not found:
            print(f"no tenant named {a.tenant!r}; try --list", file=sys.stderr)
            return 2
    elif not a.all_tenants:
        ap.error("give --tenant NAME, --all-tenants, or --list")

    skip = {s.strip().lower() for s in a.skip.split(",") if s.strip()}
    if skip:
        before = len(found)
        found = [e for e in found if e["tenant"].lower() not in skip]
        print(f"skipping {before - len(found)} tenant(s): {', '.join(sorted(skip))}",
              file=sys.stderr)

    rows = []
    for e in found:
        r, _st = sweep(e, min_lane=a.min_lane, pages=a.pages,
                       quiet=a.json, keep_all=a.keep_all,
                       prefilter=a.prefilter)
        rows.extend(r)
        # Emit each tenant's hits as soon as that tenant finishes. A fifteen-tenant run
        # takes long enough that it will sometimes be killed or interrupted, and a version
        # that printed only a final sorted block lost everything when that happened. The
        # closing summary still prints the full ranked list; this is so a partial run is
        # still worth something.
        if not a.json:
            live_new = [x for x in r if x["live"] and not x["tracked"]]
            # PASS and UNKNOWN are different answers and must not share a list. An
            # unrecognised city (Lehi, Seattle, Austin) returns "unknown", which means
            # "someone look at this", not "the candidate can work here". Printing them together made
            # a Utah role read exactly like a remote-US one.
            hits = [x for x in live_new if x["verdict"] == "pass"]
            maybe = [x for x in live_new if x["verdict"] == "unknown"]
            print(f"  -> {len(hits)} actionable, {len(maybe)} needing a location call, "
                  f"at {e['tenant']}", file=sys.stderr)
            for label, group in (("", hits), ("?", maybe)):
                for x in group:
                    # Show the location that EARNED the verdict, not just the primary.
                    # NVIDIA JR2812232 reads "US, CA, Santa Clara" and passes only because
                    # "US, CA, Remote" sits in additionalLocations. Printing the primary
                    # alone makes a correct verdict look like a bug, which is how the
                    # original JR2620896 miss happened in the first place.
                    why = ""
                    if x["additional"]:
                        key = next((a for a in x["additional"]
                                    if _HOME.names_home(a)), None)
                        why = (f"  (+{len(x['additional'])} more"
                               + (f", incl. {key}" if key else "") + ")")
                    print(f"   {label:1s} [lane {x['lane']:+d}] {x['req']:10s} "
                          f"{x['title'][:56]}\n"
                          f"                 {x['location'][:44]}{why}\n"
                          f"                 {x['url']}", flush=True)

    rows.sort(key=lambda r: (-r["lane"], r["company"]))
    if a.json:
        print(json.dumps({"count": len(rows), "rows": rows}, indent=1))
        return 0

    actionable, needs_call = partition(rows)
    # Both numbers, always. A single count under one heading is what let the unknowns
    # pass for passes; printing them apart but summarising them together would put the
    # conflation right back into the line most likely to be read.
    print(f"\n{len(rows)} at lane >= {a.min_lane if a.min_lane is not None else 'any'}; "
          f"{len(actionable)} ACTIONABLE (live, untracked, location passes); "
          f"{len(needs_call)} live and untracked but location UNKNOWN")
    print("=" * 96)
    for r in actionable:
        _print_row(r)
    if needs_call:
        print("\n" + "=" * 96)
        print(f"NOT ACTIONABLE: {len(needs_call)} row(s) whose location the gate could "
              f"not read.")
        print("These are not passes. Open each posting and settle the location before "
              "treating")
        print("any of them as reachable; the raw strings the gate saw are printed in full.")
        print("=" * 96)
        for r in needs_call:
            _print_row(r, raw=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
