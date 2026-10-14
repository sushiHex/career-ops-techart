#!/usr/bin/env python
"""eval-blockers.py — say what is stopping each queued packet from being decided.

A packet sits in the queue for one of a few specific reasons, and they need
different work. Lumping them together as "58 to review" hides that most need no
judgement at all:

  reported            a report already exists for this requisition. It is not
                      work at all, it is finished work still sitting in the
                      directory.
  closed              the packet's own `live` field says the posting is gone.
  liveness-unknown    `live` is null, which is what the resolver returns when it
                      could NOT tell. Not checked and checked-and-fine are
                      different answers, so this is never "ready".
  resolve-location    the location came back as a placeholder ("Multiple
                      Locations", "N Locations") or an unrecognised string, so the
                      hard gate cannot be applied yet. Needs a lookup, not a read.
  no-band             comp cannot be derived, so a quarter of the score is missing
                      and the floor gate cannot run. Needs the band, not a read.
  likely-tracked      strong duplicate signal against applications.md. Needs a
                      comparison, not a fresh evaluation.
  out-of-lane         the body carries no lane vocabulary at all and clear
                      anti-signals. Dispositionable without a read.
  ready               live posting, no report yet, location passes, band known,
                      no duplicate. This is the only group that genuinely needs
                      judgement.

WHY THE FIRST THREE WERE ADDED. This tool answered "what is in the directory"
while it was read as "what is left to do", and on 2026-09-20 those had diverged
badly. 106 of the 128 packets carrying a url were already written up; they landed
in `filled` when their judgement fields happened to be set, and in `ready` when
they were not, so the tool reported a backlog that was four fifths finished. And
nothing consulted the tri-state `live` field the packets have always carried, so
the READY list was headed by an Adobe requisition retired as closed an hour
earlier and contained an NVIDIA one retired that morning. A queue tool that
counts dead and duplicated rows as pending work is worse than no queue tool,
because the number looks authoritative.

Run:
  python scripts/eval-blockers.py            # counts, the ready list, prune preview
  python scripts/eval-blockers.py --all      # every packet with its blocker
  python scripts/eval-blockers.py --prune    # MOVE reported+closed to done/
  python scripts/eval-blockers.py --selftest
"""
import argparse
import glob
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
QUEUE = os.path.join(ROOT, "batch", "eval-queue")
DONE = os.path.join(QUEUE, "done")
REPORTS = os.path.join(ROOT, "reports")

