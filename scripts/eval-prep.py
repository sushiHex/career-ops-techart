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
  python scripts/eval-prep.py --from-linkedin batch/linkedin-sweep/<date>-details.json
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
# Read through rr.mask_foreign(), so a C$ or CA$ figure is never taken as US dollars.
# Amazon writes the currency once, after the range ("154,200.00 - 208,600.00 USD"): the
# third form reads the low end by looking ahead to that USD, and cents are allowed before
# USD, or the band req-resolve now extracts became no figures at all (Codex, 2026-10-29).
MONEY = re.compile(r"\$\s?([\d,]{5,})(?:\.\d\d)?|([\d,]{6,})(?:\.\d\d)?\s*USD"
                   r"|([\d,]{6,})(?:\.\d\d)?(?=\s*(?:-|to|–|\u2014)\s*[\d,]{6,}(?:\.\d\d)?\s*USD)")
# Words that contradict reading a silent hourly rate as the whole package: a bonus, equity,
# or the rate called BASE. Only consulted for an hourly figure; see comp_verdict().
EXTRA_COMP = re.compile(r"\b(bonus(es)?|equity|stock|RSUs?|commission|base (pay|salary|rate|compensation))\b", re.I)
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


HOURLY = re.compile(r"\$\s?(\d{1,3}(?:\.\d{1,2})?)\s*(?:-|to|–)?\s*\$?\s?(\d{1,3}(?:\.\d{1,2})?)?"
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
    # Both sides are read with every dash written one way. A range is spelled with a
    # hyphen, an en dash or an em dash, with or without spaces, and `pay` is not always
    # spelled like the text beside it: an Ashby summary "$100K \u2013 $150K total
    # compensation" reached `pay` as "$100,000 - $150,000", the verbatim find missed, and a
    # sub-floor stated total escaped the gate (Codex, PR 14).
    dash = lambda t: re.sub(r"\s*[-\u2010-\u2015\u2212]\s*", " - ", t or "")
    jd = dash(jd)
    for p in pays or []:
        p = dash(p)
        i = jd.find(p)
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
    # explore.jobs.netflix.net hints "netflix", and the tracker's own "Netflix" is read as a
    # possible seed of the capitalised guess, so every Netflix packet came out unnamed.
    "netflix": "Netflix",
}


