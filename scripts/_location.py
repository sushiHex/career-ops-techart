"""_location.py: where the candidate can work, read from config/location.json.

Every Python tool that judges a location reads its policy here: the evaluation gate in
eval-prep.py, triage-leads.py, the Workday and NVIDIA sweeps and the dashboard builder. The
Node scanner reads the same file through location-core.mjs, so one file moves every gate.

The file is a LOCATION POLICY (see presets/locations/). `node setup.mjs` writes it from a
preset; presets/locations/california-socal.json is the worked example the gates were built
and tested against, and the template for adding another location.

A missing file is not an error. It falls back to presets/locations/remote-us.json, which
knows no home state and no commute area, so it passes nationwide remote, asks a human about
state-scoped remote, and fails onsite work. That is deliberately the least presumptuous
policy: it never passes an onsite role nobody said was reachable.

HOW A LOCATION IS READ is written down once, in presets/README.md, and implemented twice:
here and in location-core.mjs. The two used to be two different algorithms that were
patched toward each other finding by finding, and every round of patches produced new
disagreements. Now they are the same algorithm, step for step: every pattern that reads the
meaning of location text is DATA in presets/locations/_base-us.json ("grammar"), compiled by
both, and the tokeniser's own mechanics are written the same way in each. The functions
below keep the names and the order of their Node counterparts so a reader can hold the two
side by side.
"""
import json
import os
import re
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Where configuration lives. CAREER_OPS_CONFIG_DIR overrides it, which is how the test
# suite runs against no configuration at all regardless of whose files are installed.
CONFIG_DIR = os.environ.get("CAREER_OPS_CONFIG_DIR") or os.path.join(ROOT, "config")
CONFIG = os.path.join(CONFIG_DIR, "location.json")
PRESETS = os.path.join(ROOT, "presets", "locations")
FALLBACK = os.path.join(PRESETS, "remote-us.json")

# ---- the shared grammar --------------------------------------------------------------
BASE = json.load(open(os.path.join(PRESETS, "_base-us.json"), encoding="utf-8"))
G = BASE["grammar"]
NAME_BY_CODE = {**BASE["states_by_code"], **BASE.get("territories_by_code", {})}
STATE_CODES = set(NAME_BY_CODE)
STATE_ABBR = {n.lower(): c for c, n in NAME_BY_CODE.items()}     # name -> code
SPELLED_STATES = sorted(STATE_ABBR, key=len, reverse=True)
_ST = r"<[A-Z]{2}>"
_LIST = _ST + "(?:" + G["list_sep"] + _ST + ")*"


def _expand(p):
    return (p.replace("{LIST}", _LIST).replace("{ST}", _ST)
             .replace("{US}", G["us"]).replace("{R}", G["remote"]))


def _compile(key):
    flags = 0 if key in G["case_sensitive"] else re.I
    v = G[key]
    return [re.compile(_expand(p), flags) for p in v] if isinstance(v, list) else re.compile(_expand(v), flags)


RX = {k: _compile(k) for k in (
    "remote", "remote_friendly", "remote_hybrid", "us", "city_suffix", "time_zone_words", "time_zone_abbrev",
    "time_zone_us_paren", "placeholder", "nationwide", "exclusion_lead", "exclusion_trail", "weak_context",
    "scope_shapes", "metro_scope", "chunk_split", "sentence_break", "place_split", "place_donor",
    "undetermined", "travel_phrase", "preference_after", "context_before", "negation_before")}


def _repl(r):
    """A JavaScript "$1" replacement as Python's "\\1"."""
    return re.sub(r"\$(\d)", r"\\\1", r)