if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _load(mod_name, filename):
    """Import a hyphenated script by path. Mirrors _load() in workday-sweep.py."""
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(HERE, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# The requisition pattern is IMPORTED, not spelled again here.
#
# It has already been written out four times in four spellings and every
# divergence was a silent miss rather than an error (see req-id-core.mjs for the
# four). The Node consumers import it from req-id-core.mjs; the one sanctioned
# Python copy lives in workday-sweep.py, and pipeline-audit.mjs --selftest reads
# that file and asserts the two SOURCES are character-for-character equal. A
# fifth copy here would sit outside that assertion and drift unobserved, so this
# file takes the pattern from the module that is already checked, along with
# tracked_key(), which is what applies the company scoping below.
#
# The import costs ~380ms because workday-sweep pulls in the CXS transport and
# the location gate. That is paid once, against a run that already reads ~590
# reports. There is deliberately NO fallback pattern: if the import breaks, this
# tool must fail loudly rather than quietly classify every packet as new work.
_wd = _load("wdsweep", "workday-sweep.py")
REQ_ID = _wd.REQ_ID
tracked_key = _wd.tracked_key
queue_packets = _wd._prep.queue_packets

# Host-anchored ids (Apple, Google, iCIMS with its github.careers and atlassian.com
# front ends, EA, Breezy) are DATA in host-ids.json, which role-matcher.mjs reads too,
# so the two cannot hold different lists. The file states the contract; re.ASCII is
# part of it, so \w and \d mean here what they mean in JavaScript.
HOST_IDS_PATH = os.path.join(ROOT, "host-ids.json")


def load_host_ids(path=HOST_IDS_PATH):
    """[(compiled re, namespace, per_employer, rule)] in file order."""
    with open(path, encoding="utf-8") as fh:
        rules = json.load(fh)["rules"]
    return [(re.compile(r["re"], re.I | re.ASCII), r["ns"], bool(r.get("per_employer")), r)
            for r in rules]


HOST_IDS = load_host_ids()


def hosted_id(url):
    """(key, per_employer) for the first host rule matching url, or None.

    role-matcher's hostedId(): the url trimmed, query and fragment cut, group 1
    lowercased under the rule's namespace.
    """
    path = re.split(r"[?#]", str(url).strip())[0]
    for rx, ns, per_employer, _ in HOST_IDS:
        m = rx.search(path)
        if m:
            return f"{ns}:{m.group(1).lower()}", per_employer
    return None


def employer_key(company):
    """A company name folded by case and punctuation ONLY, to scope a per_employer id.

    Not src_co(), which drops words such as Games, Labs and Systems: right for joining a
    tracker row to a portals.yml label, wrong for identity, since it gives Acme Games and
    Acme Labs one key and so one employer's report would answer for the other's packet.
    A spelling this fold fails to join ("GitHub" against "GitHub, Inc.") only leaves a
    packet visible as work, which is the safe direction.
    """
    return re.sub(r"[^a-z0-9]", "", str(company or "").lower())

# Greenhouse puts the id in the query string, which is the one place a job
# identity legitimately lives there. Ashby and Lever use a canonical UUID as a
# whole path segment; bounding it with `/` keeps a UUID-shaped tracking
# parameter from ever standing in for the posting.
GH_JID = re.compile(r"[?&]gh_jid=(\d{4,})", re.I)
GH_PATH = re.compile(r"greenhouse\.io/[^/]*?/jobs/(\d{4,})", re.I)
UUID = re.compile(
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:/|$)", re.I)

# The report header, which pipeline rule 5 makes mandatory, plus the Machine
# Summary as a second source. Both are read because they do not agree: 576 of
# 588 reports carry a **URL:** header and only 258 carry a machine `url:`, and
# 19 of the reports carrying both spell the url differently. Indexing both
# spellings costs nothing and each one covers the other's gaps.
HDR_URL = re.compile(r"^\*\*URL:\*\*\s*(\S+)", re.M)
HDR_CO = re.compile(r"^\*\*Company:\*\*\s*(.+?)\s*$", re.M)
YML_URL = re.compile(r"^[ \t]*url:[ \t]*[\"']?(\S+?)[\"']?[ \t]*$", re.M)
YML_CO = re.compile(r"^[ \t]*company:[ \t]*[\"']?(.+?)[\"']?[ \t]*$", re.M)

ANTI_MIN = 4          # mentions below this are ambient, not the job


def norm_url(u):
    """Two spellings of one posting URL are one req. Mirrors normUrl() in eval-write.

    SCHEME and HOST are folded; path, query and fragment are not. Lowercasing the whole
    URL conflates postings that differ only by case, and this lookup runs BEFORE the
    requisition match, so a report for `/jobs/ABC` made an unevaluated packet for
    `/jobs/abc` read as `reported` and `--prune` then moved it out of the queue. That is
    the destructive direction. Preserving case can only fail the other way, leaving a
    packet visible as work when a report already covers it.

    eval-write.mjs normUrl() was changed in the same commit. A comment saying these two
    mirror each other is not a mechanism, so each file now carries a case asserting the
    property rather than the wording.
    """
    s = str(u or "").strip().rstrip("/")
    m = re.match(r"^(https?://)([^/?#]+)(.*)$", s, re.I)
    return (m.group(1).lower() + m.group(2).lower() + m.group(3)) if m else s.lower()


def req_key(url, company):
    """The requisition identity behind a posting URL, or None.

    Identity, not filename and not title. nvidia-sweep.py records NVIDIA JR2620896 and
    JR2301525 as one word apart with opposite location verdicts, and two
    employers posting "AI Engineer" is the commoner shape, so a title join would
    be wrong in both directions.

    Tried in order: the host-anchored rules of host-ids.json, the shared Workday
    pattern, a Greenhouse gh_jid, an Ashby/Lever UUID. The host rules go first
    and a match there is final, as in role-matcher.mjs, because a rule that owns
    its host knows that host's id better than a generic one. Every key is
    namespaced (`apple:`, `icims:`, `wd:`, `gh:`, `uuid:` and so on, the
    spellings role-matcher produces), so no two key spaces can collide.

    Query and fragment are cut before the Workday pass, the rule jobKey()
    follows: a tracking parameter carrying a req-shaped token is not this
    posting's requisition. Last match wins, because the requisition sits at the
    end of an ATS path.

    Two kinds of key are COMPANY-SCOPED, because this index compares across
    companies. A bare R##### through tracked_key(), since Workday tenants number
    from independent counters and one tracker routinely carries bare R##### ids
    from several employers at once. And a host rule's `per_employer` id (iCIMS,
    Breezy), scoped by employer_key(), which with no company is no key at all. A
    false hit here reads as "already reported" and, under --prune, moves a live
    unevaluated req out of the queue, which is the destructive direction.
    """
    if not url:
        return None
    hosted = hosted_id(url)
    if hosted:
        key, per_employer = hosted
        if not per_employer:
            return key
        co = employer_key(company)
        return f"{key}@{co}" if co else None
    path = str(url).split("?")[0].split("#")[0]
    last = None
    for m in REQ_ID.finditer(path):
        last = m.group(1)
    if last:
        return "wd:" + tracked_key(last, company or "")
    m = GH_JID.search(str(url)) or GH_PATH.search(path)
    if m:
        return "gh:" + m.group(1)
    m = UUID.search(path)
    if m:
        return "uuid:" + m.group(1).lower()
    return None


def report_index(reports_dir=REPORTS):
    """Every report on disk keyed by requisition identity: (by_url, by_req).

    One pass, 122ms for the 588 reports on disk, once per run. If reports/ ever
    grows past what one pass can afford, make the index incremental; do not
    narrow the search back to a filename prefilter, which is the mistake
    eval-write.mjs already had to undo (both halves of a
    "-<slug>-<DATE>.md" key are mutable, so a req retried on another day was
    never compared against its own report).
    """
    by_url, by_req = {}, {}
    if not os.path.isdir(reports_dir):
        return by_url, by_req
    for f in sorted(glob.glob(os.path.join(reports_dir, "*.md"))):
        try:
            t = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        name = os.path.basename(f)
        for urx, corx in ((HDR_URL, HDR_CO), (YML_URL, YML_CO)):
            mu = urx.search(t)
            if not mu:
                continue
            mc = corx.search(t)
            by_url.setdefault(norm_url(mu.group(1)), name)
            k = req_key(mu.group(1), mc.group(1) if mc else "")
            if k:
                by_req.setdefault(k, name)
    return by_url, by_req


def report_for(p, ix):
    """The report already written for this packet's req, or None."""
    by_url, by_req = ix
    url = p.get("url")
    if not url:
        return None
    hit = by_url.get(norm_url(url))
    if hit:
        return hit
    k = req_key(url, p.get("company") or "")
    return by_req.get(k) if k else None


def strong_anti(anti, title):
    """Is an anti-signal about the ROLE, or just words on the page?

    anti_signals are counted across the whole posting, and a posting is mostly
    company boilerplate. One employer's generic "Machine Learning Engineer" posting
    was classed out-of-lane on two incidental mentions of ranking, and would have been retired without a read. Two mentions in
    a 7,000-character page is ambient vocabulary.

    So an anti-signal counts when it is repeated enough to be the subject, or when it
    is in the title, which is the one place the employer states what the job is. That
    keeps "Web Ads Ranking" and "Search Ranking" out while letting the generic roles
    through to a human.
    """
    t = (title or "").lower()
    for a in anti:
        m = re.search(r"x(\d+)\s*$", str(a))
        if m and int(m.group(1)) >= ANTI_MIN:
            return True
        term = re.sub(r"x\d+\s*$", "", str(a)).strip().lower()
        for word in re.split(r"[/,]", term):
            word = word.strip()
            if len(word) > 2 and word in t:
                return True
    return False


def blocker(p, ix):
    """Why this packet is not decided yet.

    `reported` and `closed` come FIRST and they outrank `filled`, which is the
    fix: a written-up req whose judgement fields happen to be set used to read as
    `filled` and one whose fields were null used to read as `ready`, so the same
    finished work was reported two different ways and neither said "done".

    The index is a required argument rather than an optional one. Defaulting it
    to None would make a caller that forgot it classify every packet as new work,
    silently, which is the exact class of failure this function was changed to
    remove.
    """
    if report_for(p, ix):
        return "reported"
    live = p.get("live")
    if live is False:
        return "closed"
    if p.get("match_w_cv") is not None:
        # ...but only when eval-write could actually act on it. eval-write.mjs gates on
        # `p.live !== true` and skips anything else, so a judged packet whose liveness was
        # never settled and which is told to "run eval-write" is being sent to a tool that
        # will refuse it. `live` is already known not to be False here, so the only other
        # case is null, and the actionable blocker there is the liveness, not the write.
        return "filled" if live is True else "liveness-unknown"
    lv = p.get("location_verdict")
    if lv == "fail":
        return "location-fail"
    if lv == "unknown":
        return "resolve-location"
    lane = p.get("lane_balance", 0)
    anti = p.get("anti_signals") or []
    if lane <= 0 and anti and strong_anti(anti, p.get("title") or ""):
        return "out-of-lane"
    if len(p.get("possible_tracker_duplicates") or []) >= 4 and lane < 4:
        return "likely-tracked"
    if not (p.get("comp") or {}).get("posted"):
        return "no-band"
    # Everything else about this packet says ready, so this is the one place
    # where an unchecked liveness matters. `live` is null when the resolver could
    # not tell: an unreadable board, a bot-blocked host such as amazon.jobs, an
    # ATS it does not support. Calling that ready asserts a posting is open on
    # the strength of never having looked.
    if live is None:
        return "liveness-unknown"
    return "ready"


# Ordered so the top of the list is work and the bottom is not. Each group is
# (heading, states); the heading is what makes the finished/pending split
# readable at a glance, which a flat count of ten states is not.
GROUPS = [
    ("needs judgement", ["ready"]),
    # `filled` is WORK, not a finished state, and it sat under "finished" until a review
    # caught it. Judgement fields being set with no report behind them means eval-write
    # still has to run, which is exactly why PRUNE_STATES below already excluded it. The
    # two decisions contradicted each other, and the visible cost was a summary claiming
    # nothing was left to do while a judged packet waited to be written up.
    ("needs eval-write", ["filled"]),
    ("needs a lookup", ["liveness-unknown", "resolve-location", "no-band"]),
    ("dispositionable", ["likely-tracked", "out-of-lane", "location-fail"]),
    ("finished", ["reported", "closed"]),
]
ORDER = [s for _, states in GROUPS for s in states]
PENDING = [s for h, states in GROUPS if h != "finished" for s in states]
# What --prune moves. `filled` is NOT here: judgement fields being set is not
# evidence a report was written, and moving it would hide a packet that still
# needs eval-write run over it.
PRUNE_STATES = ("reported", "closed")


def load_rows(queue=QUEUE, ix=None):
    """Every packet in the queue with its blocker; reports are indexed only when there is a packet."""
    packets = list(queue_packets(queue))
    if packets and ix is None:
        ix = report_index()
    return [(blocker(p, ix), p, f) for f, p in packets]


def free_path(dest_dir, base):
    """A destination that does not already exist.

    A prune is a MOVE and never a delete, and writing over an existing done/
    file would delete its contents, so a name collision gets a suffix rather
    than an overwrite. Collisions are real: eval-prep regenerates a packet under
    the same slug, so the same filename can be pruned twice.
    """
    path = os.path.join(dest_dir, base)
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(base)
    n = 2
    while os.path.exists(os.path.join(dest_dir, f"{stem}-{n}{ext}")):
        n += 1
    return os.path.join(dest_dir, f"{stem}-{n}{ext}")


def lane_key(p):
    """Sort key for a ready list: best lane first, and NOT SCORED last.

    `lane_balance` is written by eval-assist.py, a separate step, so a freshly prepped
    packet has no such key. Treating that as a zero both printed `lane 0` for a title like
    "Principal Engineer, Duo Agent Platform" and sorted it among the genuine zeros, which
    is the never-scored-is-not-score-missing mistake in a new place: one answer means "this
    role has no lane vocabulary", the other means "nobody has looked yet", and the second
    one is fixed by running a tool rather than by dismissing the row.
    """
    lane = p.get("lane_balance")
    return (lane is None, -(lane or 0))


def prune(rows, write, dest=DONE, limit=10, quiet=False):
    """Move the finished packets out of the live queue, or say what would move.

    Dry run unless `write`, matching apply-model.mjs: no flags is a preview and
    the write is an explicit act. shutil.move, never os.remove, because a wrong
    classification has to be recoverable by hand.
    """
    plan = [(b, p, f) for b, p, f in rows if b in PRUNE_STATES]
    left = [r for r in rows if r[0] not in PRUNE_STATES]
    counts = {s: sum(1 for b, _, _ in plan if b == s) for s in PRUNE_STATES}
    detail = ", ".join(f"{counts[s]} {s}" for s in PRUNE_STATES if counts[s])
    # Display only. On Windows relpath raises when the two paths are on different drives
    # (a checkout on D: and a temp directory on C:), so fall back to the full path.
    try:
        rel = os.path.relpath(dest, ROOT).replace("\\", "/")
    except ValueError:
        rel = os.path.abspath(dest).replace("\\", "/")
    say = (lambda *_a: None) if quiet else print

    say(f"\nprune {'' if write else '(dry run) '}-> {rel}/")
    say("-" * 46)
    if not plan:
        say("  nothing to move")
        return []
    say(f"  {'move' if write else 'would move'} {len(plan):3d}  ({detail})")
    say(f"  {'left' if write else 'would leave'} {len(left):3d}  in the live queue")

    moved = []
    if write:
        os.makedirs(dest, exist_ok=True)
    shown = 0
    for b, p, f in plan:
        base = os.path.basename(f)
        if write:
            target = free_path(dest, base)
            shutil.move(f, target)
            moved.append((base, os.path.basename(target)))
        if write or shown < limit:
            note = ""
            if write and moved and moved[-1][0] != moved[-1][1]:
                note = f" -> {moved[-1][1]}"
            say(f"    {b:10s} {base}{note}")
            shown += 1
    if not write and len(plan) > limit:
        say(f"    ... and {len(plan) - limit} more (--all for the full list)")
    if not write:
        say("  nothing was moved; run with --prune to move them")
    return moved


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true",
                    help="list every packet with its blocker, not just the ready ones")
    ap.add_argument("--ready", action="store_true",
                    help="list only the ready packets (the default)")
    ap.add_argument("--prune", action="store_true",
                    help="MOVE reported and closed packets to batch/eval-queue/done/")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()

    rows = load_rows()
    counts = {k: sum(1 for b, _, _ in rows if b == k) for k in ORDER}
    done = sum(counts[k] for k in ORDER if k not in PENDING)
    pend = sum(counts[k] for k in PENDING)

    print("blocker breakdown")
    print("-" * 46)
    for heading, states in GROUPS:
        if not any(counts[s] for s in states):
            continue
        print(f"  {heading}")
        for s in states:
            if counts[s]:
                print(f"    {s:18s} {counts[s]:3d}")
    print("-" * 46)
    pct = (100.0 * done / len(rows)) if rows else 0.0
    print(f"  {'TOTAL':20s} {len(rows):3d}")
    print(f"  {'finished':20s} {done:3d}  ({pct:.0f}% of the directory)")
    print(f"  {'still pending':20s} {pend:3d}")

    want = ORDER if a.all else ["ready"]
    for k in want:
        sel = [(b, p, f) for b, p, f in rows if b == k]
        if not sel:
            continue
        print(f"\n{k.upper()} ({len(sel)})")
        print("-" * 92)
        # Unscored rows sort last and print `-`, never `0`; lane_key says why.
        sel.sort(key=lambda r: lane_key(r[1]))
        for b, p, f in sel:
            c = (p.get("comp") or {}).get("posted") or "no band"
            lane = p.get("lane_balance")
            print(f"  lane {('-' if lane is None else str(lane)):>5}  {c:24s} "
                  f"{(p.get('title') or os.path.basename(f))[:52]}")

    prune(rows, write=a.prune, limit=10 ** 6 if a.all else 10)
    return 0