def org_from_url(u):
    """The employer's board slug as it appears in an ATS URL."""
    for pat in (r"jobs\.ashbyhq\.com/([\w.-]+)/", r"jobs\.lever\.co/([\w-]+)/",
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


def company_hint(r):
    """The raw board slug, Workday tenant or host label an employer could be GUESSED from.

    Kept beside `company` in the packet so that a null company does not lose the clue: it is
    what a person filling the packet reads, and it is never itself a name.
    """
    m = _WD_URL.search(r.get("url") or "")
    if m and not r.get("org"):
        return m.group(1).lower()
    org = (r.get("org") or r.get("discovered_board") or "").strip().lower()
    return org or org_from_url(r.get("url") or "").lower() or None


def company_from(r):
    """The employer's name, or None when nothing but a slug or a hostname says it.

    Sources, strongest first: portals.yml for the board, the hand table, the name the ATS
    record states about itself (req-resolve's `company`), then the tracker's own spelling.

    A title-cased slug is NOT a source. It used to be the last resort, and it is how
    packets came out naming "Weedmaps77", "Sonypicturesjobs" and "Certumlegalsolutions"
    (issue #12): eval-write's required-field check then saw a non-empty company and wrote
    the slug into the report and the tracker as if someone had confirmed it. A null
    company is the honest answer, because eval-write refuses a packet whose company is
    unfilled and so forces the one human read that settles it; the slug survives in
    `company_hint`. The tracker may still vouch for a slug, but only with a spelling that
    is not the mechanical capitalisation itself: "Anduril Industries" for
    `andurilindustries` is a person's spelling, while a tracker row reading "Heygen" is
    most likely an earlier seed of this very guess and confirms nothing.
    """
    m = _WD_URL.search(r.get("url") or "")
    if m and not r.get("org"):
        # An unrecorded Workday tenant gets NO name rather than a capitalised hostname:
        # eval-write refuses an unnamed packet, and a person naming it beats a confident
        # wrong employer that merge-tracker would treat as a new company.
        tenant = m.group(1).lower()
        return portal_employer(workday=(tenant, m.group(2).lower())) or ORG_NAMES.get(tenant)
    if r.get("front_end") and r.get("org"):
        # A company-hosted Workday front end (careers.blizzard.com, careers.adobe.com):
        # req-resolve set `org` to the portals.yml LABEL it matched the host on, which is
        # not a board slug, so the slug lookup below cannot find it and the capitalised
        # guess either came back null or named "Adobe (Firefly)" (Codex, PR 14). The
        # entry's base is the employer.
        names = {e["base"] for e in rr.portals_index() if e["label"] == r["org"]}
        return tracker_spelling(names.pop()) if len(names) == 1 else None
    org = company_hint(r) or ""
    named = org and (portal_employer(slug=org) or ORG_NAMES.get(org))
    if named:
        return named
    stated = r.get("company").strip() if isinstance(r.get("company"), str) else ""
    if stated:
        # The ATS's own name, in the tracker's spelling only when the tracker spells it as
        # a different WORD form ("Disney Studios" is the tracker's "Disney"). A case-only
        # difference keeps the ATS spelling, which is how "HeyGen" stops being "Heygen".
        known = tracker_spelling(stated)
        return stated if rr.name_key(known) == rr.name_key(stated) else known
    if not org:
        return None
    guess = " ".join(w.capitalize() for w in re.split(r"[-_]+", org) if w)
    known = tracker_spelling(guess)
    return known if known != guess else None


# Passed as `targets` to mean "no floor", which None cannot say: None means "read the
# installed profile", so a selftest asking for the no-floor verdict got whatever floor
# the machine it ran on had configured, and skipped the case whenever one was set.
NO_FLOOR = ()


def comp_verdict(pays, jd="", summary="", targets=None):
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
    # The ATS's own pay summary (Ashby's "$60.58 - $108.17 per hour • Offers Equity",
    # SmartRecruiters' compensation text) is read for the BASIS beside the body. It was
    # returned by the resolver and dropped here, so an hourly band whose body never
    # mentioned equity read as total and armed the floor gate while the ATS said
    # otherwise. Basis only: `pays` already carries its figures.
    # Rewritten the way ashby_summary_pay() rewrote it for `pay` ("US$" to "$", "$100K" to
    # "$100,000"), because comp_basis() looks for the pay string verbatim before reading the
    # words around it: left in K notation, "$100K - $150K total compensation" never matched
    # its own band and a stated-total band under the floor escaped the gate.
    # The BODY is K-expanded too: a stored "$100,000 - $150,000" had to find itself in a body
    # reading "Total compensation: $100K - $150K" to see the word "total", and without the
    # rewrite --recomp read the basis as unknown and lifted a correct floor gate.
    ctx = ". ".join(t for t in (rr.k_band(jd), rr.k_band(rr.us_dollars(summary))) if t)
    vals, hourly = [], False
    for p in pays or []:
        for a, b, c in MONEY.findall(rr.mask_foreign(p)):
            tok = a or b or c
            if tok:
                vals.append(int(tok.replace(",", "")))
    vals = [v for v in vals if 30_000 <= v <= 3_000_000]
    # The posted figures are read for an hourly rate as well as the body: req-resolve
    # writes a structured hourly band (Lever salaryRange, interval per-hour) as
    # "$45.00 - $60.00 per hour", which the annual rule above cannot match. Joined on a
    # full stop so HOURLY's no-full-stop window cannot pair a figure in one with a unit in
    # the next.
    hourly_src = rr.mask_foreign(
        ". ".join([p for p in (pays or []) if isinstance(p, str)] + [jd or ""]))
    if not vals and hourly_src.strip(". "):
        hrs = []
        for m in HOURLY.finditer(hourly_src):
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
        # An hourly contract usually carries no bonus or equity, so a SILENT hourly rate
        # is read as the total: the one place a basis is inferred from the shape of the
        # figure rather than from the words beside it. Only silence licenses that. A
        # posting that says "base", or names a bonus or equity, has contradicted the
        # inference, and reading it as total arms the floor gate and disposes of the req
        # (Codex, 2026-10-15: "$60 - $80 per hour ... Eligible for annual bonus and equity"
        # read as a $156K total once structured hourly bands reached this branch).
        stated, stated_why = comp_basis(pays, ctx)
        if stated != "unknown":
            basis, basis_why = stated, stated_why
        elif EXTRA_COMP.search(ctx):
            basis, basis_why = "unknown", "an hourly rate, but the posting names a bonus or equity beside it"
        else:
            basis, basis_why = "total", "an hourly rate with no bonus or equity named carries none behind it"
    else:
        basis, basis_why = comp_basis(pays, ctx)
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
    # Host AND the first path segment. On a shared board (job-boards.greenhouse.io/reddit,
    # jobs.ashbyhq.com/render, jobs.lever.co/x) the employer is the board SLUG, not the
    # host, so a host-only gate never matched and every Greenhouse, Ashby and Lever packet
    # reported zero duplicates: a tracked Greenhouse req was prepped and scored again
    # with an empty warning.
    parts = re.sub(r"^https?://(www\.)?", "", url or "").split("?")[0].split("/")
    host = rr.name_key(parts[0]) + "/" + (rr.name_key(parts[1]) if len(parts) > 1 else "")
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


# What eval-write refuses a packet without, in its own REQUIRED order; test-all asserts
# the two lists are equal. The instruction used to read "Fill every null below", which
# also ordered num, the resolver's own nulls and comp_total_est filled. comp_total_est is
# the one field that arms the comp gate, so a figure guessed to obey that sentence would
# have lowered the whole score on a total nobody reasoned to (Codex, PR 14).
EVAL_WRITE_REQUIRED = ("company", "status", "match_w_cv", "north_star", "comp_score",
                       "cultural_signals", "body", "gate", "recommendation", "arrangement")
INSTRUCTIONS = (
    "Fill " + ", ".join(EVAL_WRITE_REQUIRED) + "; arrangement is remote, hybrid, onsite "
    "or unknown, and unknown is a verdict. "
    "A gate-closed packet (location_verdict fail) needs only gate and status SKIP, with the "
    "dimensions left null. Leave comp_total_est null unless you reasoned to a USD total: it "
    "is the only field that arms the comp gate. Leave num and every resolver field as they "
    "are. Then: node eval-write.mjs <this file> --date=YYYY-MM-DD"
)


def linkedin_record(e):
    """A resolver-shaped record for a LinkedIn posting with no ATS behind it.

    `e` is one row of the details file `LIS.exportDetails()` writes (see
    scripts/linkedin-sweep-extract.js): the posting as LinkedIn rendered it in the user's own
    browser. An Easy Apply posting has no company board, so the resolver can read nothing
    and eval-prep on its URL wrote an empty packet that a person then filled by retyping the
    body (2026-10-28, twice). This carries the captured page instead.

    Provenance is stated, not upgraded (Codex review, 2026-10-28):
      * `live` is true only when the capture says the page was READ as a posting
        (`read_ok`: a title, a company, a body and an apply control were all found), the
        listing was open, and the capture is from TODAY. An unread page (a sign-in wall
        parses as company "Sign in") or a stale capture is unknown, never live, and a
        closed listing is unknown too: LinkedIn alone never closes a row.
      * `captured_on` travels into the packet and eval-write's provenance line, so the
        report says "LinkedIn page capture on <date>", not "resolver API on report date".
      * The location gate reads LinkedIn's place string with the workplace badge as the
        remote flag, exactly as an ATS isRemote flag is read (it settles an unknown, never
        overturns a fail). The body is not consulted there, as on the ATS path; a badge the
        body contradicts is check-remote.py's question.
      * The card's band is normalised into `pay` ("$200K/yr - $260K/yr" is not a form
        pays() reads as written, so it was silently dropped) and also kept in the body.
    """
    import datetime
    jd = (e.get("jd") or "").strip()
    pay = []
    if e.get("comp"):
        jd = f"{jd}\n\nPay shown on the LinkedIn listing: {e['comp']}".strip()
        if "/hr" not in e["comp"]:
            pay = rr.pays(rr.k_band(e["comp"].replace("/yr", "")))
    today = datetime.date.today().isoformat()
    fresh = e.get("read_on") == today
    live = True if (e.get("read_ok") and e.get("open") is True and fresh) else None
    why = ("" if live else
           " NOT live: " + ("the page was not read as a posting" if not e.get("read_ok") else
                            "the listing was closed" if e.get("open") is not True else
                            f"captured {e.get('read_on')}, not today"))
    return {
        "ats": "linkedin",
        "live": live,
        "captured_on": e.get("read_on"),
        "note": (f"read on LinkedIn in the user's browser {e.get('read_on') or '(date not recorded)'}; "
                 f"{'Easy Apply' if e.get('apply_url') == 'EASY_APPLY' else 'no company apply link'}, "
                 f"so LinkedIn is the only source for this posting.{why}"),
        "title": (e.get("title") or "").strip(),
        "location": (e.get("location") or "").strip() or None,
        "remote_txt": (e.get("workplace") or "").strip().lower() == "remote",
        "jd": jd, "pay": pay,
        "company": (e.get("company") or "").strip() or None,
    }


# Short-link hosts an employer's LinkedIn apply button can point at. The resolver has no
# adapter for a redirect, so a grnh.se link (Podium, 2026-10-29) reached it unread.
SHORTLINK_HOSTS = ("grnh.se", "lnkd.in")
_TRACKING_KEY = re.compile(r"^(utm_|trk|ref$|source$|src$|gh_src$|lever-|iis$|iisn$|codes$|mode$|"
                           r"rb$|cmpid$|ss$|feedId$)", re.I)


# A nested query is cut only where a TRACKING key follows it; a value that is itself a
# URL ("redirect=https://x/job?jobId=123") keeps its own query (Codex, 2026-10-29).
_NESTED_TRACKING = re.compile(r"\?(?:utm_\w+|gh_src|src|source|ref|trk\w*)=", re.I)
# Only these ATSs serve an application FORM at the posting path plus a suffix; on any
# other host the segment may be part of the posting's own slug.
_APPLY_SUFFIX_HOSTS = re.compile(r"(^|\.)(myworkdayjobs\.com|lever\.co|ashbyhq\.com)$", re.I)


def _expand(url):
    """Where a short link lands. HEAD first; a host that refuses HEAD (405) gets one GET."""
    import urllib.request, urllib.error
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.geturl()
        except urllib.error.HTTPError as ex:
            if ex.code not in (405, 501) or method == "GET":
                raise


def clean_apply(url, expand=_expand):
    """An apply link as the resolver should see it: short links expanded, tracking keys
    dropped, and a value cut at a NESTED query. Riot's LinkedIn button carries
    `?gh_jid=7037924%3Fgh_src%3Dnslt3m`, one parameter whose decoded value is
    "7037924?gh_src=nslt3m", so the extractor's key filter never saw gh_src and the id
    reached the resolver with the tail attached (2026-10-29). A failed expansion keeps the
    short link, which the resolver then reports as unreadable rather than as anything."""
    from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
    if urlsplit(url).netloc.lower() in SHORTLINK_HOSTS:
        try:
            url = expand(url)
        except Exception as ex:
            print(f"NOTE could not expand {url}: {ex}")
    s = urlsplit(url)
    q = [(k, v[:m.start()] if (m := _NESTED_TRACKING.search(v)) else v)
         for k, v in parse_qsl(s.query, keep_blank_values=True) if not _TRACKING_KEY.match(k)]
    # The button can link the APPLICATION form rather than the posting: Palo Alto's Workday
    # link ended `..._JR-015305-1/apply` and resolved "not retrievable" (2026-10-29).
    path = s.path
    if _APPLY_SUFFIX_HOSTS.search(s.netloc):
        path = re.sub(r"/(apply|application)/?$", "", path)
    return urlunsplit((s.scheme, s.netloc, path, urlencode(q), ""))


def linkedin_employer(tab_title):
    """The employer a LinkedIn posting names, from its tab title "<title> | <company> |
    LinkedIn" (an optional "(3) " notification badge first), or None."""
    parts = re.sub(r"^\(\d+\+?\)\s*", "", tab_title or "").split(" | ")
    if len(parts) < 3 or parts[-1].strip() != "LinkedIn":
        return None
    # Page names carry decoration ("Orum 🥇"); letters in any script are kept.
    return re.sub(r"[^\w\s&.,'()/+-]", "", parts[-2]).strip() or None


def from_linkedin(path, expand=_expand):
    """(url, record-or-None, employer) triples from a details file: an ATS apply link is
    resolved as usual (record None), and a posting with none is built from the captured
    page. A row the page could not be read for is refused here, by name, rather than
    becoming a packet whose company is "Sign in".

    `employer` is the company the LinkedIn listing names. An iCIMS, Workday, Dayforce or
    company-hosted link carries only a host label ("careers-americas" for Atlassian), so 7
    of 21 packets on 2026-10-29 came out company UNNAMED and needed a hand fill, while the
    tab title that `detail()` stores for every row had the name all along."""
    out = []
    for e in json.load(open(path, encoding="utf-8")):
        apply = (e.get("apply_url") or "").strip()
        if apply.startswith("http") and "linkedin.com" not in apply:
            out.append((clean_apply(apply, expand), None, linkedin_employer(e.get("title"))))
        elif not (e.get("read_ok") and e.get("id")):
            print(f"REFUSED linkedin {e.get('id')}: the page was not read as a posting "
                  f"({e.get('company')!r} / {e.get('title')!r}); open it and run LIS.detail() again")
        else:
            out.append((e.get("url") or f"https://www.linkedin.com/jobs/view/{e['id']}/",
                        linkedin_record(e), e.get("company")))
    return out


def prep(url, r=None):
    r = rr.resolve(url) if r is None else r
    lv, lw = location_verdict(r.get("location"), r.get("remote_txt"))
    title = r.get("title") or ""
    slug = slug_of(title)
    return {
        "_instructions": INSTRUCTIONS,
        "url": url, "ats": r.get("ats"), "live": r.get("live"),
        "resolver_note": r.get("note"),
        **({"captured_on": r["captured_on"]} if r.get("captured_on") else {}),
        "title": title, "location": r.get("location"),
        # The remote flag the verdict was read with. --relocate re-gates from the packet
        # and reads p.get("remote_txt"), which no packet carried, so a bare "United States"
        # that passed on an ATS isRemote flag fell back to unknown on every re-gate.
        "remote_txt": r.get("remote_txt"),
        "location_verdict": lv, "location_why": lw,
        "comp": comp_verdict(r.get("pay"), r.get("jd") or "", r.get("comp_summary") or ""),
        "comp_summary": r.get("comp_summary"),
        # The figures comp was derived from, kept so a later refetch that brings only new
        # basis evidence (a summary) can re-derive the same band; see reresolve().
        "pay": r.get("pay") or [],
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
        # A null company means nothing but a slug or a host named the employer; the slug
        # is kept in company_hint and eval-write refuses the packet until a person fills
        # company (issue #12).
        "company": company_from({**r, "url": url}),
        "company_hint": company_hint({**r, "url": url}),
        "num": None, "slug": slug, "status": None,
        "match_w_cv": None, "north_star": None, "comp_score": None,
        "cultural_signals": None, "red_flags_adj": 0,
        "verification_depth": "full-jd" if r.get("jd") else "listing",
        "body": None, "gate": None, "recommendation": None,
        # Two more judgement fields eval-write reads. They were absent from the packet,
        # so every evaluator had to know to add them; a key that is present and null
        # is the contract. arrangement: remote | hybrid | onsite | unknown, where
        # "unknown" is itself a verdict (the posting does not say). comp_total_est: a
        # USD figure, the only field that can arm the comp gate; null when the
        # evaluator did not reason to a total.
        "arrangement": None, "comp_total_est": None,
    }


# A requisition id as each ATS writes it into its own URL. Ordered, and tried before the
# digest fallback, purely so the filename stays something a human can recognise.
_URL_ID = [
    # Workday; the optional "-1" is the facet suffix Autodesk and NVIDIA append
    # (JR2846252-1), which otherwise pushed the packet to a digest name.
    re.compile(r"_((?:JR|R)-?\d{4,}|\d{2}WD\d{4,})(?:-\d+)?(?:[/?]|$)", re.I),
    re.compile(r"linkedin\.com/jobs/view/(\d{6,})"),                    # LinkedIn Easy Apply
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


def settle_gate(p):
    """Bring an unjudged packet's automatic closure in line with hard_gate(), in place.

    Returns "closed", "reopened" or None. This is the ONE place a closure is written, for
    prep, --relocate and --reresolve alike. It used to be written in two shapes by two
    hands, and each drifted (Codex, PR 14): a packet that first failed during a relocate
    got a disposition but no `auto_gate`, so a later correction could never lift it; and
    one whose gate turned from location to comp kept the location shape, with no
    `in_bounds: false`, so it read as open and could be scored.

    The shape follows the CURRENT gate: SKIP, its reason in `gate`, `auto_gate` (this
    function's, so it may lift it later), and `in_bounds: false` unless the location
    gate is what closes it, since eval-write reads `location_verdict: fail` as closed on
    its own. When nothing closes it any more, an automatic closure is lifted. A closed
    posting is left alone (its disposition is about the posting, not a gate), and so is
    a closure an evaluator wrote, which carries no `auto_gate`: that is a judgement.
    """
    if p.get("in_bounds") is False and not p.get("auto_gate"):
        return None
    g = hard_gate(p)
    if g == "closed":
        return None
    if g is None:
        if not p.get("auto_gate"):
            return None
        for k in ("status", "gate", "in_bounds", "auto_gate"):
            p.pop(k, None)
        return "reopened"
    p.update(status="SKIP", gate=g, auto_gate=True)
    if p.get("location_verdict") == "fail":
        p.pop("in_bounds", None)
    else:
        p["in_bounds"] = False
    return "closed"


def gated_packet(p):
    """The packet a hard-gated req is KEPT as at prep time, or None for a closed posting.

    A gated req used to become a disposition and nothing else, so it never reached the
    tracker: eval-write's gate-closed path needs a packet to write its unscored SKIP row
    from, and the next sweep surfaced the req as new work (Antioch and 2K, 2026-10-15;
    Codex, PR 14). A closed posting is not kept: it was never on offer, and there is no
    decision about it for the tracker to record.
    """
    if p.get("live") is False:
        return None
    out = dict(p)
    settle_gate(out)
    return out


def retract_dispositions(urls):
    """Remove these urls from dispositions.json; return how many entries went."""
    out = os.path.join(ROOT, "dispositions.json")
    if not urls or not os.path.exists(out):
        return 0
    prev = json.load(open(out, encoding="utf-8"))
    keep = [d for d in prev if d.get("url") not in set(urls)]
    if len(keep) != len(prev):
        json.dump(keep, open(out, "w", encoding="utf-8"), indent=1)
    return len(prev) - len(keep)


def report_reopened(reopened):
    """Retract and say so. An inbox row a prune already retired is not restored here."""
    if reopened:
        n = retract_dispositions(reopened)
        print(f"{len(reopened)} automatic closure(s) lifted and back in the queue; "
              f"{n} disposition(s) retracted. Any inbox row already pruned for them stays "
              "retired; re-add it by hand if it matters.")


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


def is_settled(p):
    """A packet a hard fact has already decided: closed, failed the location gate, or
    closed by an evaluator's `in_bounds: false`. relocate and reresolve KEEP these now, so
    every reader that offers judgement work must leave them out: a live=False packet with a
    clearing band printed "TARGET pass" at the top of list_queue (Codex, 2026-10-15). Their
    next steps are eval-write (an unscored SKIP row) and eval-blockers --prune."""
    return (p.get("live") is False or p.get("location_verdict") == "fail"
            or p.get("in_bounds") is False)


def list_queue():
    """Show the packets waiting on judgement, best first.

    A directory of seventy JSON files is not a work queue. Ordering by whether the
    band clears the target, then by whether it clears the floor at all, puts the
    reqs whose outcome is still open at the top, and pushes the ones that only
    survived because no band was posted to the bottom where they belong.
    """
    if not os.path.isdir(OUT_DIR):
        print("no queue"); return
    rows, settled = [], 0
    for f, p in queue_packets():
        f = os.path.basename(f)
        if is_settled(p):
            settled += 1
            continue
        c = p.get("comp", {})
        rank = (2 if c.get("clears_target") else 1 if c.get("clears_floor") else 0,
                1 if p.get("location_verdict") == "pass" else 0,
                -len(p.get("possible_tracker_duplicates") or []))
        rows.append((rank, p, f))
    rows.sort(key=lambda r: r[0], reverse=True)
    filled = sum(1 for _, p, _ in rows if p.get("match_w_cv") is not None)
    print(f"{len(rows)} packet(s) awaiting judgement, {filled} already filled"
          + (f"; {settled} settled (closed or gate-failed) left out, see eval-blockers" if settled else "")
          + "\n")
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
    changed, disp, reopened = 0, [], []
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
        if settle_gate(p) == "reopened":
            reopened.append(p["url"])
        write_packet(f, p)
        changed += 1
        # A packet that now fails STAYS in the queue. This used to os.remove() it, which
        # had two costs: a wrong gate could not be recovered by hand, and the req never
        # got a tracker row, so the next LinkedIn or board sweep surfaced it as new work.
        # eval-write records a gate-closed packet as an unscored SKIP row now, and
        # eval-blockers --prune moves it once that report exists.
        if v == "fail":
            disp.append({"url": p["url"], "disposition": w})
    print(f"\n{changed} packet(s) re-gated, {len(disp)} now fail on location")
    report_reopened(reopened)
    if disp:
        print(f"dispositions.json now holds {record_dispositions(disp)}; retire the inbox rows with:")
        print("  node pipeline-audit.mjs --prune --dispositions=dispositions.json")
        print("record each as an unscored SKIP row with:")
        print("  node eval-write.mjs <packet> --date=YYYY-MM-DD")


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
        # A LinkedIn page capture has nothing for the resolver to refetch: it would answer
        # unknown for linkedin.com and overwrite the capture's own liveness with that.
        # Recapture it in the browser instead (LIS.detail()).
        if p.get("ats") == "linkedin":
            continue
        jd = p.get("jd_full") or ""
        # An unusable location is not the only reason to refetch. Two resolver
        # branches computed the description and then forgot to return it, so those
        # packets carry an EMPTY jd and score lane 0.0 on no evidence: that is how a
        # well-paid, in-lane remote req sorted to the bottom of the queue. And escaped markup used to survive clean(), so older packets hold
        # literal <p> and <li> in the text the lane scan reads.
        # An automatic closure is refetched too: it rests on prep-day evidence, and only a
        # fresh read can find the "Offers Equity" or the new location that lifts it. A
        # gated packet with a good location and JD matched none of the tests above, so its
        # closure and disposition were permanent in practice (Codex P1, PR 14).
        # An untitled packet is stuck too: eval-write cannot name its report.
        if (p.get("location_verdict") == "unknown" or not jd or p.get("auto_gate")
                or not p.get("title") or re.search(r"<(p|li|div|br|ul|strong)\b", jd, re.I)):
            stuck.append((f, p))
    print(f"{len(stuck)} packet(s) need a fresh fetch\n")
    changed, disp, reopened = 0, [], []
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
            # Kept, with live=False written above: eval-blockers reads that as `closed`
            # and --prune MOVES it to done/. Deleting it here bypassed the one path that
            # keeps a wrong closure recoverable by hand.
            print(f"  CLOSED  {(p.get('title') or '')[:52]}")
            disp.append({"url": p["url"], "disposition": "posting closed"})
            write_packet(f, p)
            changed += 1
            continue
        if r.get("jd"):
            p["jd_full"], p["jd_chars"] = r["jd"], len(r["jd"])
            p["requirements_excerpt"] = requirements(r["jd"])
        # Pay is refreshed whether or not a JD came back: Ashby's embedded-board fallback
        # returns pay and the tier summary with jd "" on purpose, and nesting this under the
        # JD left such a packet at no band and without its "Offers Equity" (Codex, PR 14).
        # The stored body stands in as the basis context when the refetch carried none.
        if r.get("comp_summary"):
            p["comp_summary"] = r["comp_summary"]
        # A stored figure that sits in the freshly read body and that today's reader rejects
        # there (a stipend, a bonus, another place's band) is retracted: keeping it kept
        # exactly what the resolver now refuses (Codex round 3). Silence is still not a
        # retraction: a figure absent from the body came from a structured field the body
        # cannot speak for, and with no body nothing is retracted at all.
        retracted = False
        if r.get("pay"):
            p["pay"] = r["pay"]
        elif r.get("jd") and (p.get("pay") or (p.get("comp") or {}).get("posted")):
            stored = p.get("pay") or [(p.get("comp") or {}).get("posted")]
            kept = surviving_figures(stored, r["jd"])
            retracted = kept != stored
            p["pay"] = kept
        # A packet that already HAS a band is re-derived too: its basis and floor_gate were
        # decided on the evidence of the day, and a summary that now says "Offers Equity"
        # must be able to lift a gate an older inference set (Codex P1, PR 14). A refetch
        # that finds no band leaves an existing one alone; silence is not a retraction.
        # A refetch carrying ONLY a summary is new basis evidence too (Codex P1, PR 14), so
        # it re-derives the stored figures: the packet's own `pay`, or for a packet older
        # than that key, the band it recorded, which then reads as a yearly band of unknown
        # basis and so cannot gate on its own.
        if r.get("pay") or r.get("jd") or r.get("comp_summary"):
            old = (p.get("comp") or {}).get("posted")
            figures = p.get("pay") if retracted else (r.get("pay") or p.get("pay") or ([old] if old else []))
            fresh = comp_verdict(figures, r.get("jd") or p.get("jd_full") or "",
                                 p.get("comp_summary") or "")
            if fresh.get("posted") or not old or retracted:
                p["comp"] = fresh
        if not p.get("company"):
            p["company"] = company_from({**r, "url": p["url"]})
            p["company_hint"] = p.get("company_hint") or company_hint({**r, "url": p["url"]})
        # A packet first built from an unreadable host has no title and a resolver note
        # saying so; a refetch that now reads the posting must replace both, or the packet
        # stays "untitled" with a note contradicting its own body (Nominal and Cerby, after
        # the Gem and Rippling adapters landed, 2026-10-29). A title the refetch lacks is
        # kept; silence is not a retraction.
        if r.get("title") and not p.get("title"):
            p["title"] = r["title"]
        if r.get("note") is not None or r.get("live") is not None:
            p["resolver_note"] = r.get("note")
        loc = r.get("location")
        if loc:
            v, w = location_verdict(loc, r.get("remote_txt"))
            p["location"], p["location_verdict"], p["location_why"] = loc, v, w
        if settle_gate(p) == "reopened":
            reopened.append(p["url"])
        if not loc:
            print(f"  jd {p.get('jd_chars', 0):5d}  (location unchanged)  "
                  f"{(p.get('title') or '')[:38]}")
            write_packet(f, p)
            changed += 1
            continue
        print(f"  {str(loc)[:34]:34s} -> {v:7s} jd {p.get('jd_chars', 0):5d}  "
              f"{(p.get('title') or '')[:34]}")
        write_packet(f, p)
        changed += 1
        # A location failure stays in the queue too, for eval-write's SKIP row; see relocate().
        if v == "fail":
            disp.append({"url": p["url"], "disposition": w})
    print(f"\n{changed} packet(s) updated, {len(disp)} settled by a hard gate")
    report_reopened(reopened)
    if disp:
        print(f"dispositions.json now holds {record_dispositions(disp)}; retire the inbox rows with:")
        print("  node pipeline-audit.mjs --prune --dispositions=dispositions.json")
        print("then: eval-write records each location failure as an unscored SKIP row, and")
        print("  python scripts/eval-blockers.py --prune moves the closed and reported packets")


def recomp_figures(p):
    """The pay figures a packet should be judged on under the CURRENT body rules.

    A stored figure that appears in the stored body and that today's reader rejects (a
    stipend, a bonus, another place's band) is dropped; one that does not appear in the body
    came from a structured field (an Ashby tier, a Greenhouse custom field) and is kept,
    since the body cannot speak for it. With nothing kept, the body's current reading.
    `recomp` used to skip any packet already holding a band and read no figures at all,
    so it could neither repair nor even see a contaminated one (Codex round 3).
    """
    jd = p.get("jd_full") or ""
    old = (p.get("comp") or {}).get("posted")
    stored = p.get("pay") or ([old] if old else [])
    kept = surviving_figures(stored, jd)
    return kept or rr.pays(jd)


def _nums(s):
    """The amounts in one figure, as whole dollars: "$150K", "150,000.00 USD", "$150,000"
    all give 150000. Figures are compared by AMOUNT, because the stored spelling and the
    body's differ ("$150,000 - $200,000" stored, "$150,000.00 - $200,000.00" in the body)
    and a literal test read that as "absent from the body, so structured" (round 4)."""
    out = set()
    for n, k in re.findall(r"(\d[\d,]*(?:\.\d+)?)\s*([kK])?\b", s or ""):
        # The fraction counts: "$150.5K" is 150500, and dropping it made the stored
        # "$150,500" read as absent from the body (round 5).
        v = int(round(float(n.replace(",", "")) * (1000 if k else 1)))
        if v >= 1000:
            out.add(v)
    return frozenset(out)


def surviving_figures(stored, jd):
    """The stored pay figures that today's reader would still accept from this body.

    A figure whose amounts the body states, in any spelling, survives only if pays() still
    accepts it there. A figure the body never states came from a structured field (an
    Ashby tier, a Greenhouse custom field) and is kept, since the body cannot speak for it.
    """
    # Every amount the body states at all, read loosely on purpose: the stipend that started
    # this is "$2,000", which PAY itself no longer matches.
    said = _nums(rr.mask_foreign(jd or ""))
    # Accepted figures are read with K notation expanded, since _nums() reads "$150K" as an
    # amount and a body band in that spelling must be able to confirm a stored figure.
    ok = [_nums(x) for x in rr.pays(rr.k_band(jd or ""))]
    out = []
    for f in stored or []:
        n = _nums(f)
        stated = bool(n) and n <= said
        # Survives only if every amount it holds is inside one accepted figure. The reverse
        # test let an accepted "$150,000" keep a rejected "$150,000 - $200,000" equity band
        # (round 5); this direction still keeps the lone figures an older reader split a
        # cents-written band into.
        if not stated or any(a and n <= a for a in ok):
            out.append(f)
    return out


def recomp():
    """Re-derive comp for packets on disk using the CURRENT extraction rules.

    Same reasoning as relocate(): the band parser has been corrected since these
    packets were written (USD-suffix figures, then hourly rates), and a packet keeps
    whatever the parser said at prep time. "No band" is the second largest blocker
    class in the queue, and some of those postings do publish a band that the parser
    of the day could not see. The full JD is stored in the packet, so this costs no
    network.
    """
    changed, reopened = 0, []
    for f, p in queue_packets():
        if p.get("match_w_cv") is not None:
            continue
        before = p.get("comp") or {}
        c = comp_verdict(recomp_figures(p), p.get("jd_full") or "", p.get("comp_summary") or "")
        # The WHOLE verdict, not just the band: a corrected basis on the same figures can
        # lift a floor gate, and comparing `posted` alone threw that correction away; and a
        # change has to reach settle_gate(), or a closure the old band armed stayed shut
        # (Codex round 4).
        if c == before:
            continue
        print(f"  {str(before.get('posted') or 'no band'):24s} -> "
              f"{str(c.get('posted') or 'no band'):24s} {(p.get('title') or '')[:40]}")
        p["comp"] = c
        if settle_gate(p) == "reopened":
            reopened.append(p.get("url"))
        write_packet(f, p)
        changed += 1
    print(f"\n{changed} packet(s) changed comp")
    report_reopened(reopened)

    named = 0
    for f, p in queue_packets():
        if p.get("match_w_cv") is not None or p.get("company"):
            continue
        co = company_from(p)
        if not co:
            hint = company_hint(p)
            if hint and not p.get("company_hint"):
                p["company_hint"] = hint
                write_packet(f, p)
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
    ("AMER - United States - Texas - Remote | Texas, USA - Remote", True, "fail",
     "Autodesk 26WD134728 as the resolver returned it. Autodesk's Eightfold front end puts "
     "a sales region in front of the country, and the start-anchored scope shape could not "
     "see past it, so Texas read as a weak mention and the packet came out 'unknown'. The "
     "grammar now folds an Americas region label away before a US country marker",
     "scoped to states"),
    ("AMER - United States - Texas - Remote", True, "fail",
     "the region-prefixed option on its own: a Texas scope, not a weak mention",
     "scoped to states"),
    ("AMER - United States - California - Remote", True, "pass",
     "the same form scoped to California must pass, and through the SCOPE branch: it "
     "already passed before the fold, on the weak 'naming only CA' path",
     "scoped to CA"),
    ("AMER - United States - California - Los Angeles", True, "pass",
     "the onsite form of the same spelling reaches the commute list"),
    ("AMER - United States - Texas", False, "fail",
     "the onsite form with no Remote suffix is onsite in Texas"),
    ("AMER - Canada - Remote", True, "fail",
     "the fold only drops a region label in front of a US marker; the rest still fail as "
     "foreign"),
    ("EMEA - United Kingdom - London - Remote | APAC - Australia - Sydney - Remote", True, "fail",
     "EMEA and APAC labels are never folded and are blocked regions in their own right"),
    ("AMER - Remote", True, "unknown",
     "the Americas include Canada and Latin America, so a bare AMER remote is a question, "
     "not remote-US, even with the ATS isRemote flag set. The flag settles an UNRECOGNISED "
     "remote region; this one is recognised as wider than the US, and lifting it was a "
     "false pass in the direction that hides a hard no-relocation failure",
     "wider than the US"),
    ("Americas - Remote", True, "unknown", "the spelled-out label, same rule",
     "wider than the US"),
    ("NA - Remote", True, "unknown", "North America's sales label, same rule",
     "wider than the US"),
    ("Remote (Americas)", True, "unknown", "the label after the remote word, same rule",
     "wider than the US"),
    ("LATAM - Remote", True, "fail",
     "LATAM is a blocked region, so it fails outright and the flag cannot touch it"),
    ("Remote, Flexible", True, "pass",
     "the upgrade the rule above must not take away: a remote string whose qualifier names "
     "no region at all is still settled by the isRemote flag", "remote (unqualified)"),
    ("Remote, Flexible", False, "unknown",
     "and without the flag it stays a question, so the case above proves the flag did it",
     "region is not recognised"),
    ("Remote, Flexible | AMER - Remote", True, "unknown",
     "the Americas question must survive aggregation: taking the first unknown let the flag "
     "upgrade the 'unrecognised' option and pass the posting (Codex, 2026-10-15)"),
    ("AMER - Remote | Remote, Flexible", True, "unknown",
     "and the reverse order gives the same answer, which is the property being pinned"),
    ("AMER / Remote", True, "unknown",
     "a slash split the region off its remote word, and the bare half passed as remote-US"),
    ("Los Angeles - San Diego, CA", False, "fail",
     "EA writes a metro label over the city ('Los Angeles - Chatsworth'). One piece naming two "
     "places is a hierarchy, so a far place beside the commute word voids it; the metro word "
     "alone used to pass Respawn's Valley studio"),
    ("Los Angeles, CA - HQ in San Francisco", False, "pass",
     "an office named beside the place is not the place, so the rule above must not fire"),
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
    # The duplicate warning must see an employer named only by a shared board's SLUG.
    from unittest import mock as _m
    _row = ("| 417 | 2026-08-03 | Reddit | Senior Staff Machine Learning Engineer, GenAI "
            "Platform | 3.4/5 | SKIP |")
    _cells = [c.strip() for c in _row.split("|")]
    with _m.patch.object(sys.modules[__name__], "_tracker_rows", lambda: [(_row, _cells)]):
        for _u, _want in (("https://job-boards.greenhouse.io/reddit/jobs/7033254", 1),
                          ("https://job-boards.greenhouse.io/cresta/jobs/1", 0)):
            _got = len(tracker_hits("Senior Staff Machine Learning Engineer, GenAI Platform", _u))
            if _got != _want:
                bad += 1
                print(f"FAIL  tracker_hits on {_u}: {_got} hit(s), expected {_want}")
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
              ("reopen", reopen_cases), ("queue", queue_cases), ("linkedin", linkedin_cases))
    # No case may read the installed profile's floor: a case that needs one pins it (the
    # explicit `targets`, or a mock of configured_comp_targets), and every other read is
    # "no floor configured". A call naming its own profile path still reads that file.
    from unittest import mock
    _real_targets = configured_comp_targets
    with mock.patch.object(sys.modules[__name__], "configured_comp_targets",
                           lambda path=None: _real_targets(path) if path else None):
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


def linkedin_cases():
    """--from-linkedin: a captured Easy Apply posting becomes a filled packet, an ATS apply
    link still goes to the resolver, and a closed listing is never read as live."""
    import datetime
    bad = 0
    today = datetime.date.today().isoformat()
    good = {"id": "4620863806", "url": "https://www.linkedin.com/jobs/view/4620863806/",
            "company": "Escape Velocity Entertainment", "title": "AI Director - Machine Learning",
            "location": "United States", "workplace": "Remote", "comp": "$200K/yr - $260K/yr",
            "open": True, "read_ok": True, "apply_url": "EASY_APPLY",
            "jd": "Oversee ML bot research.", "read_on": today}
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "details.json")
        rows = [
            good,
            {"id": "4335539310", "url": "https://www.linkedin.com/jobs/view/4335539310/",
             "apply_url": "https://careers.activision.com/job/ACPUUSR045261EXTERNAL/x", "open": True},
            dict(good, id="4532225990", url="https://www.linkedin.com/jobs/view/4532225990/", open=False),
            dict(good, id="4400000002", url="https://www.linkedin.com/jobs/view/4400000002/",
                 read_on="2000-01-01"),
            # A sign-in wall parsed as a posting (Codex, 2026-10-28): refused outright.
            dict(good, id="4400000003", url="https://www.linkedin.com/jobs/view/4400000003/",
                 company="Sign in", title="Join LinkedIn", jd="", read_ok=False),
        ]
        with open(f, "w", encoding="utf-8") as fh:
            json.dump(rows, fh)
        with contextlib.redirect_stdout(io.StringIO()):
            got = from_linkedin(f)
    by = {u: r for u, r, _ in got}
    who = {u: w for u, _, w in got}
    checks = [
        (len(got) == 4, f"an unread page is refused, the other four rows are jobs ({len(got)})"),
        (by.get("https://careers.activision.com/job/ACPUUSR045261EXTERNAL/x", 0) is None,
         "an ATS apply link goes to the resolver, not the captured page"),
        (by["https://www.linkedin.com/jobs/view/4532225990/"]["live"] is None,
         "a closed listing is not live, and LinkedIn alone never closes a row"),
        (by["https://www.linkedin.com/jobs/view/4400000002/"]["live"] is None,
         "a capture from another day is not evidence the posting is live today"),
    ]
    checks += [
        (linkedin_employer("(3) Staff AI Engineer | Cardinal Health | LinkedIn") == "Cardinal Health",
         "the employer is read from the tab title, badge and all"),
        (linkedin_employer("Sign in | LinkedIn") is None, "a two-part title names no employer"),
        (linkedin_employer("Staff Applied AI Engineer | Orum \U0001f947 | LinkedIn") == "Orum"
         and linkedin_employer("TD | Wētā FX | LinkedIn") == "Wētā FX",
         "decoration is dropped, letters in any script are kept"),
        (linkedin_employer("A | B | C | LinkedIn") == "C", "a title holding a pipe keeps the last company cell"),
        (who[good["url"]] == "Escape Velocity Entertainment", "an Easy Apply row carries its company"),
    ]
    riot = "https://www.riotgames.com/en/work-with-us/job/7037924?gh_jid=7037924%3Fgh_src%3Dnslt3m"
    nflx = "https://explore.jobs.netflix.net/careers/job/721941852582?microsite=netflix.com&domain=netflix.com"
    fake = lambda u: "https://job-boards.greenhouse.io/podium81/jobs/123456?gh_src=abc"
    def boom(u):
        raise OSError("offline")
    checks += [
        (clean_apply(riot) == "https://www.riotgames.com/en/work-with-us/job/7037924?gh_jid=7037924",
         f"a nested ?gh_src inside gh_jid is cut, got {clean_apply(riot)}"),
        (clean_apply(nflx) == nflx, "an Eightfold domain parameter is not tracking and survives"),
        ("jobId%3D123" in clean_apply("https://a.example/go?redirect=https%3A%2F%2Fx.example%2Fjob%3FjobId%3D123"),
         "a value that is itself a URL keeps its own query"),
        (clean_apply("https://careers.example.com/jobs/application") == "https://careers.example.com/jobs/application",
         "an /application segment off the known ATS hosts is left alone"),
        (clean_apply("https://x.wd5.myworkdayjobs.com/ext/job/NYC/Eng_JR-015305-1/apply")
         == "https://x.wd5.myworkdayjobs.com/ext/job/NYC/Eng_JR-015305-1",
         "an /apply form link becomes the posting link"),
        (clean_apply("https://grnh.se/pfiou3ft1us", fake)
         == "https://job-boards.greenhouse.io/podium81/jobs/123456",
         "a grnh.se short link is expanded and its tracking dropped"),
        (clean_apply("https://grnh.se/x", boom) == "https://grnh.se/x",
         "a short link that cannot be expanded is kept, not lost"),
    ]
    p = prep(good["url"], by[good["url"]])
    checks += [
        (p["live"] is True and p["ats"] == "linkedin", "a fresh, read, open Easy Apply listing is live"),
        (p.get("captured_on") == today, "the capture date travels into the packet"),
        (p["company"] == "Escape Velocity Entertainment", "the page's company is the packet's"),
        (p["location_verdict"] == "pass",
         f"a bare United States with the Remote badge passes, got {p['location_verdict']}"),
        (p.get("remote_txt") is True, "the remote flag is kept, so --relocate re-gates the same way"),
        ((p["comp"].get("low"), p["comp"].get("high")) == (200000, 260000),
         f"the card's K/yr band is read as pay, got {p['comp'].get('posted')!r}"),
        (packet_name(p).endswith("4620863806.json"), f"packet named by its LinkedIn id: {packet_name(p)}"),
    ]
    for ok, msg in checks:
        if not ok:
            bad += 1
            print("FAIL  linkedin:", msg)
    print(f"{bad} linkedin case(s) failed" if bad else f"all {len(checks)} linkedin cases pass")
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


