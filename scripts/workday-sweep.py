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
import datetime
import importlib.util
import json
import os
import re
import sys
import urllib.parse

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
        base = _prep.rr.cxs_base(tenant, wd, site)
        if base in seen:
            continue
        seen.add(base)
        out.append(dict(label=label, tenant=tenant, wd=wd, site=site, base=base,
                        facets=slice_of(block, label)))
    return out


def slice_of(block, label):
    """A portals.yml entry's `workday_facets` slice as CXS appliedFacets, or None.

    Written as one JSON line (also valid YAML flow style) so this reader needs no YAML
    parser; providers/workday.mjs sliceOf() reads the same key through js-yaml. A malformed
    slice raises rather than widening to the whole board, which for CVS Health is 19,799
    postings."""
    if not re.search(r"^\s+workday_facets:", block, re.M):
        return None
    # The key is present, so anything but the one-line JSON form is an error: returning
    # None here would walk the whole board (Codex: garbage, multi-line YAML and a trailing
    # comment were all read as "no slice").
    m = re.search(r"^\s+workday_facets:\s*(\{.*\})\s*$", block, re.M)
    try:
        f = json.loads(m.group(1)) if m else None
    except ValueError:
        f = None
    if not (isinstance(f, dict) and f and all(isinstance(v, list) and v and all(isinstance(x, str) and x for x in v)
                                             for v in f.values())):
        raise ValueError(f"portals.yml {label}: workday_facets must be one JSON line mapping a facet to value ids")
    return f


def facet_total(body, exclude=()):
    """The board's real size from a first page's facets, or 0 when it publishes none.

    Workday's search CAPS what it will hand over: NVIDIA answers `total: 2000` and serves
    exactly 2000 postings while its own facet counts sum to 2732 (2026-10-18), and 526 reqs
    a keyword search returns were absent from the "complete" walk. A capped walk ends
    cleanly at the cap, so it looked like a whole board, and inbox-liveness closed rows
    from it: NVIDIA JR2110993 was retired as "no longer on the company board" while it was
    live and CA-remote. The SMALLEST flat-facet sum is the estimate, not the largest: a
    facet that files a multi-location posting under every location overcounts (Autodesk's
    State_Region sums to 538 on a board of 308), and the first version took that maximum,
    called a whole board capped and returned 185 of its 308 postings. A facet some postings
    lack undercounts, which errs toward "not capped", the safe side. Nested facets
    (locationMainGroup) carry no counts of their own and are skipped.
    """
    sums = []
    for f in (body or {}).get("facets") or []:
        if f.get("facetParameter") in exclude:
            continue
        vals = [v for v in (f.get("values") or []) if isinstance(v, dict) and "count" in v]
        if vals:
            sums.append(sum(int(v.get("count") or 0) for v in vals))
    return min(sums) if sums else 0


def partition_facet(body, cap, exclude=()):
    """(facetParameter, [value ids]) for a flat facet that splits the board into pieces
    each under `cap` and covering all of it, or None. A facet in `exclude` (the slice's
    own) is never chosen: partitioning on it replaced the slice's values with every value
    on the board (Codex, 2026-10-29)."""
    need = facet_total(body, exclude)
    for f in (body or {}).get("facets") or []:
        if f.get("facetParameter") in exclude:
            continue
        vals = [v for v in (f.get("values") or []) if isinstance(v, dict) and "count" in v]
        counts = [int(v.get("count") or 0) for v in vals]
        if vals and f.get("facetParameter") and sum(counts) == need and max(counts) < cap:
            return f["facetParameter"], [v["id"] for v in vals if v.get("count")]
    return None


def enumerate_board(base, pages=150, limit=20, quiet=False, scope=None):
    """Every posting the tenant will hand over, beyond Workday's result cap.

    `scope` is a portals.yml `workday_facets` slice: the walk, the cap test and any
    partition all happen inside it.

    One walk when the first page's `total` covers the board. When it does not (see
    facet_total), the board is walked once per value of a partitioning facet and the
    pieces are unioned on externalPath. Anything that still falls short of the facet total
    is reported truncated, because an absent id from a short read is a false closure.
    """
    scope = dict(scope or {})
    ok, st, first = _nv._req(base + "/jobs", data={"appliedFacets": scope, "limit": limit,
                                                    "offset": 0, "searchText": ""})
    if not ok:
        if not quiet:
            print(f"    search failed at offset 0: HTTP {st}", file=sys.stderr)
        return [], st, True
    shown, real = (first or {}).get("total", 0) or 0, facet_total(first, set(scope))
    if not real or shown >= real:
        return walk_board(base, pages=pages, limit=limit, quiet=quiet, facets=scope)
    part = partition_facet(first, shown, set(scope))
    if not part:
        posts, st, _ = walk_board(base, pages=pages, limit=limit, quiet=quiet, facets=scope)
        return posts, st, True
    param, ids = part
    merged = {}
    for k, vid in enumerate(ids, 1):
        if not quiet:
            print(f"    walking piece {k}/{len(ids)} of a capped board", file=sys.stderr, flush=True)
        posts, st, trunc = walk_board(base, pages=pages, limit=limit, quiet=quiet,
                                      facets={**scope, param: [vid]})
        # A piece that reaches the cap is itself capped. Checked per piece because the
        # union is compared with facet counts read at page 0, and a piece that grew during
        # the walk could fill the shortfall of another and pass for complete (Codex).
        if st != 200 or trunc or len(posts) >= shown:
            return list(merged.values()) + posts, st, True
        for p in posts:
            merged.setdefault(p.get("externalPath") or id(p), p)
    if not quiet:
        print(f"    capped board: total {shown}, facets {real}; walked {len(ids)} "
              f"{param} pieces, {len(merged)} postings", file=sys.stderr)
    return list(merged.values()), 200, len(merged) < real