# ── selftest ────────────────────────────────────────────────────────
# Every case below is built on temp fixtures so it never reads the real queue or
# the real reports directory, and every one is mutation-verified: break the check
# it guards and the case must go RED. A case that cannot fail is not a case.

def _write_report(d, name, url, company):
    with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
        fh.write(f"# {name}\n\n**Company:** {company}\n**URL:** {url}\n")


def _packet(**kw):
    p = {"url": None, "company": None, "live": True, "title": "Senior AI Engineer",
         "location_verdict": "pass", "location_why": "remote-US",
         "comp": {"posted": "$200,000 - $300,000"}, "lane_balance": 5.0,
         "anti_signals": [], "possible_tracker_duplicates": [], "match_w_cv": None}
    p.update(kw)
    return p


def selftest():
    global HOST_IDS  # swapped for a planted table in one case, and restored
    fails = []

    def check(label, got, want):
        if got == want:
            print(f"  ok   {label}")
        else:
            fails.append(label)
            print(f"  FAIL {label}: got {got!r}, want {want!r}")

    # Scheme and host fold; path, query and fragment do not. This lookup runs before the
    # requisition match, so conflating two postings that differ only by case made an
    # unevaluated packet read as `reported`, and --prune then moved it out of the queue.
    check("norm_url folds the scheme and host",
          norm_url("HTTPS://Careers.Example.COM/jobs/ABC/"),
          "https://careers.example.com/jobs/ABC")
    check("norm_url keeps path case",
          norm_url("https://x.com/jobs/ABC") == norm_url("https://x.com/jobs/abc"), False)
    check("norm_url keeps query and fragment case",
          norm_url("https://x.com/j?id=AbC#Frag"), "https://x.com/j?id=AbC#Frag")

    check("judged + live true -> filled",
          blocker({"match_w_cv": 3, "live": True}, ({}, {})), "filled")
    # A judged packet whose liveness was never settled is NOT ready for eval-write:
    # eval-write.mjs gates on `live !== true` and would refuse it, so telling the user to
    # run it points at the wrong remediation. The blocker is the liveness.
    check("judged + liveness never settled -> liveness-unknown",
          blocker({"match_w_cv": 3, "live": None}, ({}, {})), "liveness-unknown")
    check("judged + closed is still closed",
          blocker({"match_w_cv": 3, "live": False}, ({}, {})), "closed")

    # `filled` means judged with no report behind it, so eval-write still has to run. It
    # belongs in the pending half and must never be pruned, and those two facts have to
    # agree: they did not, and the summary read as "nothing left to do".
    check("filled counts as pending work", "filled" in PENDING, True)
    check("filled is never pruned", "filled" in PRUNE_STATES, False)
    check("every pruned state is a finished one",
          [s for s in PRUNE_STATES if s in PENDING], [])

    # A packet nobody has lane-scored must not tie with one scored zero, and must not
    # outrank a scored row either. Sorted, not just displayed, because the READY list is
    # read top-down and an unscored row sitting among the zeros is a row that gets skipped.
    check("an unscored packet sorts after a genuine zero",
          sorted([{"lane_balance": 0}, {}, {"lane_balance": 3.7}], key=lane_key),
          [{"lane_balance": 3.7}, {"lane_balance": 0}, {}])
    check("a negative lane still beats not-scored",
          sorted([{}, {"lane_balance": -2}], key=lane_key),
          [{"lane_balance": -2}, {}])

    tmp = tempfile.mkdtemp(prefix="evalblockers-")
    reports = os.path.join(tmp, "reports")
    os.makedirs(reports)

    NV_REPORT = ("https://acmecorp.wd5.myworkdayjobs.com/AcmeCorpExternalCareerSite/job/"
                 "US-CA-Example/Example-Role-06_JR1000001-1")
    NV_PACKET = ("https://acmecorp.wd5.myworkdayjobs.com/en-US/AcmeCorpExternalCareerSite/"
                 "job/US-CA-Example/Example-Role-06_JR1000001")
    GH_REPORT = "https://www.globex.example/jobs/1000001?gh_jid=1000001"
    GH_PACKET = "https://job-boards.greenhouse.io/globexlabs/jobs/1000001"
    ASH = "https://jobs.ashbyhq.com/initrode/00000000-cbe0-cbe0-cbe0-000000000000"
    PLAIN = "https://example.com/jobs/other-role"

    _write_report(reports, "900-acmecorp-agentic-2026-01-01.md", NV_REPORT, "AcmeCorp")
    _write_report(reports, "901-globex-principal-2026-01-02.md", GH_REPORT, "Globex")
    _write_report(reports, "902-initrode-applied-ml-2026-01-03.md", ASH, "Initrode")
    # A bare R##### from ONE tenant must not answer for another's. CrowdStrike
    # R26710 and Workiva R11095 come from independent counters, and a false hit
    # here moves a live unevaluated req out of the queue under --prune.
    _write_report(reports, "450-crowdstrike-r26710-2026-08-10.md",
                  "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA/x_R26710",
                  "CrowdStrike")
    # A report with no **URL:** line at all must simply contribute nothing rather
    # than matching everything through an empty key.
    with open(os.path.join(reports, "001-legacy-no-url-2026-06-18.md"), "w",
              encoding="utf-8") as fh:
        fh.write("# 001 - Legacy\n\n**Company:** Legacy Co\n")

    # One report per host rule family in host-ids.json. Each packet below names the same
    # posting with a DIFFERENT url, so only the host-anchored identity can join them.
    HOSTED = (
        ("apple", "Apple",
         "https://jobs.apple.com/en-us/details/201190336-0001/example-role",
         "https://jobs.apple.com/en-gb/details/201190336-0001/example-role-renamed"),
        ("google", "Google",
         "https://careers.google.com/jobs/results/114723757451217499-example-role/",
         "https://www.google.com/about/careers/applications/jobs/results/"
         "114723757451217499-example-role-renamed"),
        ("icims", "GitHub",
         "https://www.github.careers/careers-home/jobs/1001?lang=en-us",
         "https://careers-exampleinc.icims.com/jobs/1001/example-role/job"),
        ("atlassian", "Atlassian",
         "https://www.atlassian.com/company/careers/details/1002",
         "https://www.atlassian.com/company/careers/details/1002/?src=feed"),
        ("ea", "Electronic Arts",
         "https://jobs.ea.com/en_US/careers/JobDetail/Example-Role/200001",
         "https://jobs.ea.com/en_GB/careers/JobDetail/Example-Role-Renamed/200001"),
        ("breezy", "Example Studio",
         "https://example-studio.breezy.hr/p/3e7c3a9f0349-example-role",
         "https://example-studio.breezy.hr/p/3e7c3a9f0349-example-role-renamed/apply"),
    )
    for i, (name, co, rep_url, _) in enumerate(HOSTED):
        _write_report(reports, f"60{i}-{name}-2026-10-13.md", rep_url, co)
    _write_report(reports, "610-acme-games-icims-2026-10-13.md",
                  "https://careers-acme-games.icims.com/jobs/1003/example-role/job", "Acme Games")

    ix = report_index(reports)

    # Every rule's own example in host-ids.json, the case role-matcher is held to in
    # test-all, so a rule added to the file is tested here with nothing else to edit.
    for _, ns, per_employer, rule in HOST_IDS:
        want = rule["key"] + ("@exampleco" if per_employer else "")
        check(f"host-ids.json example keys as {want}",
              req_key(rule["example"], "Example Co"), want)
    # req_key consumes the TABLE, not a private copy: plant a rule nobody else has.
    probe = os.path.join(tmp, "host-ids.json")
    with open(probe, "w", encoding="utf-8") as fh:
        json.dump({"rules": [{"ns": "probe", "re": r"^(?:https?://)?jobs\.probe\.invalid/(\d+)"}]}, fh)
    real_rules, HOST_IDS = HOST_IDS, load_host_ids(probe)
    try:
        check("req_key reads its host rules from the loaded table",
              req_key("https://jobs.probe.invalid/123", "Probe"), "probe:123")
    finally:
        HOST_IDS = real_rules
    check("the loaded table is host-ids.json",
          [r for *_, r in HOST_IDS] == [r for *_, r in load_host_ids(HOST_IDS_PATH)], True)
    for name, co, _, packet_url in HOSTED:
        check(f"identity: {name} host rule across a re-spelt url",
              blocker(_packet(url=packet_url, company=co), ix), "reported")
    # One namespace is one id space, so its rules must agree on scoping, or a scoped
    # github.careers key and an unscoped icims.com key for one posting never meet.
    scoping = {}
    for _, ns, per_employer, _ in HOST_IDS:
        scoping.setdefault(ns, set()).add(per_employer)
    check("every namespace in host-ids.json scopes all its rules alike",
          sorted(ns for ns, s in scoping.items() if len(s) > 1), [])
    # iCIMS counts per customer, so one employer's report must not answer for another
    # employer's packet carrying the same number, and with no company there is no key.
    # Acme Games and Acme Labs share a name once src_co() drops Games and Labs, which is
    # why the scope is employer_key() and not that join key.
    check("a per_employer id at a different company is NOT reported",
          blocker(_packet(url="https://careers-acme-labs.icims.com/jobs/1003/example-role/job",
                          company="Acme Labs"), ix), "ready")
    check("a Breezy id on another employer's board is NOT reported",
          blocker(_packet(url="https://other-studio.breezy.hr/p/3e7c3a9f0349-example-role",
                          company="Other Studio"), ix), "ready")
    check("a per_employer id from another front end is NOT reported",
          blocker(_packet(url="https://www.atlassian.com/company/careers/details/1001",
                          company="Atlassian"), ix), "ready")
    # ...and an unkeyable host match is still final: the generic rules must not then
    # read a req-shaped token out of the same url.
    check("a per_employer id with no company is no key",
          req_key("https://www.github.careers/careers-home/jobs/1001/x_JR2000003", ""), None)
    # A host match is final: the generic rules never re-key a host-owned url.
    check("a host rule outranks the generic rules",
          req_key("https://jobs.apple.com/en-us/details/200000002-0001/x_JR2000002", "Apple"),
          "apple:200000002")

    # A written-up req is `reported` even when its judgement fields are filled.
    # This is the case that used to read as `filled`, which is indistinguishable
    # from "someone is mid-evaluation".
    check("report exists + judgement filled -> reported",
          blocker(_packet(url=NV_PACKET, company="AcmeCorp", match_w_cv=4.2), ix),
          "reported")

    # Identity, by each of the three key spaces. Every packet url below differs
    # textually from the report's, which is the whole point: a url join alone
    # misses a Workday re-slug and any tracking parameter.
    check("identity: Workday req id across a re-slug, judgement empty",
          blocker(_packet(url=NV_PACKET, company="AcmeCorp"), ix), "reported")
    check("identity: greenhouse gh_jid across hosts",
          blocker(_packet(url=GH_PACKET, company="Globex"), ix), "reported")
    check("identity: ashby uuid across a tracking parameter",
          blocker(_packet(url=ASH + "?utm_source=linkedin", company="Initrode"), ix),
          "reported")

    # The destructive direction: a bare R id belonging to another tenant.
    check("bare R id from a different company is NOT reported",
          blocker(_packet(
              url="https://workiva.wd1.myworkdayjobs.com/careers/job/Remote/y_R26710",
              company="Workiva"), ix),
          "ready")

    # live is the tri-state the packets carry, and all three states differ.
    check("live false -> closed",
          blocker(_packet(url=PLAIN, live=False), ix), "closed")
    check("live false outranks filled judgement",
          blocker(_packet(url=PLAIN, live=False, match_w_cv=4.5), ix), "closed")
    unknown = blocker(_packet(url=PLAIN, live=None), ix)
    check("live null -> liveness-unknown", unknown, "liveness-unknown")
    check("live null is never ready", unknown == "ready", False)
    check("live true + no report -> ready",
          blocker(_packet(url=PLAIN), ix), "ready")

    # A report carrying no url must not become a wildcard.
    check("url-less report matches nothing",
          blocker(_packet(url=None, company="Legacy Co"), ix), "ready")

    # The pre-existing states still answer, and they still outrank ready.
    check("location fail still reported as location-fail",
          blocker(_packet(url=PLAIN, location_verdict="fail"), ix), "location-fail")
    check("no band still reported as no-band",
          blocker(_packet(url=PLAIN, comp={}), ix), "no-band")

    # --prune moves and never deletes, and it leaves the pending rows alone.
    queue = os.path.join(tmp, "queue")
    dest = os.path.join(queue, "done")
    os.makedirs(queue)
    for name, pk in (("done-nv.json", _packet(url=NV_PACKET, company="AcmeCorp")),
                     ("dead.json", _packet(url=PLAIN, live=False)),
                     ("work.json", _packet(url=PLAIN + "/2"))):
        with open(os.path.join(queue, name), "w", encoding="utf-8") as fh:
            json.dump(pk, fh)
    rows = load_rows(queue, ix)
    moved = prune(rows, write=True, dest=dest, quiet=True)
    check("prune moves reported and closed", sorted(m[0] for m in moved),
          ["dead.json", "done-nv.json"])
    check("prune leaves the pending packet in place",
          sorted(os.path.basename(x) for x in glob.glob(os.path.join(queue, "*.json"))),
          ["work.json"])
    check("prune moved rather than deleted",
          sorted(os.path.basename(x) for x in glob.glob(os.path.join(dest, "*.json"))),
          ["dead.json", "done-nv.json"])

    # A second prune of the same filename must not overwrite the first.
    with open(os.path.join(queue, "dead.json"), "w", encoding="utf-8") as fh:
        json.dump(_packet(url=PLAIN, live=False, title="second"), fh)
    prune(load_rows(queue, ix), write=True, dest=dest, quiet=True)
    check("a colliding name is suffixed, never overwritten",
          sorted(os.path.basename(x) for x in glob.glob(os.path.join(dest, "*.json"))),
          ["dead-2.json", "dead.json", "done-nv.json"])

    # A dry run writes nothing at all.
    with open(os.path.join(queue, "dead3.json"), "w", encoding="utf-8") as fh:
        json.dump(_packet(url=PLAIN, live=False), fh)
    prune(load_rows(queue, ix), write=False, dest=dest, quiet=True)
    check("a dry run moves nothing", os.path.exists(os.path.join(queue, "dead3.json")),
          True)

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(fails)} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