FOLDS = [(re.compile(p, re.I), _repl(r)) for p, r in G["folds"]]
PLACE_BREAK = (re.compile(G["place_break"][0], re.I), _repl(G["place_break"][1]))
# Whitespace JavaScript's \s does not know, made plain before either engine reads the text.
_ODD_SPACE = re.compile(r"[\x1c-\x1f\x85]")
TOKEN = re.compile(r"<([A-Z]{2})>")
OPTION_SPLIT = re.compile(r"\s*(?:[;|·•\n])\s*")
_ALT_SPLIT = re.compile(r"\s+or\s+|\s*/\s*", re.I)
_NAMES = re.compile(r"(?<![A-Za-z])(" + "|".join(re.escape(n) for n in SPELLED_STATES) + r")(?![A-Za-z])", re.I)
_CODE = re.compile(r"(?<![A-Za-z0-9<])([A-Z]{2})(?![A-Za-z0-9>])")
_RUN = re.compile(r"(?<![A-Za-z0-9<])[A-Z]{2}(?:\s*(?:,|/|&|\s(?:or|and)\s)\s*[A-Z]{2})+(?![A-Za-z0-9>])")
_CODE_BEFORE = re.compile(G["code_before"], re.I)
_CODE_AFTER = re.compile(G["code_after"], re.I)
AMBIGUOUS = {c: tuple(r) for c, r in G["ambiguous_codes"].items()}
TZ_CODES = set(G["time_zone_codes"])
COUNTRY_LIKE = set(G["country_like_codes"])


def _signal_case(k):
    """A signal's state field in capitals, so a hand-typed "ontario, ca" still meets
    "Ontario, <CA>". location-core.mjs signalCase() is the same step."""
    return re.sub(r",\s*([a-z]{2})\s*$", lambda m: ", " + m.group(1).upper(), str(k), flags=re.I)


def _alternation(words, flags=re.I):
    items = sorted({w.strip() for w in words or [] if w and w.strip()}, key=len, reverse=True)
    if not items:
        return re.compile(r"(?!x)x")
    return re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(re.escape(w) for w in items) + r")(?![A-Za-z0-9])", flags)


BLOCKED = _alternation(BASE["blocked_geo"])
BLOCKED_CODES = _alternation(BASE["blocked_codes"], 0)


def fold(text):
    """Diacritics stripped, and the DC and New York City spellings folded to one form
    each (grammar "folds"). location-core.mjs foldOption() is the same function."""
    t = "".join(c for c in unicodedata.normalize("NFD", text or "") if unicodedata.category(c) != "Mn")
    t = _ODD_SPACE.sub(" ", t)
    for rx, rep in FOLDS:
        t = rx.sub(rep, t)
    return t.strip()


def tokenize(text, home=None, us_place=False):
    """The option with every state it names replaced by a token like <TX> (spec section
    2). After this, no pattern can mistake a code for a word or a word for a code.
    `us_place` reads a policy's own entry, which is always a US place: "Dublin, CA" in a
    California policy is Dublin, California, whatever Dublin means in a posting."""
    t = fold(text)
    blocked = not us_place and bool(BLOCKED.search(t) or BLOCKED_CODES.search(t))
    # Names, unless part of a city name: "New York City", "Kansas City", "Washington, PA".
    out, last = [], 0
    for m in _NAMES.finditer(t):
        after = t[m.end():]
        if RX["city_suffix"].match(after):
            continue
        city = re.match(r"\s*,\s*([A-Z]{2})(?![A-Za-z])", after)
        if city and city.group(1) in STATE_CODES:
            continue
        out += [t[last:m.start()], "<%s>" % STATE_ABBR[m.group(1).lower()]]
        last = m.end()
    t = "".join(out) + t[last:]
    # Codes, only in a field position or a run of codes.
    tz = bool(RX["time_zone_words"].search(t) or RX["time_zone_abbrev"].search(t))
    tz_spans = [m.span() for m in RX["time_zone_us_paren"].finditer(t)]
    runs = set()
    for m in _RUN.finditer(t):
        toks = [(x.start() + m.start(), x.group(0)) for x in re.finditer(r"[A-Z]{2}", m.group(0))]
        if all(c in STATE_CODES for _, c in toks):
            runs |= {s for s, _ in toks}
    out, last = [], 0
    for m in _CODE.finditer(t):
        c, s, e = m.group(1), m.start(), m.end()
        if c not in STATE_CODES:
            continue
        in_run = s in runs
        if not in_run and not (_CODE_BEFORE.search(t[:s]) and _CODE_AFTER.match(t[e:])):
            continue
        if c in COUNTRY_LIKE and blocked:
            continue                                   # "Toronto, CA" is Canada
        if c != home and c in AMBIGUOUS:
            lo, hi = AMBIGUOUS[c]
            zip_ = re.match(r"\s*(\d{5})", t[e:])
            if not (in_run or re.search(r",\s*$", t[:s])) or (zip_ and not lo <= int(zip_.group(1)[:3]) <= hi):
                continue                               # "Los Angeles (LA)", "Marina del Rey, LA 90066"
        # A time zone is a time zone even for someone who lives in Montana.
        if c in TZ_CODES and (tz or any(a <= s < b for a, b in tz_spans)):
            continue                                   # Central / Mountain time
        out += [t[last:s], "<%s>" % c]
        last = e
    return "".join(out) + t[last:]