def walk_board(base, pages=150, limit=20, quiet=False, facets=None):
    """Every posting one CXS search will hand over, walking it page by page.

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
        payload = {"appliedFacets": facets or {}, "limit": limit, "offset": offset,
                   "searchText": ""}
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


_WD_HOST = re.compile(r"([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com", re.I)


def posting_key(url):
    """A Workday posting's identity: its tenant and the id that ends its path.

    The path id survives a re-slug, and the tenant host makes even a bare number
    unambiguous ("10000101" means nothing across employers, "disney:10000101" does), so
    this keys the Disney-style ids REQ_ID deliberately refuses. None for any other URL.

    Three rules from review. The tenant is the PARSED host, never a host found along the
    string. Only the PATH is read, because a query such as `?redirect=/job/X/Z_99999999`
    otherwise supplied the id. And an id REQ_ID recognises is canonicalised the way the
    rest of this file does it, so `_R-10001` and `_R10001`, or `_JR_100002` and
    `_JR-100002`, are one posting rather than two.
    """
    s = (url or "").strip()
    try:
        u = urllib.parse.urlsplit(s if re.match(r"(?i)https?://", s) else "https://" + s)
    except ValueError:
        return None
    host = _WD_HOST.fullmatch(u.hostname or "")
    if not host or "/job/" not in u.path:
        return None
    last = u.path.rstrip("/").rsplit("/", 1)[-1]
    reqs = list(REQ_ID.finditer(last))
    if reqs:
        rid = canon_req(reqs[-1].group(1))
    else:
        # A bare number (Disney) or a short letter prefix on digits (Zillow P700202,
        # REQ-0000808), with a one- or two-digit trailer read as the facet suffix. Never a
        # WORD: a slug ending "_Engineer" is a title, and keying it would make every such
        # posting at the tenant one identity, so a tracked one hid the rest.
        m = re.search(r"_((?:[A-Za-z]{1,4}-?)?\d{5,})(?:-\d{1,2})?$", last)
        if not m:
            return None
        rid = m.group(1).upper().replace("-", "")
    return f"wd:{host.group(1).lower()}:{rid}"


def tracked_urls(path=None, gaps=None):
    """Job ids already on the tracker, so the sweep reports only what is new.

    Read ROW BY ROW rather than as one blob of text, because an ambiguous id means
    nothing without the company cell sitting beside it on the same line. Each row's
    REPORT is read too, joined by its link: a role cell that does not carry the req id
    hid the posting from dedup, so a tracked req came back as a new find.

    A row whose report cannot be read, or carries no **URL:** line, contributes no posting
    key, and that is not the same answer as "not tracked". Pass a list as `gaps` to have
    each such row named in it, so a caller can say dedup was incomplete rather than let
    the missing evidence read as absence.
    """
    p = path or os.path.join(ROOT, "data", "applications.md")
    if not os.path.exists(p):
        if gaps is not None:
            gaps.append(("-", "tracker missing"))
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
        link = re.search(r"\]\(((?:\.\./)?reports/[^)]+)\)", line)
        if not link:
            if gaps is not None:
                gaps.append((cells[0], "no report link"))
            continue
        try:
            # ../reports/x is relative to the tracker's own directory; a bare reports/x
            # is root-relative, as TSV additions write it before merge-tracker rewrites it.
            rel = link.group(1)
            anchor = os.path.dirname(p) if rel.startswith("../") else os.path.dirname(os.path.dirname(p))
            rep = open(os.path.normpath(os.path.join(anchor, rel)),
                       encoding="utf-8", errors="replace").read()
        except OSError:
            if gaps is not None:
                gaps.append((cells[0], "report unreadable"))
            continue
        # Same line only: \s* crossed the newline, so an empty URL field captured the
        # next heading's "##" and the row vanished with no key and no gap.
        u = re.search(r"\*\*URL:\*\*[ \t]*(\S*)", rep)
        if not u:
            if gaps is not None:
                gaps.append((cells[0], "report has no URL line"))
            continue
        if not re.match(r"(?i)(?:https?://)?[\w-]+(?:\.[\w-]+)+/", u.group(1)):
            if gaps is not None:
                gaps.append((cells[0], "report URL unusable"))
            continue
        k = posting_key(u.group(1))
        if k:
            keys.add(k)
    return keys


def remote_type_says_remote(value):
    """Workday's remoteType label, read as a remote signal only when it says remote:
    'Fully Remote' and 'Remote Customer-Based' do; 'Fully On-Site', 'Office - Flexible'
    and 'Primarily On-Site / Occasionally from Home' do not."""
    return bool(re.match(r"\s*(?:fully\s+)?remote\b", str(value or ""), re.I))


def sweep(entry, min_lane=2, pages=150, quiet=False, keep_all=False,
          prefilter=0, terms=None, caveats=None):
    """One tenant's board as lane-scored, location-judged rows.

    `terms` keeps only rows whose title or WHOLE body names one of them (case-insensitive).
    It narrows the full walk; it never replaces it with a search, which is the capped shape
    nvidia-sweep's keyword search had until 2026-10-19.

    `caveats`, when given, receives one dict per tenant saying how complete the read was,
    so a saved --json run carries its own truncation and unread counts rather than leaving
    them on a stderr nobody kept (Codex round 2).
    """
    base, label = entry["base"], entry["label"]
    posts, st, truncated = enumerate_board(base, pages=pages, quiet=quiet, scope=entry.get("facets"))
    note = dict(tenant=entry["tenant"], http=st, postings=len(posts), truncated=bool(truncated),
                unread=0, unknown_live=0)
    if caveats is not None:
        caveats.append(note)
    # Printed under --json too: quiet silences progress, never caveats, and an incomplete
    # walk is exactly what must not pass for a whole board (Codex, 2026-10-19). It goes to
    # stderr, so a machine reading stdout is unaffected.
    if not quiet or truncated:
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
    # Printed even under --quiet, which silences progress rather than caveats: it goes to
    # stderr, so a machine reading stdout is unaffected, and incomplete dedup evidence is
    # exactly what must not pass for a complete answer.
    gaps = []
    known = tracked_urls(gaps=gaps)
    if gaps:
        print(f"  note: {len(gaps)} tracker row(s) gave no posting key "
              f"(e.g. #{gaps[0][0]}, {gaps[0][1]}); a find matching one of them can read "
              f"as new", file=sys.stderr)
    cands = []
    for p in posts:
        title = p.get("title", "") or ""
        if not keep_all and lane_score(title) < prefilter:
            continue
        cands.append(p)

    rows, unread, unsure = [], [], 0
    # One detail fetch per candidate is the slow half: NVIDIA's 2746 postings take 10 to 25
    # minutes, and a run that printed nothing until the end was killed by three separate
    # callers' timeouts on 2026-10-25 with every result lost. A periodic line on stderr says
    # the walk is alive and how far it has to go; stdout, which --json readers parse, is
    # untouched.
    if not quiet:
        print(f"    resolving {len(cands)} posting detail(s)", file=sys.stderr, flush=True)
    for n, p in enumerate(cands, 1):
        if not quiet and n % 200 == 0:
            print(f"    ... {n}/{len(cands)} details", file=sys.stderr, flush=True)
        ep = p.get("externalPath", "") or ""
        info = detail(base, ep)
        if not info:
            unread.append(p.get("title", "") or ep)
            continue
        title, body_txt, lane = score_detail(info, p.get("title", ""))
        if min_lane is not None and lane < min_lane and not keep_all:
            continue
        if terms and not any(t.lower() in (title + " " + body_txt).lower() for t in terms):
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
        url = f"https://{entry['tenant']}.{entry['wd']}.myworkdayjobs.com/{entry['site']}{ep}"
        live = live_of(info)
        unsure += live is None
        rows.append(dict(
            company=label, req=req, title=title, lane=lane,
            live=live, location=loc, additional=list(extra),
            # Scoped by company: a bare R number is one tenant's counter, and matching
            # it across tenants marked a live posting as already done. The posting key
            # (tenant + path id) catches what the req id cannot: a tracked row whose
            # role cell omits the id, and bare-number tenants such as Disney.
            verdict=verdict, why=why,
            tracked=bool((req and tracked_key(req, label) in known) or posting_key(url) in known),
            # How many tracker rows yielded no posting key. Non-zero means `tracked: false`
            # is "not found in what could be read", not "confirmed new".
            dedup_gaps=len(gaps),
            url=url))
    # Caveats, so printed under --json too. A posting whose detail could not be read is
    # not a posting that failed the lane, and a record with no canApply is not a closure.
    note.update(unread=len(unread), unknown_live=unsure)
    if unread:
        print(f"  note: {len(unread)} posting(s) at {label[:30]} could not be read and are NOT "
              f"in these results (e.g. {unread[0][:50]!r}); re-run to retry", file=sys.stderr)
    if unsure:
        print(f"  note: {unsure} row(s) at {label[:30]} carry no canApply field; liveness is "
              f"UNKNOWN for them (live=null), not closed", file=sys.stderr)
    return rows, st


def complete(caveats):
    """True only when every tenant was walked to its end with every detail read."""
    return all(c["http"] == 200 and not c["truncated"] and not c["unread"] for c in caveats)


def score_detail(info, fallback_title=""):
    """(title, body, lane) for one Workday detail record.

    Scored on the WHOLE body. sweep() cut it at 6000 characters first, a day after
    nvidia-sweep's copy was fixed, and four NVIDIA reqs fell under the lane floor in one
    file and not the other (2026-10-19). A function, so the selftest can assert the
    behaviour rather than the spelling of a line (Codex: a slice on its own line would
    have passed the source check).
    """
    body = re.sub(r"<[^>]+>", " ", info.get("jobDescription", "") or "")
    title = info.get("title", fallback_title) or fallback_title
    return title, body, lane_score(title, body)


def live_of(info):
    """True or False from a record that STATES canApply, else None.

    bool(info.get("canApply")) read a record that never carried the field as closed: an
    unread answer presented as a definite one (Codex, 2026-10-19).
    """
    v = info.get("canApply")
    return None if v is None else bool(v)


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
    live_new = [r for r in rows if r["live"] is True and not r["tracked"]]
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


# A sweep has no memory of its own. "Actionable" means untracked, and a posting someone
# looked at and passed on never gets a tracker row, so every run re-offered the same list:
# well over a hundred rows a day once the search cadence went daily, most of them seen
# before. The answer a daily run needs is "what appeared since last time", so
# every swept row is keyed and dated here, and the zero-token scan's own first-seen dates
# (data/scan-history.tsv, which polls these same tenants) count as sightings too.
SEEN_PATH = os.path.join(ROOT, "data", "sweep-seen.tsv")
SCAN_HISTORY = os.path.join(ROOT, "data", "scan-history.tsv")
def seen_key(url):
    """One posting's identity across runs and URL spellings: posting_key(), the same
    tenant-scoped requisition identity the tracker dedup uses, else the URL minus its query."""
    return posting_key(url) or (url or "").strip().split("?")[0].rstrip("/").lower()


def load_seen(paths=(SEEN_PATH, SCAN_HISTORY)):
    """key -> earliest date any run saw it. Both files are url<TAB>date first."""
    seen = {}
    for p in paths:
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as fh:
            for line in fh:
                f = line.rstrip("\n").split("\t")
                if len(f) < 2 or not re.match(r"\d{4}-\d{2}-\d{2}$", f[1]):
                    continue
                k = seen_key(f[0])
                seen[k] = min(seen.get(k, f[1]), f[1])
    return seen


def record_seen(rows, today, seen, path=SEEN_PATH):
    """Append every row no run has seen before. Returns how many were added."""
    new = []
    for r in rows:
        k = seen_key(r["url"])
        if k not in seen:
            seen[k] = today
            new.append(f"{r['url']}\t{today}\t{r['company']}\t{r['title']}".replace("\r", " "))
    if new:
        exists = os.path.exists(path)
        with open(path, "a", encoding="utf-8", newline="") as fh:
            if not exists:
                fh.write("url\tfirst_seen\tcompany\ttitle\n")
            fh.write("\n".join(new) + "\n")
    return len(new)


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
    # A workday_facets slice is read as one JSON line, and a malformed one must raise
    # rather than widen to the whole board.
    blk = '\n    workday_facets: {"jobFamilyGroup": ["a1", "b2"]}\n'
    if slice_of(blk, "t") != {"jobFamilyGroup": ["a1", "b2"]} or slice_of("\n    provider: workday\n", "t") is not None:
        bad += 1
        print("  FAIL slice_of did not read a workday_facets line, or invented one")
    page = {"facets": [
        {"facetParameter": "jobFamilyGroup", "values": [{"id": "a", "count": 9}, {"id": "b", "count": 9}, {"id": "c", "count": 9}]},
        {"facetParameter": "timeType", "values": [{"id": "ft", "count": 6}, {"id": "pt", "count": 4}]}]}
    if partition_facet(page, 8, {"jobFamilyGroup"}) != ("timeType", ["ft", "pt"]) or facet_total(page, {"jobFamilyGroup"}) != 10:
        bad += 1
        print("  FAIL a slice's own facet was used to size or partition the slice")
    for broken in ('{"jobFamilyGroup": []}', '{"jobFamilyGroup": "a1"}', '{jobFamilyGroup: [a1]}', 'garbage',
                   '{"jobFamilyGroup": ["a1"]}  # note', '\n      jobFamilyGroup: [a1]'):
        try:
            slice_of(f"\n    workday_facets: {broken}\n", "t")
            bad += 1
            print(f"  FAIL slice_of accepted a malformed slice: {broken}")
        except ValueError:
            pass
    # Every discovered base must be a CXS path, not the human-facing board URL. Sweeping
    # the human URL returns HTML and reads as an empty board.
    for e in found:
        if "/wday/cxs/" not in e["base"]:
            bad += 1
            print(f"  FAIL {e['tenant']} base is not a CXS endpoint: {e['base']}")

    # Requisition-id extraction. The underscore case is the one that shipped broken and
    # made every row look untracked, so it leads.
    req_cases = [
        ("/job/USA---Remote-CA/Example-Role-03-_R26710", "R26710"),
        ("/job/Santa-Clara-CA/Senior-Engineer_JR2620896", "JR2620896"),
        ("/job/USA---Remote/Example-Role-02-_R23555-1", "R23555"),
        ("Lead AI Engineer, GTM Applications (Remote) — R26710", "R26710"),
        ("requisition JR2778170 is live", "JR2778170"),
        # Autodesk's year-prefixed format. Matched nothing until it was added, so every
        # Autodesk row reported itself untracked.
        ("/job/Toronto-ON-CAN/Example-Role-05_26WD91231-1", "26WD91231"),
        ("/job/Toronto-ON-CAN/Example-Role-12_26WD93101-1", "26WD93101"),
        ("/job/Toronto-ON-CAN/Example-Role-05_26WD161146", "26WD161146"),
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
        ("/job/NA--Culver-City/Example-Role-14_JR-103209", "JR103209"),
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
    import shutil, tempfile
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
    shutil.rmtree(os.path.dirname(fx), ignore_errors=True)
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
    # The posting key. A tracked req whose row's role cell does not carry the id came back
    # as a new find; the Disney form is a bare number the shared REQ_ID refuses by design.
    D = "https://disney.wd5.myworkdayjobs.com/disneycareer/job/X/Y_10000101"
    for u, want in (
            ("https://autodesk.wd1.myworkdayjobs.com/Ext/job/X/Y_26WD100505", "wd:autodesk:26WD100505"),
            (D, "wd:disney:10000101"),
            ("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/X/Y_JR1000101-1",
             "wd:nvidia:JR1000101"),
            ("https://zillow.wd5.myworkdayjobs.com/x/job/Remote-USA/Principal-MLE_P700202-2",
             "wd:zillow:P700202"),
            # Review findings: one posting, one key, whatever the id's punctuation...
            ("https://calix.wd1.myworkdayjobs.com/Calix/job/X/Y_R-10001", "wd:calix:R10001"),
            ("https://calix.wd1.myworkdayjobs.com/Calix/job/X/Y_R10001", "wd:calix:R10001"),
            ("https://sonyglobal.wd1.myworkdayjobs.com/S/job/X/Y_JR_100002", "wd:sonyglobal:JR100002"),
            ("https://sonyglobal.wd1.myworkdayjobs.com/S/job/X/Y_JR-100002", "wd:sonyglobal:JR100002"),
            ("https://acme.wd1.myworkdayjobs.com/S/job/X/Y_REQ-0000808", "wd:acme:REQ0000808"),
            # ...the query never supplies the id...
            (D + "?redirect=/job/X/Z_99999999", "wd:disney:10000101"),
            # ...and the tenant is the URL's own host, never one named along its path.
            ("https://wrapper.example/r/disney.wd5.myworkdayjobs.com/x/job/Y/Z_10000101", None),
            ("https://boards.greenhouse.io/x/jobs/123", None),
            # A word is a title, never an id.
            ("https://acme.wd1.myworkdayjobs.com/S/job/X/First_Engineer", None)):
        if posting_key(u) != want:
            bad += 1
            print(f"  FAIL posting_key({u[-48:]!r}) = {posting_key(u)!r}, want {want!r}")

    # tracked_urls() reading the posting key out of each row's REPORT, against a fixture
    # rather than the live tracker, so the case runs in any checkout. Row 2's report is
    # missing and row 3's URL field is empty: both must be reported as gaps, not dropped.
    import tempfile
    with tempfile.TemporaryDirectory() as fx:
        os.makedirs(os.path.join(fx, "data"))
        os.makedirs(os.path.join(fx, "reports"))
        with open(os.path.join(fx, "data", "applications.md"), "w", encoding="utf-8") as f:
            f.write("| # | Date | Company | Role |\n|---|---|---|---|\n"
                    "| 1 | 2026-09-29 | Disney | Staff SWE | 4.0/5 | Evaluated | x | [1](../reports/001-a.md) | n |\n"
                    "| 2 | 2026-09-29 | Disney | Other | 4.0/5 | Evaluated | x | [2](../reports/002-b.md) | n |\n"
                    "| 3 | 2026-09-29 | Disney | Third | 4.0/5 | Evaluated | x | [3](../reports/003-c.md) | n |\n"
                    "| 4 | 2026-09-29 | Disney | Fourth | 4.0/5 | Evaluated | x | no link | n |\n"
                    "| 5 | 2026-09-29 | Acme | Fifth | 4.0/5 | Evaluated | x | [5](reports/005-e.md) | n |\n")
        with open(os.path.join(fx, "reports", "005-e.md"), "w", encoding="utf-8") as f:
            f.write("# E\n\n**URL:** https://acme.wd1.myworkdayjobs.com/S/job/X/Y_10000909\n")
        with open(os.path.join(fx, "reports", "001-a.md"), "w", encoding="utf-8") as f:
            f.write(f"# A\n\n**URL:** {D}\n")
        with open(os.path.join(fx, "reports", "003-c.md"), "w", encoding="utf-8") as f:
            f.write("# C\n\n**URL:**\n\n## Analysis\n")
        gaps = []
        fk = tracked_urls(os.path.join(fx, "data", "applications.md"), gaps=gaps)
        if "wd:disney:10000101" not in fk:
            bad += 1
            print("  FAIL tracked_urls did not read the posting key out of a row's report")
        if "wd:snapchat:10000101" in fk or "10000101" in fk:
            bad += 1
            print("  FAIL a bare number keyed without its tenant")
        if "wd:acme:10000909" not in fk:
            bad += 1
            print("  FAIL a root-relative reports/ link was not followed")
        if sorted(g[0] for g in gaps) != ["2", "3", "4"]:
            bad += 1
            print(f"  FAIL unreadable dedup evidence not reported as gaps: {gaps}")
        g2 = []
        if tracked_urls(os.path.join(fx, "nope", "applications.md"), gaps=g2) or g2 != [("-", "tracker missing")]:
            bad += 1
            print(f"  FAIL a missing tracker must be reported as a gap, got {g2}")

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

        # Workday's RESULT cap (NVIDIA: total 2000, facets 2732). A walk that ends at the cap
        # must not read as the whole board: the board is walked per facet value instead.
        def capped_board(sizes, cap, partition=True):
            fam = [{"descriptor": f"F{i}", "id": f"f{i}", "count": n} for i, n in enumerate(sizes)]
            facets = [{"facetParameter": "jobFamilyGroup" if partition else "x",
                       "values": fam if partition else [{"id": "all", "count": sum(sizes)}]}]

            def _fake(url, data=None, **_k):
                off, lim = data.get("offset", 0), data.get("limit", 20)
                sel = (data.get("appliedFacets") or {}).get("jobFamilyGroup")
                if sel:
                    i = int(sel[0][1:])
                    pool = [f"/job/x/F{i}_{k}" for k in range(sizes[i])]
                    total = len(pool)
                else:
                    pool = [f"/job/x/F{i}_{k}" for i, n in enumerate(sizes) for k in range(n)][:cap]
                    total = cap
                chunk = [{"externalPath": p} for p in pool[off:off + lim]]
                return True, 200, {"total": total, "jobPostings": chunk, "facets": facets}
            return _fake
        _nv._req = capped_board([90, 70, 15], cap=100)
        got, _st, trunc = enumerate_board("https://x/wday/cxs/t/s", pages=40, limit=20, quiet=True)
        if trunc or len({p["externalPath"] for p in got}) != 175:
            bad += 1
            print(f"  FAIL capped board: got {len(got)} postings, truncated={trunc}; "
                  f"want all 175 across the facet pieces and False")
        # ...and with no facet able to split it under the cap, it is TRUNCATED, never whole.
        _nv._req = capped_board([90, 70, 15], cap=100, partition=False)
        got, _st, trunc = enumerate_board("https://x/wday/cxs/t/s", pages=40, limit=20, quiet=True)
        if not trunc:
            bad += 1
            print(f"  FAIL capped board with no partition read as whole ({len(got)} postings)")
        # An OVERLAPPING facet (a posting filed under each of its locations) is not a cap:
        # Autodesk's State_Region sums to 538 on a whole board of 308.
        overlap = [{"facetParameter": "timeType", "values": [{"id": "ft", "count": 60}]},
                   {"facetParameter": "State_Region", "values": [{"id": "x", "count": 50},
                                                                 {"id": "y", "count": 40}]}]

        def _whole(url, data=None, **_k):
            off, lim = data.get("offset", 0), data.get("limit", 20)
            pool = [f"/job/x/W_{k}" for k in range(60)]
            return True, 200, {"total": 60, "facets": overlap,
                               "jobPostings": [{"externalPath": p} for p in pool[off:off + lim]]}
        _nv._req = _whole
        got, _st, trunc = enumerate_board("https://x/wday/cxs/t/s", pages=40, limit=20, quiet=True)
        if trunc or len(got) != 60:
            bad += 1
            print(f"  FAIL an overlapping facet read as a cap: {len(got)} postings, truncated={trunc}")
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
    # ...and the lane is scored on the WHOLE body, asserted as behaviour: evidence placed
    # past 6000 characters must still count. sweep() must score through score_detail() and
    # call lane_score() nowhere else on a body.
    pad = "We value collaboration. " * 400                      # ~9600 characters
    late = {"title": "Engineer", "jobDescription": f"<p>{pad}</p><p>Build agentic eval harnesses.</p>"}
    blank = {"title": "Engineer", "jobDescription": f"<p>{pad}</p>"}
    # The selftest runs on the neutral vocabulary, which scores no body at all, so this one
    # case borrows the techart preset and puts the neutral one back.
    import _lane as _lane_mod
    _lane_mod.configure(_lane_mod.load_vocab(os.path.join(_lane_mod.PRESETS, "techart-ai-tooling.json")))
    try:
        late_wins = score_detail(late)[2] > score_detail(blank)[2]
    finally:
        _lane_mod.configure(_lane_mod.load_vocab(_lane_mod.FALLBACK))
    if not late_wins:
        bad += 1
        print("  FAIL lane evidence past 6000 characters of body was not scored")
    sweep_src = body[:body.index("def score_detail(")]
    if "score_detail(info" not in sweep_src or re.search(r"lane_score\([^)]*body", sweep_src):
        bad += 1
        print("  FAIL sweep() scores a body without going through score_detail()")
    # A record with no canApply is unknown, never closed, and is not actionable.
    if (live_of({"canApply": True}), live_of({"canApply": False}), live_of({"title": "x"})) != (True, False, None):
        bad += 1
        print("  FAIL live_of() must read a missing canApply as None")
    act, _maybe = partition([dict(live=None, tracked=False, verdict="pass")])
    if act:
        bad += 1
        print("  FAIL a row of unknown liveness was listed as actionable")
    # A saved run is complete only when every tenant was walked to its end and fully read.
    ok = dict(http=200, truncated=False, unread=0)
    if not complete([ok]) or any(complete([{**ok, **d}]) for d in
                                 ({"truncated": True}, {"unread": 3}, {"http": 422})):
        bad += 1
        print("  FAIL complete() must be False for a truncated, partly read or refused walk")

    # The seen ledger keys a posting by tenant plus requisition, so a re-slugged or
    # locale-prefixed URL is the same sighting, and the same number on two tenants is not.
    import tempfile
    seen_cases = [
        ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2620896",
         "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Y/Z_JR2620896", True),
        ("https://disney.wd5.myworkdayjobs.com/disneycareer/job/A/B_10414222-1",
         "https://disney.wd5.myworkdayjobs.com/disneycareer/job/C/D_10414222", True),
        ("https://crowdstrike.wd5.myworkdayjobs.com/x/job/A/B_R25523",
         "https://xboxgaming.wd1.myworkdayjobs.com/y/job/A/B_R25523", False),
    ]
    for a_, b_, same in seen_cases:
        if (seen_key(a_) == seen_key(b_)) != same:
            bad += 1
            print(f"  FAIL seen_key({a_!r}) vs {b_!r}: expected same={same}")
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "seen.tsv")
        row = dict(url=seen_cases[0][0], company="NVIDIA", title="T")
        s = load_seen((p,))
        n1 = record_seen([row], "2026-10-28", s, path=p)
        n2 = record_seen([dict(row, url=seen_cases[0][1])], "2026-10-29", load_seen((p,)), path=p)
        if (n1, n2) != (1, 0) or load_seen((p,)).get(seen_key(row["url"])) != "2026-10-28":
            bad += 1
            print("  FAIL record_seen must add a new posting once and keep its first date")

    print(f"workday-sweep selftest: {len(cases)} url cases + "
          f"{len(found)} discovered tenants + {len(req_cases)} req-id cases + "
          f"{len(key_cases)} req-key cases + 4 pagination "
          f"cases + 1 page-cap case + {part_checks} partition cases + "
          f"{len(remote_cases) + 1} remoteType cases, {bad} failure(s)")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tenant", help="sweep tenants by Workday tenant name or a word of the "
                                     "employer label, comma-separated (Blizzard,Pixar)")
    ap.add_argument("--all-tenants", action="store_true", help="sweep every tenant found")
    ap.add_argument("--skip", default="",
                    help="comma-separated tenants to skip (nvidia is "
                         "the slowest board by far; nvidia-sweep.py is this tool for it)")
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
    ap.add_argument("--terms", help="comma-separated words; keep only rows whose title or "
                                    "body names one (narrows the full walk)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--show-seen", action="store_true",
                    help="print rows an earlier run or scan already saw in full, not as counts")
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
        # The tenant id, or a word of the employer's label: "xboxgaming" names two
        # boards and "Blizzard" is how anyone asks for one of them. Comma-separated.
        picked = []
        for want in (w.strip().lower() for w in a.tenant.split(",") if w.strip()):
            hit = [e for e in found if e["tenant"].lower() == want] or \
                  [e for e in found if want in e["label"].lower()]
            if not hit:
                print(f"no tenant named {want!r}; try --list", file=sys.stderr)
                return 2
            picked += [e for e in hit if e not in picked]
        found = picked
    elif not a.all_tenants:
        ap.error("give --tenant NAME, --all-tenants, or --list")

    skip = {s.strip().lower() for s in a.skip.split(",") if s.strip()}
    if skip:
        before = len(found)
        found = [e for e in found if e["tenant"].lower() not in skip]
        print(f"skipping {before - len(found)} tenant(s): {', '.join(sorted(skip))}",
              file=sys.stderr)

    rows, caveats = [], []
    for e in found:
        r, _st = sweep(e, min_lane=a.min_lane, pages=a.pages,
                       quiet=a.json, keep_all=a.keep_all,
                       prefilter=a.prefilter,
                       terms=[t.strip() for t in a.terms.split(",") if t.strip()] if a.terms else None,
                       caveats=caveats)
        rows.extend(r)
        # Emit each tenant's hits as soon as that tenant finishes. A fifteen-tenant run
        # takes long enough that it will sometimes be killed or interrupted, and a version
        # that printed only a final sorted block lost everything when that happened. The
        # closing summary still prints the full ranked list; this is so a partial run is
        # still worth something.
        if not a.json:
            live_new = [x for x in r if x["live"] is True and not x["tracked"]]
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
        g = []
        tracked_urls(gaps=g)
        print(json.dumps({"count": len(rows), "dedup_gaps": len(g), "complete": complete(caveats),
                          "caveats": caveats, "min_lane": a.min_lane, "prefilter": a.prefilter,
                          "terms": a.terms, "rows": rows}, indent=1))
        return 0

    actionable, needs_call = partition(rows)
    # Both numbers, always. A single count under one heading is what let the unknowns
    # pass for passes; printing them apart but summarising them together would put the
    # conflation right back into the line most likely to be read.
    print(f"\n{len(rows)} at lane >= {a.min_lane if a.min_lane is not None else 'any'}; "
          f"{len(actionable)} ACTIONABLE (live, untracked, location passes); "
          f"{len(needs_call)} live and untracked but location UNKNOWN")
    # New since any earlier sweep or scan, versus seen before. Seen rows are COUNTED per
    # employer, never dropped: a list that quietly loses rows reads as "nothing else".
    seen = load_seen()
    today = datetime.date.today().isoformat()
    fresh = [r for r in actionable if seen.get(seen_key(r["url"]), today) == today]
    old = [r for r in actionable if r not in fresh]
    # Today's sightings count as new on purpose, so a second run the same day still shows
    # what the day turned up; say so, since "no earlier run" was false on that rerun.
    print(f"{len(fresh)} of the actionable rows are NEW (first seen today); "
          f"{len(old)} were seen on an earlier day")
    print("=" * 96)
    for r in (actionable if a.show_seen else fresh):
        _print_row(r)
    if old and not a.show_seen:
        by = {}
        for r in old:
            first = seen[seen_key(r["url"])]
            n, earliest = by.get(r["company"], (0, first))
            by[r["company"]] = (n + 1, min(earliest, first))
        print(f"\nSEEN BEFORE ({len(old)}; --show-seen prints them):")
        for c, (n, first) in sorted(by.items(), key=lambda kv: -kv[1][0]):
            print(f"   {n:3d}  {c[:50]}  (earliest {first})")
    added = record_seen(actionable + needs_call, today, seen)
    print(f"\n{added} posting(s) added to {os.path.relpath(SEEN_PATH, ROOT)}")
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
