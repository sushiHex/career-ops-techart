#!/usr/bin/env python
"""inbox-liveness.py — find the dead rows in data/pipeline.md by reading BOARDS, not URLs.

check-liveness.mjs resolves one posting at a time, with a Playwright fallback for boards
that challenge a bare fetch. That is the right tool for a handful of rows and the wrong one
for a 343-row inbox: it is hundreds of sequential page loads.

A board already knows which of its postings are open. So group the inbox by ATS board,
fetch each board ONCE, and ask whether each row's requisition id is still in the list. The
inbox spans roughly fifty boards, so this is fifty requests rather than several hundred.

THE RULE THIS IS BUILT AROUND: an absent id is only evidence when the board was READ
CLEANLY. If the fetch failed, or the id could not be extracted from the URL, or the board
came back empty, the row is UNKNOWN and stays in the queue. This repo has repeatedly
produced confident false negatives by treating "I could not check" as "it is gone", and a
prune is destructive in the direction that hides work.

  python scripts/inbox-liveness.py              # report only
  python scripts/inbox-liveness.py --mark       # mark confirmed-closed rows [x]
  python scripts/inbox-liveness.py --json
  python scripts/inbox-liveness.py --selftest
"""
import argparse
import collections
import importlib.util
import io
import json
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PIPELINE = os.path.join(ROOT, "data", "pipeline.md")
if HERE not in sys.path:
    sys.path.insert(0, HERE)

_MODULES = {}


def module(name, filename):
    """A hyphenated sibling script, loaded once. A filename with a hyphen is not an
    identifier, so these cannot be plain imports; `scripts/` is already on sys.path above,
    which the loaded modules need for their own `from _httpctx import ...` lines.

    Lazy on purpose: a run that is greenhouse and lever only needs neither of them, and
    each pulls in three further modules.
    """
    if name not in _MODULES:
        spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _MODULES[name] = m
    return _MODULES[name]


def workday():
    """scripts/workday-sweep.py, which owns the CXS transport, the pagination, the `total`
    trap (CrowdStrike answers total=436 at offset 0 and total=0 at every offset after it)
    and the requisition pattern. A second copy of any of those is the drift this repo keeps
    paying for, so this file imports rather than reimplements."""
    return module("wdsweep", "workday-sweep.py")

# (provider, pattern, reads_query) giving (board-slug, posting-id) from an inbox URL.
# Each provider exposes its id in a different place, and several expose it in more than
# one, so order matters.
#
# EVERY PATTERN IS ANCHORED AT THE HOST with `^(?:https?://)?`, and they are applied with
# match() rather than search(). An unanchored pattern finds its
# host anywhere along the string, so a wrapper carrying a posting in its PATH, like
# `https://tracker.example/r/https://agbo.breezy.hr/p/<id>`, routed this row to AGBO's
# board, looked for the embedded id, did not find it and let --mark retire a row that was
# never about that posting. The Workday branch in classify() had been anchored with
# match() since it was written, with a comment saying the tenant has to be the host of
# this url and not a host mentioned somewhere along it; the loop directly under it then
# used search(). A rule written down for one branch and not applied to the rest is the
# same shape as the Greenhouse two-branch bug in CLAUDE.md, found against
# the newest route, Breezy, when all four had it.
#
# `reads_query` is the one legitimate exemption, and leaving it out was a silent miss of
# its own: the embed form's slug and token live in the QUERY, which classify() cuts off
# before matching, so that route could not fire at all once the outer-url cut landed
# earlier. It gets the whole url, anchored at the host like the rest.
BOARD_PATTERNS = [
    # Greenhouse: the company-hosted form carries the id in gh_jid, the canonical form in
    # the path. Both point at the same board.
    ("greenhouse",
     re.compile(r"^(?:https?://)?(?:job-boards|boards)\.greenhouse\.io/([\w.-]+)/jobs/(\d+)",
                re.I), False),
    ("greenhouse",
     re.compile(r"^(?:https?://)?[\w.-]*greenhouse\.io/embed/job_app\?for=([\w.-]+)"
                r"&token=(\d+)", re.I), True),
    ("ashby",
     re.compile(r"^(?:https?://)?jobs\.ashbyhq\.com/([\w.-]+)/([0-9a-f-]{16,})", re.I), False),
    ("lever",
     re.compile(r"^(?:https?://)?jobs\.lever\.co/([\w.-]+)/([0-9a-f-]{16,})", re.I), False),
    # Breezy publishes its whole board at /json and prefixes each posting URL with that
    # posting's id, so it is a board read like any other. Four AGBO rows were sitting in
    # the "no board reader" bucket for want of these two lines.
    ("breezy",
     re.compile(r"^(?:https?://)?([\w-]+)\.breezy\.hr/p/([0-9a-f]+)", re.I), False),
]
# A company-hosted page that only carries gh_jid: the board slug has to come from
# portals.yml, because the hostname is the company's own domain.
GH_JID = re.compile(r"[?&]gh_jid=(\d+)")

API = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{s}/jobs",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{s}",
    "lever": "https://api.lever.co/v0/postings/{s}?mode=json",
    "breezy": "https://{s}.breezy.hr/json",
}
# Providers whose board endpoint answers with a bare JSON ARRAY rather than an object
# wrapping a `jobs` key. Named rather than special-cased inside the parse, so adding the
# next one is a list entry and not another branch.
ARRAY_BOARDS = ("lever", "breezy")

# https://{tenant}.wd{n}.myworkdayjobs.com/{optional locale}/{site}/job/...
#
# Anchored on the `/job/` that follows the site, which TENANT_URL in workday-sweep.py does
# not need because it reads portals.yml entries rather than posting URLs. Without the
# anchor the locale segment is indistinguishable from the site name, and a posting URL
# written `.../en/job/US-CA-Remote/X_JR2620896` yields the site "en" and a CXS base that
# addresses no board. That URL carries no site at all, so the honest answer is that this
# row cannot be checked by board membership; a plausible-looking base would turn it into a
# board that fails to load, or worse, one that loads someone else's jobs.
#
# The locale group is optional, so the engine will happily skip it and read the locale
# itself as the site: `/en/job/` yields site "en". A 4-character FLOOR on the site was the
# first answer to that and it is wrong in the other direction, because Autodesk's real site
# is `Ext`; that floor cost eight live Autodesk rows. The locale is matched by SHAPE, two
# letters with an optional region, and anything else is the site. A url that then carries a
# locale where the site belongs has no site at all, so this tool declines it rather than
# building a plausible-looking CXS base that addresses no board, or worse, someone else's.
# That shape test is req-resolve.WD_LOCALE_ONLY, read through locale_only() rather than
# copied: the two files held different spellings of it and the disagreement closed rows.
#
# `job|details` because Workday uses both spellings for a posting path, and an anchor that
# knows only one turns every site using the other into a false unknown. The anchor is what
# stops the greedy site capture from swallowing an infrastructure segment: a CXS API URL
# (.../wday/cxs/nvidia/Site/job/...) yields the site "wday" without it, which addresses no
# board. Both halves are pinned as cases below.
WORKDAY_URL = re.compile(
    r"https://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/"
    r"(?:[a-z]{2}(?:-[a-z]{2})?/)?([A-Za-z0-9_-]+)/(?:job|details)/", re.I)
