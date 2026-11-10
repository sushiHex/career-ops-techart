"""Shared pieces of the board sweeps: body-sweep.py, hn-hiring.py and remote-boards.py.

One module per rule: the three sweeps used to paste their own loader, HTTP getter, HTML
reader, portals.yml splitter, company key and tracker reader, and two of them loaded the
others as scripts just to reach a helper. The title gates are candidate preference and
live in config/sweep-gates.json (User Layer); this file only reads them.
"""
import functools, html, importlib.util, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import _lane  # noqa: E402


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@functools.lru_cache(None)
def workday():
    """workday-sweep.py, loaded once. It already loads eval-prep (`_prep`), which already
    loads req-resolve (`rr`), so prep() and resolver() reuse that chain instead of
    executing the same modules a second time."""
    return load("workday_sweep", "workday-sweep.py")


def prep():
    return workday()._prep


def resolver():
    return prep().rr


def get_json(url, ua="Mozilla/5.0 career-ops", timeout=30, swallow=True):
    """Parsed JSON, or None on any failure when `swallow` (callers treat None as NOT READ,
    never as empty)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        if not swallow:
            raise
        return None


def html_text(s):
    """HTML as one line of plain text. Unescaped twice, since board APIs often double-escape."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(html.unescape(s or "")))).strip()


# ---------------------------------------------------------------- portals.yml

BOARD_RX = {
    "gh": re.compile(r"(?:job-boards|boards)\.greenhouse\.io/(?:v1/boards/)?([\w.-]+)", re.I),
    "ab": re.compile(r"jobs\.ashbyhq\.com/([\w.%-]+)", re.I),
    "lv": re.compile(r"jobs\.lever\.co/([\w.-]+)", re.I),
}
NOT_SLUG = {"v1", "boards", "embed"}


def portals_text():
    return open(os.path.join(ROOT, "portals.yml"), encoding="utf-8").read()


def portal_entries(text):
    """(name, block) for every ENABLED portals.yml entry, as the scan skips a disabled one."""
    for block in re.split(r"\n\s*- name:", "\n" + text)[1:]:
        if not re.search(r"^\s*enabled:\s*false\b", block, re.M):
            yield block.split("\n", 1)[0].strip().strip("\"'"), block


def board_refs(text):
    """(kind, slug) for every Greenhouse, Ashby or Lever board named in `text`."""
    for kind, rx in BOARD_RX.items():
        for m in rx.finditer(text):
            slug = m.group(1).rstrip(".").lower()
            if slug not in NOT_SLUG:
                yield kind, slug


def company_key(s):
    """A company name reduced for comparison: the portals.yml label's annotation, a domain
    suffix, a corporate suffix and punctuation dropped ("Globex.io" is "Globex",
    "Initech Analytics, Inc." is "initech analytics", "Initech AI (Labs)" is "Initech AI")."""
    s = re.split(r"\s+[-—(]", (s or "").strip())[0]
    s = re.sub(r"\.(?:io|ai|com|dev)\b", "", s, flags=re.I).lower()
    s = re.sub(r"\b(inc|llc|ltd|corp|corporation|co|technologies|labs?)\b\.?", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


# ---------------------------------------------------------------- tracker

def tracker_rows(path=None):
    """[{column: cell}] for every tracker row, mapped by the HEADER, not by position."""
    p = path or os.path.join(ROOT, "data", "applications.md")
    if not os.path.exists(p):
        return []
    head, out = None, []
    for line in open(p, encoding="utf-8", errors="replace"):
        if not line.startswith("|"):
            continue
        cells = [x.strip() for x in line.strip().strip("|").split("|")]
        if head is None:
            head = [c.lower() for c in cells]
            continue
        if cells and re.fullmatch(r"\d+", cells[0]) and len(cells) == len(head):
            out.append(dict(zip(head, cells)))
    return out


def tracker_companies(rows=None):
    """lower company -> (rows, best final score)."""
    out = {}
    for r in tracker_rows() if rows is None else rows:
        m = re.match(r"([\d.]+)/5", r.get("score", ""))
        k = r.get("company", "").lower()
        n, best = out.get(k, (0, 0.0))
        out[k] = (n + 1, max(best, float(m.group(1)) if m else 0.0))
    return out


def history(company, tracked):
    """"[N prior, best X]" for a company the tracker knows, by exact name or name prefix."""
    k = company.lower()
    hit = tracked.get(k) or next((v for t, v in tracked.items() if k and t.startswith(k + " ")), None)
    return f"[{hit[0]} prior, best {hit[1]:.2f}]" if hit else ""


# ---------------------------------------------------------------- gates (config/sweep-gates.json)

@functools.lru_cache(None)
def _gates():
    # The candidate's own file wins; a fresh clone falls back to the shipped example.
    # CAREER_OPS_CONFIG_DIR selects another configuration, as it does for every other gate.
    cfg = os.environ.get("CAREER_OPS_CONFIG_DIR") or os.path.join(ROOT, "config")
    path = os.path.join(cfg, "sweep-gates.json")
    if not os.path.exists(path):
        path = os.path.join(ROOT, "config", "sweep-gates.example.json")
    with open(path, encoding="utf-8") as fh:
        g = json.load(fh)
    return {"tech": re.compile(g["tech_role"], re.I), "not_tech": re.compile(g["not_tech"], re.I),
            "lane_a": re.compile(g["lane_a_title"], re.I), "max_floor": int(g["annual_max_floor"]),
            "remote_queries": list(g.get("remote_queries") or [])}


def tech_role(title):
    g, t = _gates(), title or ""
    return bool(g["tech"].search(t)) and not g["not_tech"].search(t)


def lane_keeps(title, body, floor):
    """(score, keep): the lane floor, plus a Lane A craft title that is in lane on its own
    (Technical Artist scores about +3 and its body carries little agentic vocabulary)."""
    sc = _lane.lane_score(title, body)
    return sc, sc >= floor or bool(_gates()["lane_a"].search(title or "") and _lane.lane_score(title) >= 3)


def floor_for(preferred, title_up, body_up):
    """A sweep's default lane floor: its tuned value, lowered to what the configured
    vocabulary can actually reach. A role matching the strongest single title signal, plus
    the body cap when body signals exist, must be able to clear it, or a vocabulary with
    only +4 title words and no body words (the general preset) discards every match."""
    tops = [w for _, w in title_up if w > 0]
    reach = (max(tops) if tops else 0) + (8 if any(w > 0 for _, w in body_up) else 0)
    return min(preferred, reach)


def lane_floor(preferred):
    """floor_for() over the configured vocabulary; an explicit --min always wins."""
    return floor_for(preferred, _lane.LANE_UP, _lane.BODY_UP)


def max_floor():
    return _gates()["max_floor"]


def remote_queries():
    """The remote-board search terms, from the candidate's sweep-gates config."""
    return _gates()["remote_queries"]
