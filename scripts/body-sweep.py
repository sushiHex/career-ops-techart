#!/usr/bin/env python
"""Read the BODY of every posting on every tracked Greenhouse, Ashby and Lever board.

The zero-token scan (scan.mjs) admits a posting on its TITLE, and a title filter made of
words cannot see a role whose lane lives in the body: "Senior Staff Software Engineer,
Builder Platform" or "Senior Software Engineer, AI (contractor)" carry no lane vocabulary
at all. Both were found on 2026-11-09 by reading bodies, on boards the scan already polls.
This tool is that read made repeatable: every board portals.yml names, every posting, the
whole body scored by `_lane.lane_score()` (the same scorer the Workday sweeps use), the
place judged by eval-prep's `location_verdict()` (the one location gate), and what the
pipeline has already seen subtracted.

What is "already seen", in order:
  1. tracked: the posting's id (Greenhouse job id, Ashby or Lever uuid) or url appears in
     the tracker or in any report's **URL:** line;
  2. offered: the zero-token scan already put it in the inbox (data/scan-history.tsv);
  3. swept: an earlier run of this tool or of workday-sweep.py printed it
     (data/sweep-seen.tsv). Counted, not printed, unless --show-seen.

One company posting one title in several places is folded into one row, since a body read
cannot tell those apart either.

Zero tokens; about 200 boards and 23,000 postings in roughly a minute.

  python scripts/body-sweep.py                  # new rows only, location pass
  python scripts/body-sweep.py --unknown        # also rows whose place needs a person
  python scripts/body-sweep.py --min 10 --urls batch/body-sweep-urls.txt
  python scripts/body-sweep.py --selftest
"""
import argparse, concurrent.futures as cf, datetime, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import _sweepkit as kit  # noqa: E402
from _sweepkit import BOARD_RX, company_key, tech_role, lane_keeps  # noqa: E402,F401


# ---------------------------------------------------------------- boards

def portal_boards(text):
    """[(kind, slug, company)] for every enabled portals.yml entry with a pollable board,
    each carrying its own entry's company name."""
    out, seen = [], set()
    for name, block in kit.portal_entries(text):
        for ref in kit.board_refs(block):
            if ref not in seen:
                seen.add(ref)
                out.append(ref + (name,))
    return out


def fetch(kind, slug):
    """(postings, total read, read_ok). A board that did not answer is NOT an empty board.

    Only a technical-role TITLE gets its body built: the body is the expensive part (the
    Greenhouse record runs the HTML clean and every pay reader) and about one posting in a
    hundred passes the title gate. req-resolve's per-ATS builders are the one reading of
    each API, since a hand-written reader here had dropped Greenhouse office locations."""
    rr, rows = kit.resolver(), []
    if kind == "gh":
        d = kit.get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
        if not isinstance(d, dict) or not isinstance(d.get("jobs"), list):
            return [], 0, False
        jobs = d["jobs"]
        for j in jobs:
            if not tech_role(j.get("title")):
                continue
            rec = rr.greenhouse_record(j, slug)
            rows.append({"id": str(j.get("id")), "title": j.get("title", ""), "url": j.get("absolute_url", ""),
                         "location": rec.get("location") or "", "remote": bool(rec.get("remote_txt")),
                         "body": rec.get("jd") or ""})
    elif kind == "ab":
        d = kit.get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")
        if not isinstance(d, dict) or not isinstance(d.get("jobs"), list):
            return [], 0, False
        jobs = d["jobs"]
        for j in jobs:
            if not tech_role(j.get("title")):
                continue
            sec = [x.get("location", "") if isinstance(x, dict) else str(x) for x in j.get("secondaryLocations") or []]
            comp = (j.get("compensation") or {}).get("compensationTierSummary") or ""
            rows.append({"id": j.get("id", ""), "title": j.get("title", ""), "url": j.get("jobUrl", ""),
                         "location": " | ".join([j.get("location", "")] + sec), "remote": bool(j.get("isRemote")),
                         "body": (j.get("descriptionPlain") or kit.html_text(j.get("descriptionHtml"))) + " " + comp})
    else:
        d = kit.get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json")
        if not isinstance(d, list):
            return [], 0, False
        jobs = [j for j in d if isinstance(j, dict)]
        for j in jobs:
            if not tech_role(j.get("text")):
                continue
            c = j.get("categories") or {}
            rows.append({"id": j.get("id", ""), "title": j.get("text", ""), "url": j.get("hostedUrl", ""),
                         "location": " | ".join([c.get("location") or ""] + list(c.get("allLocations") or [])),
                         "remote": (j.get("workplaceType") or "").lower() == "remote",
                         "body": rr.lever_body(j)})
    return rows, len(jobs), True