# A site segment that is really a locale. Checked by SHAPE rather than by length, which is
# what the first version used: a 4-character floor told "en" apart from a site name and
# also rejected Autodesk's real site, which is `Ext`, so eight live Autodesk rows were
# unroutable. Two letters with an optional region is a locale; anything else is a site.
def locale_only():
    """req-resolve.py's WD_LOCALE_ONLY. Read from there, never copied.

    This file held its own spelling of it and the resolver held a LENGTH test instead, so
    a locale-only Workday url was refused here and then fabricated into a CXS path there,
    by the fallback in settle_unknowns() that hands this file's unsettled rows to that
    file's resolver. Two files disagreeing about the same string is the drift four hand
    copies of the requisition pattern already cost this repo, and the selftest asserts no
    copy of it survives here.
    """
    return resolver().WD_LOCALE_ONLY
# Workday requisition ids the SHARED pattern does not cover, because they carry no prefix
# at all. Disney's are bare 8-digit numbers (`..._10414222`) and 684 of 684 postings on its
# board use that form, 132 of them with the trailing facet suffix Autodesk also writes.
#
# A bare number is not a requisition id anywhere else in this toolchain, deliberately: it
# is ambiguous. It is unambiguous HERE because its position is fixed by the Workday posting
# path and the comparison is scoped to one tenant's board, which is the same rule that lets
# a bare `R#####` be a key once a tenant pins it down.
WD_BARE_ID = re.compile(r"_(\d{6,})(?:-\d+)?(?:[?/#]|$)")
# The requisition pattern is NOT restated here. It was, for about twenty minutes, and that
# would have been the fifth spelling of it in this repo: the four previous ones each drifted
# silently and each cost live rows (Autodesk's 26WD form missing here, six digits demanded
# after JR there, a four-digit floor that also matched the date in a report filename). It
# comes from workday-sweep.py, which holds the one hand port of req-id-core.mjs and asserts
# in its own selftest that the two SOURCES are equal character for character. The selftest
# below asserts this file contains no copy.

# NVIDIA's board is 2000 postings, measured 2026-09-20, which is 100 pages at the 20 the
# CXS endpoint allows (limit=100 is refused with a 400). The bound is a runaway guard and
# not a size estimate, so it sits well clear of the largest tenant known; reaching it means
# the board is bigger than the walk, and THAT IS REPORTED AS NOT READ rather than as a
# short board, because an absent id from a truncated read is a false closure.
WORKDAY_PAGES = 150

# The hosts this file has a board reader for. Used only to explain WHY a row could not be
# checked, and it has to stay in step with the readers above or the explanation is wrong in
# the direction that wastes work: a Workday URL missing its requisition id gets filed under
# "write a Workday reader" when one is sitting right there. The selftest asserts that every
# URL this file can actually route is also recognised here, so the list cannot fall behind.
#
# `gh_jid` is in here because a COMPANY-HOSTED page is readable too: portals.yml supplies
# the board slug, which is how www.sentinelone.com resolves against the board
# `sentinellabs`. The consistency check found that omission on its first run, and chasing
# it found the larger one behind it: those eight SentinelOne rows carried their gh_jid the
# whole time and it was the SLUG MAP that could not reach them. See portal_slugs().
READABLE_HOST = re.compile(
    r"greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|\.myworkdayjobs\.com|"
    r"\.breezy\.hr|[?&]gh_jid=", re.I)


def resolver():
    """scripts/req-resolve.py, for its portals.yml lookup and its per-row resolve()."""
    return module("reqresolve", "req-resolve.py")


def portal_slugs(url):
    """The Greenhouse board slugs portals.yml records for this URL's company.

    This file used to build its own host-label -> slug map out of portals.yml, and that map
    was narrower than the one req-resolve builds from the same file in a way nothing could
    see: it keyed on the HOSTNAMES appearing inside an entry, and SentinelOne's entry lists
    only its ATS board, never sentinelone.com. So the label "sentinelone" was never
    produced, the eight live SentinelOne rows in the inbox were unroutable, and they were
    reported as a host with no board reader.

    The routing case that should have caught it could not: it handed classify() a
    hand-built `{"sentinelone": "sentinellabs"}` and so tested the LOOKUP and never the
    map. A case that cannot fail is not a case, and this one had been green throughout.

    req-resolve's portal_boards() keys on the entry's NAME as well as its URLs, which is
    why it gets SentinelOne right and this did not. One implementation now, not two.
    """
    try:
        return resolver().portal_boards(url) or []
    except Exception:
        return []


def workday_req(path):
    """The requisition id in a Workday posting path, or None.

    Shared pattern first, always, so JR / R / 26WD forms keep the one definition this repo
    has; the bare-numeric fallback runs only when that finds nothing. Both sides of the
    membership test go through here, which is the point: the inbox URL and the board's
    externalPath have to be read by the same rule or the comparison is meaningless.
    """
    w = workday()
    m = w.REQ_ID.search(path or "")
    if m:
        return w.canon_req(m.group(0))
    m = WD_BARE_ID.search(path or "")
    return m.group(1) if m else None


def wraps_another_url(url):
    """Does this url carry a SECOND absolute url inside it?

    IMPORTED rather than defined. This file had the first copy, and then the same rule was
    needed inside resolve() itself, where every caller of the resolver is exposed to it.
    Two copies of a rule is the drift this whole branch exists to remove, so req-resolve
    owns it and this is a one-line delegation.
    """
    return resolver().wraps_another_url(url)