def tokens(n):
    return set(TOKEN.findall(n or ""))


def exclusions(n):
    """(codes, text): the states an eligibility exclusion names, and the text with every
    exclusion clause removed, so an excluded state is never read as the scope."""
    codes, spans = set(), []
    for rx in (RX["exclusion_lead"], RX["exclusion_trail"]):
        for m in rx.finditer(n):
            got = tokens(m.group(1))
            if got:
                codes |= got
                spans.append(m.span())
    for s, e in sorted(spans, reverse=True):
        n = n[:s] + " " + n[e:]
    return codes, n


def scope_of(n):
    """States named in a SCOPE POSITION (spec 5.4)."""
    found = set()
    for rx in RX["scope_shapes"]:
        for m in rx.finditer(n):
            if not RX["negation_before"].search(n[:m.start()]):   # "not required to reside in TX"
                found |= tokens(m.group(1))
    return found


def no_travel(n):
    """The text without its travel phrases: where someone travels is not where the job is."""
    return RX["travel_phrase"].sub(" ", n)


def weak_states(n):
    """States named outside a scope position, minus those in a preference or travel
    context ("Colorado preferred", "travel to Austin, TX"), which are ignored."""
    for rx in RX["weak_context"]:
        n = rx.sub(" ", n)
    return tokens(n)


def split_options(loc):
    return [o for o in OPTION_SPLIT.split(loc or "") if o.strip()]


def is_remote(n):
    """A remote OFFER. "Remote-friendly" and "hybrid remote" are not: both are hybrid
    policies with recurring office days, so they are read as onsite at the place named."""
    return bool(RX["remote"].search(RX["remote_hybrid"].sub(" ", RX["remote_friendly"].sub(" ", n))))


def _pure_country(n):
    """Nothing but country names: "United States", "United States, Canada"."""
    rest = BLOCKED.sub(" ", BLOCKED_CODES.sub(" ", RX["us"].sub(" ", n)))
    return bool(RX["us"].search(n)) and not re.sub(r"[^A-Za-z0-9]+", "", rest)


def _bare_remote(n):
    rest = RX["remote"].sub(" ", n)
    rest = re.sub(r"\b(?:anywhere|fully)\b", " ", rest, flags=re.I)
    return not re.sub(r"[^A-Za-z0-9]+", "", rest)


