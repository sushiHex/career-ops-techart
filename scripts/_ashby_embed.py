#!/usr/bin/env python
"""_ashby_embed.py — read an Ashby board whose posting-api is switched off.

Ashby's zero-token endpoint, /posting-api/job-board/{slug}, is OPT-IN per organisation.
When it is off the endpoint answers 404, which is indistinguishable from "no such company"
and is exactly how Whatnot came to be filed as a websearch handoff: portals.yml carries the
note "Ashby (slug 404'd on probe)". The slug was right and the board was live the whole
time. Its human page returns 200 and embeds all 129 postings, including an AI Tooling
Engineer role squarely in lane.

So a 404 from the posting API settles nothing on its own. Fetch the board page and read
`window.__appData`, which carries title, locationName, workplaceType, secondaryLocations
and a compensation summary for every posting: strictly more than the posting API returns.

The braces have to be matched rather than regexed. __appData is a single large JSON object
containing nested objects and braces inside strings, so a non-greedy match to the closing
</script> captures either far too little or the wrong span.
"""
import json
import re

BOARD_URL = "https://jobs.ashbyhq.com/{slug}"
_ANCHOR = re.compile(r"window\.__appData\s*=\s*")


def extract_appdata(html):
    """The parsed window.__appData object, or None."""
    m = _ANCHOR.search(html or "")
    if not m:
        return None
    start = html.find("{", m.end())
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(html)):
        c = html[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start:i + 1])
                except Exception:
                    return None
    return None


def _find_postings(node):
    """First jobPostings list anywhere in the tree; the nesting is not documented."""
    if isinstance(node, dict):
        if isinstance(node.get("jobPostings"), list):
            return node["jobPostings"]
        for v in node.values():
            got = _find_postings(v)
            if got is not None:
                return got
    elif isinstance(node, list):
        for v in node:
            got = _find_postings(v)
            if got is not None:
                return got
    return None


def postings(html, slug):
    """Normalised postings from a board page. [] when the page carries none."""
    data = extract_appdata(html)
    if not data:
        return []
    raw = _find_postings(data) or []
    out = []
    for j in raw:
        if not isinstance(j, dict) or not j.get("title"):
            continue
        # Fold secondary locations in, for the same reason every other adapter must: a
        # remote-eligible role frequently carries its reachable location HERE and a single
        # foreign office in locationName. Reading only the primary discards it.
        locs = [j.get("locationName") or ""]
        for s in (j.get("secondaryLocations") or []):
            if isinstance(s, dict):
                locs.append(s.get("locationName") or s.get("name") or "")
            elif isinstance(s, str):
                locs.append(s)
        locs = [x for x in dict.fromkeys(locs) if x]
        out.append(dict(
            id=j.get("id") or "",
            title=j.get("title") or "",
            location=" | ".join(locs),
            workplace=j.get("workplaceType") or "",
            employment=j.get("employmentType") or "",
            comp=j.get("compensationTierSummary") or "",
            url=f"https://jobs.ashbyhq.com/{slug}/{j.get('id') or ''}",
        ))
    return out


_SELFTEST_HTML = """
<html><body><script>
  window.__appData = {"organization":{"name":"Acme {Inc}"},"jobBoard":{"teams":[],
  "jobPostings":[
    {"id":"aaa","title":"AI Tooling Engineer","locationName":"Los Angeles, CA",
     "workplaceType":"Remote","employmentType":"FullTime",
     "secondaryLocations":[{"locationName":"Remote, US"}],
     "compensationTierSummary":"$225K - $320K"},
    {"id":"bbb","title":"Account Executive","locationName":"Berlin, Germany",
     "workplaceType":"Hybrid","employmentType":"FullTime","secondaryLocations":[]},
    {"id":"ccc","title":null,"locationName":"Nowhere"}
  ]}};
</script></body></html>
"""


def _selftest():
    bad = 0
    got = postings(_SELFTEST_HTML, "acme")
    if len(got) != 2:
        bad += 1
        print(f"  FAIL expected 2 postings (the title-less one dropped), got {len(got)}")
    if got:
        a = got[0]
        # The brace matcher must survive a brace INSIDE a JSON string ("Acme {Inc}"), which
        # is the case a naive depth counter gets wrong.
        if a["title"] != "AI Tooling Engineer":
            bad += 1
            print(f"  FAIL title: {a['title']!r}")
        if "Remote, US" not in a["location"]:
            bad += 1
            print(f"  FAIL secondary location dropped: {a['location']!r}")
        if a["comp"] != "$225K - $320K":
            bad += 1
            print(f"  FAIL comp: {a['comp']!r}")
        if not a["url"].endswith("/acme/aaa"):
            bad += 1
            print(f"  FAIL url: {a['url']!r}")
    if extract_appdata("<html>no appdata here</html>") is not None:
        bad += 1
        print("  FAIL a page without __appData must return None, not {}")
    if postings("<html>nothing</html>", "x") != []:
        bad += 1
        print("  FAIL a page without __appData must yield no postings")
    print(f"_ashby_embed selftest: {6} checks, {bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