# ---------------------------------------------------------------- what is already known

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
# A Greenhouse job id as a URL states it: the path segment after /jobs/, or gh_jid=. Read
# only in those positions, as whole tokens, because a bare 7-digit substring matched inside
# a longer id and inside dates (Codex: 7594373 in /149043442, 2070452 in 20261109).
GH_ID = re.compile(r"(?:/jobs/|[?&]gh_jid=|/positions/|/roles/)(\d{6,})(?!\d)", re.I)
URL_RX = re.compile(r"https?://[^\s|)\]>\"']+", re.I)


def posting_ids(url):
    """The identities one posting URL states: Ashby/Lever uuids and Greenhouse job ids."""
    s = url or ""
    return {m.group(0).lower() for m in UUID.finditer(s)} | {"gh:" + m.group(1) for m in GH_ID.finditer(s)}


def known_ids(paths=None, gaps=None):
    """Every posting identity the tracker and the reports record, read from URLs only.

    `gaps` collects what could not be read, so a missing tracker reads as "dedup was not
    possible" rather than as "nothing is tracked"."""
    tracker = os.path.join(ROOT, "data", "applications.md")
    rep = os.path.join(ROOT, "reports")
    texts = []
    if os.path.exists(tracker):
        texts.append(open(tracker, encoding="utf-8", errors="replace").read())
    elif gaps is not None:
        gaps.append("tracker missing")
    if os.path.isdir(rep):
        for f in os.listdir(rep):
            if f.endswith(".md"):
                with open(os.path.join(rep, f), encoding="utf-8", errors="replace") as fh:
                    texts += re.findall(r"\*\*URL:\*\*[ \t]*(\S*)", fh.read())
    elif gaps is not None:
        gaps.append("reports/ missing")
    ids = set()
    for t in texts:
        for u in URL_RX.findall(t):
            ids |= posting_ids(u)
    return ids


def is_tracked(row, known):
    """True when this posting's own id, or an id its URL states, is one the pipeline
    recorded. Exact token identity only; a URL with no recognisable id is never tracked
    by resemblance (a stripped-query match called gh_jid=111 tracked because gh_jid=222 was)."""
    mine = posting_ids(row.get("url"))
    rid = (row.get("id") or "").lower()
    if UUID.fullmatch(rid):
        mine.add(rid)
    elif rid.isdigit() and len(rid) >= 6:
        mine.add("gh:" + rid)
    return bool(mine & known)


def tracker_titles(rows):
    """(company, title stem) -> tracker row number."""
    out = {}
    for r in rows:
        out.setdefault((company_key(r.get("company", "")), stem(r.get("role", ""))),
                       r.get("#", "") or next(iter(r.values())))
    return out


# Word-bounded: an unbounded `us` folded "Customer Success", "Business Systems" and
# "Illustrations" into one stem and printed distinct reqs as one role's extra places (Codex).
_STEM_TAIL = re.compile(r"\s*(?:[-,|:(\[]\s*[^-,|:(\[]*\b(?:remote|united states|usa|us|canada|emea|apac|"
                        r"new york|san francisco|seattle|london)\b[^-,|:(\[]*[)\]]?)\s*$", re.I)


def stem(title):
    """A title without a trailing place qualifier, for folding one role posted in N places."""
    t = re.sub(r"\s+", " ", title or "").strip()
    for _ in range(2):
        t2 = _STEM_TAIL.sub("", t)
        if t2 == t:
            break
        t = t2
    return t.lower()


# ---------------------------------------------------------------- run

# The title gates (tech_role, lane_keeps) live in _sweepkit and read config/sweep-gates.json,
# whose `why` records what they deliberately do and do not refuse.


def read_extra(path):
    """Boards from a kind<TAB>slug<TAB>company file (hn-hiring.py --boards-out, or by hand)."""
    out = []
    for line in open(path, encoding="utf-8"):
        f = line.rstrip("\n").split("\t")
        if len(f) >= 2 and f[0] in BOARD_RX:
            out.append((f[0], f[1].lower(), f[2] if len(f) > 2 else f[1]))
    return out


