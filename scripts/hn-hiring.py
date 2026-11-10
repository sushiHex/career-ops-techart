#!/usr/bin/env python
"""Read Hacker News "Ask HN: Who is hiring?" threads into a lane-ranked shortlist.

Monthly (the thread posts on the first weekday of each month). The thread is where small
companies with no presence on LinkedIn or on any board portals.yml tracks post. Zero
tokens: the
Algolia HN API serves the whole thread as one JSON tree.

Each top-level comment is one employer's post. By convention its first line is
"Company | Role | Location | Remote | ...", so the segments are handed to the location
gate as OPTIONS (any workable option wins, exactly as for a structured ATS field) and the
whole post to `_lane.lane_score()`. A post whose company is already on the tracker is
annotated with its history, never dropped, since a tracked company can post a new role.
Posts printed by an earlier run are counted, not printed (data/sweep-seen.tsv).

  python scripts/hn-hiring.py                 # the latest thread
  python scripts/hn-hiring.py --threads 2     # latest two (this month and last)
  python scripts/hn-hiring.py --min 6 --unknown
  python scripts/hn-hiring.py --selftest
"""
import argparse, concurrent.futures as cf, datetime, html, json, os, re, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _lane  # noqa: E402
import _sweepkit as kit  # noqa: E402
from _sweepkit import history, tech_role  # noqa: E402

API = "https://hn.algolia.com/api/v1"


def _get(url):
    # Raises rather than returning None: an unread thread must stop the run, not read as empty.
    return kit.get_json(url, ua="career-ops hn-hiring", timeout=90, swallow=False)


def threads(n):
    """[(id, title, date)] of the latest n "Who is hiring?" stories, newest first. The
    account also posts "Who wants to be hired?" and "Freelancer?" threads; only the
    hiring thread lists employers."""
    q = urllib.parse.urlencode({"query": "Who is hiring", "tags": "story,author_whoishiring", "hitsPerPage": 20})
    d = _get(f"{API}/search_by_date?{q}")
    if not isinstance(d, dict) or not isinstance(d.get("hits"), list):
        # A parsed error body is not "no threads this month" (Codex).
        raise SystemExit(f"HN search answered without a hits list: {str(d)[:200]}")
    hits = d["hits"]
    out = [(h["objectID"], h["title"], h["created_at"][:10]) for h in hits
           if re.match(r"Ask HN: Who is hiring\?", h.get("title", ""), re.I)]
    return out[:n]


def text_of(h):
    """A comment's HTML as plain text, paragraph breaks kept as newlines."""
    s = re.sub(r"<p>", "\n", h or "")
    s = re.sub(r"<a [^>]*href=\"([^\"]+)\"[^>]*>.*?</a>", r" \1 ", s)
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse_post(text):
    """(company, header segments, header) from one post's first line."""
    first = (text or "").split("\n", 1)[0].strip()
    segs = [s.strip() for s in re.split(r"\s+[|•]\s+|\s+[-–]\s+(?=[A-Z])|\s*;\s*", first) if s.strip()]
    company = re.sub(r"\s*\(.*?\)\s*$", "", segs[0]) if segs else ""
    return company[:60], segs, first


# HN posts write their region in free text. A non-US region next to "remote" demotes a
# pass to unknown only when the header names no US option at all: "Remote (US and
# Canada)" is a US offer (Codex), "Remote (EU only)" is not.
NOT_US_REMOTE = re.compile(r"\bremote\b[^|\n]{0,40}\b(EU|Europe|EMEA|UK|India|Canada|LATAM|APAC|Germany|"
                           r"Australia|Brazil)\b\s*(only|based)?|\b(EU|Europe|UK|Canada)[- ]only\b", re.I)
US_MENTION = re.compile(r"\bUS\b|\bUSA\b|United States|\bAmericas?\b|North America|\bUS-", re.I)


def location_segments(segs, tech_role):
    """The header segments that can be a PLACE. The company (first segment) and any role
    title are not: handed to the gate as options, "Venice AI" and "AI Engineer, Los Angeles
    team" passed San Francisco onsite posts as SoCal (Codex)."""
    return [s for s in segs[1:] if not tech_role(s)]