def classify(url):
    """(provider, slug, posting_id) or None when the row cannot be checked this way."""
    # Route on the OUTER url: scheme, host and path, with the query and fragment cut off.
    # A posting URL riding inside a redirect or tracking parameter belongs to some other
    # row, and reading it here classifies this row as that tenant, takes the embedded
    # requisition, finds it absent from the board and lets --mark retire a row that was
    # never about that posting. req-resolve.py learned this for its own Workday fallback;
    # this file had not.
    # A wrapper is refused before any routing, exactly as resolve() and settle_unknowns()
    # refuse it. Anchoring the patterns below at the host already defeats the known
    # spelling, but the two rules answer different questions: anchoring says this row is
    # not that tenant's, and this says the row cannot be attributed to ANY tenant, so a
    # wrapper shape the detector does not yet know cannot route on a host it happens to
    # carry further along.
    if wraps_another_url(url):
        return None
    outer = (url or "").split("?")[0].split("#")[0]
    # Workday first, because it was the whole coverage gap. Measured 2026-09-20: of the
    # 220 rows this tool could not check, 200 had no board reader and 176 of those were
    # Workday tenants, 87 of them NVIDIA alone. The repo has had a tested Workday board
    # reader sitting in the next file the entire time.
    #
    # ANCHORED with match() rather than search(): the tenant has to be the host of this
    # url, not a host mentioned somewhere along it.
    m = WORKDAY_URL.match(outer)
    if m and not locale_only().match(m.group(3)):
        rid = workday_req(outer)
        if rid:
            return ("workday", f"{m.group(1).lower()}/{m.group(2).lower()}/{m.group(3)}",
                    rid)
        return None
    for prov, rx, reads_query in BOARD_PATTERNS:
        m = rx.match(url if reads_query else outer)
        if m:
            return prov, m.group(1), m.group(2)
    # The gh_jid branch reads the QUERY on purpose, because that is the one place a
    # Greenhouse job id legitimately lives, so it takes the whole url.
    jid = GH_JID.search(url)
    if jid:
        # The company hosts its own page and only the gh_jid says Greenhouse, so the board
        # slug has to come from portals.yml. Guessing it from the hostname is what made the
        # resolver declare SentinelOne had left Greenhouse and wrongly close four live rows.
        for slug in portal_slugs(url):
            return "greenhouse", slug, jid.group(1)
    return None


def fetch_workday(slug):
    """(set_of_req_ids, ok) for one Workday tenant, via workday-sweep's own walker."""
    tenant, wd, site = slug.split("/")
    base = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
    w = workday()
    try:
        posts, st, truncated = w.enumerate_board(base, pages=WORKDAY_PAGES, limit=20,
                                                 quiet=True)
    except Exception:
        return set(), False
    # Both of these are "I did not read the board", and the second is the one that matters:
    # a walk that hit its own page bound has an arbitrary suffix of the board missing, and
    # every row in that suffix would read as closed. At the 40-page default this tool would
    # have inherited, NVIDIA returns exactly 800 of its 2000 postings and 1200 reqs would
    # have been retired in one run.
    if st != 200 or truncated:
        return set(), False
    ids = set()
    for p in posts:
        rid = workday_req(p.get("externalPath") or "")
        if rid:
            ids.add(rid.lower())
    return ids, True


def ashby_ids(html, slug):
    """Posting ids parsed out of an Ashby board PAGE. Pure, so it can be tested offline."""
    import _ashby_embed
    return {str(r["id"]).lower() for r in _ashby_embed.postings(html, slug) if r.get("id")}