class Policy:
    """A loaded location policy with its matchers compiled."""

    def __init__(self, data, source):
        self.data = data
        self.source = source
        self.name = data.get("name") or os.path.splitext(os.path.basename(source))[0]
        home = data.get("home_state") or {}
        self.home_code = (home.get("code") or "").strip().upper() or None
        self.home_name = home.get("name") or NAME_BY_CODE.get(self.home_code or "") or None
        commute = data.get("commute") or {}
        self.commute_label = commute.get("label") or "Commute"
        out = data.get("same_state_out") or {}
        self.out_label = out.get("label") or "outside the commute"
        # Signals are tokenised exactly as postings are, so they meet on one text:
        # "Washington, DC" is <DC> on both sides, "Carson, CA" is "Carson, <CA>". An entry is
        # read both as a posting would read it and as the US place it is, since a posting's
        # "Dublin, CA" may keep its CA as Canada while "Dublin, California" never does.
        def sig(xs):
            out = []
            for x in xs or []:
                for us in (False, True):
                    t = tokenize(_signal_case(x), self.home_code, us_place=us)
                    if t not in out:
                        out.append(t)
            return out
        self.commute_signals = sig(commute.get("signals"))
        self.commute_re = self._matcher(self.commute_signals)
        # "Arlington, VA" also meets "US, VA, Arlington" and "Arlington or Richmond, VA":
        # the city alone, wherever the place's own or inherited state is that state.
        self.commute_cities = []
        for s in self.commute_signals:
            m = re.match(r"^(.*\S),\s*<([A-Z]{2})>$", s)
            if m and not TOKEN.search(m.group(1)):
                self.commute_cities.append((self._matcher([m.group(1)]), m.group(2)))
        # A place list that names only "New York" means the city (grammar state_as_city).
        self.state_as_city = {c: tokenize(v, self.home_code) for c, v in G["state_as_city"].items()}
        self.out_re = self._matcher(sig(out.get("signals")))
        self.far_re = self._matcher(sig((out.get("signals") or []) + list(data.get("hard_out_metro") or [])))
        # OTHER states a commute entry names in its own state field (spec, top).
        self.commute_states = set().union(*(tokens(x) for x in self.commute_signals)) \
            - {self.home_code} if self.commute_signals else set()
        mode = data.get("onsite_outside_commute", "fail")
        if mode not in ("fail", "unknown"):
            raise ValueError(f"{source}: onsite_outside_commute must be 'fail' or 'unknown', "
                             f"not {mode!r}")
        self.onsite_elsewhere = mode

    @staticmethod
    def _matcher(signals):
        """Word-bounded, case-insensitive; a short all-capitals signal ("NYC") matches
        only in capitals, so it cannot match an ordinary word."""
        ci = [s for s in signals if not (len(s) <= 3 and s.isupper())]
        cs = [s for s in signals if len(s) <= 3 and s.isupper()]
        a, b = _alternation(ci), _alternation(cs, 0)

        class M:
            def search(self, t):
                return a.search(t) or b.search(t)

            def finditer(self, t):
                return list(a.finditer(t)) + list(b.finditer(t))
        return M()

    # ---- the questions other tools ask ---------------------------------------------
    def reachable(self):
        return ({self.home_code} if self.home_code else set()) | self.commute_states

    def states_in(self, text):
        return tokens(tokenize(text, self.home_code))

    def names_home(self, text):
        return bool(self.home_code) and self.home_code in self.states_in(text)

    def names_other_state(self, text):
        return bool(self.states_in(text) - self.reachable())

    def in_commute(self, text):
        return bool(self.commute_re.search(tokenize(text, self.home_code)))

    def in_same_state_out(self, text):
        return bool(self.out_re.search(tokenize(text, self.home_code)))

    def in_far_metro(self, text):
        return bool(self.far_re.search(tokenize(text, self.home_code)))

    def in_commute_area(self, text):
        return self._commute_in(tokenize(text, self.home_code)) == "pass"

    # ---- spec section 4: an option with a commute place passes ----------------------
    def _commute_in(self, n):
        """"pass" when some place in the option is a commute place; "ambiguous" when the
        only thing against one is a state it INHERITED from a later "City, ST" ("Los
        Angeles or Austin, TX" reads Los Angeles as Texan, and the text cannot settle
        that); otherwise None."""
        onsite = not is_remote(n)
        ambiguous = False
        chunked = RX["sentence_break"].sub(lambda m: m.group(1) + "\n", n)
        chunked = PLACE_BREAK[0].sub(PLACE_BREAK[1], chunked)
        for chunk in RX["chunk_split"].split(chunked):
            pieces = RX["place_split"].split(chunk)
            # A place with no state takes the state of the next "City, ST" place in the
            # same list, never of a remote alternative or a bare state name.
            states, carry = [], set()
            for p in reversed(pieces):
                own = tokens(p)
                if own:
                    carry = own if (RX["place_donor"].match(p) and not is_remote(p)) else set()
                    states.append((own, True))
                else:
                    states.append((carry, False))
            states.reverse()
            for p, (st, owned) in zip(pieces, states):
                probe = p
                # A place that is nothing but "New York" is the city, in a list of places.
                bare = TOKEN.fullmatch(p.strip())
                if onsite and bare and bare.group(1) in self.state_as_city:
                    probe = self.state_as_city[bare.group(1)]
                hits = [m.span() for m in self.commute_re.finditer(probe)]
                clash = False
                for rx, code in self.commute_cities:
                    found = [m.span() for m in rx.finditer(probe)]
                    if found and (not st or code in st):
                        hits += found
                    elif found:
                        clash = True        # "Carson or Austin, TX" against "Carson, CA"
                if not hits:
                    ambiguous = ambiguous or (clash and not owned)
                    continue
                # A far metro over the match voids it ("Walnut" inside "Walnut Creek").
                outs = [m.span() for m in self.far_re.finditer(probe)]
                if all(any(a < d and c < b for c, d in outs) for a, b in hits):
                    continue
                # So does a foreign place BESIDE it when no US state is named: "Dublin,
                # Ireland" is not the Dublin in an Ohio commute list. The match itself may
                # be a foreign name too ("Dublin" alone), which settles nothing.
                trips = [m.span() for m in RX["travel_phrase"].finditer(probe)]
                abroad = [m.span() for rx in (BLOCKED, BLOCKED_CODES) for m in rx.finditer(probe)
                          if not any(a <= m.start() < b for a, b in trips)]
                if not tokens(probe) and not RX["us"].search(probe) and any(
                        not any(a < d and c < b for a, b in hits) for c, d in abroad):
                    continue
                if st - self.reachable():
                    ambiguous = ambiguous or not owned
                    continue
                return "pass"
        return "ambiguous" if ambiguous else None

    def _far_here(self, n):
        """A far metro named as a place, not as a preference, an office or a trip ("Bay
        Area preferred", "HQ in San Francisco")."""
        return any(not RX["preference_after"].search(n[m.end():])
                   and not RX["context_before"].search(n[:m.start()])
                   for m in self.far_re.finditer(n))

    # ---- spec sections 3, 5 and 6: one option --------------------------------------
    def classify(self, n, excluded=frozenset(), whole=True):
        """(verdict, reason, kind) for one tokenised option. location-core.mjs
        classifyNormalised() is the same function, step for step."""
        home = self.home_code
        remote = is_remote(n)
        friendly = bool(RX["remote_friendly"].search(n))
        codes, n = exclusions(n)
        if remote:
            codes |= set(excluded)
        home_out = bool(remote and home and home in codes)
        named = tokens(n)
        us = bool(RX["us"].search(n))
        stay = no_travel(n)
        abroad = bool(BLOCKED.search(stay) or BLOCKED_CODES.search(stay))
        foreign = abroad and not named and not us
        if remote and not home_out and not foreign and RX["nationwide"].search(n):
            return "pass", "remote, open nationwide", "remote"
        if remote and whole:
            alts = _ALT_SPLIT.split(n)
            if len(alts) > 1:
                for a in alts:
                    if is_remote(a):
                        v = self.classify(a, codes, whole=False)
                        if v[0] == "pass":
                            return v
        commute = self._commute_in(n)
        if commute == "pass":
            return "pass", f"{self.commute_label}, inside the commute ceiling", "commute"
        if remote and not home_out:
            if foreign:
                return "fail", "remote, but only from outside the US", "foreign"
            scope = scope_of(n)
            metro = RX["metro_scope"].search(n)
            if metro:
                st = next(iter(tokens(metro.group(1))))
                qual = metro.group(2)
                if st == home and re.search(r"\bmetro\b", qual, re.I):
                    if self._commute_in(qual) == "pass":
                        return "pass", f"remote within a {self.commute_label} metro", "remote"
                    if self.far_re.search(qual):
                        label = re.sub(r"\s*\bmetro\b.*$", "", qual.strip(" -–—"), flags=re.I)
                        return "fail", f"remote only within the {label} metro, outside the commute", "scoped"
                    return "unknown", (f"remote within a {self.home_display} metro the policy does "
                                       "not list; check whether it is inside the commute area"), "metro"
                scope.add(st)
            if scope:
                if scope & self.reachable():
                    if self._far_here(n):
                        return "unknown", ("remote in " + ", ".join(sorted(scope)) + ", naming a metro "
                                           "outside the commute; check whether the offer is limited to "
                                           "that metro"), "metro"
                    return "pass", "remote-US (scoped to " + ", ".join(sorted(scope)) + ")", "remote"
                if not home:
                    return "unknown", ("remote is scoped to specific states (" + ", ".join(sorted(scope))
                                       + ") and no home state is configured in config/location.json "
                                       "to judge them"), "scoped"
                return "fail", ("remote is scoped to states the candidate cannot use ("
                                + ", ".join(sorted(scope)) + f"), no {self.home_display} entry"), "scoped"
            mentioned = weak_states(n)
            weak = mentioned - self.reachable()
            if weak:
                return "unknown", ("remote, and it names " + ", ".join(sorted(weak))
                                   + " in a way that does not settle the scope"), "weak"
            # Every state it names is one the candidate reaches, so whether that is the
            # scope or an office, the offer is open to them; unless the place is a far
            # metro, which may mean remote from within that metro only.
            if mentioned:
                if self._far_here(n):
                    return "unknown", ("remote, naming a metro outside the commute; check whether "
                                       "the offer is limited to that metro"), "metro"
                return "pass", "remote, naming only " + ", ".join(sorted(mentioned)), "remote"
            if us or _bare_remote(n):
                return "pass", "remote-US", "remote"
            return "unknown", "remote, but the region is not recognised", "unrecognised"
        if home_out:
            return "fail", f"remote everywhere except {self.home_display}", "excluded"
        if RX["undetermined"].search(n):
            return "unknown", "the posting has not settled the location", "undetermined"
        if foreign:
            return "fail", "non-US country or city", "foreign"
        if commute == "ambiguous":
            return "unknown", (f"names a {self.commute_label} commute place, but the list may give it "
                               "another state's; check which city is meant"), "ambiguous"
        if self.far_re.search(n):
            label = self.out_label if self.out_re.search(n) else f"a metro outside the {self.commute_label} commute"
            return self.onsite_elsewhere, label, "far"
        if named - self.reachable():
            return self.onsite_elsewhere, (f"US, outside the {self.commute_label} commute ceiling "
                                           "and not remote"), "elsewhere"
        if named:
            return "unknown", f"a place in {self.home_display} the commute list does not name", "unlisted"
        if friendly:
            return "unknown", ("remote-friendly means recurring days at a named hub and none of "
                               f"them is inside the {self.commute_label} ceiling; read the posting's "
                               "in-office clause before judging"), "remote_friendly"
        if _pure_country(n):
            return "unknown", "a country, not a place", "country"
        return "unknown", "location not recognised", "unrecognised"

    # ---- spec section 1: a posting -------------------------------------------------
    def decide(self, loc):
        """(verdict, reason, kind) for a whole posting: its options combined, any workable
        option wins. `loc` is one string or a structured list of options, as in
        location-core.mjs decideLocations(), which is the same function."""
        if isinstance(loc, (list, tuple)):
            opts = [o for item in loc for o in split_options("" if item is None else str(item))]
        else:
            opts = split_options(loc)
        real = [o for o in opts if not RX["placeholder"].match(fold(o))]
        if not real:
            if opts:
                return "unknown", "placeholder location, resolve from the posting body", "placeholder"
            return "unknown", "no location returned", "none"
        norm = [tokenize(o, self.home_code) for o in real]
        # An exclusion in an option of its own applies to the posting's remote options.
        dangling, kept = set(), []
        for n in norm:
            if not is_remote(n):
                got, rest = exclusions(n)
                if got and not re.sub(r"[^A-Za-z0-9]+", "", rest):
                    dangling |= got
                    continue
            kept.append(n)
        results = [self.classify(n, dangling) for n in kept]
        # A bare "Remote" beside options that are all foreign could be that country's.
        bare = [i for i, n in enumerate(kept) if is_remote(n) and _bare_remote(n)]
        others = [r for i, r in enumerate(results) if i not in bare]
        if bare and others and all(r[2] == "foreign" for r in others):
            for i in bare:
                results[i] = ("unknown", "a bare remote entry next to a non-US place; confirm which "
                              "country the remote option covers before judging", "ambiguous")
        for want in ("pass", "unknown", "fail"):
            for r in results:
                if r[0] == want:
                    return r
        # Every option was an exclusion with nothing to exclude from ("except CA").
        return "unknown", "no option could be read", "none"

    @property
    def home_display(self):
        return self.home_name or self.home_code or "your home state"