def reopen_cases():
    """An automatic closure is lifted when the evidence that closed it changes."""
    from unittest import mock
    bad = 0

    def check(ok, msg):
        nonlocal bad
        if not ok:
            bad += 1
            print(f"FAIL  {msg}")

    me = sys.modules[__name__]
    URL, OTHER = "https://careers.example.com/job/2468013/x", "https://careers.example.com/job/1/y"
    # An evaluator's closure is a judgement and is never reopened.
    hand = {"url": URL, "live": True, "in_bounds": False, "gate": "relocation", "comp": {}}
    check(settle_gate(dict(hand)) is None, "an evaluator's closure must never be reopened")
    # The shape follows the CURRENT gate. A location closure whose location now passes
    # while a stated-total band still fails becomes a comp closure, with in_bounds false.
    sub_total = {"posted": "$93,600 - $124,800", "basis": "total", "floor_gate": True}
    q = {"url": URL, "live": True, "location_verdict": "pass", "comp": sub_total,
         "status": "SKIP", "gate": "Texas only", "auto_gate": True}
    check(settle_gate(q) == "closed" and q.get("in_bounds") is False
          and q.get("gate", "").startswith("below floor"),
          f"a gate that turns from location to comp must take the comp shape: {q}")
    # A packet that FIRST fails during a re-gate is marked automatic, so it can be lifted.
    q = {"url": URL, "live": True, "location_verdict": "fail", "location_why": "Texas only", "comp": {}}
    check(settle_gate(q) == "closed" and q.get("auto_gate") is True and "in_bounds" not in q,
          f"a fresh location failure must be an automatic closure: {q}")
    # A closed posting keeps what it has; its disposition is about the posting.
    q = {"url": URL, "live": False, "status": "SKIP", "gate": "x", "auto_gate": True}
    check(settle_gate(q) is None and q.get("auto_gate") is True,
          f"a closed posting must not be reopened: {q}")
    with tempfile.TemporaryDirectory(prefix="evalprep-reopen-") as d:
        def seed(packet):
            f = os.path.join(d, "x.json")
            write_packet(f, packet)
            json.dump([{"url": URL, "disposition": "gated"}, {"url": OTHER, "disposition": "x"}],
                      open(os.path.join(d, "dispositions.json"), "w", encoding="utf-8"))
            return f

        def read(f):
            return (json.load(open(f, encoding="utf-8")),
                    [x["url"] for x in json.load(open(os.path.join(d, "dispositions.json")))])

        # relocate: a stale location failure that now passes.
        loc_gated = gated_packet({"url": URL, "title": "A Role", "company": "Example", "live": True,
                                  "location": "United States - Remote", "location_verdict": "fail",
                                  "location_why": "Texas only", "match_w_cv": None, "comp": {},
                                  "jd_full": "plain"})
        f = seed(loc_gated)
        with _patched(d):
            relocate()
        p, urls = read(f)
        check(p.get("location_verdict") == "pass" and "status" not in p and "gate" not in p
              and "auto_gate" not in p and urls == [OTHER],
              f"relocate must lift a closure the location no longer supports: "
              f"{p.get('location_verdict')} {p.get('status')} {p.get('gate')} / {urls}")
        # reresolve: a total-band gate that an equity summary lifts, on a no-JD refetch.
        comp_gated = gated_packet({"url": URL, "title": "A Role", "company": "Example", "live": True,
                                   "location": "United States - Remote", "location_verdict": "pass",
                                   # A good JD and location: only auto_gate gets it refetched.
                                   "match_w_cv": None, "jd_full": "Build agent tooling.",
                                   "comp": {"posted": "$93,600 - $124,800", "basis": "total",
                                            "floor_gate": True}})
        f = seed(comp_gated)
        refetch = {"live": True, "location": "United States - Remote", "jd": "",
                   "pay": ["$45 - $60 per hour"],
                   "comp_summary": "$45 \u2013 $60 per hour \u2022 Offers Equity"}
        with _patched(d), mock.patch.object(rr, "resolve", lambda *a, **k: refetch), \
                mock.patch.object(me, "configured_comp_targets", lambda *a, **k: (200_000, 250_000)):
            reresolve()
        p, urls = read(f)
        check((p.get("comp") or {}).get("floor_gate") is False and "in_bounds" not in p
              and "status" not in p and urls == [OTHER],
              f"reresolve must lift a comp closure the refetch contradicts: "
              f"{p.get('comp')} {p.get('in_bounds')} {p.get('status')} / {urls}")
        # ...and one the evidence still supports stays closed, with its disposition.
        f = seed(gated_packet({**comp_gated, "auto_gate": None}))
        with _patched(d), mock.patch.object(rr, "resolve", lambda *a, **k: {**refetch, "comp_summary": ""}), \
                mock.patch.object(me, "configured_comp_targets", lambda *a, **k: (200_000, 250_000)):
            reresolve()
        p, urls = read(f)
        check(p.get("in_bounds") is False and p.get("status") == "SKIP" and URL in urls,
              f"a closure the refetch still supports must stay: {p.get('in_bounds')} / {urls}")
    print(f"{bad} reopen case(s) failed" if bad else "all reopen cases pass")
    return bad


