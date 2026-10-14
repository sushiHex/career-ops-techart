#!/usr/bin/env python
"""eval-prep.py — gather everything needed to score a req, leaving only judgement.

Evaluating a posting has two halves. One is mechanical: resolve it, decide whether
the location clears, work out what the band means against the floor and target,
find the requirements paragraph, and check it is not already on the tracker. The
other is judgement: four dimension scores and the prose that justifies them.

Every evaluation this session hand-assembled the mechanical half inside a one-off
script, which is slow and is where the mistakes happened (a fabricated URL, a
mis-signed correction). This does the mechanical half once, the same way each
time, and writes a JSON packet with the judgement fields left null.

Fill in the nulls, then run eval-write.mjs on the packet to produce the report and
the tracker TSV.

Run:
  python scripts/eval-prep.py <url> [<url> ...]
  python scripts/eval-prep.py --from-triage triage.json --min 6
"""
import atexit, contextlib, glob, hashlib, importlib.util, io, json, os, re, shutil, sys, tempfile

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("rr", os.path.join(ROOT, "scripts", "req-resolve.py"))
rr = importlib.util.module_from_spec(spec); spec.loader.exec_module(rr)

OUT_DIR = os.path.join(ROOT, "batch", "eval-queue")
BAND_POINT = 0.75   # a strong senior negotiates into the upper band, per score-model

# The comp floor and target are CANDIDATE FACTS. They used to be literals here, in a
# System Layer file, while config/profile.yml held the authoritative pair. They agreed on
# the day this was written and nothing kept them agreeing: the floor had already been
# renormalised once, from one figure per track to a single shared floor, and the next such
# move would have left this script gating against a number the candidate no longer uses.
# It gates in the DISPOSING direction, so the drift would have shown up as reqs quietly
# never reaching the queue.
_COMP_CACHE = {}
# Figures as a comp line writes them: "USD 200K", "USD 200K-250K", "$250,000".
# A comp FIGURE, read the same way in setup.mjs, scripts/eval-prep.py and score-model.mjs:
# digits with optional thousands commas and one optional decimal part, then an optional K
# or M. A bare number under 10,000 is a level, a year fragment or a footnote, never
# dollars, and is skipped. Three readers once took three different figures from
# "L5 USD 180K" (5K, 180K, 180K) and "$150,000..." crashed one of them.
_FIGURE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?")


def comp_targets(path=None):
    """(floor, target) in dollars, read from config/profile.yml. Raises if it cannot.

    The floor is `minimum` and the target is the TOP of `target_range`, both from the
    top-level `compensation:` block. The `alternate_ranges:` entries are deliberately out
    of reach: they sit deeper inside a list item and the keys here are anchored to the
    block's own two-space indent, so another track's range cannot be picked up by
    accident and re-split a floor that was normalised across both tracks on purpose.

    It raises rather than defaulting. A hardcoded fallback would recreate exactly the
    drift this removes, and would do it silently: nothing downstream can tell a defaulted
    number from a read one, and a floor that is wrong in the low direction disposes of
    reqs permanently.
    """
    p = path or os.path.join(_location.CONFIG_DIR, "profile.yml")
    if p in _COMP_CACHE:
        return _COMP_CACHE[p]
    try:
        text = open(p, encoding="utf-8", errors="replace").read()
    except OSError as e:
        raise RuntimeError(
            f"eval-prep cannot read the comp floor and target from {p}: {e}. They are "
            "candidate facts and have no default here; fix the file rather than letting "
            "this script guess a floor.") from e
    # Indented OR blank lines, so a blank line between keys does not truncate the block.
    # Same block shape score-model.mjs uses for company_preference.
    block = re.search(r"^compensation:[^\n]*\n((?:(?:[ \t]+[^\n]*)?\n)*)", text, re.M)
    if not block:
        raise RuntimeError(f"{p} has no top-level `compensation:` block; eval-prep cannot "
                           "derive a comp floor without one")

    def _figs(key):
        # [ \t]*, not \s*: a blank value must not read the NEXT line as its own.
        m = re.search(r"^  " + key + r":[ \t]*(\S.*)$", block.group(1), re.M)
        if not m:
            raise RuntimeError(f"{p} compensation block has no `{key}:` key")
        raw = m.group(1).split("#")[0].strip().strip("\"'")
        out = []
        for num, suf in _FIGURE.findall(raw):
            v = float(num.replace(",", ""))
            suf = (suf or "").lower()
            if suf == "k":
                v *= 1_000
            elif suf == "m":
                v *= 1_000_000
            elif v < 10_000:
                # A bare small number in a comp line is not a dollar figure (a year, a
                # percentage, a footnote marker). Skipping it rather than scaling it is
                # the point: guessing the unit is how a floor silently becomes $200.
                continue
            out.append(int(round(v)))
        if not out:
            raise RuntimeError(f"{p} `{key}: {raw}` holds no readable dollar figure")
        return out

    floor = _figs("minimum")[0]
    # A target is optional, as it is in setup.mjs and score-model.mjs: with none, the floor
    # is the target too. A PRESENT but unreadable target still raises, through _figs.
    # Blank, null, ~ and an empty string are all "no target", as YAML reads them.
    has_target = re.search(r"^  target_range:[ \t]*(?!(?:null|~|\"\"|''|)[ \t]*(?:#.*)?$)\S",
                           block.group(1), re.M)
    target = max(_figs("target_range")) if has_target else floor
    if not (20_000 <= floor <= 2_000_000 and floor <= target <= 5_000_000):
        raise RuntimeError(f"{p} gives an implausible comp pair (floor ${floor:,}, target "
                           f"${target:,}); refusing to gate reqs on it")
    _COMP_CACHE[p] = (floor, target)
    return floor, target