def sweep(min_score=8, want_unknown=False, workers=16, extra=None, only_extra=False):
    boards = [] if only_extra else portal_boards(kit.portals_text())
    have = {(k, s) for k, s, _ in boards}
    boards += [b for b in extra or [] if (b[0], b[1]) not in have]
    ep = kit.prep()        # loads the module chain and the gates once, before the threads share them
    tech_role("")
    rows, unread, total = [], [], 0
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(fetch, k, s): (k, s, n) for k, s, n in boards}
        for f in cf.as_completed(futs):
            k, s, n = futs[f]
            got, n_read, ok = f.result()
            total += n_read
            if not ok:
                unread.append(f"{k}:{s}")
            for r in got:
                r.update(kind=k, slug=s, company=n)
                rows.append(r)
    kept = []
    for r in rows:
        sc, keep = lane_keeps(r["title"], r["body"], min_score)
        if not keep:
            continue
        verdict, why = ep.location_verdict(r["location"], r["remote"])
        if verdict == "fail" or (verdict == "unknown" and not want_unknown):
            continue
        r.update(score=sc, verdict=verdict, why=why)
        kept.append(r)
    return boards, total, unread, kept


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--min", type=int, default=8, help="lane_score floor (title plus body)")
    ap.add_argument("--unknown", action="store_true", help="also print rows whose place needs a person")
    ap.add_argument("--show-seen", action="store_true", help="print rows earlier runs already printed")
    ap.add_argument("--no-record", action="store_true", help="do not write data/sweep-seen.tsv")
    ap.add_argument("--urls", help="write the new rows' urls here, one per line, for eval-prep")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--extra", help="also read the boards in this kind<TAB>slug<TAB>company file")
    ap.add_argument("--only-extra", action="store_true", help="read only the --extra boards")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return _selftest()
    if a.only_extra and not a.extra:
        ap.error("--only-extra needs --extra")

    boards, total, unread, kept = sweep(a.min, a.unknown, extra=read_extra(a.extra) if a.extra else None,
                                        only_extra=a.only_extra)
    wd = kit.workday()
    gaps = []
    known = known_ids(gaps=gaps)
    twins = tracker_titles(kit.tracker_rows())
    # Read each ledger once: which one saw a key decides "offered" versus "swept".
    scanned = wd.load_seen((wd.SCAN_HISTORY,))
    seen = {**scanned, **wd.load_seen((wd.SEEN_PATH,))}
    today = datetime.date.today().isoformat()

    groups, counts = {}, {"tracked": 0, "offered": 0, "swept": 0}
    for r in sorted(kept, key=lambda r: -r["score"]):
        if is_tracked(r, known):
            counts["tracked"] += 1
            continue
        # Same employer, same title, different requisition: a regional twin (one employer
        # posts one Agentic Intelligence req for the US and one for Canada). Annotated,
        # never dropped, since a same-title req can be a real second seat.
        st = stem(r["title"])
        r["twin"] = twins.get((company_key(r["company"]), st), "")
        key = wd.seen_key(r["url"])
        if key in seen and not a.show_seen:
            counts["offered" if key in scanned else "swept"] += 1
            continue
        g = (r["company"].lower(), st)
        if g in groups:
            groups[g]["n"] += 1
            continue
        r["n"] = 1
        groups[g] = r
    new = list(groups.values())

    if a.json:
        print(json.dumps({"rows": [{k: r[k] for k in ("score", "verdict", "company", "title", "location", "url", "n", "twin")}
                                   for r in new],
                          "boards": len(boards), "not_read": sorted(unread), "dedup_gaps": gaps}, indent=1))
    else:
        print(f"{len(boards)} boards ({len(unread)} NOT READ), {total} postings, "
              f"{len(kept)} in lane and placeable")
        print(f"subtracted: {counts['tracked']} tracked, {counts['offered']} already offered by the scan, "
              f"{counts['swept']} printed by an earlier sweep")
        if gaps:
            print("DEDUP INCOMPLETE:", "; ".join(gaps))
        for r in new:
            more = f" (+{r['n'] - 1} places)" if r["n"] > 1 else ""
            twin = f" [TWIN of tracked #{r['twin']}]" if r["twin"] else ""
            print(f"{r['score']:>3} {r['verdict']:<7} {r['company'][:28]:<28} | {r['title'][:70]}{more}{twin}"
                  f" | {r['location'][:50]} | {r['url']}")
        if unread:
            print("NOT READ (no answer, not an empty board):", ", ".join(sorted(unread)))
    if a.urls:
        with open(a.urls, "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(r["url"] + "\n" for r in new))
    if not a.no_record:
        wd.record_seen(new, today, seen)
    return 0


# ---------------------------------------------------------------- selftest

def _selftest():
    bad = 0

    def check(name, got, want):
        nonlocal bad
        if got != want:
            bad += 1
            print(f"FAIL {name}: got {got!r}, want {want!r}")

    yml = ("tracked_companies:\n"
           "  - name: Acme\n    careers_url: https://jobs.ashbyhq.com/acme\n    enabled: true\n"
           "  - name: Off\n    careers_url: https://job-boards.greenhouse.io/off\n    enabled: false\n"
           "  - name: Both\n    careers_url: https://job-boards.greenhouse.io/both\n"
           "    api: https://boards-api.greenhouse.io/v1/boards/both/jobs\n    enabled: true\n"
           "  - name: Lev\n    careers_url: https://jobs.lever.co/lev\n")
    check("boards", portal_boards(yml), [("ab", "acme", "Acme"), ("gh", "both", "Both"), ("lv", "lev", "Lev")])

    known = set()
    for u in ["https://job-boards.greenhouse.io/acme/jobs/7594373", "https://acme.com/careers?gh_jid=2285524",
              "https://jobs.ashbyhq.com/acme/221c81c6-a030-6c6f-a347-f6d8eaf98fde",
              "https://jobs.lever.co/other/149043442", "reports/1450-acme-2026-11-09.md"]:
        known |= posting_ids(u)
    check("gh id", is_tracked({"id": "7594373", "url": "https://other/x"}, known), True)
    check("gh id from gh_jid", is_tracked({"id": "", "url": "https://acme.com/c?gh_jid=2285524"}, known), True)
    check("ashby uuid", is_tracked({"id": "221c81c6-a030-6c6f-a347-f6d8eaf98fde", "url": ""}, known), True)
    # The three Codex counterexamples, each a false TRACKED under the substring rule.
    check("id inside a longer id", is_tracked({"id": "7594373", "url": ""}, posting_ids("https://x/jobs/149043442")), False)
    check("id inside a date", is_tracked({"id": "2070452", "url": ""}, posting_ids("reports/x-20261109.md")), False)
    check("different gh_jid", is_tracked({"id": "", "url": "https://acme.com/c?gh_jid=1982939"}, known), False)
    check("untracked", is_tracked({"id": "9253856", "url": "https://jobs.ashbyhq.com/acme/zzz"}, known), False)

    check("stem place dash", stem("Forward Deployed Engineer - Remote, US"), "forward deployed engineer")
    check("stem place paren", stem("Solutions Architect (New York)"), "solutions architect")
    check("stem keeps a real qualifier", stem("Software Engineer, Agents"), "software engineer, agents")
    for t in ("Software Engineer, Customer Success", "Software Engineer, Business Systems", "Software Engineer, Illustrations"):
        check(f"stem keeps {t}", stem(t) != "software engineer", True)
    # A case that cannot fail is not a case: two distinct roles must not fold together.
    check("distinct roles stay distinct", stem("Software Engineer, Agents") == stem("Software Engineer, Evals"), False)

    check("tech role", tech_role("Staff Software Engineer - Builder Platform"), True)
    check("tech role, tech artist", tech_role("Senior Technical Artist"), True)
    check("not a tech role", tech_role("Head of Communications"), False)
    check("hardware engineer is out", tech_role("Electrical Engineer, Robotics Hardware"), False)
    for t in ("Sales Engineer, Agentic AI", "AI Solutions Consultant", "Technical Art Lead", "AI Evaluation Lead",
              "AI Data Engineer", "Creative Technologist", "Solutions Architect"):
        check(f"in scope: {t}", tech_role(t), True)
    # The rescue is "craft title AND a title score of 3", so pin the score: the installed
    # vocabulary decides how a title scores, and this case tests the rule, not the vocabulary.
    real_score = kit._lane.lane_score
    kit._lane.lane_score = lambda title, body="": 1 if body else 3
    try:
        check("tech art title survives a thin body", lane_keeps("Senior Technical Artist", "We make games.", 8)[1], True)
        check("a non-craft title at 3 is not rescued", lane_keeps("Backend Engineer", "We make games.", 8)[1], False)
    finally:
        kit._lane.lane_score = real_score
    check("off-lane title with a thin body is dropped", lane_keeps("Backend Engineer", "Payments.", 8)[1], False)
    check("a +3 title word is not a rescue", lane_keeps("Software Engineer II, Backend (Decisions Orchestration)",
                                                        "Payments.", 8)[1], False)
    check("company norm", company_key("Globex.io"), company_key("Globex"))
    tw = tracker_titles([{"#": "901", "company": "Globex.io", "role": "Agentic Intelligence - Canada"}])
    check("twin key", tw.get((company_key("Globex"), stem("Agentic Intelligence - Remote, US"))), "901")

    print("body-sweep selftest:", "OK" if not bad else f"{bad} FAILED")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