def load(path=None):
    """The configured policy, or the neutral fallback when none is configured."""
    # A selftest never reads the user's policy, even through a module it imports.
    import sys
    use_config = os.path.exists(CONFIG) and "--selftest" not in sys.argv
    p = path or (CONFIG if use_config else FALLBACK)
    with open(p, encoding="utf-8") as fh:
        return Policy(json.load(fh), p)


def preset(name):
    """A named preset from presets/locations/, for self-tests and for setup."""
    return load(os.path.join(PRESETS, name + ".json"))


def _selftest():
    bad = ran = 0

    def check(ok, msg):
        nonlocal bad, ran
        ran += 1
        if not ok:
            bad += 1
            print("  FAIL", msg)

    ca = preset("california-socal")
    check(ca.home_code == "CA" and ca.names_home("US, CA, Remote"), "CA preset names CA")
    check(ca.in_commute("Irvine, California") and ca.in_commute("Ontario, CA"),
          "CA commute signals match")
    check(not ca.in_commute("Carlsbad, California"),
          "Carlsbad is outside the SoCal geofence (it is ~60 miles out)")
    check(ca.in_same_state_out("Santa Clara, CA") and not ca.in_same_state_out("Irvine"),
          "Bay Area is same-state-out, Irvine is not")
    check(not ca.names_home("Cary, North Carolina"), "a word containing 'ca' is not CA")
    ore = Policy({"home_state": {"code": "OR", "name": "Oregon"}}, "fixture:or")
    check(not ore.names_home("Remote - Washington or California") and ore.names_home("US, OR, Remote"),
          "the word 'or' is not Oregon; the slot code is")
    check(ca.in_commute_area("Glendale, CA") and not ca.in_commute_area("Glendale, AZ")
          and not ca.in_commute_area("Walnut Creek, CA"),
          "the guarded commute match rejects other states and out-of-range metros")
    wa = Policy({"home_state": {"code": "WA", "name": "Washington"}}, "fixture:wa")
    check(not wa.names_home("Washington, DC") and "DC" in tokens(tokenize("Washington D.C.")),
          "Washington, DC is not Washington state")
    check(tokenize("Portland, OR (Remote)") == "Portland, <OR> (Remote)"
          and tokenize("Irvine, CA (IN-PERSON)") == "Irvine, <CA> (IN-PERSON)"
          and tokenize("Missouri City, TX") == "Missouri City, <TX>"
          and tokenize("Remote - US (CT)") == "Remote - US (CT)"
          and tokenize("US, CT, Stamford") == "US, <CT>, Stamford",
          "tokens: Oregon's OR, IN-PERSON, a state name inside a city name, CT as a time zone and as a state")
    neutral = preset("remote-us")
    check(neutral.home_code is None and not neutral.in_commute("Los Angeles"),
          "the neutral preset knows no home and no commute area")
    check(not neutral.names_home("US, CA, Remote"), "no home state means nothing names it")
    # Another state, built the way setup.mjs builds one, must work with no code change.
    tx = Policy({"home_state": {"code": "TX", "name": "Texas"},
                 "commute": {"label": "Austin", "signals": ["Austin", "Round Rock"]},
                 "same_state_out": {"label": "Houston", "signals": ["Houston"]}}, "fixture")
    check(tx.names_home("Texas - Remote") and tx.in_commute("Round Rock, TX")
          and tx.in_same_state_out("Houston, TX") and not tx.in_commute("Irvine"),
          "a Texas policy works from data alone")
    # A hand-written or agent-written policy may pad the code; the home state is still TX.
    padded = Policy({"home_state": {"code": " tx "}}, "fixture")
    check(padded.home_code == "TX" and padded.names_home("US, TX, Remote"),
          "a padded home code is trimmed")
    # A structured option list, as the Node gate takes it; and a posting of nothing but an
    # exclusion, which used to raise IndexError here while Node answered unknown.
    check(ca.decide(["Austin, TX", "Irvine, CA"])[0] == "pass" and ca.decide("except CA")[0] == "unknown",
          "decide takes a list and survives an exclusion-only posting")
    houston = Policy({"home_state": {"code": "TX"}, "commute": {"signals": ["Houston", "Missouri City"]}}, "f")
    check(houston.commute_states == set(), "a state name inside a city name reaches no state")
    try:
        Policy({"onsite_outside_commute": "maybe"}, "fixture")
        check(False, "an invalid onsite_outside_commute must raise")
    except ValueError:
        pass
    # Counted, not written down: a literal stayed at 12 while checks were added.
    print(f"_location selftest: {ran} checks, {bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    pol = load()
    print(f"{pol.name} ({pol.source}): home {pol.home_display}, "
          f"{len(pol.commute_signals)} commute signals, onsite elsewhere -> {pol.onsite_elsewhere}")