def configured_comp_targets(path=None):
    """(floor, target) when the profile sets a floor, or None when it deliberately does not.

    No floor is a valid configuration (`node setup.mjs` allows it) and means no comp gate,
    the same answer score-model.mjs gives. It is None only when the profile, its
    `compensation:` block or that block's `minimum:` is ABSENT; a floor that is present but
    unreadable or implausible still raises through comp_targets(), because a half-read
    floor is how reqs get disposed at the wrong number.
    """
    p = path or os.path.join(_location.CONFIG_DIR, "profile.yml")
    try:
        text = open(p, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    block = re.search(r"^compensation:[^\n]*\n((?:(?:[ \t]+[^\n]*)?\n)*)", text, re.M)
    if not block:
        return None
    # A `minimum:` key that is present but BLANK is the setup prompt's documented way to
    # turn the comp gate off ("blank for no comp gate"), and score-model.mjs reads null,
    # ~ and "" the same way js-yaml does: no floor. Testing only for the key's presence
    # made every one of those spellings raise instead, in comp_targets()'s own _figs(),
    # because the key that is a floor's absence looked like a floor comp_targets could
    # not read. Case-insensitive so `NULL` reads the same as `null`, which is the same
    # gap round-3 closed for target_range's blank spellings.
    has_minimum = re.search(
        r"^  minimum:[ \t]*(?!(?:null|~|\"\"|''|)[ \t]*(?:#.*)?$)\S",
        block.group(1), re.M | re.I)
    if not has_minimum:
        return None
    return comp_targets(p)


# Where the candidate can work is DATA: config/location.json, read through
# scripts/_location.py (see presets/locations/). The commute area and the same-state
# metros outside it used to be two regexes here, SOCAL and BAY, and three other tools
# kept their own diverging copies of the first. presets/locations/california-socal.json
# holds the reconciled lists and is the worked example the cases below still run on.
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import _location  # noqa: E402
LOCATION = _location.load()

REQ_START = re.compile(r"(what we need to see|qualifications|requirements|what you'?ll need|"
                       r"about you|minimum qualifications|basic qualifications|desired background|"
                       r"what you bring|skills (and|&) experience|you have)", re.I)
# Matches "$184,000" and "184,000 USD" alike; NVIDIA uses the second form and its
# bands were being dropped silently.
MONEY = re.compile(r"\$\s?([\d,]{5,})(?:\.\d\d)?|([\d,]{6,})\s*USD")
REMOTE_WORD = _location.RX["remote"]


def location_verdict(loc, remote_flag, policy=None):
    """(verdict, reason) for one posting's location string under a location policy.

    The reading itself is _location.Policy.decide(), the same algorithm as the scanner's
    location-core.mjs decideLocations(), over one grammar both compile
    (presets/locations/_base-us.json). This gate used to be its own 300-line algorithm,
    patched toward the scanner's finding by finding; every round of patches produced new
    disagreements between the two, so the reading now lives in one place and this wrapper
    only adds what the scanner cannot see.

    That is the ATS's structured isRemote flag. It can only settle a question, never
    overturn an answer: it upgrades `unknown` to `pass` for a bare country ("United States"
    with Ashby isRemote=true, which Tern posts) or an unrecognised remote region, and it
    never touches a fail or a place the policy recognises. "Austin, United States" is a
    place, so an Austin ONSITE role with the flag set stays unknown, as it must.
    """
    pol = policy or LOCATION
    verdict, why, kind = pol.decide(loc or "")
    if remote_flag and verdict == "unknown" and not pol.in_far_metro(loc or ""):
        if kind == "country":
            others = [o for o in _location.split_options(loc or "")
                      if pol.classify(_location.tokenize(o, pol.home_code))[2] == "foreign"]
            return "pass", ("remote-US (ATS isRemote flag; the posting also hires remotely in "
                            "other countries, which does not remove the US option)" if others else
                            "remote-US (ATS isRemote flag; location string omits the word)")
        if kind == "unrecognised" and REMOTE_WORD.search(loc or ""):
            return "pass", "remote (unqualified)"
    return verdict, why


HOURLY = re.compile(r"\$\s?(\d{1,3}(?:\.\d{2})?)\s*(?:-|to|–)?\s*\$?\s?(\d{1,3}(?:\.\d{2})?)?"
                    r"[^.]{0,40}?\b(per hour|an hour|hourly|/\s?hr|/\s?hour)\b", re.I)

# What a posted figure MEASURES. score-model.mjs draws exactly this line in compBand(),
# and the two must not disagree about a basis, so the vocabulary is kept close to its.
# "total" wins when both appear, e.g. "base $150K, total $250K".
TOTAL_BASIS = re.compile(
    r"\btotal (?:comp|compensation|package|target|cash|rewards)\b|\bOTE\b|"
    r"\bon[-\s]?target earnings\b|\ball[-\s]?in\b|"
    r"\bincluding (?:bonus|equity|RSUs?|stock)", re.I)
BASE_BASIS = re.compile(
    r"\bbase (?:salary|pay|compensation|comp|range|rate)\b|\bsalary range\b|"
    r"\bannual salary\b|\bbase\b", re.I)


def comp_basis(pays, jd=""):
    """Whether the posted figures measure TOTAL comp or only BASE. (basis, why).

    req-resolve extracts whatever range a posting prints and never establishes what that
    range measures, and the floor in config/profile.yml is a TOTAL-comp number. So a
    base-only band was being compared against a total floor and the caller then DISPOSED
    of the req for good: $170K base plus bonus and equity clears the floor on total and
    was thrown away as under it, permanently, with a dispositions.json entry to keep it
    from ever coming back.

    score-model.mjs settled this argument for the scoring side and its MODEL note says why
    there is no base-to-total ratio anywhere in this pipeline: the ratio is not a constant,
    it is the difference between a studio paying base plus ten percent and a big-tech RSU
    package worth double the base. Its compVerdict() therefore gates only on `total`. This
    is that rule, moved upstream to the gate that actually throws reqs away.

    The basis is read from the words AROUND the figure in the posting body. A figure the
    body does not contain (an Ashby compensation summary, for instance) is `unknown`,
    which is the answer that costs a human read rather than a lost req.
    """
    for p in pays or []:
        i = (jd or "").find(p)
        if i < 0:
            continue
        near = jd[max(0, i - 120):i + len(p) + 120]
        if TOTAL_BASIS.search(near):
            return "total", "the posting calls this figure total compensation"
        if BASE_BASIS.search(near):
            return "base", "the posting calls this figure base salary"
    return "unknown", ("the posting does not say whether this figure is base or total, "
                       "so it cannot settle a total-comp floor on its own")


# Board slugs that are not simply the company name title-cased. A fallback: portal_employer()
# answers first for any board portals.yml records, so this matters only for unrecorded ones.
ORG_NAMES = {
    "openai": "OpenAI", "elevenlabs": "ElevenLabs", "nvidia": "NVIDIA",
    "ea": "EA", "wbd": "Warner Bros. Discovery", "hbo": "HBO", "ibm": "IBM",
    "epicgames": "Epic Games", "riotgames": "Riot Games", "sonyinteractive": "Sony",
    "2kgames": "2K Games", "cddprojektred": "CD Projekt Red", "wetafx": "Weta FX",
    "ilm": "ILM", "dneg": "DNEG", "mpc": "MPC", "scanlinevfx": "Scanline VFX",
    "anthropic": "Anthropic", "xai": "xAI", "ssi": "SSI", "aws": "AWS",
    "eyelinestudios": "Eyeline Studios", "lumalabs-ai": "Luma AI",
}


def org_from_url(u):
    """The employer's board slug as it appears in an ATS URL."""
    for pat in (r"jobs\.ashbyhq\.com/([\w-]+)/", r"jobs\.lever\.co/([\w-]+)/",
                r"(?:job-boards|boards)\.greenhouse\.io/([\w-]+)/",
                r"greenhouse\.io/(?:embed/job_app\?for=)?([\w-]+)/jobs/",
                r"//([\w-]+)\.wd\d+\.myworkdayjobs\.com/",
                r"smartrecruiters\.com/([\w-]+)/", r"jobs\.gem\.com/([\w-]+)/",
                r"apply\.workable\.com/([\w-]+)/"):
        m = re.search(pat, u or "", re.I)
        if m:
            return m.group(1)
    # Company-hosted boards (epicgames.com/careers, riotgames.com/work-with-us,
    # explore.jobs.netflix.net) carry the employer in the host, not the path.
    # Aggregators are excluded: builtin.com is not an employer, and naming it one
    # would put a job board in the company column.
    AGG = {"builtin", "linkedin", "indeed", "ziprecruiter", "glassdoor", "dice",
           "otta", "wellfound", "angellist", "monster", "simplyhired", "lensa",
           "lnkd", "jobright", "himalayas"}
    GENERIC = rr.HOST_NOISE | {"explore", "app", "my", "talent"}
    h = re.search(r"https?://([^/]+)", u or "")
    if h:
        labels = [l for l in h.group(1).lower().split(".") if l and l not in GENERIC]
        if labels and labels[0] not in AGG:
            return labels[0]
    return ""


_WD_URL = re.compile(r"//([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/(?:[a-z]{2}-[a-z]{2}/)?([a-z0-9_-]+)",
                     re.I)
_TRACKER = {}


def _tracker_rows():
    """(raw line, cells) for every table row of data/applications.md, read once.

    tracker_hits and tracker_spelling both parsed the whole file on every call, which
    recomp made once per packet. Keyed on the path, size and mtime, so the selftest's
    patched ROOT and a tracker rewritten mid-run both read fresh.
    """
    p = os.path.join(ROOT, "data", "applications.md")
    try:
        st = os.stat(p)
    except OSError:
        return []
    key = (p, st.st_size, st.st_mtime_ns)
    if _TRACKER.get("key") != key:
        rows = [(l, [c.strip() for c in l.split("|")])
                for l in open(p, encoding="utf-8", errors="replace") if l.startswith("|")]
        _TRACKER.update(key=key, rows=rows)
        return rows
    return _TRACKER["rows"]


def tracker_spelling(name):
    """`name` as the tracker already spells that employer, else `name` unchanged.

    portals.yml labels and tracker rows grew up separately: the label says "Disney Studios"
    and eight tracker rows say "Disney". merge-tracker compares employers by normalised
    name before it ever looks at a requisition id, so a second spelling is a second
    employer to it, and its id guard never runs. Exact match first, then the one tracker
    spelling that one name is a prefix of, most-used wins.
    """
    key = rr.name_key(name)
    if not key:
        return name
    seen = {}
    for _, c in _tracker_rows():
        if len(c) > 4 and c[1].isdigit() and c[3]:
            seen[c[3]] = seen.get(c[3], 0) + 1
    exact = [n for n in seen if rr.name_key(n) == key]
    if exact:
        return max(exact, key=seen.get)
    # A prefix counts only at a WORD boundary: "Disney Studios" is the tracker's "Disney",
    # but "Metaphysic" must never become "Meta", which a character prefix would make it.
    def word_prefixes(s):
        w = re.findall(r"[A-Za-z0-9]+", s)
        return {rr.name_key(" ".join(w[:k])) for k in range(1, len(w) + 1)}
    mine = word_prefixes(name)
    near = [n for n in seen if len(rr.name_key(n)) > 2
            and (rr.name_key(n) in mine or key in word_prefixes(n))]
    return max(near, key=seen.get) if near else name


def portal_employer(slug=None, workday=None):
    """The employer portals.yml records for a board slug or a Workday (tenant, site), or None.

    portals.yml already says who each board belongs to; its label base is the name, spelled
    the way the tracker spells that employer. A Workday tenant hostname is not a name
    ("snapchat" is Snap, and "xboxgaming" is BOTH Blizzard and Activision, told apart only
    by the site), and neither is a capitalised slug ("Shieldai"). So a hand-kept slug table
    is needed only for boards nobody recorded. Two entries naming different employers for
    one board return None rather than a guess.
    """
    if slug:
        names = {e["base"] for e in rr.portals_index() if slug.lower() in e["boards"]}
    else:
        tenant, site = workday
        names = {e["base"] for e in rr.portals_index()
                 if e["workday"] and e["workday"][0].lower() == tenant
                 and e["workday"][2].lower() == site}
    return tracker_spelling(names.pop()) if len(names) == 1 else None


def company_from(r):
    """The employer's name: portals.yml first, then the hand table, then the tracker."""
    m = _WD_URL.search(r.get("url") or "")
    if m and not r.get("org"):
        # An unrecorded Workday tenant gets NO name rather than a capitalised hostname:
        # eval-write refuses an unnamed packet, and a person naming it beats a confident
        # wrong employer that merge-tracker would treat as a new company.
        tenant = m.group(1).lower()
        return portal_employer(workday=(tenant, m.group(2).lower())) or ORG_NAMES.get(tenant)
    org = (r.get("org") or r.get("discovered_board") or "").strip().lower()
    if not org:
        org = org_from_url(r.get("url") or "").lower()
    if not org:
        return None
    # A capitalised slug ("Andurilindustries") is a new employer to every name-keyed
    # lookup; the tracker usually already spells it, and its normalised key is the slug's.
    return (portal_employer(slug=org) or ORG_NAMES.get(org)
            or tracker_spelling(" ".join(w.capitalize() for w in re.split(r"[-_]+", org) if w))
            or None)


# Passed as `targets` to mean "no floor", which None cannot say: None means "read the
# installed profile", so a selftest asking for the no-floor verdict got whatever floor
# the machine it ran on had configured, and skipped the case whenever one was set.
NO_FLOOR = ()


def comp_verdict(pays, jd="", targets=None):
    """Turn the posted figures into the numbers the comp dimension is judged on.

    Handles hourly as well as annual. The annual pattern requires five or more
    digits, so a union rate written "$39.54 - $73.16 an hour" produced NO band at
    all and the req sat in the queue as comp-unknown. Those are precisely the
    postings that fail the floor and should settle themselves: annualised at 2080
    hours, that example is $82,000 to $152,000, well under it.

    The packet now records TWO different things about the floor, because they were one
    thing and that one thing was disposing of live reqs:

      clears_floor  is arithmetic about the POSTED figures: does the achievable point of
                    the printed range reach the floor. Unchanged, and still what the queue
                    sorts and displays on.
      floor_gate    is the only key with the authority to throw a req away. It is True
                    only when the posted range misses the floor AND the posting says that
                    range is TOTAL compensation, because the floor is a total-comp number
                    and a base-only band under it says nothing about total. `basis` says
                    which, and `basis_why` says how it was decided.

    A below-floor band of unknown basis therefore stays a packet, flagged, and is read by
    a human. That is the same trade score-model.mjs makes and for the same stated reason:
    a genuinely underpaying base-only role stays visible and is judged on its comp
    DIMENSION by someone who can see the equity, instead of being sunk by a regex that
    cannot.
    """
    # `targets` exists for the selftest, which must not depend on whose profile is
    # installed. Production callers never pass it and still read config/profile.yml.
    if targets is None:
        targets = configured_comp_targets()
    floor, target = targets if targets else (None, None)
    vals, hourly = [], False
    for p in pays or []:
        for a, b in MONEY.findall(p):
            tok = a or b
            if tok:
                vals.append(int(tok.replace(",", "")))
    vals = [v for v in vals if 30_000 <= v <= 3_000_000]
    if not vals and jd:
        hrs = []
        for m in HOURLY.finditer(jd):
            for g in (m.group(1), m.group(2)):
                if g:
                    hrs.append(float(g))
        hrs = [h for h in hrs if 15 <= h <= 400]
        if hrs:
            vals = [int(round(h * 2080)) for h in (min(hrs), max(hrs))]
            hourly = True
    if not vals:
        return dict(posted=None, low=None, high=None, achievable=None,
                    clears_floor=None, clears_target=None,
                    basis=None, basis_why=None, floor_gate=None,
                    note="no band posted; score comp on evidence, not on this")
    if hourly:
        # An hourly rate is the whole of the cash offer. There is no bonus and no equity
        # attached to an hourly contract, so unlike an annual salary line it IS the total
        # and can settle the floor by itself. This is the one place a basis is inferred
        # from the shape of the figure rather than from the words beside it.
        basis, basis_why = "total", "an hourly rate carries no bonus or equity behind it"
    else:
        basis, basis_why = comp_basis(pays, jd)
    lo, hi = min(vals), max(vals)
    ach = lo + (hi - lo) * BAND_POINT
    if floor is None:
        # No floor configured: report the band and gate nothing.
        return dict(posted=f"${lo:,} - ${hi:,}", low=lo, high=hi, achievable=round(ach),
                    clears_floor=None, clears_target=None,
                    basis=basis, basis_why=basis_why, floor_gate=None,
                    note=f"achievable ${round(ach):,} at the {int(BAND_POINT*100)}th "
                         "percentile; no comp floor is configured, so nothing is gated")
    clears = ach >= floor
    gate = (not clears) and basis == "total"
    if clears:
        why = f"clears the floor on the posted range ({basis})"
    elif gate:
        why = "below the floor on a range the posting states is TOTAL comp; hard gate"
    else:
        why = (f"below the floor, but the posted range is {basis}, not total comp. "
               "Bonus and equity are unknown and the base-to-total ratio is not a "
               "constant, so this is a flag for a human read, not a disposal")
    return dict(posted=f"${lo:,} - ${hi:,}", low=lo, high=hi, achievable=round(ach),
                clears_floor=clears, clears_target=ach >= target,
                basis=basis, basis_why=basis_why, floor_gate=gate,
                note=f"achievable ${round(ach):,} at the {int(BAND_POINT*100)}th percentile; "
                     f"floor ${floor:,}, target ${target:,}; {why}")


def requirements(jd, n=1800):
    if not jd:
        return ""
    m = REQ_START.search(jd)
    return (jd[m.start():m.start() + n] if m else jd[:n]).strip()


def tracker_hits(title, url=""):
    """Cheap duplicate warning. Report-only: this never blocks, it prompts a look.

    The company must match as well as the title. Matching on title words alone made
    "Machine Learning Engineer 3 (Firefly)" at Adobe look like a duplicate of a
    tracked Cresta row, because both contain "machine learning engineer". Generic
    role nouns are most of a job title, so a title-only check flags nearly every ML
    req as already-evaluated, and a real lead dismissed as a duplicate is never seen
    again.
    """
    if not title:
        return []
    host = rr.name_key(re.sub(r"^https?://(www\.)?", "", url or "").split("/")[0])
    STOP = ("senior", "staff", "principal", "lead", "engineer")
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", title.lower()).split() if len(w) > 3]
    key = [w for w in words if w not in STOP]
    # A short title like "Applied AI Engineer" leaves one usable word once the level
    # and role nouns are stripped, and one word can never reach a two-match threshold,
    # so an already-tracked req reported zero duplicates. When the distinctive words
    # run out, put the generic ones back rather than matching on nothing.
    if len(key) < 2:
        key = words or [w for w in re.sub(r"[^a-z0-9 ]", " ", title.lower()).split()]
    need = 2 if len(key) >= 2 else 1
    hits = []
    for line, cells in _tracker_rows():
        low = line.lower()
        co = rr.name_key(cells[3]) if len(cells) > 3 else ""
        # Company gate: the tracker row's company must be recognisable in the posting
        # URL, or in the packet's own host. Without this the title words alone match
        # across unrelated employers.
        same_co = bool(co) and co[:8] in host
        if not same_co:
            continue
        if key and sum(1 for w in key if w in low) >= max(need, len(key) // 2):
            if len(cells) > 5:
                hits.append(f"#{cells[1]} {cells[3]} - {cells[4][:60]} ({cells[5]})")
    return hits[:4]


def prep(url):
    r = rr.resolve(url)
    lv, lw = location_verdict(r.get("location"), r.get("remote_txt"))
    title = r.get("title") or ""
    slug = slug_of(title)
    return {
        "_instructions": "Fill every null below, then: node eval-write.mjs <this file> --date=YYYY-MM-DD",
        "url": url, "ats": r.get("ats"), "live": r.get("live"),
        "resolver_note": r.get("note"),
        "title": title, "location": r.get("location"),
        "location_verdict": lv, "location_why": lw,
        "comp": comp_verdict(r.get("pay"), r.get("jd") or ""),
        "possible_tracker_duplicates": tracker_hits(title, url),
        "requirements_excerpt": requirements(r.get("jd")),
        # Keep the whole body, not just the excerpt. eval-assist scans for stated
        # gates (clearance, required degree, years thresholds) and those appear
        # anywhere in a posting, so analysing a 1800-character window silently
        # missed most of them.
        "jd_full": r.get("jd") or "",
        "jd_chars": len(r.get("jd") or ""),
        # --- judgement: fill these in ---
        # company is seeded from the ATS org slug rather than left blank. It was
        # always None, so the duplicate check had nothing but the title to match on
        # and fired across unrelated employers, and any lookup keyed on employer
        # fell back to the URL host, which is the ATS vendor ("ashbyhq"), not the
        # company. The slug is the employer's own board name and is right far more
        # often than it is wrong; confirm it when filling in the judgement.
        # The URL is merged in because a resolver result does not carry one, and a
        # Workday employer exists ONLY in the tenant hostname: every NVIDIA, Salesforce
        # and Disney packet was prepped with company None until 2026-10-08, and
        # eval-write refuses an unnamed packet. reresolve() already passed it this way.
        "company": company_from({**r, "url": url}), "num": None, "slug": slug, "status": None,
        "match_w_cv": None, "north_star": None, "comp_score": None,
        "cultural_signals": None, "red_flags_adj": 0,
        "verification_depth": "full-jd" if r.get("jd") else "listing",
        "body": None, "gate": None, "recommendation": None,
    }


# A requisition id as each ATS writes it into its own URL. Ordered, and tried before the
# digest fallback, purely so the filename stays something a human can recognise.
_URL_ID = [
    re.compile(r"_((?:JR|R)-?\d{4,}|\d{2}WD\d{4,})(?:[/?]|$)", re.I),   # Workday
    re.compile(r"[?&]gh_jid=(\d+)"),                                    # hosted Greenhouse
    re.compile(r"/jobs?/(\d{5,})"),                                     # Greenhouse, Netflix
    re.compile(r"/postings/([\w-]{4,})"),                               # SmartRecruiters
    re.compile(r"/p/([0-9a-f]{8,})"),                                   # Breezy
    re.compile(r"/j/([A-Za-z0-9]{6,})"),                                # Workable
    re.compile(r"/details/([\w-]+)"),                                   # Apple
    re.compile(r"/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-"),             # Ashby, Lever UUID
]


def packet_id(url):
    """A stable, collision-safe token for one posting URL."""
    for pat in _URL_ID:
        m = pat.search(url or "")
        if m:
            tok = re.sub(r"[^a-z0-9]+", "", m.group(1).lower())[:18]
            if tok:
                return tok
    # No id this parser recognises. A digest is never wrong, only unreadable, and an
    # unreadable name costs a glance where a collision costs the whole req.
    return hashlib.sha1((url or "").encode("utf-8")).hexdigest()[:8]


def packet_name(p):
    """The filename for a packet, which must not be able to name another req's file.

    It was `{title-slug}.json` and nothing else. Two employers posting "AI Engineer", or
    two reqs at one employer whose titles slug the same, wrote to the same path and the
    second json.dump silently overwrote the first. The overwritten req then gets no
    report and no tracker row, and nothing anywhere says a packet went missing: the queue
    simply has one fewer file than the run prepped. NVIDIA is the standing example of the
    second shape, JR2620896 and JR2301525 being one word apart with opposite location
    verdicts, which is why CLAUDE.md says never to dedup reqs by title.

    Keyed on the URL, so re-prepping the same req still overwrites its own packet instead
    of accumulating a new one each run. `slug` is left alone: eval-write.mjs builds the
    REPORT filename from that field, and report naming is not what was broken here.
    """
    org = re.sub(r"[^a-z0-9]+", "-", (org_from_url(p.get("url") or "")).lower()).strip("-")
    slug = (p.get("slug") or "untitled")[:48].strip("-")
    parts = [x for x in (org, slug, packet_id(p.get("url") or "")) if x]
    return "-".join(parts) + ".json"


def hard_gate(p):
    """The disposition that settles this req with no judgement needed, or None.

    A disposition is PERMANENT: it is written to dispositions.json so the req never
    returns to triage, so every gate on this list has to be safe to be wrong about never.

    Comp qualifies only when the posting states that its range is TOTAL compensation,
    which is what the floor is denominated in. This used to read `clears_floor is False`,
    which threw away any req whose printed range missed the floor, and most postings print
    BASE. A $170K base carried over the floor by bonus and equity was disposed of exactly
    as if the employer had published a sub-floor total. See comp_verdict for the rest.
    """
    if p.get("live") is False:
        return "closed"
    if p.get("location_verdict") == "fail":
        return p.get("location_why") or "location fails"
    c = p.get("comp") or {}
    if c.get("floor_gate"):
        return (f"below floor on stated total comp "
                f"(achievable ${c.get('achievable', 0):,})")
    return None


def write_packet(path, p):
    """Write one packet the way every reader expects it: UTF-8, one-space indent."""
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(p, fh, indent=1, ensure_ascii=False)


def slug_of(title):
    """The filename slug for a posting title."""
    return re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:60] or "untitled"


def record_dispositions(disp):
    """Append hard-gate dispositions to dispositions.json, once per url; return the total."""
    out = os.path.join(ROOT, "dispositions.json")
    prev = json.load(open(out, encoding="utf-8")) if os.path.exists(out) else []
    seen = {d["url"] for d in prev}
    prev += [d for d in disp if d["url"] not in seen]
    json.dump(prev, open(out, "w", encoding="utf-8"), indent=1)
    return len(prev)


def queue_packets(queue=None):
    """Yield (path, packet) for every PACKET in the queue, and nothing else.

    The queue directory also holds files that are not packets: score dumps
    (`_nvidia-0827-scores.json` is a list) and a sweep's own JSON (a dict with no url).
    Each reader used to glob `*.json` itself, and only eval-assist and eval-blockers
    filtered, so `--relocate` died on the first list it opened and the other three
    readers were one stray file from the same crash. A rule written into some readers and
    not the rest is the shape CLAUDE.md records three times over; one enumerator is the
    structure in which it cannot recur. A packet is a dict carrying the url it was
    prepped from. Unreadable files are skipped rather than fatal, since one bad file must
    not stop the pass over the others.

    The default is resolved at CALL time, never written `queue=OUT_DIR`. A default is
    bound once, when the def runs, so the selftests' patch of OUT_DIR stopped reaching
    the readers and the reresolve cases ran against the REAL queue with a mocked
    resolver, rewriting a live packet's location with the mock's. reresolve_cases now
    asserts the real queue is untouched, so that cannot pass silently again.
    """
    queue = queue or OUT_DIR
    for f in sorted(glob.glob(os.path.join(queue, "*.json"))):
        try:
            p = json.load(open(f, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(p, dict) and p.get("url"):
            yield f, p


def list_queue():
    """Show the packets waiting on judgement, best first.

    A directory of seventy JSON files is not a work queue. Ordering by whether the
    band clears the target, then by whether it clears the floor at all, puts the
    reqs whose outcome is still open at the top, and pushes the ones that only
    survived because no band was posted to the bottom where they belong.
    """
    if not os.path.isdir(OUT_DIR):
        print("no queue"); return
    rows = []
    for f, p in queue_packets():
        f = os.path.basename(f)
        c = p.get("comp", {})
        rank = (2 if c.get("clears_target") else 1 if c.get("clears_floor") else 0,
                1 if p.get("location_verdict") == "pass" else 0,
                -len(p.get("possible_tracker_duplicates") or []))
        rows.append((rank, p, f))
    rows.sort(key=lambda r: r[0], reverse=True)
    filled = sum(1 for _, p, _ in rows if p.get("match_w_cv") is not None)
    print(f"{len(rows)} packet(s) awaiting judgement, {filled} already filled\n")
    print(f"{'comp':14s} {'loc':8s} {'dup':4s} title")
    print("-" * 92)
    for rank, p, f in rows:
        c = p.get("comp", {})
        money = ("TARGET" if c.get("clears_target") else
                 "floor" if c.get("clears_floor") else
                 # A sub-floor band now survives into the queue when its basis is not
                 # total, and it must not display as "no band": a posting that states a
                 # low base is the opposite of one that states nothing at all.
                 f"sub-floor {c.get('basis') or '?'}" if c.get("clears_floor") is False
                 else "no band")
        dups = len(p.get("possible_tracker_duplicates") or [])
        mark = "*" if p.get("match_w_cv") is not None else " "
        print(f"{mark}{money:13s} {p.get('location_verdict',''):8s} "
              f"{(str(dups) if dups else ''):4s} {(p.get('title') or f)[:66]}")


def relocate():
    """Re-apply the CURRENT location rules to packets already on disk.

    The gate has been corrected twice since these packets were written (city names
    as well as countries, and placeholder strings flagged rather than passed). The
    stored verdicts are whatever the rules said at prep time, so they go stale
    silently and a req that should now fail keeps asking for a human read.

    Recomputed from the stored location string, so it costs no network. Packets that
    already carry a judgement are left alone.
    """
    changed, disp = 0, []
    for f, p in queue_packets():
        if p.get("match_w_cv") is not None:
            continue
        # Duplicates are recomputed too: the check was title-only and matched across
        # unrelated employers, so stored lists are full of false positives that make a
        # live req look already-evaluated.
        dups = tracker_hits(p.get("title"), p.get("url", ""))
        if dups != p.get("possible_tracker_duplicates"):
            p["possible_tracker_duplicates"] = dups
            write_packet(f, p)
        v, w = location_verdict(p.get("location"), p.get("remote_txt"))
        if v == p.get("location_verdict") and w == p.get("location_why"):
            continue
        print(f"  {str(p.get('location'))[:30]:30s} {p.get('location_verdict')} -> {v}  "
              f"({(p.get('title') or '')[:40]})")
        p["location_verdict"], p["location_why"] = v, w
        write_packet(f, p)
        changed += 1
        if v == "fail":
            disp.append({"url": p["url"], "disposition": w})
            os.remove(f)
    print(f"\n{changed} packet(s) re-gated, {len(disp)} now fail on location")
    if disp:
        print(f"dispositions.json now holds {record_dispositions(disp)}; retire with:")
        print("  node pipeline-audit.mjs --prune --dispositions=dispositions.json")


def reresolve():
    """Re-fetch packets whose stored location the gate cannot use.

    relocate() recomputes the verdict from the location string already in the packet,
    so a packet holding a placeholder ("BLANK,BLANK,Multiple Locations") stays stuck
    no matter how much the gate improves: the placeholder is what the resolver of the
    day wrote down. The resolver now reads Greenhouse offices[] and remote metadata,
    which is where those real sites live, but that only helps on a fresh fetch.

    So this one costs network, unlike relocate() and recomp(). It is scoped to the
    packets that cannot move without it.
    """
    stuck = []
    for f, p in queue_packets():
        if p.get("match_w_cv") is not None:
            continue
        jd = p.get("jd_full") or ""
        # An unusable location is not the only reason to refetch. Two resolver
        # branches computed the description and then forgot to return it, so those
        # packets carry an EMPTY jd and score lane 0.0 on no evidence: that is how a
        # well-paid, in-lane remote req sorted to the bottom of the queue. And escaped markup used to survive clean(), so older packets hold
        # literal <p> and <li> in the text the lane scan reads.
        if (p.get("location_verdict") == "unknown" or not jd
                or re.search(r"<(p|li|div|br|ul|strong)\b", jd, re.I)):
            stuck.append((f, p))
    print(f"{len(stuck)} packet(s) need a fresh fetch\n")
    changed, disp = 0, []
    for f, p in stuck:
        r = rr.resolve(p["url"]) or {}
        # Rewrite the packet's OWN liveness on every refetch, whatever the answer comes
        # back as. It never was rewritten: this loop updated the jd, the location, the
        # comp and the company and left `live` exactly as the day the packet was built,
        # so a packet stamped live=True in June still said so months later. eval-blockers
        # reads that field to decide what is ready to work on, which is how a requisition
        # retired an hour earlier could head the READY list.
        p["live"] = r.get("live")
        if not r:
            # "The resolver returned nothing" is not "the posting is gone", and the two
            # used to share this branch. Deleting the packet is the one thing in this
            # function that cannot be undone, so it needs the stronger evidence.
            print(f"  UNKNWN  resolver returned no result  {(p.get('title') or '')[:38]}")
            write_packet(f, p)
            changed += 1
            continue
        if r.get("live") is False:
            print(f"  CLOSED  {(p.get('title') or '')[:52]}")
            disp.append({"url": p["url"], "disposition": "posting closed"})
            os.remove(f)
            changed += 1
            continue
        if r.get("jd"):
            p["jd_full"], p["jd_chars"] = r["jd"], len(r["jd"])
            p["requirements_excerpt"] = requirements(r["jd"])
            if not (p.get("comp") or {}).get("posted"):
                p["comp"] = comp_verdict(r.get("pay"), r["jd"])
        if not p.get("company"):
            p["company"] = company_from({**r, "url": p["url"]})
        loc = r.get("location")
        if not loc:
            print(f"  jd {p.get('jd_chars', 0):5d}  (location unchanged)  "
                  f"{(p.get('title') or '')[:38]}")
            write_packet(f, p)
            changed += 1
            continue
        v, w = location_verdict(loc, r.get("remote_txt"))
        p["location"], p["location_verdict"], p["location_why"] = loc, v, w
        print(f"  {str(loc)[:34]:34s} -> {v:7s} jd {p.get('jd_chars', 0):5d}  "
              f"{(p.get('title') or '')[:34]}")
        write_packet(f, p)
        changed += 1
        if v == "fail":
            disp.append({"url": p["url"], "disposition": w})
            os.remove(f)
    print(f"\n{changed} packet(s) updated, {len(disp)} settled by a hard gate")
    if disp:
        print(f"dispositions.json now holds {record_dispositions(disp)}; retire with:")
        print("  node pipeline-audit.mjs --prune --dispositions=dispositions.json")


def recomp():
    """Re-derive comp for packets on disk using the CURRENT extraction rules.

    Same reasoning as relocate(): the band parser has been corrected since these
    packets were written (USD-suffix figures, then hourly rates), and a packet keeps
    whatever the parser said at prep time. "No band" is the second largest blocker
    class in the queue, and some of those postings do publish a band that the parser
    of the day could not see. The full JD is stored in the packet, so this costs no
    network.
    """
    changed = 0
    for f, p in queue_packets():
        if p.get("match_w_cv") is not None or (p.get("comp") or {}).get("posted"):
            continue
        c = comp_verdict([], p.get("jd_full") or "")
        if not c.get("posted"):
            continue
        print(f"  {c['posted']:24s} {(p.get('title') or '')[:52]}")
        p["comp"] = c
        write_packet(f, p)
        changed += 1
    print(f"\n{changed} packet(s) gained a band")

    named = 0
    for f, p in queue_packets():
        if p.get("match_w_cv") is not None or p.get("company"):
            continue
        co = company_from(p)
        if not co:
            continue
        p["company"] = co
        write_packet(f, p)
        named += 1
    print(f"{named} packet(s) gained an employer name")


LOCATION_CASES = [
    # (location, ats_remote_flag, expected verdict, why this case exists)
    ("Remote, Global", False, "pass",
     "worldwide remote includes the US; it read as an unrecognised region"),
    ("Indiana - Remote", True, "fail",
     "Salesforce's format: state first, dash separator. The fifth spelling of state-scoped "
     "remote found on a real board, and like the other four it read as plain remote-US"),
    ("Indiana - Remote | California - Remote", True, "pass",
     "a California entry among Salesforce-format scoped options keeps it reachable"),
    ("Virginia - Washington DC Metro - Remote", True, "fail",
     "Salesforce JR340399, recorded as a PASS on remote-US by the 2026-08-25 sweep in "
     "research/2026-08-25-workday-sweep-13-tenants.txt. The dashed rule was anchored to "
     "the end of the segment, so an interior metro defeated it and a Virginia-scoped "
     "remote role read as nationwide"),
    ("Texas - Dallas Metro - Remote", True, "fail",
     "the same metro shape on a different state, and the reason the fix cannot special-"
     "case Washington DC"),
    ("Maryland - Washington DC Metro - Remote", True, "fail",
     "the SAME metro against a different leading state. The rule has to resolve which "
     "state LEADS the segment, not match whichever state name appears first anywhere in "
     "it, or 'Washington' inside the metro would decide the verdict"),
    ("California - Los Angeles Metro - Remote", True, "pass",
     "the metro form scoped to the candidate's own state. A fix that simply rejected any "
     "segment with an interior qualifier would discard their own back yard, which is the "
     "expensive direction of this gate"),
    ("California - San Francisco Metro - Remote", True, "fail",
     "the California mirror of the same bug, and the one a Californian is most "
     "likely to be talked into. Salesforce posts this as its own option BESIDE a plain "
     "'California - Remote', so the metro narrows the scope to the Bay Area rather than "
     "decorating the state. Reading the state and discarding the metro passes a role the "
     "candidate cannot take under a name that looks like their own",
     "San Francisco metro"),
    ("California - San Francisco Metro - Remote | California - Remote", True, "pass",
     "a state-wide California entry beside the Bay-metro one is reachable, so the metro "
     "rule must narrow a single option rather than poison the whole string"),
    ("Texas - Dallas Metro - Remote | California - Los Angeles Metro - Remote", True, "pass",
     "a California entry among metro-qualified scoped options keeps it reachable, the "
     "same way it does for the plain dashed form"),
    ("Texas - we are fully remote", True, "unknown",
     "prose that names a state and then talks about remote work is not a SCOPE, so it can "
     "never fail; it is a weak mention, which asks rather than guesses. It used to pass "
     "here and reject in the scanner; both gates now read it the same way"),
    ("Peru - Remote", True, "fail",
     "Peru was in neither the country list nor the ISO-3 list, so this passed as "
     "'remote (unqualified)'. A country list is never finished; the failure mode is that "
     "an unlisted country reads as a reachable remote role"),
    ("Remote Massachusetts", True, "fail",
     "Adobe's format: no comma, no country. Scoped to Massachusetts and unreachable, but "
     "read as plain remote-US because nothing parsed the state out"),
    ("Remote New York", True, "fail", "the same, scoped to New York"),
    ("Remote California", True, "pass",
     "the same shape scoped to the candidate's own state, which must still pass"),
    ("Remote West Virginia", True, "fail",
     "two-word state in the no-comma form"),
    ("Remote New York or anywhere nationwide", True, "pass",
     "the no-comma rule is anchored to the END of the segment on purpose. Adobe's format "
     "is exactly 'Remote <State>' and nothing more; a segment that names a state and then "
     "keeps going is prose, not scoping, and treating it as scoping would falsely reject "
     "a nationwide role"),
    ("Remote California | Remote New York", True, "pass",
     "a California entry among Adobe-format scoped options keeps it reachable"),
    ("Pennsylvania, USA - Remote", True, "fail",
     "Autodesk's spelled-out scoping. Same meaning as 'US, PA, Remote' and just as "
     "unreachable, but the abbreviation rule could not see it, so it read as plain "
     "remote-US. location-core already rejected this shape; the gates disagreeing is "
     "what surfaced it"),
    ("California, USA - Remote", True, "pass",
     "the same shape scoped to a state the candidate DOES live in must still pass"),
    ("West Virginia, USA - Remote", True, "fail",
     "the state list is matched longest-first, so this must not resolve as Virginia"),
    ("Pennsylvania, USA - Remote | California, USA - Remote", True, "pass",
     "a California entry among the scoped ones is what makes it reachable"),
    ("Toronto, ON, CAN | Ontario, CAN - Remote", True, "fail",
     "Autodesk's Principal MCP/AI Developer. BOTH entries are Canadian and the remote one "
     "names its own country, so there is nothing to defer to. This returned 'unknown' and "
     "put a Canadian role in the actionable list purely because the string held the word "
     "'Remote' somewhere"),
    ("Ontario, CAN - Remote | Remote", True, "unknown",
     "TWO remote options where only the FIRST names a country. The rule must weigh every "
     "remote segment, not just the first: the trailing bare 'Remote' could cover the US, "
     "so this defers. Judging only the leading segment would fail a reachable role"),
    ("Remote | Toronto", True, "unknown",
     "the genuinely ambiguous shape this branch exists for: a BARE remote entry beside a "
     "foreign city, where a US-headquartered company may well mean US-remote"),
    ("Toronto, ON, CAN | USA - Remote", True, "pass",
     "a US remote option alongside a Canadian office is reachable, and must not be caught "
     "by the all-remote-options-are-foreign rule"),
    ("Ontario, CAN - Remote", True, "fail",
     "Autodesk writes its country as the ISO-3 code. The country list held 'canada' but "
     "not 'CAN', so the bare word 'Remote' carried this through as a PASS and a Canadian "
     "role was reported as actionable under a hard no-relocation constraint"),
    ("UK, Remote | Switzerland, Remote | Finland, Remote", True, "fail",
     "NVIDIA JR2548194, AI Developer Tools. NVIDIA writes the United Kingdom as 'UK', "
     "which is neither the spelled-out name nor the ISO-3 'GBR', so that one segment carried "
     "no foreign marker and three foreign remote options read as 'unknown'"),
    ("US, CA, Remote | UK, Remote", True, "pass",
     "the same NVIDIA shape with a California remote option among them is reachable"),
    ("Culver City, CA | UK, Remote", True, "pass",
     "a SoCal site beside a UK remote option. Adding 'UK' as a marker failed this, because "
     "the foreign rule recognised a US place only by the literal token US/USA"),
    ("Irvine, CA | London, UK", False, "pass",
     "a SoCal office beside a London one is inside the commute ceiling. This failed as "
     "non-US BEFORE 2026-10-08 too, on 'london', for the same reason"),
    ("Los Angeles, California | Remote - UK", True, "pass",
     "the spelled-out state names the US place, and it passes on LA, NOT as remote-US: the "
     "only remote option is in the UK", "SoCal"),
    ("Global HQ, London", False, "fail",
     "'Global' beside a place is not worldwide remote"),
    ("Austin, Texas | Remote - UK", True, "fail",
     "a foreign remote option must not carry a US office outside the commute through as "
     "remote-US"),
    ("Austin, TX | Remote - UK", True, "fail",
     "the policy knows Austin as a metro outside the commute; the UK remote option must not "
     "turn it into a pass"),
    ("London, UK | New York, NY", False, "fail",
     "a US place stops the string reading as foreign, and the commute rule still fails NY"),
    ("Toronto, ON, CAN", False, "fail", "ISO-3 country code with no remote entry"),
    ("Krakow, POL", False, "fail", "ISO-3 code for a country not spelled out in the string"),
    ("Dublin, IRL", False, "fail", "same, and 'IRL' is not the word 'ireland'"),
    ("Irvine, California | Remote - you can choose your days", True, "pass",
     "the ISO-3 check must be CASE-SENSITIVE: lowercase 'can' here is the English verb. "
     "This case deliberately contains NO 'US' or 'USA' token, because that token "
     "short-circuits the whole non-US branch and would let a case-insensitive ISO-3 "
     "check pass the test while still being wrong"),
    ("Vancouver, BC, CAN | USA - Remote", True, "pass",
     "a US remote entry alongside a foreign office is still reachable"),
    ("US, CA, Santa Clara | US, GA, Remote | US, DC, Remote | US, NC, Remote | US, WA, Remote",
     False, "fail",
     "JR2212194: every remote entry names a state and none is California. Its own "
     "evaluation called it a hard out; a later re-check passed it because the words "
     "'Remote' and 'US' both appear somewhere in the string"),
    ("US, CA, Santa Clara | US, NC, Remote | US, TX, Remote | US, CA, Remote", False, "pass",
     "a California entry among the scoped ones is what makes it reachable"),
    ("US, CA, Santa Clara | US, Remote", False, "pass",
     "an UNSCOPED nationwide remote entry covers California"),
    ("United States | Canada", True, "pass",
     "Elastic's Tech Lead, Agent Framework. A distributed company hiring remotely in two "
     "countries; the flag branch accepted only a BARE US string, so one extra country "
     "flipped a genuinely remote-US role to fail and it was gated out of an eval run"),
    ("United States, Canada", True, "pass", "the same, comma separated"),
    ("Canada | United Kingdom", True, "fail",
     "the flag must not pass a posting with NO US segment at all"),
    ("Austin, United States", True, "fail",
     "an ONSITE US city with a remote flag somewhere in the posting. The comma is a "
     "city-country separator here, not a list separator, so a rule that only asked whether "
     "SOME segment was the US passed an Austin onsite role as remote-US"),
    ("Cary, North Carolina, United States", True, "fail", "the same, with a state as well"),
    ("US, TX, Remote | Canada", True, "fail",
     "state scoping is resolved before the flag branch, so a Texas-scoped remote cannot "
     "be re-admitted by the multi-country rule"),
    ("US, TX, Remote", False, "fail", "a single non-California scoped remote"),
    ("US, CA, Remote", False, "pass", "a single California scoped remote"),
    ("USA | Remote", False, "pass", "the Ashby spelling"),
    ("Remote - United States", False, "pass", "the Greenhouse spelling"),
    ("United States", True, "pass",
     "Tern: the ATS isRemote flag with a bare country string. Without this the row fell "
     "to the US-and-not-remote failure and was discarded in silence"),
    ("San Mateo, California | Remote - United States", True, "pass",
     "GC AI: the remote option lives in Ashby's secondaryLocations, not the primary"),
    ("Los Angeles, California", False, "pass", "SoCal onsite is inside the ceiling"),
    ("Austin, Texas", False, "fail", "a US city outside the ceiling with no remote option"),
    ("Toronto, ON", False, "fail", "non-US"),
    ("United States | Playa Vista, California, United States", False, "pass",
     "Crexi: Greenhouse puts the real site in offices[] while location reads a bare "
     "'United States'. Before the adapter folded offices in, the gate saw only the country "
     "and failed an LA role as outside the commute ceiling"),
    ("Remote | Toronto", False, "unknown",
     "CaptivateIQ: a bare remote entry beside a foreign city is ambiguous, not a failure. "
     "Failing it silently discarded the row; unknown asks for the one lookup that settles it"),
    ("Toronto | Vancouver", False, "fail",
     "foreign cities with NO remote entry stay a hard fail"),
    ("Remote-Friendly (Travel-Required) | San Francisco, CA | New York City, NY",
     False, "unknown",
     "an employer's exact string on a live Greenhouse req. It PASSED as remote-US because "
     "'New York' is in the US-word list and nothing parsed the policy, yet one report "
     "read this same hub pair as hub-onsite and a decisive relocation blocker. It cannot "
     "be a pass. It cannot be a silent fail either: another report quotes a posting under the "
     "same label saying 'Location is flexible', and a hub list cannot tell the two apart",
     "remote-friendly"),
    ("Remote-Friendly (Travel-Required) | San Francisco, CA | Seattle, WA | New York City, NY",
     False, "unknown",
     "the same policy with a third hub appended. Adding a hub must not move the verdict; "
     "the verdict moving with the trailing city is the whole bug",
     "remote-friendly"),
    ("Remote-Friendly, United States; San Francisco, CA", False, "unknown",
     "One employer's board index writes the same policy with semicolons and a country. "
     "Same answer, whichever separator the board chose",
     "remote-friendly"),
    ("Remote-Friendly (Travel-Required) | Seattle, WA | New York City, NY", False, "unknown",
     "the same policy with no California hub at all, which also passed as remote-US. The "
     "reason pin matters here: this case was green before the rule existed, because "
     "'New York' carried it to a pass for reasons that had nothing to do with the policy",
     "remote-friendly"),
    ("Remote-Friendly (Travel-Required) | Seattle, WA", False, "unknown",
     "the SAME policy returned 'unknown' here for no better reason than that no token in "
     "'Seattle, WA' is in the US-word list. Same verdict now, but reached by parsing the "
     "policy rather than by failing to recognise a city, which is what the reason pins",
     "remote-friendly"),
    ("Remote-Friendly (Travel-Required) | London, UK", False, "unknown",
     "a foreign hub with a bare policy token. This one deliberately does NOT reach the "
     "remote-friendly rule: the non-US branch owns it first and defers for its own "
     "reason. Pinned so that moving the rule earlier shows up as a failure rather than as "
     "a silent change of owner",
     "remote-friendly"),
    ("Remote-Friendly, Ontario, CAN", False, "fail",
     "and this is why the rule must sit AFTER the non-US test. The remote option names "
     "its own country, so it is a settled foreign role, not an open question. Placing the "
     "policy rule first would soften this to unknown",
     "non-US country"),
    ("Remote-Friendly, United States", False, "unknown",
     "the policy with no hub named at all. Before, the bare country carried it through to "
     "remote-US. Unknown must never be used here to mean probably fine",
     "remote-friendly"),
    ("Remote-Friendly (Travel-Required) | Culver City, California", False, "pass",
     "the one shape that clears: a hub inside the commute ceiling. Hybrid days within the "
     "ceiling are full marks in modes/_profile.md, so this must not be swept up by the "
     "no-SoCal-hub deferral",
     "inside the commute ceiling"),
    ("Remote-Friendly (Travel-Required) | San Francisco, CA | El Segundo, California",
     False, "pass",
     "a reachable hub among distant ones still clears, because the candidate can choose which office "
     "the in-office share is served at",
     "inside the commute ceiling"),
    # Location spellings the shared grammar first read wrongly. Each is now a rule in
    # presets/locations/_base-us.json or the tokeniser, pinned here and in location-core.mjs.
    ("Torrance 1450 W. Washington Ave (hybrid, 3 days on-site)", False, "pass",
     "an office written as a street address. 'Washington' after a house number and a "
     "direction is the street, not Washington state; read as a state it failed a role "
     "inside the commute", "inside the commute ceiling"),
    ("Los Angeles, London, Sydney", False, "pass",
     "a hub in a comma list of cities. A foreign CITY beside a commute place is another "
     "place in the list, not a qualifier of it, so it must not void the Los Angeles match"),
    ("Seattle, Boston, Los Angeles, Berlin", False, "pass",
     "the same list shape with a trailing foreign city"),
    ("Santa Ana, San Jose, Costa Rica", False, "fail",
     "...while a foreign COUNTRY still qualifies the place: this is Santa Ana in Costa Rica, "
     "not the Orange County city", "non-US"),
    ("Venice, Italy", False, "fail", "the same rule for a commute name with a foreign twin"),
    ("Onsite in Singapore, reporting to Los Angeles", False, "fail",
     "a foreign city counts as another place only in a bare list of place names; in prose "
     "it still voids the commute match"),
    ("Office - Ontario/Canada", False, "fail",
     "'Ontario' alone is the province here; the policy's 'Ontario, CA' entry must not pass "
     "a bare Ontario", "non-US"),
    ("Manitoba; Ontario; Nova Scotia", False, "unknown",
     "a bare 'Ontario' with no state is a question, never a commute pass. The policy writes "
     "it 'Ontario, CA' precisely because the city name alone is ambiguous"),
    ("New York, USA - Remote", False, "fail",
     "a state-scoped remote. The New York fold to the city must not fire before a country, "
     "or the NY scope reads as a city mention and the row softens to unknown"),
    ("New York, U.S.A. (Remote)", False, "fail", "the same scope, another spelling"),
    ("New York City", False, "fail",
     "the bare city, as several boards write it, is the out-of-range metro"),
    ("Chicago, IL | Hybrid", False, "fail",
     "a bare work-arrangement option names no place, so it cannot hold the posting open"),
    ("Hybrid", False, "unknown", "...and on its own it is a placeholder", "placeholder"),
    ("Anywhere", False, "pass", "a bare 'Anywhere' is a remote offer", "nationwide"),
    ("Boston, MA, Chicago, IL, or Remote within Canada or United States", False, "pass",
     "the remote alternative covers the whole US; the onsite cities before it are "
     "alternatives, not a scope", "nationwide"),
    ("Remote within the United States (Texas residents only)", False, "unknown",
     "a restriction after 'within the US' keeps it out of the nationwide shortcut"),
    ("Remote in US, restricted to Texas", False, "unknown",
     "the shortcut fires only when the US ENDS the option; a blacklist of restriction words "
     "after it missed 'restricted' and passed a Texas-only role"),
    ("US Remote, must reside in one of 2 Texas counties", False, "unknown",
     "a street needs a house number AND a direction; a bare number before a state name is "
     "prose, and reading it as a street erased the Texas restriction"),
    ("Remote, Texaſ", False, "unknown",
     "a long s matched the state-name pattern case-insensitively and then missed the "
     "lookup, raising KeyError; the Python patterns now use JavaScript's ASCII semantics"),
]


CA_PRESET = _location.preset("california-socal")

# The same rules under a policy that is NOT California, built the way setup.mjs builds one.
# If any branch above still assumed California, one of these would come back wrong: the
# home state has to come from the policy, and so do the commute area and the metro veto.
TX_POLICY = _location.Policy({
    "home_state": {"code": "TX", "name": "Texas"},
    "commute": {"label": "Austin", "signals": ["Austin", "Round Rock", "Cedar Park"]},
    "same_state_out": {"label": "Houston", "signals": ["Houston", "The Woodlands"]},
    "onsite_outside_commute": "fail"}, "fixture:texas")
OTHER_STATE_CASES = [
    ("USA - Remote, CA", False, "fail", "the code after the word Remote is still a scope"),
    ("Remote, Washington, USA", False, "fail", "a state between Remote and the country is a scope"),
    ("USA - Remote, TX", False, "pass", "...and it is reachable when it names the home state"),
    ("US, TX, Remote", False, "pass", "the home state's scoped remote is reachable"),
    ("US, CA, Remote", False, "fail", "California-scoped remote is out for a Texan", "Texas"),
    ("Texas - Remote | Indiana - Remote", True, "pass", "a home-state entry keeps it reachable"),
    ("Round Rock, TX", False, "pass", "inside the configured commute", "Austin"),
    ("Irvine, California", False, "fail", "a SoCal city is not this candidate's commute"),
    ("Texas - Houston Metro - Remote", True, "fail",
     "a same-state metro qualifier narrows the scope out of reach", "Houston"),
    ("Houston, TX", False, "fail", "same-state metro outside the commute", "Houston"),
]


def other_state_cases():
    bad = 0
    for case in OTHER_STATE_CASES:
        loc, flag, want, why = case[:4]
        want_note = case[4] if len(case) > 4 else None
        got, note = location_verdict(loc, flag, TX_POLICY)
        if got != want or (want_note and want_note.lower() not in note.lower()):
            bad += 1
            print(f"FAIL  [TX] {loc!r}: got {got} ({note}), expected {want}  {why}")
    # No home state at all: a state-scoped remote is a question, not a verdict.
    got, _ = location_verdict("US, GA, Remote", False, _location.preset("remote-us"))
    if got != "unknown":
        bad += 1
        print(f"FAIL  [no home state] 'US, GA, Remote': got {got}, expected unknown")
    # A candidate open to relocating sets onsite_outside_commute to 'unknown': an onsite
    # role elsewhere becomes a question instead of a discard, and that includes a metro in
    # the home state that is simply too far to commute to.
    ask = _location.Policy({"home_state": {"code": "TX", "name": "Texas"},
                            "commute": {"signals": ["Austin"]},
                            "same_state_out": {"label": "Houston", "signals": ["Houston"]},
                            "onsite_outside_commute": "unknown"}, "fixture:ask")
    extra = [("Denver, Colorado", ask, "unknown"), ("Houston, TX", ask, "unknown"),
             ("Austin, Minnesota", TX_POLICY, "fail"), ("Austin, MN", TX_POLICY, "fail"),
             ("Austin, TX", TX_POLICY, "pass"),
             ("Glendale, Arizona", CA_PRESET, "fail"), ("Glendale, California", CA_PRESET, "pass"),
             # A state after the word Remote scopes it, whichever separator is used.
             ("Remote - Texas", CA_PRESET, "fail"), ("Remote (Oregon)", CA_PRESET, "fail"),
             ("Remote (must reside in Ohio)", CA_PRESET, "fail"),
             ("Remote - Texas", TX_POLICY, "pass"),
             ("Remote - Texas", _location.preset("remote-us"), "unknown"),
             # English words are not state codes.
             ("Hybrid in Irvine", CA_PRESET, "pass"), ("Irvine or Remote", CA_PRESET, "pass"),
             # US cities that share a name with a foreign place, and New Mexico.
             ("Dublin, OH", _location.Policy({"home_state": {"code": "OH", "name": "Ohio"},
                                              "commute": {"signals": ["Dublin", "Columbus"]}}, "f"), "pass"),
             ("Albuquerque, New Mexico", _location.Policy({"home_state": {"code": "NM", "name": "New Mexico"},
                                                           "commute": {"signals": ["Albuquerque"]}}, "f"), "pass"),
             ("Toronto, CA", CA_PRESET, "fail"),
             # Out-of-range metros, in and out of the home state.
             ("Walnut Creek, CA", CA_PRESET, "fail"),
             ("California - San Diego Metro - Remote", CA_PRESET, "fail"),
             # DC is not Washington state.
             ("Remote - Washington, DC", _location.Policy({"home_state": {"code": "WA", "name": "Washington"}}, "f"), "fail")]
    for loc, pol, want in extra:
        got, _ = location_verdict(loc, False, pol)
        if got != want:
            bad += 1
            print(f"FAIL  [{pol.name}] {loc!r}: got {got}, want {want}")
    n = len(OTHER_STATE_CASES) + 1 + len(extra)
    print(f"{bad} of {n} other-state cases failed" if bad else f"all {n} other-state cases pass")
    return bad


def selftest():
    """Check the location gate without touching the network.

    LOCATION_CASES run on presets/locations/california-socal.json, never on the user's
    config/location.json, so they test the rules and not whatever is configured.

    A case may carry a FIFTH element: a substring the reason must contain. Verdict-only
    assertions let a case pass on the right answer from the wrong branch, and that is not
    hypothetical. Every Remote-Friendly case below already returned its expected verdict
    before the rule that handles them existed, so deleting the rule left them green while
    the bug was live. Pin the reason wherever the branch is the point of the case.
    """
    bad = 0
    for case in LOCATION_CASES:
        loc, flag, want, why = case[:4]
        want_note = case[4] if len(case) > 4 else None
        got, note = location_verdict(loc, flag, CA_PRESET)
        if got != want or (want_note and want_note.lower() not in note.lower()):
            bad += 1
            print(f"FAIL  {loc[:64]!r}\n      got {got} ({note}), expected {want}"
                  + (f" via a reason containing {want_note!r}" if want_note else "")
                  + f"\n      {why}")
    print(f"{bad} of {len(LOCATION_CASES)} location cases failed" if bad
          else f"all {len(LOCATION_CASES)} location cases pass")
    # The cases below patch OUT_DIR to a temp dir and run readers that rewrite and DELETE
    # packets. If a patch ever stops reaching a reader, they run against the real queue,
    # which happened on 2026-10-08. So fingerprint the real queue's bytes around them.
    # A concurrent writer (an eval-assist run, another prep) also changes the queue and
    # will trip this; that is a FAIL worth reading, not a reason to look away.
    def _real_queue():
        out = {}
        for f in glob.glob(os.path.join(OUT_DIR, "*.json")):
            try:
                out[f] = hashlib.sha1(open(f, "rb").read()).hexdigest()
            except OSError:
                out[f] = "unreadable"   # vanished or locked mid-run: recorded, not a crash
        return out
    before = _real_queue()
    bad += other_state_cases()
    groups = (("comp", comp_cases), ("naming", naming_cases), ("reresolve", reresolve_cases),
              ("queue", queue_cases))
    bad += sum(fn() for _, fn in groups)
    if _real_queue() != before:
        bad += 1
        print("FAIL  the selftest modified the REAL eval queue; a patch of OUT_DIR is not "
              "reaching some reader")
    # A closing line, because test-all.mjs labels this run with whatever the LAST line of
    # output was. With three groups the label read "all naming cases pass", which says
    # nothing about the two groups that matter most. Built from the group list, so a group
    # added later cannot go unnamed, as the queue group briefly did.
    print(f"eval-prep selftest: {bad} failure(s) across "
          + ", ".join(["location"] + [name for name, _ in groups]) + " cases")
    return bad


@contextlib.contextmanager
def _patched(d, root=True):
    """Point OUT_DIR (and ROOT, unless root=False) at a selftest dir, output silenced.

    The cases below run readers that rewrite and DELETE packets; this is the one place
    that redirects them, so a case cannot reach the real queue by forgetting a patch.
    """
    from unittest import mock
    me = sys.modules[__name__]
    with mock.patch.object(me, "OUT_DIR", d), mock.patch.object(me, "ROOT", d if root else me.ROOT), \
            contextlib.redirect_stdout(io.StringIO()):
        yield d


def reresolve_cases():
    """What --reresolve writes back, and what it is allowed to delete.

    Two defects, both found by cross-review on 2026-09-20, both the same shape: a refetch
    that updated everything about a packet EXCEPT the field the rest of the toolchain
    reads to decide whether the packet is still worth working on.

    The delete is the reason these are pinned rather than just fixed. Everything else here
    rewrites a file; this branch removes one, and it used to fire on a falsy resolver
    result as readily as on a real closure.
    """
    from unittest import mock
    bad = 0

    def check(ok, msg):
        nonlocal bad
        if not ok:
            bad += 1
            print(f"FAIL  {msg}")

    def run(result, **over):
        """One packet, one mocked resolver answer. Returns the packet, or None if deleted."""
        packet = {**dict(url="https://careers.example.com/job/1194374/x", title="A Role",
                         company="Example", live=True, location_verdict="unknown",
                         match_w_cv=None, jd_full="plain text, no markup"), **over}
        with tempfile.TemporaryDirectory(prefix="evalprep-queue-") as d, _patched(d), \
                mock.patch.object(rr, "resolve", lambda *a, **k: result):
            f = os.path.join(d, "x.json")
            with open(f, "w", encoding="utf-8") as fh:
                json.dump(packet, fh, indent=1)
            reresolve()
            if not os.path.exists(f):
                return None
            with open(f, encoding="utf-8") as fh:
                return json.load(fh)

    # A packet stamped live=True the day it was built kept saying so through every later
    # refetch, because this loop wrote jd, location, comp and company and never `live`.
    # eval-blockers reads that field to decide what is READY, so the staleness surfaced
    # as a retired requisition heading the ready list.
    p = run({"live": None, "location": "United States - Remote"})
    check(p is not None and p.get("live") is None,
          f"an unknown refetch must overwrite a stale live=True: {p and p.get('live')}")
    p = run({"live": True, "location": "United States - Remote"}, live=None)
    check(p is not None and p.get("live") is True,
          f"a live refetch must overwrite a stale live=None: {p and p.get('live')}")
    # "The resolver returned nothing" shared a branch with "the posting is gone", and
    # that branch DELETES the packet. Silence is not evidence, and a delete cannot be
    # undone from the disposition it leaves behind.
    check(run({}) is not None, "an empty resolver result must not delete the packet")
    check(run(None) is not None, "a null resolver result must not delete the packet")
    # ...and a real closure must still remove it, or the fix would have bought safety by
    # making --reresolve unable to settle anything.
    check(run({"live": False}) is None, "a resolved closure must still remove the packet")
    print(f"{bad} of 5 reresolve cases failed" if bad else "all 5 reresolve cases pass")
    return bad


def queue_cases():
    """Every queue reader must survive the non-packet files a real queue holds.

    `--relocate` died on 2026-10-08 on `_nvidia-0827-scores.json`, a score dump that is a
    LIST, because it globbed `*.json` itself and called .get() on whatever it opened. The
    queue here is built with exactly those strays, and each reader is RUN over it, since an
    enumerator that filters correctly proves nothing about a reader that bypasses it.
    """
    with tempfile.TemporaryDirectory(prefix="evalprep-strays-") as d:
        return _queue_cases_in(d)


def _queue_cases_in(d):
    good = dict(url="https://careers.example.com/job/1234567/x", title="A Role",
                company="Example", location="UK, Remote", location_verdict="unknown",
                match_w_cv=None, comp={}, jd_full="plain")
    json.dump(good, open(os.path.join(d, "a-packet.json"), "w", encoding="utf-8"))
    json.dump([{"num": 1, "score": 4.1}], open(os.path.join(d, "_scores.json"), "w"))
    json.dump({"tenant": "x", "rows": []}, open(os.path.join(d, "sweep.json"), "w"))
    open(os.path.join(d, "torn.json"), "w").write("{not json")
    bad = 0
    got = [os.path.basename(f) for f, _ in queue_packets(d)]
    if got != ["a-packet.json"]:
        bad += 1
        print(f"FAIL  queue_packets yielded {got}, expected only the packet")
    for fn in (list_queue, relocate, recomp):
        try:
            # ROOT is redirected only for relocate, which writes dispositions.json there;
            # recomp reads the candidate's comp targets from ROOT/config and needs the real one.
            with _patched(d, root=fn is relocate):
                fn()
        except Exception as e:  # noqa: BLE001, the crash IS the failure being tested
            bad += 1
            print(f"FAIL  {fn.__name__}() crashed on a queue holding non-packets: {e!r}")
    # relocate() ran the fixed gate over the packet, and "UK, Remote" now fails, so the
    # packet must be gone and its disposition written. This also proves relocate reached
    # the packet rather than passing by skipping everything.
    if os.path.exists(os.path.join(d, "a-packet.json")):
        bad += 1
        print("FAIL  relocate() did not re-gate the one real packet in a queue of strays")
    print(f"{bad} queue case(s) failed" if bad else "all queue cases pass")
    return bad


def _tmp_profile(body):
    """Write a throwaway profile.yml and return its path. Each call gets a fresh path so
    comp_targets' per-path cache cannot carry one case's answer into the next."""
    d = tempfile.mkdtemp(prefix="evalprep-profile-")
    atexit.register(shutil.rmtree, d, True)
    p = os.path.join(d, "profile.yml").replace("\\", "/")
    open(p, "w", encoding="utf-8").write(body)
    return p


def comp_cases():
    """The comp floor's source, and what a posted band is allowed to settle."""
    bad = 0

    def check(ok, msg):
        nonlocal bad
        if not ok:
            bad += 1
            print(f"FAIL  {msg}")

    # ── The floor and target come from config/profile.yml, not from this file ──
    # They used to be literals in a System Layer script beside the
    # User Layer file that owns them. Asserting the REAL numbers alone would pass with a
    # hardcoded default reinstated, so the load is proved against a file that says
    # something else: if these values do not move, the values are not being read.
    p = _tmp_profile('compensation:\n  target_range: "USD 205K-315K"\n'
                     '  currency: "USD"\n  minimum: "USD 175K"\n'
                     'location:\n  country: "United States"\n')
    check(comp_targets(p) == (175_000, 315_000),
          f"the floor and target must come from the file, got {comp_targets(p)}")
    # The ai-ml alternate range is nested deeper on purpose and must stay out of reach.
    # Reading it here would re-split a floor that was deliberately normalised across both
    # tracks on 2026-07-27, and would do it in whichever direction the file happened to
    # be ordered. So the nested block is written FIRST here: a rule that relies on the
    # top-level keys simply appearing earlier in the file passes by luck, and the first
    # version of this case did exactly that, staying green while the indent anchor was
    # loosened to \s+. A case that cannot fail is not a case.
    p = _tmp_profile('compensation:\n'
                     '  alternate_ranges:\n    - track: "ai-ml"\n'
                     '      target_range: "USD 320K-420K"\n      minimum: "USD 260K"\n'
                     '  target_range: "USD 200K-250K"\n  minimum: "USD 200K"\n')
    check(comp_targets(p) == (200_000, 250_000),
          f"alternate_ranges must not override the top-level pair, got {comp_targets(p)}")
    # And with no top-level pair at all it must RAISE rather than quietly fall through to
    # the other track's numbers, which would gate every req against that track's floor.
    p = _tmp_profile('compensation:\n  currency: "USD"\n'
                     '  alternate_ranges:\n    - track: "ai-ml"\n'
                     '      target_range: "USD 320K-420K"\n      minimum: "USD 260K"\n')
    try:
        got = comp_targets(p)
        check(False, f"a block with only alternate_ranges must raise, not return {got}")
    except RuntimeError:
        pass
    check(comp_targets(_tmp_profile('compensation:\n  target_range: "$205,000 - $315,000"\n'
                                    '  minimum: "$175,000"\n')) == (175_000, 315_000),
          "full-dollar spellings must parse as well as K-notation")
    # A comment on the line carries digits of its own (a real profile's minimum line can
    # end in a note with figures of its own). Reading past the # would pick one up.
    check(comp_targets(_tmp_profile(
        'compensation:\n  target_range: "USD 200K-250K"   # was 150K-230K last year\n'
        '  minimum: "USD 200K"   # was 150K for one track, 260K for another\n')) == (200_000, 250_000),
        "a trailing comment's figures must not be read as the band")

    # Unreadable means RAISE, never default. A silent fallback is the drift this removes,
    # and it would fail in the disposing direction with nothing downstream able to tell.
    for label, path in (("a missing file", "/no/such/profile-file.yml"),
                        ("no compensation block",
                         _tmp_profile("location:\n  country: US\n")),
                        ("no minimum key",
                         _tmp_profile('compensation:\n  target_range: "USD 200K-250K"\n')),
                        ("a minimum with no figure",
                         _tmp_profile('compensation:\n  target_range: "USD 200K-250K"\n'
                                      '  minimum: "negotiable"\n')),
                        ("an implausible floor",
                         _tmp_profile('compensation:\n  target_range: "USD 200K-250K"\n'
                                      '  minimum: "USD 19K"\n'))):
        try:
            got = comp_targets(path)
            check(False, f"{label} must raise, not return {got}")
        except RuntimeError:
            pass
        except Exception as e:
            check(False, f"{label} must raise RuntimeError, raised {type(e).__name__}: {e}")
    # And the real file must actually parse, or every comp verdict in the pipeline stops.
    # Only when there IS one: a fresh clone has no profile yet, and that is a setup step
    # (doctor.mjs reports it), not a defect in this script. Said out loud rather than
    # skipped silently, because "not checked" and "fine" are different answers.
    # The INSTALLED profile is not checked here: a selftest tests the rules, and whether
    # one user's file parses is `node doctor.mjs`'s question. It used to be checked here,
    # which made this suite pass or fail by whose profile was installed.

    # ── A base band may not dispose of a req against a TOTAL-comp floor ──────
    # req-resolve extracts whatever range a posting prints and never says what it
    # measures. The gate then compared a base range to a total floor and the caller
    # DISPOSED of the req for good, so a $170K base plus bonus and equity was thrown away
    # as sub-floor. score-model.mjs already refuses to gate on anything but `total`.
    # Every verdict below runs against a PINNED fixture pair, not the installed profile:
    # the suite must mean the same thing on every machine. SUB sits under the fixture
    # floor and OVER clears it; both are fixture values.
    FIX = (200_000, 250_000)

    def cv(pays, jd=""):
        return comp_verdict(pays, jd, targets=FIX)

    SUB = "$150,000 - $170,000"
    OVER = "$220,000 - $260,000"
    for label, pays, jd, want_basis, want_gate, want_clears in [
        ("stated BASE, under the floor",
         [SUB], f"The base salary range for this role is {SUB}. Equity and bonus are "
                "awarded separately.", "base", False, False),
        ("stated TOTAL, under the floor",
         [SUB], f"Total compensation for this role is {SUB}, inclusive of equity.",
         "total", True, False),
        ("basis unstated, under the floor",
         [SUB], f"The range for this role is {SUB}.", "unknown", False, False),
        ("both words present, total wins",
         [SUB], f"Base is lower; total compensation for this role is {SUB}.",
         "total", True, False),
        ("stated BASE, over the floor",
         [OVER], f"The base salary range for this role is {OVER}.", "base", False, True),
        ("stated TOTAL, over the floor",
         [OVER], f"Total compensation for this role is {OVER}.", "total", False, True),
        ("a figure the body never mentions",
         [SUB], "This posting's body says nothing about pay.", "unknown", False, False),
    ]:
        c = cv(pays, jd)
        check(c["basis"] == want_basis,
              f"{label}: basis read as {c['basis']}, want {want_basis}")
        check(c["floor_gate"] is want_gate,
              f"{label}: floor_gate is {c['floor_gate']}, want {want_gate}")
        check(c["clears_floor"] is want_clears,
              f"{label}: clears_floor is {c['clears_floor']}, want {want_clears}")
    # clears_floor and floor_gate are DIFFERENT questions and the whole fix is that they
    # stopped being one. Pinned directly, because a mutation that re-aliases them would
    # otherwise only show up through the cases above.
    c = cv([SUB], f"The base salary range is {SUB}.")
    check(c["clears_floor"] is False and c["floor_gate"] is False,
          "a sub-floor BASE band must fail clears_floor and still not be a disposal")
    # No band at all settles nothing, and must not read as a gate.
    c = cv([], "No pay information anywhere in this posting.")
    check(c["floor_gate"] is None and c["clears_floor"] is None and c["basis"] is None,
          f"no band must leave every comp key unknown, got {c['floor_gate']}/{c['basis']}")
    # An hourly rate is the whole cash offer, so it CAN settle the floor by itself. This
    # is the one inferred basis, and it keeps a $39-$73/hr union rate settling itself.
    c = cv([], "Pay range for this role is $39.54 - $73.16 an hour.")
    check(c["basis"] == "total" and c["floor_gate"] is True,
          f"an hourly rate must still settle itself: {c['basis']} / {c['floor_gate']}")

    # ── hard_gate: only these three may throw a req away permanently ────────
    base_p = dict(live=True, location_verdict="pass", location_why="remote-US",
                  title="X", comp=cv([OVER], f"Total compensation is {OVER}."))
    check(hard_gate(base_p) is None, "a clean req must not be disposed of")
    check(hard_gate({**base_p, "live": False}) == "closed", "a closed req is disposed of")
    check(hard_gate({**base_p, "location_verdict": "fail", "location_why": "Bay Area"})
          == "Bay Area", "a failed location is disposed of")
    check(hard_gate({**base_p, "location_verdict": "unknown"}) is None,
          "an UNKNOWN location must never be disposed of; it needs a human read")
    sub_base = cv([SUB], f"The base salary range is {SUB}.")
    check(hard_gate({**base_p, "comp": sub_base}) is None,
          "a sub-floor BASE band must reach the queue, not dispositions.json")
    sub_total = cv([SUB], f"Total compensation is {SUB}.")
    check("below floor" in (hard_gate({**base_p, "comp": sub_total}) or ""),
          "a sub-floor TOTAL band is real evidence and still disposes")

    # ── no floor configured: a valid choice, never a crash and never a gate ────
    # setup.mjs lets a user leave the floor out. eval-prep then crashed on every posting
    # that printed pay, because comp_targets() raises for a missing block by design.
    check(configured_comp_targets(_tmp_profile("candidate:\n  full_name: X\n")) is None,
          "a profile with no compensation block means no floor, not an error")
    check(configured_comp_targets(_tmp_profile("compensation:\n  currency: USD\n")) is None,
          "a compensation block with no minimum means no floor, not an error")
    check(comp_targets(_tmp_profile('compensation:\n  minimum: "USD 150K"\n')) == (150000, 150000),
          "a floor with no target_range is a floor and its own target, as setup and score-model read it")
    for blank in ('target_range:\n  minimum: "USD 150K"\n', 'minimum: "USD 150K"\n  target_range: null\n',
                  'minimum: "USD 150K"\n  target_range: ""\n', 'minimum: "USD 150K"\n  target_range:\n  currency: USD\n',
                  'minimum: "USD 150K"\n  target_range: ~\n', "minimum: \"USD 150K\"\n  target_range: ''\n",
                  'minimum: "USD 150K"\n  target_range:   # none yet\n'):
        check(comp_targets(_tmp_profile("compensation:\n  " + blank)) == (150000, 150000),
              f"a blank or null target_range is no target, never the next line: {blank!r}")
    # setup's prompt says "blank for no comp gate", and score-model.mjs reads null, ~ and
    # "" the same way js-yaml does: no floor. A `minimum:` this blank used to reach
    # comp_targets() and raise there instead of reading as the absence configured_comp_targets
    # already handles for a missing key.
    for blank in ("minimum:\n", "minimum: null\n", "minimum: NULL\n", "minimum: ~\n",
                  'minimum: ""\n', "minimum: ''\n"):
        check(configured_comp_targets(_tmp_profile("compensation:\n  " + blank)) is None,
              f"a blank, null or ~ minimum means no floor, not a raise: {blank!r}")
    try:
        configured_comp_targets(_tmp_profile('compensation:\n  minimum: "lots"\n'
                                             '  target_range: "more"\n'))
        check(False, "a floor that is present but unreadable must still raise")
    except RuntimeError:
        pass
    nf = comp_verdict([SUB], f"Total compensation is {SUB}.", targets=NO_FLOOR)
    check(nf["floor_gate"] is None and nf["clears_floor"] is None
          and hard_gate({**base_p, "comp": nf}) is None,
          f"with no floor a sub-anything TOTAL band must gate nothing: {nf}")
    print(f"{bad} comp case(s) failed" if bad else "all comp cases pass")
    return bad


def naming_cases():
    """Packet filenames must not be able to name another req's file."""
    bad = 0

    def check(ok, msg):
        nonlocal bad
        if not ok:
            bad += 1
            print(f"FAIL  {msg}")

    def name(url, title="Senior AI Engineer"):
        return packet_name({"url": url, "slug": slug_of(title)})

    # The exact shape CLAUDE.md warns about: two NVIDIA reqs one word apart in the title,
    # opposite location verdicts. Slugged from the title alone they were ONE file and the
    # second json.dump silently destroyed the first.
    NV = "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Remote/"
    a = name(NV + "Agent-Architecture-and-Evaluation_JR2620896", "Agent Evaluation")
    b = name(NV + "Agent-Simulation-and-Evaluation_JR2301525", "Agent Evaluation")
    check(a != b, f"two reqs sharing a title slug must not share a filename: {a}")
    check("jr2620896" in a and "jr2301525" in b,
          f"the requisition id must reach the filename: {a} / {b}")
    # The EMPLOYER on a Workday packet. The resolver's result carries no url and a Workday
    # tenant is named only in the hostname, so prep() wrote company None for every NVIDIA,
    # Salesforce and Disney req and eval-write refused them all. Asserted through prep()
    # itself with the resolver's real shape, since company_from() alone was never wrong.
    from unittest import mock
    _wd = {"ats": "workday", "live": True, "title": "Senior AI Engineer",
           "location": "US, CA, Remote", "pay": [], "jd": "x"}
    # comp is not what this case tests, and computing it reads the configured floor.
    with mock.patch.object(rr, "resolve", lambda *a, **k: dict(_wd)), \
            mock.patch.object(sys.modules[__name__], "comp_verdict", lambda *a, **k: {}):
        got = prep(NV + "Example-Role-01_JR2099999").get("company")
    check(got == "NVIDIA", f"a Workday packet must name its employer from the tenant: {got!r}")
    # ...and from portals.yml, by tenant AND site, never the hostname: xboxgaming is two
    # employers, and an unrecorded tenant gets NO name rather than a capitalised host,
    # since merge-tracker treats a misspelt employer as a new company.
    # Run against a FAKE portals index and an empty tracker, so the cases hold in any
    # checkout and cannot drift with the user's own portals.yml.
    XB = "https://xboxgaming.wd1.myworkdayjobs.com/"
    fake_portals = [dict(label=b + " (notes)", base=b, boards=set(), workday=(t, "wd1", s))
                    for b, t, s in (("Blizzard Entertainment", "xboxgaming", "Blizzard_External_Careers"),
                                    ("Activision", "xboxgaming", "External"),
                                    ("Snap", "snapchat", "snap"))]
    with tempfile.TemporaryDirectory(prefix="evalprep-wdname-") as _empty, \
            mock.patch.object(rr, "portals_index", lambda: fake_portals), \
            mock.patch.object(sys.modules[__name__], "ROOT", _empty):
        for url, want in ((XB + "Blizzard_External_Careers/job/Irvine/X_R1000301", "Blizzard Entertainment"),
                          (XB + "en-US/External/job/Santa-Monica/X_R1000302", "Activision"),
                          ("https://snapchat.wd1.myworkdayjobs.com/snap/job/LA/X_R1000303", "Snap"),
                          ("https://unrecorded.wd5.myworkdayjobs.com/Ext/job/X/Y_R1000001", None)):
            got = company_from({"url": url})
            check(got == want, f"Workday employer for {url[8:60]}: {got!r}, want {want!r}")
    # The tracker's spelling wins only on a whole key or at a WORD boundary. Asserted
    # against a fake tracker so the cases cannot drift with the real one.
    with tempfile.TemporaryDirectory(prefix="evalprep-spell-") as _d:
        os.makedirs(os.path.join(_d, "data"))
        with open(os.path.join(_d, "data", "applications.md"), "w", encoding="utf-8") as fh:
            for i, co in enumerate(("Meta", "Disney", "Anduril Industries"), 1):
                fh.write(f"| {i} | 2026-10-13 | {co} | Role | 3.0/5 | Evaluated | x | [r](r) | n |\n")
        with mock.patch.object(sys.modules[__name__], "ROOT", _d):
            for spelt, want in (("Metaphysic", "Metaphysic"), ("Disney Studios", "Disney"),
                                ("Andurilindustries", "Anduril Industries")):
                got = tracker_spelling(spelt)
                check(got == want, f"tracker spelling of {spelt!r}: {got!r}, want {want!r}")
    # Two EMPLOYERS posting the same title, which is the other half of the collision.
    x = name("https://job-boards.greenhouse.io/cresta/jobs/5055750430")
    y = name("https://job-boards.greenhouse.io/anthropic/jobs/4820222953")
    check(x != y, f"two employers with one title must not share a filename: {x}")
    check(x.startswith("cresta") and y.startswith("anthropic"),
          f"the employer must be readable in the name: {x} / {y}")
    # A host this parser knows no id shape for must STILL separate two reqs. The digest
    # is unreadable, and an unreadable name costs a glance where a collision costs a req.
    u1 = name("https://careers.example-studio.com/openings/alpha")
    u2 = name("https://careers.example-studio.com/openings/beta")
    check(u1 != u2, f"an unrecognised URL shape must still not collide: {u1}")
    # Re-prepping one req must overwrite its own packet rather than accumulate new ones.
    for u in (NV + "Agent-Architecture-and-Evaluation_JR2620896",
              "https://job-boards.greenhouse.io/cresta/jobs/5055750430",
              "https://careers.example-studio.com/openings/alpha"):
        check(name(u) == name(u), f"the name must be stable for one URL: {u}")
    # Readable, and safe on this filesystem. A slug carrying a slash or a colon would
    # raise on Windows at the json.dump, after the network work was already spent.
    check(re.fullmatch(r"[a-z0-9.-]+\.json", a) is not None,
          f"a packet name must be filesystem-safe and lowercase: {a}")
    check("agent-evaluation" in a, f"the title must survive into the name: {a}")
    # Every ATS this pipeline resolves should yield its own id rather than a digest, or
    # the queue fills with names nobody can read.
    for url, want in (("https://jobs.ashbyhq.com/whatnot/e8760e88-1ecc-0bb9-564e-a726f5e7f568",
                       "e8760e88"),
                      ("https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472",
                       "3f63e800"),
                      ("https://www.sentinelone.com/jobs/?gh_jid=7260141299", "7260141299"),
                      ("https://jobs.smartrecruiters.com/Experian/postings/757675447924470",
                       "757675447924470"),
                      ("https://apply.workable.com/panorama-education/j/9200125A8B/",
                       "9200125a8b"),
                      ("https://rootstock-software.breezy.hr/p/fe71c039c890-agent-eng",
                       "fe71c039c890"),
                      ("https://explore.jobs.netflix.net/careers/job/712200781859", "712200781859"),
                      ("https://crowdstrike.wd5.myworkdayjobs.com/x/job/USA/Lead_R26710",
                       "r26710")):
        got = packet_id(url)
        check(got == want, f"packet id for {url[:56]}: got {got!r}, want {want!r}")
    print(f"{bad} naming case(s) failed" if bad else "all naming cases pass")
    return bad


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(1 if selftest() else 0)
    if "--list" in sys.argv:
        list_queue(); sys.exit(0)
    if "--relocate" in sys.argv:
        relocate(); sys.exit(0)
    if "--recomp" in sys.argv:
        recomp(); sys.exit(0)
    if "--reresolve" in sys.argv:
        reresolve(); sys.exit(0)
    urls = [a for a in sys.argv[1:] if a.startswith("http")]
    if "--from-triage" in sys.argv:
        f = sys.argv[sys.argv.index("--from-triage") + 1]
        lo = int(sys.argv[sys.argv.index("--min") + 1]) if "--min" in sys.argv else 0
        urls += [x["url"] for x in json.load(open(f, encoding="utf-8"))
                 if x.get("score", 0) >= lo]
    # A URL list written in Windows text mode and expanded with $(cat ...) carries a
    # trailing \r on every argument, because shell word splitting does not treat \r as
    # whitespace. It then rode into the packet and the report's **URL:** line, where it
    # broke requisition-identity matching, more than once.
    urls = [u.strip() for u in urls]
    if not urls:
        print(__doc__); sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    disp = []
    for u in urls:
        p = prep(u)
        # Hard gates decide on their own and need no judgement, so they are recorded
        # as dispositions rather than turned into packets. Without this they come back
        # in every future triage and get re-resolved and re-rejected forever.
        # Comp is a hard gate ONLY when a band is actually posted; an unposted band is
        # unknown, not low, and unknown still needs a human read.
        gated = hard_gate(p)
        if gated:
            print(f"SKIP ({gated})  {(p['title'] or u)[:56]}")
            disp.append({"url": u, "disposition": gated}); continue
        name = packet_name(p)
        write_packet(os.path.join(OUT_DIR, name), p)
        c = p["comp"]
        money = c["posted"] or "no band"
        gates = ("clears target" if c["clears_target"] else
                 "clears floor" if c["clears_floor"] else
                 # It survived the gate above, so a below-floor band here is base-only or
                 # of unknown basis. Say so, or the line reads like a gate that leaked.
                 f"SUB-FLOOR on {c['basis']} comp, needs a read"
                 if c["clears_floor"] is False else "unknown")
        dup = f"  [{len(p['possible_tracker_duplicates'])} possible dup]" if p["possible_tracker_duplicates"] else ""
        print(f"PREP  {p['title'][:50]:50s} {p['location_verdict']:7s} {money:24s} {gates}{dup}")
        print(f"      -> batch/eval-queue/{name}")

    if disp:
        record_dispositions(disp)
        print(f"\n{len(disp)} req(s) settled by a hard gate -> dispositions.json")
        print("   retire them with: node pipeline-audit.mjs --prune --dispositions=dispositions.json")