def non_us_remote(header):
    return bool(NOT_US_REMOTE.search(header)) and not US_MENTION.search(header)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--min", type=int, default=5, help="lane_score floor over header and post")
    ap.add_argument("--unknown", action="store_true", help="also print posts whose place needs a person")
    ap.add_argument("--show-seen", action="store_true")
    ap.add_argument("--no-record", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--boards-out", help="write the untracked boards here (kind<TAB>slug<TAB>company), "
                                         "for `body-sweep.py --extra`")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return _selftest()

    wd, ep = kit.workday(), kit.prep()
    polled = {ref for _, block in kit.portal_entries(kit.portals_text()) for ref in kit.board_refs(block)}
    seen, tracked = wd.load_seen(), kit.tracker_companies()
    today = datetime.date.today().isoformat()
    rows, counts = [], {"posts": 0, "seen": 0, "place": 0, "lane": 0}
    boards = {}   # (kind, slug) -> company, for workable posts whose board portals.yml lacks
    found = threads(a.threads)
    with cf.ThreadPoolExecutor(max(1, len(found))) as ex:   # each tree is multi-MB; fetch them together
        trees = list(ex.map(lambda t: _get(f"{API}/items/{t[0]}"), found))
    for (_, _, date), tree in zip(found, trees):
        for c in tree.get("children") or []:
            text = text_of(c.get("text"))
            if not text:
                continue
            counts["posts"] += 1
            company, segs, header = parse_post(text)
            url = f"https://news.ycombinator.com/item?id={c['id']}"
            # seen_key() drops a query string, which turned every item?id= into ONE key,
            # so a single recorded post would have suppressed every later post (Codex).
            key = f"hn:{c['id']}"
            verdict = ep.location_verdict(location_segments(segs, tech_role), False)[0]
            if verdict == "pass" and non_us_remote(header):
                verdict = "unknown"   # remote, but the post names a non-US region
            if verdict == "fail":
                counts["place"] += 1
                continue
            # A post usually lists several roles under one header, so its lane score is low
            # even when a role on its board is a bullseye (one real case scored 4 and 0 here
            # while its board carried two strong roles). The board is the durable find: once portals.yml
            # names it, scan.mjs and body-sweep.py read every role on it, every day.
            for ref in kit.board_refs(text):
                if ref not in polled:
                    boards.setdefault(ref, company)
            if verdict == "unknown" and not a.unknown:
                counts["place"] += 1
                continue
            sc = _lane.lane_score(header, text)
            if sc < a.min:
                counts["lane"] += 1
                continue
            if key in seen and not a.show_seen:
                counts["seen"] += 1
                continue
            links = [u for u in re.findall(r"https?://\S+", text) if "ycombinator" not in u][:3]
            rows.append({"score": sc, "verdict": verdict, "company": company, "header": header[:160],
                         "url": url, "key": key, "links": links, "history": history(company, tracked),
                         "thread": date, "title": header[:120]})
    rows.sort(key=lambda r: -r["score"])
    if a.json:
        print(json.dumps(rows, indent=1))
    else:
        print(f"{counts['posts']} posts; dropped {counts['lane']} below lane {a.min}, {counts['place']} on place, "
              f"{counts['seen']} printed by an earlier run")
        for r in rows:
            print(f"{r['score']:>3} {r['verdict']:<7} {r['header']} {r['history']}\n      {r['url']}  "
                  + "  ".join(r["links"]))
        if boards:
            print(f"\nBOARDS NOT IN portals.yml ({len(boards)}), from every post the place gate did not"
                  " fail; add the in-lane ones so the daily sweeps read them (each posting is gated there):")
            for (kind, slug), co in sorted(boards.items(), key=lambda x: x[1].lower()):
                print(f"  {kind} {slug:<28} {co}")
    if a.boards_out:
        with open(a.boards_out, "w", encoding="utf-8", newline="") as fh:
            fh.write("".join(f"{k}\t{s}\t{co}\n" for (k, s), co in sorted(boards.items())))
    if not a.no_record:
        wd.record_seen([dict(r, url=r["key"]) for r in rows], today, seen)
    return 0


def _selftest():
    bad = 0

    def check(name, got, want):
        nonlocal bad
        if got != want:
            bad += 1
            print(f"FAIL {name}: got {got!r}, want {want!r}")

    co, segs, _ = parse_post("Acme Voice | Software Engineer, Agents | Remote (US) | Full-time\nWe build...")
    check("company", co, "Acme Voice")
    check("segments", segs, ["Acme Voice", "Software Engineer, Agents", "Remote (US)", "Full-time"])
    co, segs, _ = parse_post("Acme (YC W24) | ML Engineer | San Francisco or REMOTE")
    check("company drops the batch", co, "Acme")
    check("text keeps links", "https://acme.dev/jobs" in text_of('Apply: <a href="https://acme.dev/jobs">acme.dev</a>'), True)
    check("paragraphs", text_of("A | B<p>body"), "A | B\nbody")
    check("EU-only remote", non_us_remote("Acme | Eng | Remote (EU only)"), True)
    check("US remote is not closed", non_us_remote("Acme | Eng | Remote (US)"), False)
    check("US and Canada stays a US offer", non_us_remote("Acme | Eng | Remote (US and Canada)"), False)
    wd, ep = kit.workday(), kit.prep()
    # The three Codex counterexamples: a company or role segment read as a place.
    for h in ("Venice AI | AI Engineer | San Francisco | Onsite",
              "Anywhere | AI Engineer | Berlin | Onsite",
              "Acme | AI Engineer, Los Angeles team | San Francisco | Onsite"):
        v = ep.location_verdict(location_segments(parse_post(h)[1], tech_role), False)[0]
        check(f"not a pass: {h}", v != "pass", True)
    v = ep.location_verdict(location_segments(parse_post("Acme Voice | Software Engineer | Remote (US)")[1], tech_role), False)[0]
    check("remote US still passes", v, "pass")
    check("board refs", list(kit.board_refs("apply https://jobs.ashbyhq.com/AcmeVoice. or boards.greenhouse.io/embed")),
          [("ab", "acmevoice")])
    check("seen keys stay distinct", wd.seen_key("hn:123") != wd.seen_key("hn:456"), True)
    tr = {"acme voice": (2, 3.77), "globex analytics": (1, 3.82)}
    check("history exact", history("Acme Voice", tr), "[2 prior, best 3.77]")
    check("history prefix", history("Globex", tr), "[1 prior, best 3.82]")
    check("history none", history("Initech", tr), "")
    print("hn-hiring selftest:", "OK" if not bad else f"{bad} FAILED")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