def fetch_ashby_embed(slug):
    """An Ashby board whose posting API is switched off, read from its human page.

    Ashby's /posting-api/job-board/{slug} is OPT-IN per organisation, and when it is off
    the endpoint answers 404, which is indistinguishable from "no such company". That is
    how Whatnot came to be filed as having no board at all while its board carried 131
    postings including a role squarely in lane. `_ashby_embed` already solves this for
    the resolver and for find-ats.py; this is the third consumer, not a third copy.

    An unparseable page is NOT READ rather than an empty board. The page is a fallback for
    a fetch that already failed once, so "I got bytes and made nothing of them" is much
    likelier to be a broken read than a company with no jobs, and treating it as the latter
    would retire every row on the board in one step.
    """
    import _ashby_embed
    try:
        html = subprocess.run(
            ["curl", "-s", "--max-time", "25", "-A", "Mozilla/5.0",
             _ashby_embed.BOARD_URL.format(slug=slug)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=45).stdout
    except Exception:
        return set(), False
    ids = ashby_ids(html, slug)
    return (ids, True) if ids else (set(), False)


def fetch_board(prov, slug):
    """(set_of_ids, ok). ok=False means the board was NOT read, which is not the same as
    a board with nothing on it."""
    if prov == "workday":
        return fetch_workday(slug)
    url = API[prov].format(s=slug)
    try:
        out = subprocess.run(
            ["curl", "-s", "--max-time", "25", "-H", "Accept: application/json",
             "-A", "Mozilla/5.0", "-w", "\n%{http_code}", url],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=45).stdout
        body, _, code = (out or "").rpartition("\n")
        # The STATUS, which this used to ignore entirely. Greenhouse answers a missing
        # board with HTTP 404 and a JSON body, `{"status":404,"error":"Job not found"}`,
        # which parses cleanly, carries no `jobs` key, and was therefore read as a board
        # that exists and holds nothing. Three Temporal rows were reported as sitting on an
        # empty board when the board is simply gone. Only the empty-board rule kept that
        # from becoming three false closures, so the safety net worked and the diagnosis
        # was wrong, which is its own kind of expensive.
        if code.strip() != "200":
            return fetch_ashby_embed(slug) if prov == "ashby" else (set(), False)
        d = json.loads(body)
    except Exception:
        # An Ashby 404 is not absence, it is an organisation with the posting API switched
        # off, so ask the board page before recording anything.
        return fetch_ashby_embed(slug) if prov == "ashby" else (set(), False)
    if prov in ARRAY_BOARDS:
        jobs = d if isinstance(d, list) else []
    else:
        jobs = d.get("jobs", []) if isinstance(d, dict) else []
    if not isinstance(jobs, list):
        return set(), False
    ids = set()
    for j in jobs:
        if not isinstance(j, dict):
            continue
        for key in ("id", "jobId", "internal_job_id"):
            if j.get(key) is not None:
                ids.add(str(j[key]).lower())
    # An empty board is a real answer from these three providers (they 404 an unknown
    # account), but it is worth flagging: every row on it would read as closed at once.
    return ids, True


def unchecked_rows():
    rows = []
    for i, line in enumerate(io.open(PIPELINE, encoding="utf-8", errors="replace")):
        if not line.startswith("- [ ] "):
            continue
        parts = [p.strip() for p in line[len("- [ ] "):].split("|")]
        if len(parts) < 3 or not parts[0].startswith("http"):
            continue
        rows.append(dict(line_no=i, url=parts[0], company=parts[1],
                         title=re.sub(r"\s*<!--.*", "", parts[2]).strip()))
    return rows


def sweep(quiet=False):
    rows = unchecked_rows()
    by_board = collections.defaultdict(list)
    unroutable = []
    for r in rows:
        c = classify(r["url"])
        if not c:
            unroutable.append(r)
            continue
        prov, slug, pid = c
        r["pid"] = pid.lower()
        by_board[(prov, slug)].append(r)

    # WHY a row is unknown, carried on the row. The three causes below are three different
    # problems with three different fixes: a host with no board reader needs one written, a
    # board that would not load needs a retry or a different endpoint, and a board that
    # parsed empty needs a human. Merging them into one count produced the state this tool
    # was in on 2026-09-20: it reported "220 unknown" and offered nothing to act on, which
    # is the same collapse of distinct answers this repo keeps paying for elsewhere.
    for r in unroutable:
        # Two different answers, and the difference decides who fixes it. A host this tool
        # has a reader for, whose URL simply carries no id, is a URL problem and there is
        # nothing to write. A host with no reader is a gap in this file. Matched against
        # the hosts the readers actually cover rather than guessed, so that a Workday URL
        # missing its requisition id is not filed under "write a Workday reader" when one
        # is sitting right there.
        r["why"] = ("no requisition id in the url" if READABLE_HOST.search(r["url"] or "")
                    else "no board reader for this host")
    live, closed, unknown = [], [], list(unroutable)
    for (prov, slug), group in sorted(by_board.items()):
        ids, ok = fetch_board(prov, slug)
        if not ok:
            for r in group:
                r["why"] = f"board {prov}/{slug} would not load"
                r["held"] = True
            unknown.extend(group)
            if not quiet:
                print(f"  {prov}/{slug[:26]:28s} BOARD NOT READ, {len(group)} row(s) "
                      f"stay unknown", file=sys.stderr)
            continue
        if not ids:
            # A board that parsed but holds nothing would mark every one of its rows
            # closed in a single step. That is exactly the shape of a silent false
            # negative, so it is reported and never auto-marked.
            for r in group:
                r["why"] = f"board {prov}/{slug} parsed but is empty"
                r["held"] = True
            unknown.extend(group)
            if not quiet:
                print(f"  {prov}/{slug[:26]:28s} board is EMPTY, {len(group)} row(s) "
                      f"held back for a manual look", file=sys.stderr)
            continue
        for r in group:
            (live if r["pid"] in ids else closed).append(r)
        if not quiet:
            n_dead = sum(1 for r in group if r["pid"] not in ids)
            print(f"  {prov}/{slug[:26]:28s} {len(ids):4d} on board, {len(group):3d} row(s), "
                  f"{n_dead} closed", file=sys.stderr)
    # Whatever no board could answer, ask the resolver about it one row at a time.
    unknown, alive, gone = settle_unknowns(unknown, quiet=quiet)
    live.extend(alive)
    closed.extend(gone)
    return live, closed, unknown


def settle_unknowns(unknown, quiet=False):
    """Ask each unsettled row's OWN posting URL, which can only ever close it.

    Board membership answers most rows for the price of one request per board, and the
    residue is rows no board can answer: a host with no reader, a URL with no requisition
    id in it, a board that has itself gone away. Those are not unanswerable, they are just
    not answerable THAT way, and the resolver already has the right instrument.

    req-resolve's resolve() is that instrument, and it is the whole tri-state resolver
    rather than just its last_resort() probe. The first version called last_resort alone,
    reasoning that a probe which can only ever CLOSE a row is the safest thing to reach
    for. It is also blind: three rows from one employer sat unsettled while resolve() answers them
    LIVE outright, because SmartRecruiters has a real adapter and last_resort never gets
    as far as calling it. resolve() ends in last_resort anyway for a host with no adapter,
    so this is the same floor with an adapter on top, and every closing path inside it is
    guarded, which is most of what this file's neighbours were hardened for.

    THE UNKNOWN BUCKET HOLDS TWO POPULATIONS AND ONLY ONE OF THEM BELONGS HERE (found in
    review, twice, and both reports were one root cause). A row that could not be
    ROUTED (no reader for the host, no id in the url) is unknown because this tool never
    asked, and the resolver is exactly the right second opinion. A row whose board WAS
    found and whose read was then refused, because the board would not load or parsed
    empty, is unknown because this tool asked and decided the answer could not be trusted.
    Sending that second kind here re-asks the SAME board down a path that can close: the
    resolver's Ashby adapter fetches the same board API, found the posting absent from the
    same empty list and answered live=False, so `--mark` retired every row the guard above
    had just held back. The guard was upstream and being undone downstream.

    So a row carrying `held` is never re-asked. The resolver's own two holes were fixed at
    the same time and in the same direction, because it has other callers and an empty
    Ashby board is not evidence for any of them, but that fix is per-adapter while this one
    is the rule: a verdict this file declined to trust is not re-derived by a route that can
    only close.

    Runs last and costs one request per remaining row, tens rather than hundreds.
    Returns (still_unknown, newly_live, newly_closed).
    """
    if not unknown:
        return unknown, [], []
    rr = resolver()
    still, alive, closed = [], [], []
    for r in unknown:
        # classify() above routes on the outer url; this did not, and handed the raw
        # wrapper straight to resolve(), whose adapter patterns search the whole string.
        # An Ashby or Lever posting sitting in a redirect parameter would then be resolved
        # and ITS verdict applied to this row, which --mark would act on. A posting url
        # never legitimately contains a second url, so a wrapper is refused rather than
        # unwrapped: the embedded row is somebody else's and guessing which is not this
        # tool's job.
        if wraps_another_url(r["url"]):
            r["why"] = "the url wraps another posting's url, so it cannot be resolved here"
            still.append(r)
            continue
        # A board read this file already refused to trust. Re-asking it here reaches the
        # same board by a route that can close, which is the guard being undone by its own
        # fallback. The `why` it arrived with is kept, since it is the more specific
        # reason and the one a human needs.
        if r.get("held"):
            still.append(r)
            continue
        try:
            verdict = rr.resolve(r["url"]) or {}
        except Exception:
            verdict = {}
        live = verdict.get("live")
        if live is False:
            r["why"] = verdict.get("note") or "the posting URL itself reports it is gone"
            closed.append(r)
        elif live is True:
            alive.append(r)
        else:
            still.append(r)
    if not quiet:
        print(f"  last resort: {len(closed)} closed and {len(alive)} live of "
              f"{len(unknown)} unsettled row(s), asked one at a time", file=sys.stderr)
    return still, alive, closed


def mark_closed(closed):
    """Mark confirmed-closed rows [x], by URL rather than by line number."""
    t = io.open(PIPELINE, encoding="utf-8", errors="replace").read()
    lines = t.split("\n")
    urls = {r["url"] for r in closed}
    n = 0
    for i, line in enumerate(lines):
        if not line.startswith("- [ ] "):
            continue
        u = line[len("- [ ] "):].split("|")[0].strip()
        if u in urls:
            lines[i] = ("- [x] " + line[len("- [ ] "):].rstrip()
                        + "  <!-- resolved: verified closed by inbox-liveness, the id is "
                          "no longer on the company board -->")
            n += 1
    io.open(PIPELINE, "w", encoding="utf-8", newline="").write("\n".join(lines))
    return n


def _selftest():
    # Parse the test fixture, never the user's own file: see portals_path().
    os.environ["CAREER_OPS_PORTALS"] = os.path.join(ROOT, "test-fixtures", "portals.yml")
    # req-resolve is loaded lazily; if something loaded it already, drop its cache so it
    # re-reads through the override above.
    if "reqresolve" in _MODULES:
        _MODULES["reqresolve"]._PORTALS = None
    bad = 0
    # No hand-built slug map here any more. The one that used to sit on this line,
    # {"sentinelone": "sentinellabs"}, made the SentinelOne case test the LOOKUP and never
    # the map, and the map was the broken half: it keyed on hostnames appearing inside a
    # portals.yml entry, and SentinelOne's entry lists only its ATS board. The case was
    # green while eight live SentinelOne rows sat unroutable in the inbox.
    CASES = [
        ("https://job-boards.greenhouse.io/cresta/jobs/4233080640",
         ("greenhouse", "cresta", "4233080640")),
        ("https://boards.greenhouse.io/andurilindustries/jobs/5832515109?gh_jid=5832515109",
         ("greenhouse", "andurilindustries", "5832515109")),
        ("https://jobs.ashbyhq.com/openai/24b26ace-c62f-a931-6d63-47859e74d98c",
         ("ashby", "openai", "24b26ace-c62f-a931-6d63-47859e74d98c")),
        ("https://jobs.lever.co/vrchat/b7fa68ef-a543-549e-5c9b-dcaabf8a9b79",
         ("lever", "vrchat", "b7fa68ef-a543-549e-5c9b-dcaabf8a9b79")),
        # A company-hosted page carrying only gh_jid. The slug MUST come from portals.yml:
        # guessing it from the hostname is what made the resolver declare SentinelOne had
        # left Greenhouse, and wrongly close four live rows.
        ("https://www.sentinelone.com/jobs/?gh_jid=7505468003",
         ("greenhouse", "sentinellabs", "7505468003")),
        # Workday, added 2026-09-20. 176 of the 200 rows with no board reader were Workday
        # tenants, 87 of them NVIDIA, while a tested tenant walker sat in the next file.
        ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/"
         "US-CA-Remote/Senior-Engineer_JR2391853",
         ("workday", "nvidia/wd5/NVIDIAExternalCareerSite", "JR2391853")),
        # A locale segment in front of the site, and an underscore before the req id. That
        # underscore is why the id pattern cannot use \b: there is no word boundary between
        # `_` and `R`, and a \b-anchored pattern extracts nothing from a Workday path.
        ("https://xboxgaming.wd1.myworkdayjobs.com/en-US/Blizzard_External_Careers/job/"
         "Irvine/Senior-Software-Engineer_R021430",
         ("workday", "xboxgaming/wd1/Blizzard_External_Careers", "R021430")),
        # Not routable by board membership; must return None rather than a wrong guess.
        # This one carries no site segment at all, only a locale. Reading `en` as the site
        # builds a CXS base that addresses no board, and a plausible wrong base is worse
        # than an honest unknown.
        ("https://nvidia.wd5.myworkdayjobs.com/en/job/US-CA-Remote/X_JR2620896", None),
        # Autodesk's Workday site is literally `Ext`. A length floor told a locale from a
        # site until this URL was looked at; eight live Autodesk rows were unroutable.
        ("https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/"
         "Software-Developer--Agentic-Evaluation-_26WD95532-1",
         ("workday", "autodesk/wd1/Ext", "26WD95532")),
        # Disney's requisition ids carry no prefix at all: 684 of 684 postings on its board
        # are bare numbers, so the shared pattern finds nothing and twelve live rows sat
        # unroutable. Both spellings, because 132 of those 684 carry the facet suffix.
        ("https://disney.wd5.myworkdayjobs.com/disneycareer/job/San-Francisco-CA-USA/"
         "Technical-Artist---Expression-of-Interest---ILM-San-Francisco_15203431",
         ("workday", "disney/wd5/disneycareer", "15203431")),
        ("https://disney.wd5.myworkdayjobs.com/disneycareer/job/Anaheim-CA-USA/"
         "DLR-Ops-Coord_12085041-1",
         ("workday", "disney/wd5/disneycareer", "12085041")),
        # A Workday URL with no requisition id in it cannot be tested for membership.
        ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Remote",
         None),
        # Workday spells a posting path both ways. Adobe uses `details`, and an anchor
        # that knows only `job` makes every such site a false unknown.
        ("https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/details/"
         "Senior-AI-Systems-Engineer_R170265",
         ("workday", "adobe/wd5/external_experienced", "R170265")),
        # ...and the anchor has to hold against a greedy site capture. This is the CXS API
        # URL rather than the human one; without the anchor the site reads "wday", which
        # addresses no board, and the rows under it would come back as a board that would
        # not load. An honest unknown is the right answer for a URL this tool was not
        # written to take.
        ("https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/"
         "job/US-CA-Remote/Senior-Engineer_JR2391853", None),
        # Breezy. The posting id prefixes the URL slug, which is what makes a board read
        # possible at all here; the human posting URL itself 302s.
        ("https://agbo.breezy.hr/p/49a145320531-expression-of-interest-character-artist",
         ("breezy", "agbo", "49a145320531")),
        ("https://www.github.careers/careers-home/jobs/5742", None),
        # A posting URL riding inside a redirect or tracking parameter belongs to another
        # row. Classifying THIS row as that tenant takes the embedded requisition, finds
        # it absent from the board, and --mark retires a row that was never about it.
        ("https://tracker.example.com/click?to=https://nvidia.wd5.myworkdayjobs.com/"
         "NVIDIAExternalCareerSite/job/US-CA-Remote/Senior-Engineer_JR2391853", None),
        ("https://tracker.example.com/click?to=https://job-boards.greenhouse.io/"
         "cresta/jobs/4233080640", None),
        # And in the PATH, which cutting the query cannot help with. This is what makes
        # the routing ANCHOR load-bearing rather than redundant: without match() the
        # embedded tenant and its requisition are both read off someone else's url.
        ("https://tracker.example.com/r/https://nvidia.wd5.myworkdayjobs.com/"
         "NVIDIAExternalCareerSite/job/US-CA-Remote/Senior-Engineer_JR2391853", None),
        # ...while the same Workday posting as the OUTER url still routes, tracking tag
        # and all, because the query is cut rather than the url rejected for having one.
        ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/"
         "US-CA-Remote/Senior-Engineer_JR2391853?utm_source=linkedin",
         ("workday", "nvidia/wd5/NVIDIAExternalCareerSite", "JR2391853")),
        # ── The same anchor, for the BOARD routes ────────────────────────────────
        # Workday was anchored with match() from the start and the loop under it used
        # search(), so every board route found its host anywhere along the string. It was
        # reported against Breezy because Breezy was the newest, but all four had it,
        # so all four are pinned. Each one would otherwise route to a real board, look
        # for the embedded id, not find it, and let --mark retire the row.
        ("https://tracker.example.com/r/https://agbo.breezy.hr/p/49a145320531-x", None),
        ("https://tracker.example.com/r/https://jobs.ashbyhq.com/whatnot/"
         "075210ef360cf159e1af", None),
        ("https://tracker.example.com/r/https://jobs.lever.co/acme/"
         "075210ef360cf159e1af", None),
        ("https://tracker.example.com/r/https://job-boards.greenhouse.io/"
         "cresta/jobs/4233080640", None),
        # ...and each still routes as the OUTER url, so the anchor cost no coverage.
        ("https://jobs.ashbyhq.com/whatnot/075210ef360cf159e1af",
         ("ashby", "whatnot", "075210ef360cf159e1af")),
        ("https://jobs.lever.co/acme/075210ef360cf159e1af",
         ("lever", "acme", "075210ef360cf159e1af")),
        # The scheme is OPTIONAL on purpose rather than by accident, so an inbox row
        # stored without one keeps routing. Asserted so anchoring cannot tighten into a
        # silent loss of rows.
        ("job-boards.greenhouse.io/cresta/jobs/4233080640",
         ("greenhouse", "cresta", "4233080640")),
        # The embed form reads the QUERY, which is the one exemption from the outer-url
        # cut, and it had been dead since that cut landed earlier: classify()
        # matched it against a string its `?for=` had already been removed from, so the
        # route could not fire at all. Found while anchoring the rest.
        ("https://boards.greenhouse.io/embed/job_app?for=cresta&token=4233080640",
         ("greenhouse", "cresta", "4233080640")),
        # ...and that exemption is not a way back in for a wrapper either.
        ("https://tracker.example.com/r/https://boards.greenhouse.io/embed/"
         "job_app?for=cresta&token=4233080640", None),
        # A wrapper the DETECTOR cannot see, which is what makes the anchor load-bearing
        # rather than a second copy of the refusal above. The embedded url has no scheme,
        # so the string holds one "https://" and wraps_another_url() correctly says no.
        # Nothing but the anchor stands between this row and AGBO's board. Every other
        # wrapper case here is caught by BOTH rules, so removing either one left the suite
        # green: two guards that mask each other test one guard.
        ("https://tracker.example.com/r/agbo.breezy.hr/p/49a145320531", None),
    ]
    for url, want in CASES:
        got = classify(url)
        if got != want:
            bad += 1
            print(f"  FAIL classify({url[:56]!r})")
            print(f"       got {got}, want {want}")
        # Anything this file can route is a host it has a reader for, by definition. Pinned
        # so READABLE_HOST cannot drift behind the readers and mislabel the coverage gap.
        if want and not READABLE_HOST.search(url):
            bad += 1
            print(f"  FAIL READABLE_HOST misses a host this file routes: {url[:58]!r}")

    # An unreadable or empty board must never produce a "closed" verdict. This is the
    # property that makes --mark safe, so it is asserted rather than assumed.
    real_fetch = globals()["fetch_board"]
    real_settle = globals()["settle_unknowns"]
    real_rows = globals()["unchecked_rows"]
    try:
        # FIXTURE inbox rows, never the user's data/pipeline.md. One per board reader.
        _fx = [
            {"line_no": 0, "url": "https://job-boards.greenhouse.io/acme/jobs/4233080640",
             "company": "Acme", "title": "Engineer"},
            {"line_no": 1, "url": "https://jobs.ashbyhq.com/acme/075210ef360cf159e1af",
             "company": "Acme", "title": "Engineer"},
            {"line_no": 2, "url": "https://jobs.lever.co/acme/075210ef360cf159e1af",
             "company": "Acme", "title": "Engineer"},
            {"line_no": 3, "url": "https://acme.breezy.hr/p/49a145320531-engineer",
             "company": "Acme", "title": "Engineer"},
        ]
        globals()["unchecked_rows"] = lambda: [dict(r) for r in _fx]
        # settle_unknowns is stubbed out here, and that is not a convenience. It reaches the
        # NETWORK for every unsettled row, so leaving it in would make this suite both slow
        # and online, and it would answer rows the board rule is supposed to leave alone,
        # which is exactly the property under test. It gets its own offline case below.
        globals()["settle_unknowns"] = lambda u, quiet=False: (u, [], [])
        globals()["fetch_board"] = lambda p, s: (set(), False)
        _l, c, u = sweep(quiet=True)
        # With zero rows routed to a board, "no closed verdicts" is true of an empty loop.
        if len(u) != len(_fx):
            bad += 1
            print(f"  FAIL the fixture rows did not all reach the stubbed board: "
                  f"{len(u)} of {len(_fx)} came back unknown")
        if c:
            bad += 1
            print(f"  FAIL an unreadable board produced {len(c)} closed verdict(s); "
                  f"it must produce none")
        globals()["fetch_board"] = lambda p, s: (set(), True)
        _l2, c2, _u2 = sweep(quiet=True)
        if c2:
            bad += 1
            print(f"  FAIL an EMPTY board produced {len(c2)} closed verdict(s); every row "
                  f"on it would be marked dead at once")
    finally:
        globals()["fetch_board"] = real_fetch
        globals()["settle_unknowns"] = real_settle
        globals()["unchecked_rows"] = real_rows

    # A non-200 board response is NOT READ, whatever its body parses to. Greenhouse answers
    # a missing board with HTTP 404 and valid JSON, which used to read as a board holding
    # nothing; only the empty-board rule stopped three rows from one employer being closed on it.
    class _Out:
        def __init__(self, text):
            self.stdout = text

    real_run = subprocess.run
    try:
        subprocess.run = lambda *a, **k: _Out('{"status":404,"error":"Job not found"}\n404')
        ids, ok = fetch_board("greenhouse", "temporaltechnologies")
        if ok or ids:
            bad += 1
            print(f"  FAIL a 404 carrying a JSON body must be NOT READ, got ok={ok}")
        subprocess.run = lambda *a, **k: _Out('{"jobs":[{"id":7}]}\n200')
        ids2, ok2 = fetch_board("greenhouse", "acme")
        if not ok2 or ids2 != {"7"}:
            bad += 1
            print(f"  FAIL a 200 board must still read: ok={ok2} ids={ids2}")
    finally:
        subprocess.run = real_run

    # A wrapper url is refused by the settle pass, not unwrapped. resolve()'s adapter
    # patterns search the whole string, so an Ashby or Lever posting sitting in a redirect
    # parameter would be resolved and ITS verdict applied to this row.
    for wrapper in ("https://t.example.com/c?to=https://jobs.lever.co/acme/"
                    "b7fa68ef-a543-549e-5c9b-dcaabf8a9b79",
                    "https://t.example.com/r/https://jobs.ashbyhq.com/acme/"
                    "0f1db59b-b272-644c-af35-f84c91963e3b",
                    "https://t.example.com/c?to=https%3A%2F%2Fjobs.lever.co%2Facme%2Fx"):
        if not wraps_another_url(wrapper):
            bad += 1
            print(f"  FAIL a wrapped posting url must be recognised: {wrapper[:64]}")
    for plain in ("https://jobs.lever.co/acme/b7fa68ef-a543-549e-5c9b-dcaabf8a9b79",
                  "https://www.sentinelone.com/jobs/?gh_jid=7505468003"):
        if wraps_another_url(plain):
            bad += 1
            print(f"  FAIL an ordinary posting url must not read as a wrapper: {plain}")
    _rr = resolver()
    _real = _rr.resolve
    try:
        _rr.resolve = lambda u: {"live": False, "note": "the embedded posting is gone"}
        still, alive, gone = settle_unknowns(
            [{"url": "https://t.example.com/c?to=https://jobs.lever.co/acme/x"}], quiet=True)
        if gone or alive or len(still) != 1:
            bad += 1
            print(f"  FAIL a wrapper must not take the embedded posting's verdict: "
                  f"{len(gone)} closed, {len(alive)} live")
    finally:
        _rr.resolve = _real

    # The last-resort pass, offline. It may CLOSE a row on the posting URL's own status and
    # may never open one, which is the same asymmetry the board rule keeps, reached from the
    # other side: a 200 from a client-rendered careers shell says nothing whatever.
    rr = resolver()
    real_resolve = rr.resolve
    try:
        rows = [{"url": "https://x/1"}, {"url": "https://x/2"}]
        rr.resolve = lambda u: {"live": False, "note": "HTTP 404"}
        still, alive, gone = settle_unknowns(list(rows), quiet=True)
        if len(gone) != 2 or still or alive:
            bad += 1
            print(f"  FAIL a gone posting must close the row: {len(gone)} closed, "
                  f"{len(alive)} live, {len(still)} still unknown")
        rr.resolve = lambda u: {"live": True}
        still, alive, gone = settle_unknowns(list(rows), quiet=True)
        if len(alive) != 2 or gone or still:
            bad += 1
            print(f"  FAIL a resolved posting must come back live: {len(alive)} live, "
                  f"{len(gone)} closed")
        # An unknown must stay unknown. This is the one that matters: a resolver that
        # cannot tell must not be read as either answer, which is the rule every other
        # part of this file is built on.
        for answer in ({"live": None}, {}):
            rr.resolve = lambda u, a=answer: a
            still2, alive2, gone2 = settle_unknowns(list(rows), quiet=True)
            if gone2 or alive2 or len(still2) != 2:
                bad += 1
                print(f"  FAIL resolve {answer} must settle nothing: {len(gone2)} closed, "
                      f"{len(alive2)} live")
    finally:
        rr.resolve = real_resolve

    # A TRUNCATED Workday walk is the same failure one level down, and it is the one this
    # tool would have shipped: at the 40-page default it inherits from workday-sweep,
    # NVIDIA returns exactly 800 of its 2000 postings, so 1200 live requisitions would be
    # absent from the set and every row among them marked closed in a single run. The page
    # bound is a runaway guard, and reaching it means the board was not read.
    w = workday()
    real_enum = w.enumerate_board
    try:
        w.enumerate_board = lambda *a, **k: ([{"externalPath": "/job/x/y_JR2391853"}],
                                             200, True)
        ids, ok = fetch_workday("nvidia/wd5/NVIDIAExternalCareerSite")
        if ok or ids:
            bad += 1
            print(f"  FAIL a truncated Workday walk reported ok={ok} with {len(ids)} id(s); "
                  f"it must report NOT READ")
        # ...while a complete walk still reads, or the guard would have made the whole
        # feature inert and nothing would have said so.
        w.enumerate_board = lambda *a, **k: ([{"externalPath": "/job/x/y_JR2391853"}],
                                             200, False)
        ids2, ok2 = fetch_workday("nvidia/wd5/NVIDIAExternalCareerSite")
        if not ok2 or ids2 != {"jr2391853"}:
            bad += 1
            print(f"  FAIL a complete Workday walk must yield its ids: ok={ok2} {ids2}")
    finally:
        w.enumerate_board = real_enum

    # No fifth copy of the requisition pattern. Four hand copies have already drifted in
    # this repo and every divergence was a silent miss rather than an error, so the rule is
    # structural: this file may USE workday-sweep's pattern and may not restate it.
    # Ashby's posting API is opt-in, so a 404 from it says nothing about the board. The
    # page parse is shared with the resolver; what is asserted here is this file's own
    # rule, that a page yielding nothing is NOT READ rather than an empty board.
    import _ashby_embed
    got = ashby_ids(_ashby_embed._SELFTEST_HTML, "acme")
    if got != {"aaa", "bbb"}:
        bad += 1
        print(f"  FAIL ashby board-page ids: got {got}, want {{'aaa', 'bbb'}}")
    if ashby_ids("<html>no board here</html>", "acme"):
        bad += 1
        print("  FAIL an unparseable Ashby page must yield no ids")

    # A board read this file refused to trust must not be re-derived by settle_unknowns()
    # (found in review). Both findings from that review were this one bug: the
    # resolver reaches the SAME board, and before it was hardened it read the same empty
    # Ashby list as an absence and closed every row the guard above had just held back.
    # The resolver is stubbed to answer live=False for everything, which is the worst case
    # and the one that was actually happening.
    rr2 = resolver()
    real_resolve2 = rr2.resolve
    try:
        rr2.resolve = lambda _u: {"live": False, "note": "stub says gone"}
        held = [{"url": "https://jobs.ashbyhq.com/acme/075210ef360cf159e1af",
                 "pid": "075210ef360cf159e1af", "why": "board ashby/acme parsed but is "
                 "empty", "held": True}]
        s, a, c = settle_unknowns(list(held), quiet=True)
        if len(s) != 1 or c or a:
            bad += 1
            print(f"  FAIL a held row must stay unknown: {len(s)} still, {len(c)} closed, "
                  f"{len(a)} live")
        elif s[0]["why"] != held[0]["why"]:
            bad += 1
            print(f"  FAIL a held row must keep its specific reason: {s[0]['why']!r}")
        # ...while a row that was merely UNROUTABLE is still asked, or the fallback that
        # settled three such rows and the whole Workday residue goes inert and
        # nothing says so. This is the half the rule must not take with it.
        s2, a2, c2 = settle_unknowns([{"url": "https://careers.example.com/job/1",
                                       "pid": None, "why": "no board reader for this host"}],
                                     quiet=True)
        if len(c2) != 1:
            bad += 1
            print(f"  FAIL an unroutable row must still be asked: {len(c2)} closed")
    finally:
        rr2.resolve = real_resolve2

    # The OTHER half of the held rule: that the empty-board branch actually SETS the flag.
    # The case above hand-builds a held row, so deleting the flag at its source left the
    # suite green, which is half a rule testing itself. Driven through sweep() end to end
    # with the pipeline stubbed rather than read, because this is a System Layer test and
    # data/pipeline.md is User Layer. The resolver is stubbed to close everything, which
    # is the worst case and the one that was happening.
    real_rows, real_board = unchecked_rows, fetch_board
    rr3 = resolver()
    real_resolve3 = rr3.resolve
    try:
        globals()["unchecked_rows"] = lambda: [
            {"line_no": 0, "url": "https://jobs.ashbyhq.com/acme/075210ef360cf159e1af",
             "company": "Acme", "role": "Engineer"}]
        globals()["fetch_board"] = lambda _p, _s: (set(), True)   # parsed, and EMPTY
        rr3.resolve = lambda _u: {"live": False, "note": "stub says gone"}
        li, cl, un = sweep(quiet=True)
        if cl or li or len(un) != 1:
            bad += 1
            print(f"  FAIL an empty board must leave its row unknown end to end: "
                  f"{len(li)} live, {len(cl)} closed, {len(un)} unknown")
        elif not un[0].get("held"):
            bad += 1
            print("  FAIL an empty board must MARK its rows held, or settle_unknowns "
                  "re-asks the same empty board by a route that can close")
    finally:
        globals()["unchecked_rows"] = real_rows
        globals()["fetch_board"] = real_board
        rr3.resolve = real_resolve3

    # Anchoring is a property of the TABLE, not of the four entries that happen to have
    # behavioural cases, so it is asserted structurally as well: a route added later
    # without `^` would pass every case here and reopen the hole for its own provider.
    # Worth knowing that `^` is the real guard and match() is belt-and-braces, since a
    # pattern already beginning `^` behaves identically under search(): swapping the call
    # is a mutation that CANNOT go red, and the anchor being in each pattern is why.
    for _prov, _rx, _q in BOARD_PATTERNS:
        if not _rx.pattern.startswith("^"):
            bad += 1
            print(f"  FAIL the {_prov} route is not anchored at the host, so it matches "
                  f"a wrapper carrying that host anywhere along the url")

    # The other half of the wrapper rule, isolated. Anchoring the board patterns cannot
    # reach the gh_jid branch, which reads the WHOLE url on purpose because the query is
    # the one place a Greenhouse job id legitimately lives. So a wrapper whose embedded
    # url carries `gh_jid` hands this row someone else's posting id, and the board slug
    # then comes from whatever portals.yml records for the WRAPPER's host. That is the
    # case the refusal at the top of classify() exists for, and it is the only case that
    # the anchors do not also catch, which is why it is asserted here rather than as one
    # more routing row. portal_slugs is stubbed rather than read: a real lookup makes this
    # pass for the wrong reason on a host portals.yml happens not to record, and reading
    # the User Layer from a System Layer test is its own mistake.
    real_slugs = portal_slugs
    try:
        globals()["portal_slugs"] = lambda _u: ["sentinellabs"]
        wrapped = ("https://careers.example.com/redirect"
                   "?to=https://other.example.com/jobs?gh_jid=4233080640")
        if classify(wrapped) is not None:
            bad += 1
            print(f"  FAIL a wrapper carrying gh_jid must not route: {classify(wrapped)}")
        # ...while the same gh_jid on an unwrapped url still routes, so the refusal
        # narrowed nothing but the ambiguous case.
        plain = "https://careers.example.com/jobs?gh_jid=4233080640"
        if classify(plain) != ("greenhouse", "sentinellabs", "4233080640"):
            bad += 1
            print(f"  FAIL an unwrapped gh_jid url must still route: {classify(plain)}")
    finally:
        globals()["portal_slugs"] = real_slugs

    # The needle is assembled at runtime so the check cannot match itself, which the first
    # version of it did: a literal here IS a copy of the pattern by any honest reading.
    src = io.open(os.path.abspath(__file__), encoding="utf-8").read()
    # Same rule for the Workday locale test, and for the same reason: this file refused a
    # locale-only url by SHAPE while the resolver tested LENGTH, so a row held back here
    # was fabricated into a CXS path there. Assembled at runtime so the check cannot match
    # itself, exactly as the requisition needle below is.
    locale_needle = "[a-z]{2}(?:-" + "[a-z]{2})?$"
    if locale_needle in src:
        bad += 1
        print("  FAIL this file restates the Workday locale test; read it from "
              "req-resolve.WD_LOCALE_ONLY through locale_only()")
    if locale_only().match("en") is None or locale_only().match("Ext") is not None:
        bad += 1
        print("  FAIL locale_only() must read shape, not length")

    needle = "JR[-_]?" + r"\d{5,}"
    if needle in src:
        bad += 1
        print("  FAIL this file restates the requisition pattern; import it from "
              "workday-sweep.py, which holds the one hand port of req-id-core.mjs")

    print(f"inbox-liveness selftest: {len(CASES)} routing cases + 29 safety properties, "
          f"{bad} failure(s)")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mark", action="store_true",
                    help="mark confirmed-closed rows [x] in data/pipeline.md")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return _selftest()

    live, closed, unknown = sweep(quiet=a.json)
    # The unknown bucket is the COVERAGE GAP, so report it as one. Grouping by reason is
    # what turns "220 rows I could not check" into a work list: the largest group names the
    # board reader worth writing next, and a reason that is one company's outage is
    # obviously different from one that is a whole ATS nobody has taught this tool to read.
    why = collections.Counter(r.get("why", "unrecorded") for r in unknown)
    if a.json:
        print(json.dumps({"live": len(live), "closed": len(closed),
                          "unknown": len(unknown),
                          "unknown_by_reason": dict(why.most_common()),
                          "closed_rows": [{"company": r["company"], "title": r["title"],
                                           "url": r["url"]} for r in closed],
                          "unknown_rows": [{"company": r["company"], "title": r["title"],
                                            "url": r["url"], "why": r.get("why")}
                                           for r in unknown]}, indent=1))
        return 0

    print(f"\n{len(live)} live, {len(closed)} CLOSED, {len(unknown)} unknown "
          f"(not checkable by board membership)")
    if unknown:
        print("\nwhy the unknowns could not be checked, largest gap first:")
        for reason, n in why.most_common(12):
            print(f"  {n:4d}  {reason}")
        if len(why) > 12:
            print(f"        ...and {len(why) - 12} more reason(s); --json lists every row")
    if closed:
        print("\nconfirmed closed, the id is no longer on the company board:")
        for r in sorted(closed, key=lambda x: x["company"]):
            print(f"  {r['company'][:28]:30s} {r['title'][:46]}")
    if a.mark:
        n = mark_closed(closed)
        print(f"\nmarked {n} row(s) resolved")
    elif closed:
        print("\nre-run with --mark to retire them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