def reresolve_cases():
    """What --reresolve writes back, and what it is allowed to settle. It deletes nothing.

    Two defects, both found by cross-review on 2026-09-20, both the same shape: a refetch
    that updated everything about a packet EXCEPT the field the rest of the toolchain
    reads to decide whether the packet is still worth working on.

    The delete is the reason these are pinned rather than just fixed. Everything else here
    rewrites a file; this branch removes one, and it used to fire on a falsy resolver
    result as readily as on a real closure.
    """
    from unittest import mock
    bad = n = 0

    def check(ok, msg):
        nonlocal bad, n
        n += 1
        if not ok:
            bad += 1
            print(f"FAIL  {msg}")

    me = sys.modules[__name__]
    # A PINNED floor for the cases that need one, never the installed profile's: the suite
    # must mean the same thing on every machine, configured or not.
    FLOOR_FIX = (200_000, 250_000)

    def pinned_floor():
        return mock.patch.object(me, "configured_comp_targets", lambda *a, **k: FLOOR_FIX)

    def run(result, root=True, **over):
        """One packet, one mocked resolver answer. Returns the packet, or None if deleted.

        root=False keeps the real ROOT and pins the fixture floor, for a case that needs one."""
        packet = {**dict(url="https://careers.example.com/job/1194374/x", title="A Role",
                         company="Example", live=True, location_verdict="unknown",
                         match_w_cv=None, jd_full="plain text, no markup"), **over}
        with tempfile.TemporaryDirectory(prefix="evalprep-queue-") as d, _patched(d, root), \
                mock.patch.object(rr, "resolve", lambda *a, **k: result), \
                (contextlib.nullcontext() if root else pinned_floor()):
            f = os.path.join(d, "x.json")
            with open(f, "w", encoding="utf-8") as fh:
                json.dump(packet, fh, indent=1)
            reresolve()
            if not os.path.exists(f):
                return None
            with open(f, encoding="utf-8") as fh:
                return json.load(fh)

    # A packet built untitled from an unreadable host gains the title and loses the stale
    # note once the refetch reads it; an existing title is never overwritten.
    got = run({"live": True, "title": "Staff AI Engineer", "note": "", "location": "Remote",
               "jd": "We build agents. " * 20},
              root=False, title="", resolver_note="no API for this host")
    check(got and got.get("title") == "Staff AI Engineer" and got.get("resolver_note") == "",
          f"an untitled packet takes the refetched title and note: {got and (got.get('title'), got.get('resolver_note'))}")
    got = run({"live": True, "title": "Renamed", "note": "", "location": "Remote",
               "jd": "We build agents. " * 20}, root=False)
    check(got and got.get("title") == "A Role", "a stored title is not overwritten by a refetch")
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
    # ...and a real closure must still SETTLE it, or the fix would have bought safety by
    # making --reresolve unable to settle anything. Settling used to mean a delete; since
    # 2026-10-15 it writes live=False and keeps the file, which eval-blockers reads as
    # `closed` and --prune moves to done/, so a wrong closure stays recoverable by hand.
    p = run({"live": False})
    check(p is not None and p.get("live") is False,
          f"a resolved closure must be kept and marked live=False: {p and p.get('live')}")
    # A location failure is kept too, rewritten to fail, so eval-write can record it as an
    # unscored SKIP row instead of the req vanishing from the tracker.
    p = run({"live": True, "location": "Austin, TX"})
    check(p is not None and p.get("location_verdict") == "fail",
          f"a refetch that fails the gate must keep the packet as fail: {p and p.get('location_verdict')}")
    # The ATS pay summary has to reach comp_verdict from BOTH builders, prep() and this
    # refetch: comp_verdict reading it is no use if a caller drops it on the way (Codex
    # P1, PR 14). A sub-floor hourly band, a silent body, "Offers Equity" in the summary.
    SUMMARY = {"live": True, "location": "United States - Remote", "jd": "Build agent tooling.",
               "pay": ["$45.00 - $60.00 per hour"],
               "comp_summary": "$45 \u2013 $60 per hour \u2022 Offers Equity"}
    p = run(SUMMARY, root=False)
    check(p is not None and (p.get("comp") or {}).get("floor_gate") is False
          and "Offers Equity" in (p.get("comp_summary") or ""),
          f"a refetch must read the ATS summary for the basis: {p and p.get('comp')}")
    # A packet that already has a band, gated on an old total inference, is re-derived
    # when the refetch brings the summary that contradicts it...
    stale = {"posted": "$93,600 - $124,800", "basis": "total", "floor_gate": True}
    p = run(SUMMARY, root=False, comp=stale)
    check(p is not None and (p.get("comp") or {}).get("floor_gate") is False,
          f"a refetch must re-derive an existing band's basis: {p and p.get('comp')}")
    # ...and a refetch that finds no band leaves an existing one alone.
    p = run({"live": True, "location": "United States - Remote", "jd": "No pay stated."},
            root=False, comp=stale)
    check(p is not None and (p.get("comp") or {}).get("posted") == stale["posted"],
          f"a refetch with no band must not erase one: {p and p.get('comp')}")
    # ...and a refetch carrying ONLY the summary re-derives the stored band, from the
    # packet's own pay when it has it and from the recorded band when it does not.
    only_summary = {"live": True, "location": "United States - Remote", "jd": "",
                    "comp_summary": SUMMARY["comp_summary"]}
    for kept, why in ((["$45.00 - $60.00 per hour"], "stored pay"), ([], "the recorded band")):
        p = run(only_summary, root=False, comp=stale, pay=kept)
        check(p is not None and (p.get("comp") or {}).get("floor_gate") is False
              and (p.get("comp") or {}).get("posted"),
              f"a summary-only refetch must re-derive from {why}: {p and p.get('comp')}")
    # ...including when the refetch carries pay and no JD, as the embedded board does.
    p = run({**SUMMARY, "jd": ""}, root=False)
    check(p is not None and (p.get("comp") or {}).get("posted")
          and (p.get("comp") or {}).get("floor_gate") is False
          and "Offers Equity" in (p.get("comp_summary") or ""),
          f"a no-JD refetch must still refresh pay and summary: {p and p.get('comp')}")
    with mock.patch.object(rr, "resolve", lambda *a, **k: SUMMARY), pinned_floor():
        p = prep("https://careers.example.com/job/7654321/x")
    check(p["comp"].get("floor_gate") is False and "Offers Equity" in (p.get("comp_summary") or ""),
          f"prep must read the ATS summary for the basis: {p['comp']}")
    # A stored figure the body still states, and that the reader now rejects, is retracted
    # on refetch; a structured figure absent from the body is not (Codex round 3).
    stip = {"posted": "$2,000 - $2,000", "basis": "unknown", "floor_gate": False}
    body = {"live": True, "location": "United States - Remote", "pay": [],
            "jd": "Build agent evals. Perks: a $2,000 learning stipend."}
    p = run(body, root=False, comp=stip, pay=["$2,000"])
    check(p is not None and not p.get("pay") and not (p.get("comp") or {}).get("posted"),
          f"a figure the body states and the reader rejects must be retracted: {p and (p.get('pay'), p.get('comp'))}")
    p = run({**body, "jd": "Build agent evals."}, root=False,
            comp={"posted": "$200,000 - $350,000", "basis": "unknown", "floor_gate": False},
            pay=["$200,000 - $350,000"])
    check(p is not None and p.get("pay") == ["$200,000 - $350,000"],
          f"a structured figure absent from the body must survive a refetch: {p and p.get('pay')}")
    # recomp_figures: the same rule offline.
    check(recomp_figures({"jd_full": "Perks: a $2,000 learning stipend.", "pay": ["$2,000"]}) == []
          and recomp_figures({"jd_full": "Build evals.", "pay": ["$200,000 - $350,000"]}) == ["$200,000 - $350,000"]
          and recomp_figures({"jd_full": "Base salary $150,000 - $200,000.", "pay": []}) == ["$150,000 - $200,000"],
          "recomp_figures must drop rejected body figures, keep structured ones, and read the body")
    # Round 4: a figure is matched to the body by AMOUNT, whatever the spelling, and a
    # legacy packet's recorded band is judged the same way.
    check(recomp_figures({"jd_full": "Equity grant $150,000.00 - $200,000.00", "pay": ["$150,000 - $200,000"]}) == [],
          "a rejected body band must be dropped even when the body spells it differently")
    check(recomp_figures({"jd_full": "Base salary $150K - $200K",
                          "comp": {"posted": "$150,000 - $200,000"}}) == ["$150,000 - $200,000"],
          "a legacy packet's correct recorded band must survive a K-notation body")
    # Round 4: --recomp must re-settle the gate. A budget figure once read as a sub-floor
    # TOTAL band closed this packet automatically; once the reader rejects the figure, the
    # closure has to lift rather than outlive its reason.
    gated = dict(url="https://careers.example.com/job/2468101/x", title="A Role", company="Example",
                 live=True, location="United States - Remote", location_verdict="pass", match_w_cv=None,
                 jd_full="Our annual budget is $150,000 for tooling. Total compensation is discussed later.",
                 pay=["$150,000"],
                 comp={"posted": "$150,000 - $150,000", "low": 150000, "high": 150000, "achievable": 150000,
                       "clears_floor": False, "clears_target": False, "basis": "total",
                       "basis_why": "stated", "floor_gate": True, "note": ""})
    with tempfile.TemporaryDirectory(prefix="evalprep-queue-") as d, _patched(d, False), pinned_floor():
        settle_gate(gated)
        closed_before = gated.get("auto_gate") and gated.get("status") == "SKIP"
        f = os.path.join(d, "g.json")
        with open(f, "w", encoding="utf-8") as fh:
            json.dump(gated, fh, indent=1)
        with contextlib.redirect_stdout(io.StringIO()):
            recomp()
        with open(f, encoding="utf-8") as fh:
            after = json.load(fh)
    check(closed_before and not after.get("auto_gate") and after.get("status") != "SKIP",
          f"--recomp must lift a closure its corrected comp no longer supports: "
          f"{closed_before} -> {after.get('status')} / {after.get('auto_gate')}")
    # Round 5: one accepted endpoint keeps no rejected band; a K amount keeps its fraction;
    # a K-written total band keeps its gate through --recomp.
    check(recomp_figures({"jd_full": "Base salary $150,000. Equity grant $150,000 - $200,000.",
                          "pay": ["$150,000 - $200,000"]}) == ["$150,000"],
          "an accepted endpoint must not keep a rejected band alive")
    check(recomp_figures({"jd_full": "Equity grant $150.5K - $200.5K", "pay": ["$150,500 - $200,500"]}) == [],
          "a decimal-K body figure must be matched by its full amount")
    check(recomp_figures({"jd_full": "Base salary $229,200.00 - $319,500.00",
                          "pay": ["$229,200", "$319,500"]}) == ["$229,200", "$319,500"],
          "lone figures an older reader split from one band must survive")
    tot = comp_verdict(["$100,000 - $150,000"], "Total compensation: $100K - $150K", targets=FLOOR_FIX)
    check(tot.get("basis") == "total" and tot.get("floor_gate") is True,
          f"a K-written total band must read as total: {tot.get('basis')} / {tot.get('floor_gate')}")
    # Counted, not written down: a literal "23" stayed 23 when cases were added (2026-10-29).
    print(f"{bad} of {n} reresolve cases failed" if bad else f"all {n} reresolve cases pass")
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
    # relocate() ran the fixed gate over the packet, and "UK, Remote" now fails. The packet
    # must STAY, rewritten to fail, so eval-write can record it as an unscored SKIP row; it
    # used to be deleted, which lost the req from the tracker and from recovery by hand.
    # Its disposition is still written. Reading the verdict back also proves relocate
    # reached the packet rather than passing by skipping everything.
    kept = os.path.join(d, "a-packet.json")
    if not os.path.exists(kept):
        bad += 1
        print("FAIL  relocate() deleted a packet that failed the gate; it must keep it")
    elif json.load(open(kept, encoding="utf-8")).get("location_verdict") != "fail":
        bad += 1
        print("FAIL  relocate() did not re-gate the one real packet in a queue of strays")
    if not os.path.exists(os.path.join(d, "dispositions.json")):
        bad += 1
        print("FAIL  relocate() did not record the failed packet's disposition")
    # ...and a kept packet is settled, never offered as judgement work.
    buf = io.StringIO()
    with _patched(d), contextlib.redirect_stdout(buf):
        list_queue()
    if not buf.getvalue().startswith("0 packet(s) awaiting judgement") or "1 settled" not in buf.getvalue():
        bad += 1
        print(f"FAIL  list_queue() offered a gate-failed packet as work: {buf.getvalue()[:120]!r}")
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

    # Amazon's currency-after-the-range band becomes a band, not a point or nothing.
    v = comp_verdict(["154,200.00 - 208,600.00 USD"], "", "", targets=NO_FLOOR)
    check((v.get("low"), v.get("high")) == (154_200, 208_600),
          f"a range with one trailing USD is a band: {v.get('low')}-{v.get('high')}")
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
    # A foreign-currency band beside the US one is not US pay (AssemblyAI, 2026-10-18).
    c = comp_verdict(["$160,000 - $210,000", "C$225,000 - C$285,000"], "Build agent tooling.",
                      targets=FIX)
    check(c["high"] == 210_000, f"a C$ band must not raise the US high, got {c['high']}")
    # ...nor a C$ hourly rate read as a US annual figure that arms the floor gate (Codex).
    c = comp_verdict([], "C$45 - C$60 per hour.", targets=FIX)
    check(c["floor_gate"] is None and c["low"] is None, f"a C$ hourly rate is not US pay: {c['low']}")
    # No band at all settles nothing, and must not read as a gate.
    c = cv([], "No pay information anywhere in this posting.")
    check(c["floor_gate"] is None and c["clears_floor"] is None and c["basis"] is None,
          f"no band must leave every comp key unknown, got {c['floor_gate']}/{c['basis']}")
    # An hourly rate is the whole cash offer, so it CAN settle the floor by itself. This
    # is the one inferred basis, and it keeps a $39-$73/hr union rate settling itself.
    c = cv([], "Pay range for this role is $39.54 - $73.16 an hour.")
    check(c["basis"] == "total" and c["floor_gate"] is True,
          f"an hourly rate must still settle itself: {c['basis']} / {c['floor_gate']}")
    # A STRUCTURED hourly band arrives in `pay`, not the body: req-resolve writes Lever's
    # per-hour salaryRange as "$45.00 - $60.00 per hour". Annualised at 2080 hours, never
    # read as a $45 yearly figure and never dropped as no band.
    c = comp_verdict(["$45.00 - $60.00 per hour"], "The body states no pay at all.", targets=FIX)
    check(c["low"] == 93_600 and c["high"] == 124_800 and c["basis"] == "total",
          f"a structured hourly band must be annualised: {c['posted']} / {c['basis']}")
    # One decimal is a rate too; the window cannot cross a full stop, so ".5" unread
    # stranded the whole band (Codex, PR 14).
    c = comp_verdict(["$60.5 - $70.5 per hour"], "The body states no pay at all.", targets=FIX)
    check(c["low"] == 125_840 and c["high"] == 146_640,
          f"a one-decimal hourly band must be annualised: {c['posted']}")
    # The Ashby summary spelling has no cents ("$57 - $70 per hour"); same reading.
    c = comp_verdict(["$57 - $70 per hour"], "The body states no pay at all.", targets=FIX)
    check(c["low"] == 118_560 and c["high"] == 145_600,
          f"a whole-dollar hourly band must be annualised too: {c['posted']}")
    # Silence is what licenses reading an hourly rate as total. A posting that names a
    # bonus or equity, or calls the rate base, has said otherwise, and reading it as total
    # armed the floor gate and disposed of the req (Codex, 2026-10-15).
    for jd in ("This is base pay. Eligible for annual bonus and equity.",
               "Plus a quarterly bonus.", "This is the base rate for the role."):
        c = comp_verdict(["$60.00 - $80.00 per hour"], jd, targets=FIX)
        check(c["basis"] != "total" and c["floor_gate"] is False,
              f"an hourly band beside {jd!r} must not settle as total: {c['basis']} / {c['floor_gate']}")
    # The ATS summary is the posting's own words too. Ashby writes "Offers Equity" into
    # the tier summary (OpenAI's hourly band carries it) while the body can be silent.
    # The band here is under the floor so the gate CAN fire; pinned both ways, so the
    # case can fail: without the summary the same band still settles as total.
    # A K-notation summary that states TOTAL must gate its own band, which reached `pay`
    # rewritten in full dollars.
    for summ in ("$100K - $150K total compensation", "$100K \u2013 $150K total compensation",
                 "$100K\u2014$150K total compensation"):
        c = comp_verdict(["$100,000 - $150,000"], "Build agent tooling.", summ, targets=FIX)
        check(c["basis"] == "total" and c["floor_gate"] is True,
              f"a K-notation total summary must settle its band ({summ!r}): {c['basis']} / {c['floor_gate']}")
    # ...and the other way round: a pay string spelt with an en dash, a body with a hyphen.
    c = comp_verdict(["$100,000\u2013$150,000"], "Total compensation is $100,000 - $150,000.",
                      targets=FIX)
    check(c["basis"] == "total" and c["floor_gate"] is True,
          f"an en-dash pay string must still find its band: {c['basis']} / {c['floor_gate']}")
    OAI = ["$45.00 - $60.00 per hour"]
    c = comp_verdict(OAI, "Build agent tooling.", "$45 \u2013 $60 per hour \u2022 Offers Equity",
                      targets=FIX)
    check(c["basis"] != "total" and c["floor_gate"] is False,
          f"an ATS summary naming equity must stop the hourly total read: {c['basis']} / {c['floor_gate']}")
    c = comp_verdict(OAI, "Build agent tooling.", targets=FIX)
    check(c["basis"] == "total" and c["floor_gate"] is True,
          f"the same silent hourly band must still settle as total: {c['basis']} / {c['floor_gate']}")
    # ...and a structured yearly band is a band of unknown basis, never a gate on its own.
    c = comp_verdict(["$250,000 - $350,000"], "The body states no pay at all.", targets=FIX)
    check(c["low"] == 250_000 and c["basis"] == "unknown" and c["floor_gate"] is False,
          f"a structured yearly band must read as posted, basis unknown: {c['posted']} / {c['basis']}")

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
    # A gated LIVE req is kept in the shape eval-write's gate-closed path writes; a closed
    # posting is not kept at all.
    g = gated_packet({**base_p, "location_verdict": "fail", "location_why": "Texas only"})
    check(g and g.get("status") == "SKIP" and g.get("gate") == "Texas only" and "in_bounds" not in g,
          f"a location-gated req must be kept as a SKIP packet: {g and {k: g.get(k) for k in ('status', 'gate')}}")
    g = gated_packet({**base_p, "comp": sub_total})
    check(g and g.get("in_bounds") is False and g.get("gate", "").startswith("below floor"),
          f"a comp-gated req must be kept with in_bounds false: {g and g.get('in_bounds')}")
    check(gated_packet({**base_p, "live": False}) is None,
          "a closed posting must not be kept as a packet")
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
        # A company-hosted front end resolves with org = the matched portals.yml LABEL and
        # front_end set; its employer is that entry's base, never the label or a guess.
        for org, want in (("Blizzard Entertainment (notes)", "Blizzard Entertainment"),
                          ("Unrecorded Studio (notes)", None)):
            got = company_from({"url": "https://careers.example.com/global/en/job/R095439/x",
                                "org": org, "front_end": True, "ats": "workday"})
            check(got == want, f"front-end employer for {org!r}: {got!r}, want {want!r}")
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
    # ── A slug is a HINT, never a name (issue #12) ───────────────────────────
    # A title-cased board slug or host label used to be the last-resort company, and
    # eval-write's required check took "Weedmaps77" as filled. Only portals.yml, the hand
    # table, the ATS record's own name, or a tracker spelling that is not the mechanical
    # capitalisation itself may name an employer. Fake portals and tracker, as above.
    GH = "https://job-boards.greenhouse.io/"
    fake_boards = [dict(label="Whatnot (LA)", base="Whatnot", boards={"whatnot"}, workday=None)]
    with tempfile.TemporaryDirectory(prefix="evalprep-slug-") as _d:
        os.makedirs(os.path.join(_d, "data"))
        with open(os.path.join(_d, "data", "applications.md"), "w", encoding="utf-8") as fh:
            for i, co in enumerate(("Heygen", "Anduril Industries", "Disney"), 1):
                fh.write(f"| {i} | 2026-10-13 | {co} | Role | 3.0/5 | Evaluated | x | [r](r) | n |\n")
        with mock.patch.object(rr, "portals_index", lambda: fake_boards), \
                mock.patch.object(sys.modules[__name__], "ROOT", _d):
            for r, want, why in (
                    ({"url": GH + "weedmaps77/jobs/8623654667", "org": "weedmaps77"}, None,
                     "a bare Greenhouse slug names no one"),
                    ({"url": GH + "weedmaps77/jobs/8623654667", "org": "weedmaps77",
                      "company": "Weedmaps"}, "Weedmaps",
                     "the ATS record's own company_name is a name"),
                    ({"url": "https://www.sonypicturesjobs.com/job/-/-/22978/105825311512"}, None,
                     "a host label names no one"),
                    ({"url": GH + "heygen/jobs/5893099557", "org": "heygen"}, None,
                     "a tracker row that merely echoes the capitalised slug confirms nothing"),
                    ({"url": GH + "heygen/jobs/5893099557", "org": "heygen", "company": "HeyGen"},
                     "HeyGen", "a case-only tracker difference keeps the ATS spelling"),
                    ({"url": GH + "andurilindustries/jobs/1", "org": "andurilindustries"},
                     "Anduril Industries", "a tracker spelling a person wrote still vouches"),
                    ({"url": GH + "disneystudios/jobs/1", "org": "disneystudios",
                      "company": "Disney Studios"}, "Disney",
                     "an ATS name takes the tracker's word form, as merge-tracker keys on it"),
                    ({"url": "https://jobs.ashbyhq.com/whatnot/x", "org": "whatnot",
                      "company": "Whatnot {HQ}"}, "Whatnot",
                     "portals.yml still outranks the ATS name for a recorded board")):
                got = company_from(r)
                check(got == want, f"{why}: company_from gave {got!r}, want {want!r}")
            check(company_hint({"url": GH + "weedmaps77/jobs/8623654667", "org": "weedmaps77"})
                  == "weedmaps77", "the slug must survive as company_hint")
            check(company_hint({"url": "https://www.sonypicturesjobs.com/job/-/-/22978/1"})
                  == "sonypicturesjobs", "a host label must survive as company_hint")
            # Through prep() with the resolver's real shape, both branches.
            _gh = {"ats": "greenhouse", "live": True, "title": "Senior Software Engineer, AI",
                   "location": "Remote", "pay": [], "jd": "x", "org": "weedmaps77"}
            for extra, want in (({}, None), ({"company": "Weedmaps"}, "Weedmaps")):
                with mock.patch.object(rr, "resolve", lambda *a, **k: {**_gh, **extra}), \
                        mock.patch.object(sys.modules[__name__], "comp_verdict",
                                          lambda *a, **k: {}):
                    pk = prep(GH + "weedmaps77/jobs/8623654667")
                check(pk.get("company") == want and pk.get("company_hint") == "weedmaps77",
                      f"prep() company/hint with {extra or 'no ATS name'}: "
                      f"{pk.get('company')!r} / {pk.get('company_hint')!r}")
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
                       "r26710"),
                      # the facet suffix some Workday tenants append is not part of the id
                      ("https://nvidia.wd5.myworkdayjobs.com/en-US/X/job/US-CA-Santa-Clara/MLE_JR2846252-1",
                       "jr2846252")):
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
    jobs = [(u.strip(), None, None) for u in urls]
    if "--from-linkedin" in sys.argv:
        jobs += from_linkedin(sys.argv[sys.argv.index("--from-linkedin") + 1])
    if not jobs:
        print(__doc__); sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    disp = []
    for u, rec, employer in jobs:
        p = prep(u, rec)
        # The listing's own employer name fills a packet the ATS left unnamed; it never
        # overrides a name the ATS stated. It goes through the tracker's spelling, so the
        # company-scoped id guards see one employer, and it says where it came from: a
        # recruiter's repost or a parent brand can name someone else (Codex, 2026-10-29),
        # and eval-write's reviewer should be able to see that the name is LinkedIn's.
        if employer:
            p["linkedin_company"] = employer
            if not p.get("company"):
                p["company"] = tracker_spelling(employer)
                p["company_source"] = "linkedin listing"
        # Hard gates decide on their own and need no judgement, so they are recorded as
        # dispositions, or they come back in every future triage and get re-resolved and
        # re-rejected forever. A live one is ALSO kept as a gate-closed packet, so
        # eval-write gives it an unscored SKIP row; see gated_packet().
        # Comp is a hard gate ONLY when a band is actually posted; an unposted band is
        # unknown, not low, and unknown still needs a human read.
        gated = hard_gate(p)
        if gated:
            disp.append({"url": u, "disposition": gated})
            kept = gated_packet(p)
            if kept is None:
                print(f"SKIP ({gated})  {(p['title'] or u)[:56]}")
                continue
            name = packet_name(kept)
            write_packet(os.path.join(OUT_DIR, name), kept)
            print(f"GATED ({gated})  {(p['title'] or u)[:56]}\n"
                  f"      -> batch/eval-queue/{name}  (eval-write records it as an unscored SKIP row)")
            continue
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
        if not p.get("company"):
            print(f"      company UNNAMED: nothing but a slug or host names the employer "
                  f"(hint {p.get('company_hint')!r}); fill `company` or eval-write refuses it")
        print(f"      -> batch/eval-queue/{name}")

    if disp:
        record_dispositions(disp)
        print(f"\n{len(disp)} req(s) settled by a hard gate -> dispositions.json")
        print("   retire them with: node pipeline-audit.mjs --prune --dispositions=dispositions.json")
