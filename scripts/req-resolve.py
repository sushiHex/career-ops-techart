#!/usr/bin/env python
"""req-resolve.py — resolve posting URLs across every ATS the board actually uses.

Checking sixty reqs by hand is what makes a triage backlog permanent. Each ATS
publishes the same three facts through a different endpoint, so this normalises
them: is it live, where is it, what does it pay.

Supported: Greenhouse, Ashby, Lever, Workday (any tenant), Netflix/Eightfold.
Anything else returns UNSUPPORTED rather than a guess, because a wrong location
verdict is worse than a missing one under a hard no-relocation constraint.

Reads a JSON array of {url, role, source} on stdin, or URLs as arguments.

  node pipeline-audit.mjs --rank --json | python scripts/req-resolve.py --stdin
"""
import datetime, html, json, os, re, subprocess, sys
import urllib.request, urllib.error, urllib.parse

# `from _httpctx import ...` resolves only because sys.path[0] is this file's directory
# when it is run as a script. Loaded through importlib from anywhere else, which is how
# eval-prep, check-remote and the test suite reach it, that import raises
# ModuleNotFoundError instead. Put the directory on the path first so the module works the
# same whichever way it is entered.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _httpctx import CTX, is_tls_failure
# Ashby's posting API is opt-in per organisation, so a 404 from it settles nothing. The
# board page carries every posting in window.__appData, and find-ats.py and
# providers/ashby.mjs both already fall back to it. Share the one brace matcher.
import _ashby_embed  # noqa: E402  (same directory; sys.path is set two lines up)
ROOT = os.path.dirname(_HERE)


def _req_id_from_sweep():
    """The Workday requisition pattern, READ from the one sanctioned Python copy.

    That pattern has already been written out in four spellings and every divergence was
    a silent miss rather than an error, so a fifth copy here is the thing to avoid.
    pipeline-audit.mjs --selftest reads scripts/workday-sweep.py and asserts its REQ_ID
    SOURCE is character-for-character equal to req-id-core.mjs, so taking the text from
    that file keeps this consumer inside an assertion that already exists.

    The module cannot simply be imported the way eval-blockers.py imports it: workday-sweep
    pulls in eval-prep, and eval-prep imports THIS file, so the import is circular. Reading
    the source is the same single source of truth without the cycle.

    There is deliberately no fallback pattern. A fallback would be a fifth copy, and a
    fifth copy is exactly the silent divergence this is meant to prevent.
    """
    src = open(os.path.join(_HERE, "workday-sweep.py"), encoding="utf-8",
               errors="replace").read()
    m = re.search(r'REQ_ID = re\.compile\(\s*r"([^"]+)"\s*\)', src)
    if not m:
        raise RuntimeError(
            "scripts/workday-sweep.py no longer declares REQ_ID as one raw string; "
            "req-resolve reads the requisition pattern from there rather than keeping "
            "a fifth copy of it")
    # Compiled case-INSENSITIVELY, which is a composition of the shared pattern rather
    # than a redefinition of it: the source text is untouched and the selftest asserts it
    # still matches workday-sweep.py character for character. The flag is needed because
    # a Workday FRONT END does not have to spell the id the way the tenant does, and
    # careers.salesforce.com writes /en/jobs/jr343369/ in lower case, which the shared
    # pattern misses entirely. The sweeps read the id out of a CXS externalPath, where it
    # is always upper case, so they never needed this.
    return re.compile(m.group(1), re.I)


WD_REQ_ID = _req_id_from_sweep()

# How far a tenant's fuzzy `searchText` result set is walked before the question is handed
# back unanswered. Five pages is generous for a query that is a requisition id: the exact
# match ranks at or near the top on every tenant seen so far, and a board that serves more
# than a hundred results for one id is not a search this file should be closing a row on.
WD_SEARCH_LIMIT = 20
WD_SEARCH_PAGES = 5

# A Workday path segment that is a LOCALE and not a site name. By SHAPE, never by length:
# Autodesk's real site is `Ext`, so a length bound mistakes a site for a locale, and a
# locale-only url (`.../nvidia.wd5.myworkdayjobs.com/en/job/...`) mistakes the locale for
# a site and fabricates a CXS path whose 404 is about the fabrication. Both directions cost
# real rows, and both are recorded in CLAUDE.md.
#
# THE SOURCE, and inbox-liveness.py reads it from here rather than keeping a second copy.
# That file's selftest asserts it holds no copy of its own, because four hand copies of the
# requisition pattern have already drifted in this repo and every divergence was a silent
# miss rather than an error.
WD_LOCALE_ONLY = re.compile(r"^[a-z]{2}(?:-[a-z]{2})?$", re.I)


def canon_req(s):
    """One requisition, one id. `R-13733`, `R_13733` and `r13733` are the same req.

    A hand copy of canon_req() in workday-sweep.py, and deliberately so: that module
    imports eval-prep, which imports THIS file, so importing it back would be a cycle.
    What must never be duplicated is the PATTERN, and it is not: WD_REQ_ID above is read
    out of workday-sweep's own source text and the selftest asserts the two still match
    character for character. This is a three-character normaliser, not a definition of
    what a requisition looks like.
    """
    return str(s or "").upper().replace("-", "").replace("_", "")

# Job titles are not ASCII. One board carries a Japanese title, and the default
# Windows stdout codec (cp1252) raises on it, taking the whole run down after all
# the network work is already done. Force UTF-8 on the way out.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
HDRS = {"User-Agent": UA, "Accept": "application/json"}
# Not every employer writes a dollar sign. NVIDIA posts "184,000 USD - 287,500 USD",
# so a $-anchored pattern dropped its bands entirely and every NVIDIA req came back
# with no comp at all.
PAY = re.compile(
    r"\$\s?[\d,]{5,}(?:\s*(?:-|to|–|—)\s*\$?\s?[\d,]{5,})?"
    r"|[\d,]{6,}\s*USD(?:\s*(?:-|to|–|—)\s*[\d,]{6,}\s*USD)?")
TAG = re.compile(r"<[^>]+>")

# Host labels that describe the page rather than the company. careers.roblox.com is
# roblox; unity.com is still unity.
HOST_NOISE = {"www", "careers", "career", "jobs", "job", "boards", "board",
              "apply", "hire", "hiring", "work", "com", "io", "ai", "co",
              "net", "org", "dev", "gg", "us", "inc"}
# Eightfold tenants whose apply-API `domain` parameter this file RECORDS rather than
# derives, because it is not derivable: explore.jobs.netflix.NET answers to netflix.COM,
# mercadolibre.eightfold.ai publishes mercadolibre.com, and anywhere.eightfold.ai
# publishes volkscience.com. A recorded domain is declared evidence and its 404 may close
# a row; a domain this code derived from the hostname may never close one. Add a host here
# only once its apply API has actually been seen to answer.
EIGHTFOLD_DOMAINS = {
    "explore.jobs.netflix.net": "netflix.com",
    "jobs.nvidia.com": "nvidia.com",       # verified 2026-09-20, HTTP 200
}
# Hosts belonging to an ATS rather than to an employer. A portals.yml entry is identified
# by the company's OWN domain, so these must never be read as its identity: indexing them
# would file every Greenhouse-hosted employer in the file under the key "greenhouse" and
# hand back the wrong company's board slug.
ATS_HOST = re.compile(
    r"greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|"
    r"breezy\.hr|workable\.com|successfactors|jobvite|eightfold|gem\.com|avature|"
    r"icims\.com|taleo\.net|github\.careers|jobs\.netflix\.net|jobs\.apple\.com|"
    r"amazon\.jobs", re.I)
# The same vendors as they appear INSIDE A PATH, which is where a redirect puts its
# destination when it drops the scheme. Deliberately NOT ATS_HOST, and the difference is
# the point: that pattern answers "is this parsed HOSTNAME a vendor's" and is loose on
# purpose, carrying `successfactors`, `jobvite`, `eightfold` and `avature` with no domain
# at all, which is correct against a host and wrong against a path. Matching those loose
# forms in a path would call `careers.acme.com/successfactors/job/x/123456` a wrapper when
# it is a company's own page with a telling folder name. So every entry here is a real
# hostname ending in its real suffix, and it must be followed by a path separator, which
# is what a redirect destination always has.
ATS_IN_PATH = re.compile(
    r"(?<![\w.-])(?:[\w-]+\.)*(?:greenhouse\.io|ashbyhq\.com|lever\.co"
    r"|myworkdayjobs\.com|smartrecruiters\.com|breezy\.hr|workable\.com"
    r"|successfactors\.com|jobvite\.com|eightfold\.ai|avature\.net|icims\.com"
    r"|taleo\.net|github\.careers|amazon\.jobs|apple\.com|netflix\.net)[/?#]", re.I)
# Every spelling of a Greenhouse board URL that portals.yml actually carries: the
# zero-token api: line, the job-boards/boards careers_url, and the embed snippet.
GH_SLUG = re.compile(
    r"boards-api\.greenhouse\.io/v1/boards/([\w-]+)"
    r"|(?:job-boards|boards)\.greenhouse\.io/(?:embed/job_board(?:/js)?\?for=)?([\w-]+)")
# The snippet a company-hosted careers page uses to embed its Greenhouse board. BOTH
# spellings have to be here. The standard loader is
# `boards.greenhouse.io/embed/job_board/js?for=SLUG`, and a pattern that knew only the
# older `embed/job_board?for=` failed its optional group against it, so ([\w-]+) captured
# the literal word "embed", probed a board named embed, and reported "no valid board" for
# a company that was on Greenhouse the whole time.
GH_EMBED = re.compile(
    r"(?:boards|job-boards)\.greenhouse\.io/(?:embed/job_board(?:/js)?\?for=)?([\w-]+)"
    r"|greenhouse\.io/embed/job_board(?:/js)?\?for=([\w-]+)")
# Path words that are never a board slug. Whichever greenhouse.io URL shape appears first
# on the page wins, so a stray one has to be skipped rather than probed: probing "embed"
# costs a request and, worse, reads as a discovery.
GH_NOT_A_SLUG = {"embed", "job_board", "js", "jobs", "v1", "boards", "job-boards"}
_PORTALS = None


def portals_path():
    """The user's portals.yml, or CAREER_OPS_PORTALS when set. The selftests point that at
    test-fixtures/portals.yml: portals.yml is User Layer and absent on a fresh clone,
    so a suite that read it passed only on a machine that already had one."""
    return os.environ.get("CAREER_OPS_PORTALS") or os.path.join(ROOT, "portals.yml")


def discover_board(page_html):
    """The Greenhouse board slug a careers page embeds, or None."""
    for a, b in GH_EMBED.findall(page_html or ""):
        slug = a or b
        if slug and slug not in GH_NOT_A_SLUG:
            return slug
    return None


# Both public SmartRecruiters URL shapes. The `/postings/` segment is not exotic: this
# pipeline MINTS it, because providers/smartrecruiters.mjs rewrites the API's own `ref`
# into jobs.smartrecruiters.com/{company}/postings/{id}. The pattern used to read
# ([\w-]+)/(\d+), which cannot cross the slash before `postings`, so every URL the scan
# wrote for itself fell through to "no API for this host" while
# api.smartrecruiters.com/v1/companies/{company}/postings/{id} answered 200 for it.
# The prefix every host-shaped adapter carries, so that its host must BE this url's host
# rather than a host mentioned somewhere along it. `ou` cuts the query and the fragment,
# which is not enough on its own: a tracking url can carry the embedded address in its
# PATH, and if it does so without a second scheme then wraps_another_url() cannot see it
# either. Anchoring is what closes that, and it is the same fix inbox-liveness.py took for
# its board routes earlier. A new adapter that forgets this is caught by the
# structural check in --selftest, not by hoping someone notices.
OUTER_HOST = r"^https?://(?:www\.)?"

SR_URL = (re.compile(OUTER_HOST + r"jobs\.smartrecruiters\.com/([\w-]+)/(?:postings/)?([\w-]+)"),
          re.compile(OUTER_HOST + r"careers\.smartrecruiters\.com/([\w-]+)/[^/]*/(?:postings/)?([\w-]+)"))


def smartrecruiters_ref(url):
    """(company, [posting id candidates]) for a SmartRecruiters URL, or None.

    The id is NOT assumed to be numeric. Today's are, but the public URL is also written
    {id}-{title-slug}, so the whole token is tried first and the part before the first
    dash second. Matching \\d+ instead would break the day SmartRecruiters issues an id
    with a letter in it, and splitting at the dash first would break a hyphenated one.
    """
    for pat in SR_URL:
        m = pat.search(url or "")
        if m:
            tok = m.group(2)
            return m.group(1), [tok] + ([tok.split("-")[0]] if "-" in tok else [])
    return None


def name_key(s):
    """A company name as a comparable token: lowercase, letters and digits only."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def host_keys(url):
    """Identity tokens for whoever owns `url`: its host labels, minus the generic ones.

    Returns nothing for an ATS host, because api.greenhouse.io identifies the vendor and
    not the employer, and treating it as identity matches every entry in the file.
    """
    h = re.search(r"https?://([^/]+)", url or "")
    if not h or ATS_HOST.search(h.group(1)):
        return set()
    labels = [l for l in h.group(1).lower().split(".") if l and l not in HOST_NOISE]
    keys = {name_key(l) for l in labels}
    keys.add(name_key("".join(labels)))   # unity3d.com and unity-3d.com are one company
    return {k for k in keys if len(k) > 2}


# The Workday careers_url shape portals.yml records, borrowed character for character from
# TENANT_URL in scripts/workday-sweep.py, which is the tool that established it.
WD_TENANT_URL = re.compile(
    r"https://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)")


def portals_index():
    """portals.yml as one record per entry. Parsed once, READ-ONLY.

    Same block split the Workday sweeps use, deliberately: portals.yml is User Layer and
    no resolver should need a YAML dependency to read a slug out of it. A missing file is
    a missing hint, never a hard failure.

    `keys` is the strict identity the Greenhouse lookup uses. `loose` adds the first word
    of the label, which the Workday lookup needs and Greenhouse must not have: the
    Blizzard entry is labelled "Blizzard Entertainment" and its only declared URL is the
    Microsoft/Xbox Workday tenant, an ATS host that host_keys() deliberately refuses to
    read as identity, so nothing on the strict side matches careers.blizzard.com at all.
    The two are kept apart rather than merged because a wrong Greenhouse slug costs one
    extra probe while a wrong Workday tenant can CLOSE a live req, so the looser key is
    only allowed where the caller also enforces a uniqueness check.
    """
    global _PORTALS
    if _PORTALS is not None:
        return _PORTALS
    _PORTALS = []
    try:
        text = open(portals_path(), encoding="utf-8",
                    errors="replace").read()
    except OSError:
        return _PORTALS
    for block in re.split(r"\n  - name:", text)[1:]:
        label = block.split("\n")[0].strip()
        # Labels carry descriptive suffixes: "SentinelOne (AI Developer Experience /
        # enablement) [REMOTE-US]". find-ats.py's owns() learned this the hard way, where
        # reading the whole label made the suffix words part of the company name and
        # rejected a board with 131 live postings. Read only up to the first separator.
        # The em- and en-dash the labels separate with are written as \u escapes:
        # a literal em-dash may not appear in a file written for this repo, and
        # `re` reads the escape itself, so the class still matches the character.
        base = re.split(r"[(\[|/]|\s[-\u2014\u2013]\s", label)[0]
        keys = {name_key(base)} - {""}
        # Identity comes from the DECLARED urls only, not from any link in the notes: a
        # levels.fyi or news link in a note would otherwise make that host this company.
        for u in re.findall(r"^\s*(?:careers_url|api|url):\s*(\S+)", block, re.M):
            keys |= host_keys(u)
        loose = set(keys)
        first = name_key(base.split()[0]) if base.split() else ""
        if len(first) > 2:
            loose.add(first)
        slugs = [a or b for a, b in GH_SLUG.findall(block)]
        wd = WD_TENANT_URL.search(block)
        _PORTALS.append(dict(
            label=label, keys=keys, loose=loose,
            slugs=list(dict.fromkeys(s for s in slugs if s)),
            workday=(wd.group(1), wd.group(2), wd.group(3)) if wd else None))
    return _PORTALS


def portal_boards(url):
    """Greenhouse board slugs portals.yml records for the company hosting `url`.

    The slug is NOT derivable from the hostname, and guessing it returns a confident wrong
    answer rather than an error. sentinelone.com serves its board under the slug
    `sentinellabs`, so every hostname guess 404s, and the 404 path then concluded "company
    no longer uses Greenhouse; inbox row is stale" and closed four live SentinelOne reqs.
    portals.yml had the real slug the whole time. Ask it before guessing.

    These are PREPENDED to the hostname guesses rather than replacing them, so a wrong
    match here costs one extra 404 probe and can never remove a candidate.
    """
    keys = host_keys(url)
    if not keys:
        return []
    out = []
    for e in portals_index():
        if keys & e["keys"]:
            out += e["slugs"]
    return list(dict.fromkeys(out))


def portal_workday(url):
    """The ONE Workday tenant portals.yml records for the company hosting `url`, or None.

    careers.blizzard.com and careers.adobe.com are human front ends for Workday tenants:
    the first is xboxgaming/wd1/Blizzard_External_Careers, the second is
    adobe/wd5/external_experienced, and in both cases the requisition id sits in the URL
    path and resolves through the tenant's CXS search exactly like any other Workday req.
    Neither host has an adapter, so both dead-ended at "no API for this host" and their
    rows were never classified again.

    Returns None when NOTHING matches and, just as deliberately, when more than one tenant
    matches. A wrong tenant here is not a wasted request the way a wrong Greenhouse slug
    is: its search would run cleanly, find nothing, and retire a live requisition. Two
    tenants matching one host means the file cannot tell them apart, and a guess in the
    closing direction is the one this toolchain keeps paying for.
    """
    keys = host_keys(url)
    if not keys:
        return None
    hits = []
    for e in portals_index():
        if e["workday"] and keys & e["loose"]:
            hits.append((e["label"],) + e["workday"])
    if len(dict.fromkeys(h[1:] for h in hits)) != 1:
        return None
    return hits[0]


# The statuses where the server is STATING the posting is gone, rather than failing to
# hand it over. 410 Gone belongs beside 404 and was missing, which is not a hypothetical
# omission: careers.blizzard.com answers 410 for requisition R095439 and careers.adobe.com
# answers 410 for R134478, and both rows sat on the dashboard as unclassifiable, one of
# them carried at 4.1 for weeks, while their own servers were saying the postings had been
# removed. 410 is the stronger of the two statements, not the weaker: 404 means "no such
# resource here", 410 means "this resource existed and is permanently gone".
GONE = (404, 410)


def unresolved(st):
    """The liveness a non-200 status is actually evidence for: False on 404/410, else None.

    A 404 or a 410 from an endpoint that answered is a closure. Anything else is a failure
    to READ the posting, and a read that did not happen says nothing about whether the job
    is open. Six branches spelled this `live=(st != 404)`, which turns a timeout (0), a
    429, a 500 or a WAF's 403 into live=True, and a req certified live on a request that
    never completed goes on to be verified downstream as though someone had looked at it.
    The Greenhouse branch already drew the line correctly; this is that shape, shared.
    """
    return False if st in GONE else None


def gone_note(st):
    """The note that belongs beside unresolved(st).

    Written from the same constant so the verdict and the prose cannot disagree. Six
    branches spelled the note `"closed" if st == 404 else "not retrievable"` beside a
    liveness taken from unresolved(), so widening the closure set in one place alone
    would have returned live=False under the words "not retrievable".
    """
    return f"closed (HTTP {st})" if st in GONE else "not retrievable"


class _Unreadable:
    """Sentinel: a response arrived and could not be read. Never a posting."""
    __slots__ = ()

    def __repr__(self):
        return "<UNREADABLE>"


UNREADABLE = _Unreadable()


def _present(d, path):
    """Is `path` present and non-null in `d`? A dot walks INTO a nested object.

    The top-level check was not deep enough, and the hole is the same one `need` was
    added to close, one level down. Workday's posting record is nested:
    `{"jobPostingInfo": {}}` satisfies a top-level `jobPostingInfo` check, and the
    adapter then reads `bool(info.get("canApply"))` off an empty object and CLOSES a
    posting it never read. So an adapter that reads a nested field declares the nested
    field, `jobPostingInfo.canApply`, and the declaration mechanism walks it rather than
    each such adapter growing its own hand-written second look.

    Presence, not truth, all the way down: `canApply` false is a posting that was read
    and cannot be applied to, and `{"jobPostings": []}` is a search that ran. Only a
    missing key, an explicit null, or a non-object in the middle of the path is absent.
    """
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return False
        cur = cur.get(part)
        if cur is None:
            return False
    return True


def jload(body, want=dict, need=()):
    """Parse an ATS response body into JSON, or return UNREADABLE. Never raises.

    A 200 is not a promise of JSON. A WAF interstitial, a CDN error page, a login
    redirect and a truncated response all answer 200 with HTML or with half an object,
    and every direct adapter in resolve() called json.loads on that unguarded. The
    ValueError then escaped resolve() altogether, and the batch loop at the bottom of
    this file has no per-item handler, so ONE malformed response aborted the entire run
    before a single result printed. The cost is not the bad req, it is the three hundred
    good ones that were resolved and never written down.

    An unparseable 200 is an UNREADABLE RESPONSE: not live, not closed. That is the same
    line unresolved() draws for a non-200 and workday_reslug() draws for its search, and
    it is the rule this toolchain keeps having to restate, because a failure that reads
    as a verdict is the expensive kind. Prefer "not checked" over "nothing found".

    A scalar parses cleanly and is still not a posting record. `null`, a number or a bare
    quoted string would pass a try/except and then raise AttributeError on the .get()
    one line later, so the SHAPE is checked here rather than at eleven call sites. `want`
    is the shape the caller is about to use: every adapter here reads an object except
    Breezy, whose board is a bare array, and handing a list to code expecting .get() is
    the same crash by a slower route.

    `want` ALONE WAS NOT ENOUGH, and the hole it left is the exact failure this whole
    file keeps being fixed for. `want=dict` accepts any dict, so an HTTP 200 carrying
    `{}` or `{"error": "rate limited"}` from a WAF or a changed API reached the adapters
    intact, and they disagreed about what that meant: Lever, Greenhouse, Netflix and
    SmartRecruiters read it as `live=True`, while Workday (`canApply` absent -> False)
    and Workable (`state` absent -> not "published") read it as `live=False`. One
    unread response therefore both CERTIFIED and CLOSED postings depending on which
    branch it landed in, and neither answer had read a posting.

    So `need` names the fields that make this response a POSTING for the adapter about
    to read it: one declarative argument at each call site rather than eleven
    hand-written guards that drift. An item is a field name, a DOTTED PATH into a nested
    object, or a tuple of either of which at least one must be present (Netflix answers
    under `job`, under `data`, or at the top level). A field must be PRESENT and not
    null; it need not be truthy, because `{"jobPostings": []}` is a search that ran
    cleanly and found nothing, which is a real answer and not an unreadable one.

    The dotted form exists because a top-level name was not deep enough for a nested
    record: `{"jobPostingInfo": {}}` passed a top-level `jobPostingInfo` check and
    Workday then read `canApply` off an empty object and reported the unread response as
    CLOSED. An adapter that reads a nested field declares the nested field. See
    _present().

    A response that parses and lacks those fields is UNREADABLE: not live, not closed.
    """
    try:
        d = json.loads(body)
    except Exception:
        return UNREADABLE
    if not isinstance(d, want):
        return UNREADABLE
    if need and not isinstance(d, dict):
        return UNREADABLE
    for field in need:
        names = (field,) if isinstance(field, str) else tuple(field)
        if not any(_present(d, n) for n in names):
            return UNREADABLE
    return d


def unreadable(ats, st, what="the response body"):
    """The verdict for a response that arrived and could not be parsed.

    Shared so the eleven adapters cannot drift into eleven different answers, the way
    six branches once drifted into `live=(st != 404)` before unresolved() existed.
    """
    return dict(ats=ats, live=None, status=st,
                note=f"HTTP {st} but {what} did not parse as the JSON this adapter "
                     f"expects, so the posting was never read; liveness is unknown, "
                     f"neither live nor closed")


HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"


def fetch(url, timeout=25, accept=None):
    """(status, text). urllib first, curl as fallback: urllib fails at the TLS
    layer in some environments where curl against the same URL succeeds.

    `accept` overrides the default `Accept: application/json`, for a caller fetching a PAGE
    rather than an API.

    **A 405 is a statement about the REQUEST, not about the resource, so it is retried
    once with no custom headers at all.** Measured 2026-09-21 on
    careers-githubinc.icims.com: the spoofed Chrome User-Agent this file sends gets 405,
    and urllib's own default gets 200 with the posting. The Accept header was the first
    suspect and was innocent; varying one header at a time is what settled it. This
    matters because last_resort's entire verdict is the status code, so without the retry
    it reports a property of its own request as a property of the posting, and a whole ATS
    reads as permanently unknowable. The retry can only ever turn an unknown into an
    answer, and it costs one request on a path that had already failed.

    `-L` is on the curl command because urllib's default opener follows redirects and
    curl's default does not, so the fallback transport was answering a different question
    from the primary one. That matters most for the last-resort probe below, whose whole
    verdict is the status code: a careers front end that 301s to its own gone-page would
    read as 301 here and as 410 there, purely on which transport happened to run.

    `timeout` is a parameter rather than a constant because the probe is not fetching a
    posting, it is asking one question of a page that may be a heavy client-rendered
    shell. The curl and subprocess bounds are derived from it so the three cannot drift.
    """
    hdrs = {**HDRS, "Accept": accept} if accept else HDRS
    try:
        r = urllib.request.Request(url, headers=hdrs)
        with urllib.request.urlopen(r, timeout=timeout, context=CTX) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # See the docstring: 405 and 406 describe the request, so ask again as a plain
        # client before believing them.
        if e.code in (405, 406) and hdrs:
            try:
                bare = urllib.request.Request(url)
                with urllib.request.urlopen(bare, timeout=timeout, context=CTX) as resp:
                    return resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e2:
                return e2.code, ""
            except Exception:
                pass
        return e.code, ""
    except Exception:
        pass
    def _curl(send_headers):
        cmd = ["curl", "-sL", "-w", "\n%{http_code}", "--max-time", str(timeout + 5)]
        if send_headers:
            for k, v in hdrs.items():
                cmd += ["-H", f"{k}: {v}"]
        out = subprocess.run(cmd + [url], capture_output=True, text=True,
                             encoding="utf-8", errors="replace",
                             timeout=timeout + 20).stdout
        body, _, code = (out or "").rpartition("\n")
        return int(code.strip() or 0), body

    try:
        st, body = _curl(True)
        # The SAME retry as the urllib path above, and leaving it off here was worse than
        # an omission: this branch is the one that runs when urllib fails at the TLS layer,
        # so on exactly the machines the fallback exists for, the documented iCIMS tenant
        # stayed unresolvable while a bare request returns the posting. Verified 2026-09-22:
        # curl's own default client gets 200 from that host.
        if st in (405, 406) and hdrs:
            st, body = _curl(False)
        return st, body
    except Exception:
        return 0, ""


def post(url, payload):
    """POST JSON. urllib first, curl fallback, same reasoning as fetch()."""
    body = json.dumps(payload).encode()
    try:
        r = urllib.request.Request(url, data=body, method="POST",
                                   headers={**HDRS, "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=25, context=CTX) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        pass
    import tempfile
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    tmp.write(json.dumps(payload)); tmp.close()
    try:
        cmd = ["curl", "-s", "-w", "\n%{http_code}", "--max-time", "30",
               "-H", "Content-Type: application/json"]
        for k, v in HDRS.items():
            cmd += ["-H", f"{k}: {v}"]
        out = subprocess.run(cmd + ["-X", "POST", "-d", "@" + tmp.name, url],
                             capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=45).stdout
        b, _, code = out.rpartition("\n")
        return int(code.strip() or 0), b
    except Exception:
        return 0, ""
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def workday_reslug(tenant, wd, site, path):
    """Re-resolve a Workday job path that 403s. Returns (path, searched).

    Workday's CXS detail endpoint returns 403, not 404, when the job-path slug is
    stale, so a saved URL rots into an unreadable posting that is easy to mistake
    for a closure. The req id in the slug is stable though, so the tenant's own
    search endpoint can hand back the current canonical path. This is the NVIDIA
    liveness trick generalised to any tenant.

    `searched` is the half that was missing, and it is the half the caller needs.
    This used to return a bare None for two different things: the search ran cleanly and
    the req is genuinely gone from the index, AND the search never ran at all (non-200,
    timeout, curl fallback exhausted, unparseable JSON). The caller read every None as the
    first and answered "slug stale and req absent from tenant search = closed", so a
    transient CXS failure retired a live job. An absent id is evidence ONLY when the board
    was read cleanly. `searched` is True only when the endpoint answered 200 and its JSON
    parsed; with no id extractable from the path there was nothing to search for, so it is
    False there too.
    """
    m = re.search(r"_([A-Za-z0-9-]+)$", path.split("?")[0].rstrip("/"))
    if not m:
        return None, False
    rid = m.group(1)
    base = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
    st, body = post(base + "/jobs",
                    {"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": rid})
    if st != 200 or not body:
        return None, False
    # This is the tenant SEARCH, not a posting. `jobPostings: []` is a search that ran
    # and found nothing, which is the answer the caller wants; a 200 with no jobPostings
    # key at all never searched, and the caller reads a bare None with searched=True as
    # "req absent from tenant search = closed", retiring a live req on an unread reply.
    d = jload(body, need=("jobPostings",))
    if d is UNREADABLE:
        return None, False
    for p in d.get("jobPostings", []):
        ep = p.get("externalPath", "") or ""
        if rid.lower() in ep.lower():
            return ep.lstrip("/"), True
    return None, True


def clean(h):
    """HTML (escaped or not) to plain text.

    Order matters and used to be wrong. Greenhouse delivers the description as
    ESCAPED html ("&lt;p&gt;"), so stripping tags before unescaping found no tags to
    strip, and the unescape then turned the entities into real markup: every
    Greenhouse JD carried literal <p> and <li> through into the requirements excerpt
    and the lane-signal scan. Unescape first, then strip, and unescape once more for
    the entities (&amp;, &nbsp;) that only surface after the tags are gone.
    """
    import html as H
    s = h or ""
    for _ in range(2):                     # some payloads are escaped twice
        if "&lt;" not in s and "&amp;lt;" not in s:
            break
        s = H.unescape(s)
    s = TAG.sub(" ", s)
    s = H.unescape(s)
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def pays(txt):
    return list(dict.fromkeys(PAY.findall(txt)))[:3]



def _json_obj_at(s, start):
    """Brace-match a JSON object at or after `start`. Returns the parsed dict or None."""
    i = s.find("{", start)
    if i < 0:
        return None
    depth, instr, esc = 0, False, False
    for j in range(i, len(s)):
        ch = s[j]
        if instr:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                instr = False
            continue
        if ch == '"':
            instr = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[i:j + 1])
                except Exception:
                    return None
    return None


def apple_jobs_data(page):
    """Pull Apple's jobsData object out of a detail page.

    Apple ships no usable public job API: /api/role/detail/{id} now 301s to
    apple.com/pagenotfound. The detail page instead carries the whole record inside a
    script block, escaped as a JS string, so it has to be unescaped before the braces
    can be matched.
    """
    m = re.search(r"<script[^>]*>((?:(?!</script>).)*?jobDetails(?:(?!</script>).)*)</script>",
                  page, re.S)
    if not m:
        return None
    un = (html.unescape(m.group(1)).replace('\\"', '"')
          .replace("\\u0026", "&").replace("\\/", "/"))
    k = re.search(r'"jobsData"\s*:', un)
    d = _json_obj_at(un, k.end()) if k else None
    return d if isinstance(d, dict) and d else None


def k_band(summary):
    """A K-notation band rewritten in full dollars, so PAY can read it.

    Ashby states its band as "$200K - $260K" and the shared PAY pattern wants five
    consecutive digits, so a posting that names a band reached eval-prep as "no band
    posted; score comp on evidence" and the comp dimension was judged on nothing. The
    rewrite is mechanical, $200K is $200,000, and any other shape is left untouched
    rather than guessed at: a wrong band is worse than a missing one against a floor.
    """
    return re.sub(r"\$\s?(\d{2,4})[Kk]\b",
                  lambda m: "$" + format(int(m.group(1)) * 1000, ","), summary or "")


def ashby_from_page(page_html, org, jid):
    """One Ashby posting read out of a page's window.__appData, or None.

    Ashby's posting API is OPT-IN per organisation. An org that never switched it on
    answers 404 for ever while its board is perfectly live, and from outside those two
    states look identical. Whatnot is the worked example: 132 postings behind a 404, and
    this resolver dead-ended on it with "board not retrievable", which blocks eval-prep
    from ever building a packet for the org. find-ats.py and providers/ashby.mjs both
    already fall back to the page; this is the same fallback for a single posting.

    The detail page carries the record itself, which is strictly more than the posting
    API returns: descriptionHtml, the secondary locations and a compensation summary.
    """
    data = _ashby_embed.extract_appdata(page_html)
    p = (data or {}).get("posting") if isinstance(data, dict) else None
    if not isinstance(p, dict) or not p.get("title"):
        return None
    if jid and str(p.get("id", "")).lower() != jid.lower():
        return None
    # The detail page spells its secondary locations as plain strings in
    # secondaryLocationNames; the board page spells the same thing as secondaryLocations
    # objects. Read both, for the reason every adapter in this file has to: the location
    # the candidate can actually reach is regularly the secondary one, and dropping it fails the
    # gate closed and in silence.
    locs = [p.get("locationName") or p.get("location") or ""]
    for s in (list(p.get("secondaryLocationNames") or [])
              + list(p.get("secondaryLocations") or [])):
        locs.append(s if isinstance(s, str)
                    else (s or {}).get("locationName") or (s or {}).get("location") or "")
    locs = [l for l in dict.fromkeys(locs) if l]
    txt = clean(p.get("descriptionHtml") or p.get("descriptionPlain") or "")
    # The scrapeable summary is the plainer of the two: "$200K - $260K" against
    # "$200K <en-dash> $260K <bullet> Offers Equity". Both are kept verbatim in
    # comp_summary and
    # expanded through k_band() for `pay`, because the JD frequently states no band at all.
    comp = (p.get("scrapeableCompensationSalarySummary")
            or p.get("compensationTierSummary") or "")
    work = str(p.get("workplaceType") or "")
    return dict(ats="ashby", live=True, title=p.get("title"), org=org,
                location=" | ".join(locs), jd=txt,
                pay=pays(txt) or pays(k_band(comp)), comp_summary=comp or None,
                embedded=True, listed=bool(p.get("isListed", True)),
                remote_txt=bool(re.search(r"\bremote\b",
                                          work + " " + " ".join(locs), re.I)))


def greenhouse_record(d, board, **extra):
    """One Greenhouse posting record as a resolver result.

    Shared because the DISCOVERED-BOARD fallback inside resolve() did not share it. A
    company hosting Greenhouse on its own domain sometimes only resolves after the board
    slug is recovered from the page, and that path built its own result out of
    location.name alone: no offices[], no "careers page remote eligible" metadata. So a
    req whose location reads a bare "United States" while offices[] names "Los Angeles,
    CA" and the remote metadata says Yes came back as a non-remote country string, and
    eval-prep's gate then hard-failed it as outside the commute ceiling.

    That is the TOO STRICT direction of the location gate, and under a hard
    no-relocation constraint it is the expensive one: a reachable role is discarded with
    no error, no warning and no row, so nothing downstream can recover it. Two code
    paths reading one API is how the omission survived, so now there is one path. This
    is the same secondary-locations rule every other adapter here already keeps (Ashby
    secondaryLocations, Lever categories.allLocations, Workday additionalLocations,
    Breezy is_remote), and Greenhouse spells it offices[] plus metadata.
    """
    txt = clean(d.get("content", ""))
    # location.name is often a placeholder ("BLANK,BLANK,Multiple Locations")
    # while the REAL sites sit in offices[] and remote eligibility sits in
    # metadata. Reading only location.name left a whole cluster of Epic reqs
    # unresolvable and parked for a human lookup that the API could answer.
    loc = (d.get("location") or {}).get("name", "") or ""
    offices = [o.get("location") or o.get("name") or ""
               for o in (d.get("offices") or [])]
    offices = [o for o in offices if o]
    if offices and re.search(r"multiple locations|BLANK|\d+ locations", loc, re.I):
        loc = " | ".join(dict.fromkeys(offices))
    elif offices:
        # A location string can be real and still carry no commute information.
        # Crexi posts location "United States" with offices[] naming "Playa Vista,
        # California", which is INSIDE the commute ceiling; folding only on placeholder
        # strings meant the gate saw a bare country, failed it as "US, outside the
        # commute ceiling", and discarded an LA role in silence. Append any office
        # the location does not already name. Fourth ATS with this shape, after
        # Ashby secondaryLocations, Lever allLocations and Workday
        # additionalLocations.
        extra_locs = [o for o in dict.fromkeys(offices)
                      if o.split(",")[0].strip().lower() not in loc.lower()]
        if extra_locs:
            loc = " | ".join([loc] + extra_locs) if loc else " | ".join(extra_locs)
    meta = {str(x.get("name", "")).lower(): str(x.get("value", ""))
            for x in (d.get("metadata") or [])}
    remote_meta = meta.get("careers page remote eligible", "")
    if remote_meta.strip().lower() in ("yes", "true"):
        loc = (loc + " | Remote").strip(" |")
    return dict(ats="greenhouse", live=True, title=d.get("title"),
                location=loc, jd=txt, offices=offices, org=board,
                remote_eligible=remote_meta or None,
                pay=pays(txt),
                remote_txt=(remote_meta.strip().lower() in ("yes", "true")
                            if remote_meta else
                            bool(re.search(r"\bremote\b", txt, re.I))),
                **extra)


def workday_record(info, **extra):
    """One Workday CXS posting record as a resolver result.

    Shared for the same reason greenhouse_record() is: the direct path and the re-slugged
    path had each written this out, and a THIRD caller is now added for the human careers
    front ends (careers.blizzard.com, careers.adobe.com) that resolve through a tenant
    recorded in portals.yml. Three hand-written copies of "fold additionalLocations in and
    read bool(canApply)" is three chances for one of them to quietly stop folding, and
    dropping a secondary location fails the gate CLOSED, with no error and no row.
    """
    locs = [l for l in [info.get("location", "")] +
            (info.get("additionalLocations") or []) if l]
    jd = clean(info.get("jobDescription", ""))
    return dict(ats="workday", live=bool(info.get("canApply")), title=info.get("title"),
                location=" | ".join(locs), pay=pays(jd), jd=jd,
                remote_txt=any(re.search(r"\bremote\b", l, re.I) for l in locs),
                **extra)


def workday_detail(base, ep, what, **extra):
    """Fetch one CXS detail path under `base` and turn it into a verdict.

    `need` names the NESTED field the verdict is taken from, because the verdict is
    bool(canApply) and `{"jobPostingInfo": {}}` at HTTP 200 satisfied a top-level check
    and then CLOSED a posting nobody had read.
    """
    st, body = fetch(f"{base}/{ep}")
    if st != 200 or not body:
        return dict(ats="workday", live=None, status=st,
                    note=f"{what}: the CXS detail request answered HTTP {st}, so the "
                         f"posting was not read; liveness unknown, not closed")
    d = jload(body, need=("jobPostingInfo.canApply",))
    if d is UNREADABLE:
        return unreadable("workday", st, what)
    return workday_record(d.get("jobPostingInfo", {}) or {}, **extra)


def workday_by_req(entry, rid):
    """Resolve a requisition through a portals.yml Workday tenant, or None to hand back.

    This is workday_reslug()'s evidence rule applied to a host that has no adapter at all.
    careers.blizzard.com/global/en/job/R095439/... is the human face of the xboxgaming
    tenant and carries the req id in its path, so the tenant's own CXS search can answer
    the question the front end cannot. Returning None means nothing was read HERE, and the
    caller falls through to the status probe rather than to a verdict.

    The asymmetry is the same one every board reader in this toolchain keeps: an absent id
    is evidence only when the search was read CLEANLY. A non-200, an empty body or an
    unparseable one all hand the question back, because a search that did not run would
    otherwise retire a live requisition on an empty hand.

    A FULL FIRST PAGE IS NOT A CLEAN ABSENCE, and that is the same rule one step further
    out. `searchText` is a fuzzy query, not a lookup: a tenant is free to rank a partial
    match above the exact requisition, so reading twenty results and closing on the id not
    being among them retires a live row whenever the board returns twenty-one. This walks
    the result set until it ENDS, and hands the question back if it does not end within the
    bound. `total` is latched from the FIRST page only, per the CrowdStrike trap recorded
    in CLAUDE.md, where a tenant answers 436 at offset 0 and 0 at every offset after.
    """
    label, tenant, wd, site = entry
    base = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
    # Compare CANONICAL ids, not substrings. `rid in externalPath` accepts R185011 while
    # resolving R13733 and then returns that other requisition's title, location and
    # liveness as this posting's; it also misses R-13733 against R13733, which is the same
    # req spelled two ways. Extract the id from the path with the shared pattern and
    # normalise both sides.
    want = canon_req(rid)
    seen, total = 0, None
    for page in range(WD_SEARCH_PAGES):
        st, body = post(base + "/jobs",
                        {"appliedFacets": {}, "limit": WD_SEARCH_LIMIT,
                         "offset": page * WD_SEARCH_LIMIT, "searchText": rid})
        if st != 200 or not body:
            return None
        # `jobPostings: []` is a search that RAN and found nothing, which is the answer
        # this closes on; a 200 with no jobPostings key at all never searched.
        d = jload(body, need=("jobPostings",))
        if d is UNREADABLE:
            return None
        posts = d.get("jobPostings") or []
        for p in posts:
            ep = (p.get("externalPath") or "").lstrip("/")
            found = WD_REQ_ID.search(ep)
            if found and canon_req(found.group(0)) == want:
                return workday_detail(base, ep, "the CXS detail response for " + rid,
                                      org=label, front_end=True, req_id=rid)
        seen += len(posts)
        if page == 0:
            total = d.get("total") if isinstance(d.get("total"), int) else None
        closed = dict(ats="workday", live=False, status=200, org=label, front_end=True,
                      req_id=rid,
                      note=f"{rid} absent from a clean search of all {seen} results in "
                           f"the {tenant}/{site} tenant recorded in portals.yml for this "
                           f"host = closed")
        stream_ended = len(posts) < WD_SEARCH_LIMIT
        if total is not None:
            if seen >= total:
                return closed
            # It served fewer than it claimed and then stopped. The two halves of one
            # response disagree, and a disagreement is not an absence.
            if stream_ended:
                return None
        elif stream_ended:
            return closed
    return None


def last_resort(url):
    """The verdict for a host with no adapter: CLOSED or unknown, never live.

    Hosts with no adapter used to end at "no API for this host" for ever. That is honest
    and it was also a dead end, because nothing else ever looked at those rows again: on
    2026-09-20 seven dashboard rows were unclassifiable this way and three of them were
    permanently gone, one carried at 4.1 for weeks.

    THE ASYMMETRY IS THE WHOLE POINT AND MUST NOT BE RELAXED. 404 and 410 are the server
    stating the posting is not there, which is a real answer. ANY other status, 200 very
    much included, stays unknown. A 200 proves nothing here: these are client-rendered
    careers shells that serve the same 200 for a retired requisition as for a live one,
    which is precisely why they have no adapter and why a status probe is all that is
    left. Four of those seven rows answered 200 and their true state is still unknown.

    A tool that can only ever retire, never promote, is safe in the direction that
    matters: promoting a dead row wastes an application, retiring a live one hides work.
    A network failure or a timeout returns 0 from fetch() and is therefore unknown, which
    is the same rule, since nothing was read.
    """
    # HTML_ACCEPT because this is a PAGE, not an API. See fetch(), which also retries a
    # 405 bare, since this function reports the status as the verdict.
    st, body = fetch(url, timeout=12, accept=HTML_ACCEPT)
    # Before falling back to the status, ask whether the page SAYS anything. A schema.org
    # JobPosting with a past `validThrough` is the employer's own machine-readable
    # statement that the position is no longer open, which is real evidence where a status
    # of 200 is none at all. Same closing-direction-only rule as the rest of this function.
    expired = jsonld_expired(body, url)
    if expired:
        return dict(status=st, **expired)
    if st in GONE:
        return dict(ats="unsupported", live=False, status=st,
                    note=f"no API for this host; the posting URL itself answers HTTP {st}, "
                         f"which is the server stating the posting is gone")
    return dict(ats="unsupported", live=None, status=st,
                note=f"no API for this host; the posting URL answers HTTP {st}, which is "
                     f"not evidence either way (a client-rendered careers shell serves "
                     f"200 for a retired req), so liveness is unknown")


# A schema.org JobPosting embedded in a page. The `+` in the MIME type is frequently
# HTML-ESCAPED, which is how the first version of this missed Built In entirely: its tag
# reads `type="application/ld&#x2B;json"`. Unescape before matching, never pattern-match the
# raw attribute.
LD_BLOCK = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                      re.S | re.I)


def jsonld_postings(page_html):
    """Every schema.org JobPosting object embedded in a page, walked out of @graph."""
    out = []
    for raw in LD_BLOCK.findall(html.unescape(page_html or "")):
        try:
            data = json.loads(raw.strip())
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                if node.get("@type") == "JobPosting":
                    out.append(node)
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
    return out


# Query parameters that describe the VISIT rather than the posting. Everything else is
# treated as identity. The asymmetry is deliberate: a key missing from this list makes the
# comparison STRICTER and declines a match, which costs a closure, while a key wrongly on
# it makes the comparison looser, which costs a live row. A list that falls behind should
# fail in the direction that is only expensive, not the one that is destructive.
VISIT_PARAMS = re.compile(
    r"^(utm_\w+|source|src|ref|referrer|referer|lang|locale|language|domain|mobile|trk|"
    r"gh_src|sid|session|campaign|medium|from|redirect|in_iframe|width|height)$", re.I)


def _same_posting(a, b):
    """Do two posting URLs address the same thing? Host, path, and identity query params.

    The query cannot simply be discarded. On a page whose posting identity lives there,
    `/jobs?id=live` and `/jobs?id=dead` would compare equal, and an expired neighbour could
    then close a live row through last_resort and inbox-liveness --mark. It cannot simply
    be kept either, because the requested URL routinely carries tracking parameters the
    canonical record in the page does not.
    """
    def key(u):
        # The FRAGMENT is captured too. On a hash-routed careers site the fragment is the
        # posting identity, so `/#/jobs/live` and `/#/jobs/dead` were comparing equal.
        # verify-report-urls already treats a fragment-only URL as posting-specific, and
        # this matcher discarding it was a contradiction introduced in the same commit.
        m = re.search(r"https?://(?:www\.)?([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?",
                      (u or "").strip(), re.I)
        if not m:
            return None
        params = tuple(sorted(
            p for p in (m.group(3) or "").split("&")
            if p and not VISIT_PARAMS.match(p.split("=")[0])))
        # Host folded, PATH NOT. A hostname is case-insensitive and a path is not, so
        # `/jobs/ABC` and `/jobs/abc` are two resources; folding them let an expired
        # neighbour close the requested row. It errs the right way too: a host that does
        # serve its paths case-insensitively now produces a declined match rather than an
        # invented one.
        return (m.group(1).lower(), m.group(2).rstrip("/"), params, m.group(4) or "")
    ka, kb = key(a), key(b)
    return bool(ka) and ka == kb


def ld_identity(j, url):
    """True if this JobPosting IS the requested one, False if it names a DIFFERENT one,
    None if the record carries nothing that could tell.

    A page can embed several JobPosting objects: the one being viewed, plus the "related
    roles" rail beside it. Reading any expired one as the answer closes the requested URL
    on a stale neighbour, and inbox-liveness --mark consumes that verdict, so a live row
    would be retired on someone else's dead job. Match before believing.
    """
    for key in ("url", "@id"):
        v = j.get(key)
        if isinstance(v, str) and v.strip():
            return _same_posting(v, url)
    ident = j.get("identifier")
    if isinstance(ident, dict):
        val = str(ident.get("value") or "").strip()
        # Built In carries no url and no @id, only identifier {name, value}, and the value
        # IS the numeric id in the path. Bounded so 8534252 cannot match inside 19083663.
        #
        # Returns a BOOLEAN, like the url branch above. A non-empty identifier that does
        # not appear in the url is evidence of a DIFFERENT posting, not an absence of
        # evidence, and falling through to None let the single-posting rule treat such a
        # record as anonymous and trust its expired date. A page keeping one stale record
        # for another job could close this row on it.
        if val:
            return bool(re.search(rf"(?<![A-Za-z0-9]){re.escape(val)}(?![A-Za-z0-9])",
                                  url or ""))
    return None


def jsonld_expired(page_html, url=None, today=None):
    """The expired JobPosting on a page, or None. PURE: the caller supplies the body.

    Pure because the only caller already has the page in hand. An earlier version fetched
    it again, which meant every adapterless row paid for two downloads of the same URL and
    the tests had to mock a transport to exercise a rule about parsing.

    CLOSING DIRECTION ONLY, and the asymmetry is deliberate for the same reason
    last_resort's is. `validThrough` is the employer's own machine-readable statement of
    the date after which the position is no longer open, so a date in the past is real
    evidence. The converse is not: a stale JobPosting block left on a page after the req
    closed is exactly the failure this whole file keeps designing against, and a generic
    page is the weakest place to take that risk. So a future date, a missing date or an
    unparseable one all return None and let the caller carry on to its own last resort.

    Found by hand-working the last two unsettled inbox rows on 2026-09-21: Built In's
    listing of a Luma AI role published `validThrough 2026-06-29`, nearly three months
    past, while every status-based probe could only ever say 200 and shrug.
    """
    postings = jsonld_postings(page_html)
    if not postings:
        return None
    # Only records that ARE the requested posting may speak for it. A record that names a
    # different URL is excluded outright; one that carries no identity at all is usable
    # only when it is the page's single JobPosting, because then there is nothing it could
    # be confused with. Anything else is an ambiguous page, and an ambiguous page settles
    # nothing. Without this a "related roles" rail could retire a live row.
    matched = [j for j in postings if ld_identity(j, url) is True]
    if not matched and len(postings) == 1 and ld_identity(postings[0], url) is None:
        matched = postings
    now = today or datetime.date.today().isoformat()
    dated = []
    for j in matched:
        through = j.get("validThrough")
        if not isinstance(through, str):
            continue
        stamp = re.match(r"(\d{4}-\d{2}-\d{2})", through.strip())
        if stamp:
            dated.append((stamp.group(1), j))
    expired = [(d, j) for d, j in dated if d < now]
    current = [d for d, _ in dated if d >= now]
    # CONTRADICTION SETTLES NOTHING. A page can carry two records that both pass the
    # identity test above and disagree: a stale copy left by a CMS or an aggregator's
    # cached duplicate beside the live one. Reading the first expired record and closing
    # on it makes the verdict depend on DOM order, and the direction it fails in is the
    # expensive one, because `inbox-liveness.py --mark` retires what this calls closed.
    # An employer stating a future validThrough on the same posting is exactly as much
    # its own machine-readable statement as the past one, so the two cancel and the
    # caller falls through to its own last resort. Same rule as jload()'s: one unread
    # answer must never be able to both certify and close a row.
    if not expired or current:
        return None
    day, j = expired[0]
    return dict(ats="jsonld", live=False, title=j.get("title"),
                note=f"the page's own schema.org JobPosting gives validThrough "
                     f"{day}, which is past; that is the employer "
                     f"stating the position is no longer open")


def board_owns_host(listing, url):
    """Does this Greenhouse board's own listing link back to the host `url` came from?

    The question that has to be answered before an INFERRED Greenhouse claim is allowed
    to close a row. "A board by this name exists" is not enough, because board names are
    a flat global namespace and two companies can want the same word. A board that really
    belongs to the company says so in its own data: every posting carries an
    `absolute_url`, and a company-hosted board points those at the company's own site.

    Measured 2026-09-20, and the separation is total rather than marginal:

        board        jobs   absolute_url hosts
        disney          2   job-boards.greenhouse.io (0 back to disneycareers.com)
        riotgames     155   www.riotgames.com        (155 of 155)
        airbnb        168   careers.airbnb.com       (168 of 168)
        coinbase      217   www.coinbase.com         (217 of 217)
        samsara       273   www.samsara.com          (273 of 273)

    So the impostor is rejected and all four real boards keep their pruning power,
    including Airbnb, Coinbase and Samsara, which portals.yml does not record. That is
    why this and not a portals.yml lookup: no curation, no list to fall behind the code,
    and it works the first time a host is seen.

    host_keys() does the comparison because it already returns NOTHING for an ATS host,
    which is exactly the disney case: its postings live on job-boards.greenhouse.io, so
    there is no employer identity there to match against.

    Costs no extra request. The caller has already fetched this listing to ask whether
    the board exists at all, and used to discard the body.
    """
    keys = host_keys(url)
    if not keys:
        return False
    try:
        d = json.loads(listing or "")
    except (ValueError, TypeError):
        return False
    jobs = d.get("jobs") if isinstance(d, dict) else None
    if not isinstance(jobs, list):
        return False
    for j in jobs[:200]:
        if isinstance(j, dict) and keys & host_keys(j.get("absolute_url") or ""):
            return True
    return False


def greenhouse_claim(u, allow_inference):
    """Greenhouse's answer for `u`, or None when this pass declines to claim the URL.

    resolve() calls this TWICE, and the difference between the two calls is the point.
    The first pass (`allow_inference=False`) handles the two shapes in which the COMPANY
    itself declared Greenhouse: a greenhouse.io URL, and its own `?gh_jid=` parameter.
    The second pass runs LAST, after every host-specific adapter and after the portals.yml
    Workday lookup, and only there is the resolver allowed to GUESS that a long number in
    a URL path is a Greenhouse job id.

    Splitting them fixes an ordering bug, not a missing case. The guess used to run FIRST,
    ahead of Ashby, Lever, Netflix, Apple, SmartRecruiters, Workable, Breezy and the rest,
    so the only thing keeping it off their URLs was a hand-maintained regex of hosts it
    must not claim. A blacklist that guards a guess is a list that falls behind the code
    without saying so, and it had: `jobs.nvidia.com` is recorded in portals.yml as the
    NVIDIA Workday tenant and was answered "company no longer uses Greenhouse", because
    the guess reached it 350 lines before the lookup that knew better. Running the guess
    last makes that list an optimisation rather than the guarantee.
    """
    # Anchored to the HOST. These two patterns used to be searched against the whole URL,
    # so any address carrying a greenhouse.io link inside a parameter (a redirect target,
    # a tracking `?next=https://boards.greenhouse.io/acme/jobs/1194374`) was read as a
    # direct Greenhouse posting and handed the highest confidence level in this function,
    # the one that closes a row on a 404 with no further questions asked.
    # The OUTER url again: host and path only. The gh_jid branch below keeps the
    # whole url on purpose, because the query is the one place a Greenhouse job id
    # legitimately lives.
    ou = u.split("?")[0].split("#")[0]
    hm = re.search(r"https?://([^/?#]+)", u)
    host = hm.group(1).lower() if hm else ""
    m = None
    # A LABEL boundary, not a suffix. `notgreenhouse.io` ends with "greenhouse.io" and
    # would otherwise be handed the one confidence level in this function that closes a row
    # on a 404 with no further questions. Anchoring to the host was the previous round's
    # fix; this is the same rule one level finer.
    if host == "greenhouse.io" or host.endswith(".greenhouse.io"):
        m = re.search(OUTER_HOST + r"[\w.-]*greenhouse\.io/(?:embed/job_app\?for=)?"
                      r"([\w-]+)/jobs/(\d+)", ou) \
            or re.search(OUTER_HOST + r"(?:job-boards|boards)\.greenhouse\.io/"
                         r"([\w-]+)/jobs/(\d+)", ou)
    boards = []
    # Did the company DECLARE this a Greenhouse job id, or did we infer it from a bare
    # number in a path? That distinction, and not the status code, is what decides
    # whether a 404 is allowed to close a row further down.
    id_declared = True
    if m:
        boards = [m.group(1)]
        jid = m.group(2)
    else:
        # A company hosting Greenhouse on its own domain keeps gh_jid but drops the
        # board slug from the path (databricks.com/company/careers/...?gh_jid=123).
        # The board slug is almost always the bare host label, so try that, plus a
        # couple of common spellings, before giving up.
        g = re.search(r"[?&]gh_jid=(\d+)", u)
        # Other ATSes also put long numeric ids in the path. This list used to be the
        # ONLY thing keeping the guess off their URLs; now that the guess runs last it
        # mostly just saves requests. It still earns its place for an AGGREGATOR whose
        # own Greenhouse board exists (Built In), where the corroboration test below
        # would pass on a company that is not the one the URL is about.
        if not g and allow_inference and not re.search(
                r"(smartrecruiters|myworkdayjobs|ashbyhq|lever\.co|"
                r"jobs\.apple\.com|eightfold|workable|jobvite|"
                r"jobs\.netflix\.net|jobs\.gem\.com|builtin|"
                r"amazon\.jobs|successfactors|lionsgate)", u, re.I):
            # Company-hosted Greenhouse without the gh_jid query param. Riot, Airbnb,
            # Coinbase, Samsara and others put the Greenhouse job id straight in the
            # path (/job/8372403/, /positions/6631030/, /roles/7552544). Greenhouse
            # ids are long, so a 7+ digit segment is a safe signal; shorter numbers
            # are page indexes and would generate noise.
            g = re.search(r"/(?:job|jobs|positions?|roles?|opening|work-with-us)/(\d{7,})",
                          ou) \
                or re.search(r"/(\d{9,})(?:/|$)", ou)
            if g:
                # Inferred, never declared. The number is equally consistent with a
                # Radancy, Eightfold or Avature id, so nothing downstream may treat a
                # 404 from it as evidence about the posting.
                id_declared = False
        if g and host:
            jid = g.group(1)
            # Take every host label that is not a generic prefix or a TLD. A host
            # like careers.roblox.com must yield "roblox", not "careers", and
            # unity.com must still yield "unity". Trying several beats guessing one.
            labels = [l for l in host.split(".") if l and l not in HOST_NOISE]
            cands = []
            for l in labels:
                cands += [l, l.replace("-", "")]
                # pinterestcareers.com -> the board is "pinterest". The generic
                # word is glued onto the company name rather than being its own
                # host label, so splitting on dots alone never finds it.
                for suf in ("careers", "career", "jobs", "job", "hiring", "hr"):
                    if l.endswith(suf) and len(l) > len(suf) + 2:
                        cands.append(l[: -len(suf)])
            # Ask portals.yml BEFORE trusting any of those guesses. It already records
            # the real slug for the companies the scan polls, and the real slug is
            # routinely nothing like the domain: sentinelone.com is `sentinellabs`,
            # and every guess above 404s. That 404 used to be reported as "company no
            # longer uses Greenhouse" and closed four live SentinelOne reqs.
            boards = list(dict.fromkeys(portal_boards(u) + cands))
    if boards:
        st, body = 0, ""
        # WHICH board gave WHICH answer. The closure below used to read the status of the
        # LAST board tried against the existence of the FIRST board that answered, and
        # those need not be the same board. A correct board timing out at 503 while a
        # wrong candidate 404s and the correct board's listing answers 200 produced a
        # confident closure assembled from three unrelated requests.
        job_status = {}
        for board in boards:
            st, body = fetch(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jid}")
            job_status[board] = st
            if st == 200 and body:
                break
        if st == 200 and body:
            d = jload(body, need=("title",))
            if d is UNREADABLE:
                return unreadable("greenhouse", st, "the board API response")
            if not id_declared:
                # Finding SOMETHING is not the same as finding this posting. When both
                # the slug and the id were ours, make the record's own canonical address
                # agree with the URL we were asked about. Only a positive disagreement
                # counts: a record that points back at the ATS host names the vendor and
                # not an employer, and rejecting that would throw away a live verdict to
                # avoid a collision nothing has shown.
                back = host_keys(d.get("absolute_url") or "")
                if back and not (back & host_keys(u)):
                    return None
            return greenhouse_record(d, board)
        # A 404 here is ambiguous when the board slug was GUESSED from the host: it
        # means either the job closed or the guess was wrong. Distinguish by asking
        # whether the board itself exists. Same failure mode as a Workday 403, and
        # a false closure is the expensive direction of the error.
        #
        # 410 joins it rather than falling through to "not retrievable" below. The
        # ambiguity is a property of the GUESS, not of the status: a wrong slug and a
        # closed job are equally capable of producing either code, so a 410 needs the
        # same board-exists disambiguation before it is allowed to close a row.
        if st in GONE:
            guessed = not m
            if guessed:
                good, listing = None, ""
                for b in boards:
                    bst, blist = fetch(f"https://boards-api.greenhouse.io/v1/boards/{b}/jobs")
                    if bst == 200:
                        good, listing = b, blist
                        break
                if not good:
                    # Last resort: ask the posting page which board it embeds.
                    pst, phtml = fetch(u)
                    disc = discover_board(phtml)
                    if disc and disc not in boards:
                        st2, body2 = fetch(f"https://boards-api.greenhouse.io/v1/boards/{disc}/jobs/{jid}")
                        if st2 == 200 and body2:
                            dd = jload(body2, need=("title",))
                            if dd is UNREADABLE:
                                return unreadable("greenhouse", st2,
                                                  f"the discovered board {disc}")
                            # Same builder as the direct path above. This branch used to
                            # read location.name alone, so a req whose reachable site sat
                            # in offices[] or whose remote metadata said Yes was returned
                            # as a bare country and hard-failed by the location gate.
                            return greenhouse_record(dd, disc, discovered_board=disc)
                    if not id_declared:
                        # Everything about this claim was inferred: the board slug from
                        # the hostname, the id from a number in the path. Nothing has
                        # corroborated either, so there is no basis for ANY verdict here,
                        # least of all `stale_ats`, which is the pruning one. Decline and
                        # let last_resort ask the posting page itself.
                        return None
                    # "No Greenhouse at all" is checked literally rather than inferred
                    # from a slug match that failed. A page can name greenhouse.io in a
                    # snippet this parser cannot read, and calling that a departure from
                    # the ATS retires a row that is still live. Measured 2026-09-20: the
                    # careers roots of Riot, Airbnb, NVIDIA and Disney ALL come back with
                    # no "greenhouse.io" in the served HTML, Riot included, and Riot is a
                    # real Greenhouse board. So this test is only safe where something
                    # else already established the ATS, which `id_declared` now does.
                    if pst == 200 and "greenhouse.io" not in (phtml or "").lower():
                        # The careers page loads and contains no Greenhouse at all,
                        # so the company has left the ATS this row was scraped from.
                        # The row can never resolve and should stop recurring. This
                        # verdict is real (Unity's board retired 2026-07-27, four slugs
                        # all 404), but portals.yml has already been asked by the time
                        # it is reached, so it can no longer fire on a slug we guessed
                        # wrong. Name what was tried, because the verdict prunes rows.
                        return dict(ats="greenhouse", live=None, status=st, stale_ats=True,
                                    note="company no longer uses Greenhouse; inbox row is "
                                         f"stale (tried {boards}, portals.yml first)")
                    return dict(ats="greenhouse", live=None, status=st,
                                note=f"no valid board among {boards}; HTTP {st} may be a "
                                     f"bad guess, not a closure")
                if job_status.get(good) not in GONE:
                    # The board that exists is not the board that said the job was gone.
                    return dict(ats="greenhouse", live=None, status=job_status.get(good),
                                note=f"board {good} exists, but ITS answer for the job was "
                                     f"HTTP {job_status.get(good)}, which is not a closure; "
                                     f"the {st} came from a different candidate")
                if not id_declared and not board_owns_host(listing, u):
                    # A board by this name exists, but BOTH halves of the key were ours:
                    # the slug guessed off the hostname, the id read out of a path. A
                    # same-named board belonging to a different company makes the
                    # board-exists test worthless on its own, and that is not
                    # hypothetical. Measured 2026-09-20: www.disneycareers.com yields
                    # the candidate slug "disney", the Greenhouse board "disney" exists
                    # and answers 200, every Radancy id 404s inside it, and a LIVE
                    # Disney posting returning HTTP 200 was resolved CLOSED. It was
                    # deterministic rather than unlucky: it fired for every
                    # disneycareers URL, live or dead, because a Radancy id can never
                    # appear in Greenhouse's namespace.
                    return None
            # Say which evidence closed it. The guessed path reaches here having PROVED the
            # board exists; the direct-URL path never looks, because the slug came from the
            # URL, and it was still claiming "on a board that exists". Temporal's rows are
            # the case that showed it: their board answers 404 and the note asserted the
            # opposite. The verdict was right and the reason was invented.
            return dict(ats="greenhouse", live=False, status=st,
                        note=(f"job HTTP {st} on the board named in the URL = closed" if m
                              else f"job HTTP {st} on a board that exists = closed"))
        # No decline here, deliberately. The safety property is narrower than "an
        # uncorroborated guess must stay silent": it is that an uncorroborated guess must
        # never CLOSE a row. A transport failure or a 500 is not evidence that this host
        # is on some other ATS, and `live=None` makes no claim about the posting either
        # way, so reporting it costs nothing and keeps the branch visible to the routing
        # test. Every path that could reach `live=False` or `stale_ats` is guarded above.
        return dict(ats="greenhouse", live=None, status=st, note="not retrievable")
    return None


# A host-shaped segment sitting inside a path or a query: two or more dot-separated labels
# ending in something TLD-shaped, followed by a separator, which a redirect destination
# always has. Candidates only; maps_to_a_board() decides.
#
# THE SEPARATOR IS `/`, `?` OR `#`, not `/` alone. A destination
# with no path still has somewhere to put its requisition:
# `careers.acme.com?job=R185011` and `careers.acme.com#R185011` are both real addresses,
# and a tracker percent-encodes the `?` as readily as the slash. This is the same
# three-separator rule the OUTER host cut in wraps_another_url() already uses, applied one
# place and not the other, a shape this codebase has hit repeatedly.
EMBEDDED_HOST = re.compile(r"(?<![\w.-])((?:[\w-]+\.)+[a-z]{2,24})[/?#]", re.I)


def maps_to_a_board(host):
    """Would this resolver turn `host` into a board of its own, via portals.yml?

    The question the wrapper detector needs and cannot ask of a vendor list: careers
    .adobe.com is not an ATS hostname, and this file maps it to adobe/wd5 all the same.
    Asked of the same functions the resolver itself uses, so the two can never disagree
    about which hosts are mapped.
    """
    u = f"https://{host}/"
    return bool(portal_workday(u)) or bool(portal_boards(u))


def wraps_another_url(url):
    """Does this url carry a SECOND posting's address inside it?

    A posting url never legitimately contains another one, so a second scheme means a
    click tracker, a redirect or a login bounce carrying somebody else's posting. The
    encoded spelling counts, since that is how a query parameter usually holds one.

    AND THE SCHEME IS OFTEN DROPPED, which counting schemes cannot see.
    `https://tracker.example/r/foo.successfactors.com/job/x/123456` holds one
    scheme and is still a wrapper. Anchoring the adapters, done earlier, stops
    the embedded posting being RESOLVED, and does nothing about a branch that reads the
    OUTER url's status: the SuccessFactors branch closed on the tracker's own 404 through
    `not (st == 200 and body)`, and last_resort would do the same for any host. That is
    the general shape, so the fix belongs here rather than in either branch.

    Lives here rather than in inbox-liveness.py, which had the first copy: this module
    owns url handling, every caller of resolve() is exposed to the same problem, and two
    copies of a rule is the drift this file has spent a day removing.
    """
    s = str(url or "")
    if len(re.findall(r"https?://", s, re.I)) > 1:
        return True
    if re.search(r"https?(%3a|%3A)(%2f|%2F){2}", s):
        return True
    # EVERYTHING AFTER THE OUTER HOST is scanned, query and fragment included. Cutting the
    # query first was the obvious move and it is wrong: a query
    # parameter is the commonest place a tracker puts its destination, and
    # `https://tracker.example/c?url=jobs.ashbyhq.com/acme/<id>` then read as an ordinary
    # url, fell through the anchored adapters to last_resort() and was closed on the
    # tracker's own 404. Only the HOST has to come off, because the host is the one part
    # that is legitimately this row's own.
    #
    # Percent-decoded first, so an encoded separator counts: `...%2Facme%2F<id>` is the
    # same destination written differently, and a rule that reads only the literal spelling
    # is a rule a tracker defeats by accident.
    #
    # The host is cut at the first `/`, `?` or `#`, whichever comes first, and not at `/`
    # alone: `tracker.example?url=jobs.ashbyhq.com/acme/x` has its first slash INSIDE the
    # embedded address, so cutting there removes the very host being looked for. The scheme
    # is optional throughout, because this toolchain routes scheme-less urls on purpose and
    # an inbox row can be stored without one: cutting `^https?://[^/]*` in one step leaves
    # a bare `job-boards.greenhouse.io/cresta/jobs/4233080640` entirely intact, and it then
    # reads as a url wrapping ITSELF. That is the over-refusal direction, which loses rows
    # silently, and an existing routing case caught it within the minute.
    bare = re.sub(r"^https?://", "", urllib.parse.unquote(s), flags=re.I)
    cut = [i for i in (bare.find(c) for c in "/?#") if i >= 0]
    rest = bare[min(cut):] if cut else ""
    if ATS_IN_PATH.search(rest):
        return True
    # A vendor list cannot be the whole rule, because this resolver also maps COMPANY-HOSTED
    # front ends. careers.adobe.com and careers.blizzard.com are
    # the human faces of Workday tenants portals.yml records, and portal_workday() keys on
    # the PARSED host, so a wrapper carrying one of them matched nothing, fell through to
    # last_resort() and was closed on the tracker's own 404.
    #
    # So the second half asks the question by DATA rather than by another list: is any
    # host-shaped thing in here one this resolver would map to a board? That covers Adobe
    # and Blizzard today and every portals.yml entry added later, with nothing to keep in
    # step. A false positive needs a host-shaped segment that portals.yml also recognises,
    # and it costs an unknown rather than a wrong closure.
    return any(maps_to_a_board(h) for h in EMBEDDED_HOST.findall(rest))


def resolve(url):
    u = url.strip()
    # A wrapper is refused outright, not unwrapped. Cutting the query is not enough
    # because the embedded url can sit in the PATH, and every adapter below searches for
    # a host and path shape wherever it appears. Which of the two postings the row is
    # about is not answerable here, so nothing is claimed.
    #
    # AND NOTHING IS CLOSED EITHER, which the first version of this got wrong. It handed
    # the wrapper to last_resort() on the reasoning that a
    # status probe of the outer url is safe because it "can only ever close it". That is
    # the whole bug stated as though it were the safeguard: last_resort closes on 404 and
    # 410, and a dead click-tracking or redirect endpoint answers exactly that while the
    # posting it points at is untouched. Tracking links rot on their own schedule, so the
    # outer status is evidence about the REDIRECT. It is the same provenance rule this
    # file already applies to an inferred Greenhouse slug and to an Eightfold domain
    # derived from a hostname: something that cannot identify the posting may report what
    # it finds, and may never report an absence.
    if wraps_another_url(u):
        return dict(ats="unsupported", live=None, url=u,
                    note="this url wraps another posting's url, so which posting the row "
                         "is about is not answerable here; the outer redirect's own "
                         "status is evidence about the redirect and not about either "
                         "posting, so liveness is unknown")
    # The OUTER url: query and fragment cut. Every adapter below matches a host and path
    # shape, and a posting url riding inside a redirect or tracking parameter belongs to
    # another row entirely, so searching the whole string lets an embedded Ashby or Lever
    # posting be resolved and ITS verdict returned for this one. Only the two branches
    # that genuinely read the query keep `u`: the Greenhouse gh_jid, and Eightfold's
    # `?domain=` tenant parameter. The selftest asserts that list has not grown.
    ou = u.split("?")[0].split("#")[0]
    # Positive rules first, every one of them, and the guess last. The order below is
    # load-bearing: each branch matches a shape its own ATS is the only issuer of.
    gh = greenhouse_claim(u, allow_inference=False)
    if gh:
        return gh

    m = re.search(OUTER_HOST + r"jobs\.ashbyhq\.com/([\w-]+)/([0-9a-f-]{16,})", ou)
    if m:
        org, jid = m.group(1), m.group(2)
        st, body = fetch(f"https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true")
        if st == 200 and body:
            d = jload(body, need=("jobs",))
            if d is UNREADABLE:
                return unreadable("ashby", st, "the posting API response")
            for j in d.get("jobs", []):
                if jid in json.dumps(j):
                    txt = clean(j.get("descriptionHtml") or j.get("descriptionPlain") or "")
                    # Ashby's remote option often lives in secondaryLocations rather
                    # than the primary string: GC AI posts "San Mateo, California" with
                    # a secondary "Remote - United States". Returning only the primary
                    # made it read as Bay Area and auto-skip, discarding a role the candidate can
                    # actually take. Fold them in the way the Workday branch already does.
                    locs = [j.get("location", "")] + [
                        (sl or {}).get("location", "")
                        for sl in (j.get("secondaryLocations") or [])]
                    locs = [l for l in dict.fromkeys(locs) if l]
                    return dict(ats="ashby", live=True, title=j.get("title"),
                                location=" | ".join(locs), pay=pays(txt), jd=txt,
                                org=org, remote_txt=bool(j.get("isRemote")))
            # AN EMPTY BOARD CLOSES NOTHING. `{"jobs": []}`
            # parses, so `need=("jobs",)` is satisfied and the loop above simply finds
            # nothing, which read as "absent from board" and retired every row on that
            # board. It is not hypothetical here: CLAUDE.md records the bare `patronus`
            # Ashby board as a decoy that serves an empty array while the real board is
            # `patronusaiinc`, so a slug that is merely WRONG produces a clean 200 and an
            # empty list. inbox-liveness.py has treated an empty board as NOT READ since
            # it was written; this adapter disagreed with it, and this adapter is what
            # that file falls back to.
            if not d.get("jobs"):
                return dict(ats="ashby", live=None, status=st, org=org,
                            note="the Ashby board parsed and is EMPTY, which is what a "
                                 "wrong org slug also returns, so it is not evidence "
                                 "this posting is gone; liveness is unknown")
            return dict(ats="ashby", live=False, note="absent from board = closed")
        # The posting API answered something other than 200, which says nothing about the
        # board: it is opt-in, and an org that never enabled it answers 404 for ever. Read
        # the pages the way a browser would before returning any verdict at all.
        pst, page = fetch(f"https://jobs.ashbyhq.com/{org}/{jid}")
        got = ashby_from_page(page, org, jid) if pst == 200 else None
        if got:
            got["status"] = st
            return got
        bst, bpage = fetch(f"https://jobs.ashbyhq.com/{org}")
        rows = _ashby_embed.postings(bpage, org) if bst == 200 else []
        for r in rows:
            if str(r.get("id", "")).lower() == jid.lower():
                # On the board but not readable on its own page. Live, with the listing's
                # fields and no JD, and it SAYS there is no JD: a packet built from this
                # scores lane signals on nothing, and silence there reads as a bad fit
                # rather than as missing evidence.
                return dict(ats="ashby", live=True, title=r.get("title"), org=org,
                            location=r.get("location") or None, jd="",
                            pay=pays(k_band(r.get("comp") or "")), embedded=True, status=st,
                            comp_summary=r.get("comp") or None,
                            note="read from the embedded board; the listing carries no JD",
                            remote_txt=bool(re.search(
                                r"\bremote\b",
                                (r.get("workplace") or "") + " " + (r.get("location") or ""),
                                re.I)))
        if rows:
            # The board page parsed and this id is not on it. Same evidence, same verdict
            # as the API path above.
            return dict(ats="ashby", live=False, status=st,
                        note=f"absent from the embedded board of {len(rows)} = closed")
        # Neither page yielded a posting. That is "not checked", not "nothing found".
        return dict(ats="ashby", live=None, status=st,
                    note="posting API and board page both unreadable")

    m = re.search(OUTER_HOST + r"jobs\.lever\.co/([\w-]+)/([0-9a-f-]{16,})", ou)
    if m:
        st, body = fetch(f"https://api.lever.co/v0/postings/{m.group(1)}/{m.group(2)}")
        if st == 200 and body:
            d = jload(body, need=("text",))
            if d is UNREADABLE:
                return unreadable("lever", st, "the postings API response")
            txt = clean(d.get("descriptionPlain") or d.get("description") or "")
            # Lever keeps the remote option in categories.allLocations while
            # categories.location shows only ONE of them, and they disagree. Waabi's
            # "Simulation Assets & Content Systems" req reads "Toronto, ON" as its
            # primary and lists "Remote US & Canada" only in allLocations, so reading
            # the primary alone auto-skipped the best-fitting role of the whole sweep.
            # Third ATS today with this exact shape, after Ashby's secondaryLocations
            # and Workday's additionalLocations: assume every board has one.
            cats = d.get("categories") or {}
            locs = [cats.get("location", "")] + list(cats.get("allLocations") or [])
            locs = [l for l in dict.fromkeys(locs) if l]
            return dict(ats="lever", live=True, title=d.get("text"), org=m.group(1),
                        location=" | ".join(locs),
                        pay=pays(txt), jd=txt,
                        workplace=d.get("workplaceType"),
                        remote_txt=bool(re.search(r"\bremote\b", " ".join(locs), re.I))
                                   or bool(re.search(r"\bremote\b", txt, re.I)))
        return dict(ats="lever", live=unresolved(st), status=st,
                    note=gone_note(st))

    # `(?:[\w-]{2,5}/)?` for the locale was a LENGTH test, and CLAUDE.md already records
    # why that is wrong in the other direction: Autodesk's Workday site is literally
    # `Ext`, so a length bound cannot tell a locale from a site. This is the same bug read
    # the other way. On a URL that carries a locale and NO site,
    # `.../nvidia.wd5.myworkdayjobs.com/en/job/US-CA-Remote/X_JR2620896`, the engine
    # backtracks the optional group away and reads the locale itself as the site, then
    # fabricates `/wday/cxs/nvidia/en/job/...`, an endpoint that has never existed. Its
    # 404 then CLOSED the row. inbox-liveness.py refuses exactly this URL by shape and
    # hands it here as unsettled, so the guard upstream was being undone downstream.
    m = re.match(r"https://([\w-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[\w-]{2,5}/)?([^/]+)/(job/.+)$",
                 u.split("?")[0])
    if m and WD_LOCALE_ONLY.match(m.group(3)):
        return dict(ats="workday", live=None, org=m.group(1),
                    note=f"this url carries a locale ({m.group(3)}) where the Workday "
                         f"SITE belongs, so there is no board to ask; building a CXS "
                         f"path from it addresses an endpoint that does not exist and "
                         f"its 404 would be about the fabricated path, not the posting")
    if m:
        tenant, wd, site, path = m.groups()
        st, body = fetch(f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/{path}")
        if st == 200 and body:
            # Without jobPostingInfo there is no canApply, and bool(None) is False, so a
            # WAF's `{}` at HTTP 200 used to CLOSE the posting rather than admit it had
            # not been read. The NESTED spelling is the same bug one level down:
            # `{"jobPostingInfo": {}}` satisfied a top-level `jobPostingInfo` check and
            # then closed the posting on an empty record. The verdict below is
            # bool(canApply), so canApply is what has to have been read.
            d = jload(body, need=("jobPostingInfo.canApply",))
            if d is UNREADABLE:
                return unreadable("workday", st, "the CXS detail response")
            return workday_record(d.get("jobPostingInfo", {}) or {})
        if st == 403:
            # Stale slug, not a closure. Ask the tenant for the current path.
            ep, searched = workday_reslug(tenant, wd, site, path)
            if ep:
                st2, body2 = fetch(f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/{ep}")
                if st2 == 200 and body2:
                    # Same nested declaration as the direct path: the re-slugged branch
                    # issues the same bool(canApply) verdict off the same record.
                    d2 = jload(body2, need=("jobPostingInfo.canApply",))
                    if d2 is UNREADABLE:
                        return unreadable("workday", st2,
                                          "the re-slugged CXS detail response")
                    return workday_record(d2.get("jobPostingInfo", {}) or {},
                                          reslugged=True)
            # Search saw nothing carrying this req id, which for Workday means the
            # posting is no longer in the active index. That verdict rests entirely on
            # the search having RUN: if CXS refused it, timed out or returned something
            # unparseable, nothing was read and the same empty hand would retire a live
            # req. Same rule as the Ashby board fallback above and as inbox-liveness:
            # an absent id is evidence only when the board was read cleanly.
            if searched:
                return dict(ats="workday", live=False, status=403,
                            note="slug stale and req absent from tenant search = closed")
            return dict(ats="workday", live=None, status=403,
                        note="slug stale and the tenant search was unreadable, so nothing "
                             "was checked; liveness unknown, not closed")
        return dict(ats="workday", live=unresolved(st), status=st,
                    note=gone_note(st))

    # Eightfold. Netflix was the first tenant seen and was written in hostname and all;
    # `/careers/job/<digits>` is Eightfold's shape everywhere, and jobs.nvidia.com serves
    # the identical apply API (verified 2026-09-20: /api/apply/v2/jobs/824350365339
    # ?domain=nvidia.com answers 200). Until this generalised, an NVIDIA Eightfold URL
    # fell past every adapter to the Greenhouse guess and came back "company no longer
    # uses Greenhouse", about NVIDIA.
    #
    # The tenant `domain` parameter is NOT derivable from the hostname, and assuming it
    # were would rebuild the exact defect this file spent the day paying off. Netflix is
    # its own counterexample: host explore.jobs.netflix.NET, domain netflix.COM. Further
    # out, mercadolibre.eightfold.ai publishes domain mercadolibre.com and
    # anywhere.eightfold.ai publishes volkscience.com, which no hostname arithmetic
    # reaches. So provenance decides authority here exactly as it does for a Greenhouse
    # job id: a domain the link itself declares, or one this file records against a host
    # somebody verified, may close a row; one derived from the hostname may report a
    # posting it finds and may report not knowing, and may never report a closure,
    # because a 404 from the wrong tenant and a 404 from a retired posting are one 404.
    m = re.search(r"^https?://([^/]+)/careers/job/(\d+)", ou)
    if m:
        ehost, ejid = m.group(1).lower(), m.group(2)
        dm = re.search(r"[?&]domain=([\w.-]+)", u)
        domain = dm.group(1) if dm else EIGHTFOLD_DOMAINS.get(ehost)
        declared = domain is not None
        if not domain:
            labels = ehost.split(".")
            domain = f"{labels[-2]}.com" if len(labels) > 1 else ""
        ats = "netflix" if "netflix" in ehost else "eightfold"
        st, body = fetch(f"https://{ehost}/api/apply/v2/jobs/{ejid}?domain={domain}")
        if st == 200 and body:
            # The posting record is NESTED here and may sit under `job`, under `data` or
            # at the top level, so the declaration names the nested field in each of the
            # three places it can appear. {"job": {}} used to satisfy a bare `job` check
            # and then yield live=True with a null title, which is the unread-as-verdict
            # failure one level down; the dotted paths are what _present() walks.
            d = jload(body, need=(("job.name", "data.name", "name"),))
            if d is UNREADABLE:
                return unreadable(ats, st, "the apply API response")
            j = d.get("job") or d.get("data") or d
            # Belt and braces: `need` proves SOME spelling carried a name, and this
            # proves the one the `or` chain picked is the same object.
            if not isinstance(j, dict) or j.get("name") is None:
                return unreadable(ats, st,
                                  "the posting record inside the apply API response")
            txt = clean(j.get("job_description", ""))
            return dict(ats=ats, live=True, title=j.get("name"), jd=txt,
                        org=(domain or ehost).split(".")[0],
                        location=" | ".join(j.get("locations") or [j.get("location", "")]),
                        pay=pays(txt), remote_txt=bool(re.search(r"\bremote\b", txt, re.I)))
        if declared:
            return dict(ats=ats, live=unresolved(st), status=st, note=gone_note(st))
        return dict(ats=ats, live=None, status=st,
                    note=f"tenant domain {domain!r} was derived from the hostname rather "
                         f"than declared, so HTTP {st} cannot tell a retired posting from "
                         f"the wrong tenant; liveness unknown")

    sr = smartrecruiters_ref(ou)
    if sr:
        company, ids = sr
        st, body = 0, ""
        for rid in ids:
            st, body = fetch(
                f"https://api.smartrecruiters.com/v1/companies/{company}/postings/{rid}")
            if st == 200 and body:
                break
        if st == 200 and body:
            d = jload(body, need=("name",))
            if d is UNREADABLE:
                return unreadable("smartrecruiters", st, "the postings API response")
            loc = d.get("location") or {}
            parts = [loc.get("city"), loc.get("region"), loc.get("country")]
            txt = clean(json.dumps(d.get("jobAd", {})))
            return dict(ats="smartrecruiters", live=True, title=d.get("name"),
                        org=company,
                        location=", ".join([p for p in parts if p]), jd=txt, pay=pays(txt),
                        remote_txt=bool(loc.get("remote")) or
                                   bool(re.search(r"\bremote\b", txt, re.I)))
        return dict(ats="smartrecruiters", live=unresolved(st), status=st,
                    note=gone_note(st))


    m = re.search(OUTER_HOST + r"jobs\.apple\.com/[\w-]+/details/([\w-]+)", ou)
    if m:
        st, body = fetch(u)
        d = apple_jobs_data(body) if st == 200 and body else None
        if d:
            locs = [", ".join([x for x in (l.get("city"), l.get("stateProvince"),
                                           l.get("countryName") or l.get("country")) if x])
                    for l in (d.get("locations") or [])]
            locs = [l for l in locs if l]
            txt = clean(" ".join(str(d.get(k) or "") for k in (
                "jobSummary", "description", "minimumQualifications",
                "preferredQualifications", "postingFooters")))
            # homeOffice False plus a named campus is Apple's onsite shape. The band
            # spans two levels when lowJobTitle and highJobTitle differ, which changes
            # what the posted range means, so surface both.
            lvl = [d.get("lowJobTitle"), d.get("highJobTitle")]
            lvl = " to ".join([x for x in dict.fromkeys([l for l in lvl if l])])
            return dict(ats="apple", live=True, title=d.get("postingTitle"), org="apple",
                        location=" | ".join(locs) or None, jd=txt, pay=pays(txt),
                        req_id=d.get("jobNumber") or d.get("reqId"), level=lvl or None,
                        remote_txt=bool(d.get("homeOffice")) or
                                   bool(re.search(r"\bremote\b", txt, re.I)))
        # 410 joins 404 here for the same reason it does everywhere else: Apple's detail
        # page answering either is Apple saying the posting is not there, and the branch
        # below would otherwise report a stated removal as "re-check the parser".
        if st in GONE:
            return dict(ats="apple", live=False, status=st,
                        note=f"detail page gone (HTTP {st}) = closed")
        return dict(ats="apple", live=None, status=st,
                    note="page fetched but no jobsData block; Apple may have changed the "
                         "embed, re-check the parser before trusting a verdict")

    if re.search(OUTER_HOST + r"amazon\.jobs/", ou, re.I):
        # amazon.jobs answers scripted requests with 406 and an anti-bot HTML page on
        # every variant tried: the .json endpoint, the slugged .json, with and without
        # an Accept header. There is no verdict to be had over plain HTTP, and guessing
        # one would be worse than admitting it.
        return dict(ats="amazon", live=None,
                    note="amazon.jobs blocks scripted access (406). Resolve with Playwright.")

    # SuccessFactors career sites. Lionsgate is the one that surfaced, but the same
    # markup backs many employers, so match the platform rather than the tenant.
    sf_named = re.search(r"successfactors", ou, re.I)
    if sf_named or re.search(r"/job/[^/]+/\d{6,}/?$", ou, re.I):
        st, body = fetch(u)
        if st == 200 and body and re.search(r"successfactors", body, re.I):
            title = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', body)
            txt = clean(body)
            loc = re.search(r"Location:\s*([A-Za-z][^#|]{3,60}?)\s*(?:#|Date|Req|$)", txt)
            return dict(ats="successfactors", live=True,
                        title=html.unescape(title.group(1)).strip() if title else None,
                        location=loc.group(1).strip() if loc else None,
                        jd=txt, pay=pays(txt),
                        remote_txt=bool(re.search(r"\bremote\b", txt, re.I)))
        # Decline ONLY when a page was actually read and DISPROVED the platform. The shape
        # `/job/<slug>/<digits>` is a common layout rather than a SuccessFactors signature:
        # it also matches builtin.com, whose row was answered "not retrievable" by an
        # adapter for an ATS it has never used, while its own page carried a schema.org
        # JobPosting stating the req expired in June. Claiming a URL you cannot read is
        # worse than declining it, because everything downstream is denied its turn.
        #
        # Narrow on purpose. Lionsgate IS SuccessFactors and its URL never says so, so a
        # decline on every unconfirmed shape would throw away a working adapter: a 404 or
        # 410 there is real evidence about the posting whatever the platform, and a
        # transport failure has disproved nothing at all.
        if sf_named or not (st == 200 and body):
            return dict(ats="successfactors", live=unresolved(st), status=st,
                        note=gone_note(st))

    # Workable. The account-scoped v1 API is public and authoritative; state
    # "published" is the liveness signal and "remote" is a real boolean rather than a
    # word to be grepped out of a location string.
    m = re.search(OUTER_HOST + r"apply\.workable\.com/([\w-]+)/j/([A-Za-z0-9]+)", ou)
    if m:
        acct, code = m.group(1), m.group(2)
        st, body = fetch(f"https://apply.workable.com/api/v1/accounts/{acct}/jobs/{code}")
        if st == 200 and body:
            # `state` is the liveness signal, so an absent one compared unequal to
            # "published" and closed the posting. The other direction of the same bug:
            # Lever and Greenhouse above returned live=True for the identical `{}`.
            d = jload(body, need=("title", "state"))
            if d is UNREADABLE:
                return unreadable("workable", st, "the account API response")
            locs = []
            for L in (d.get("locations") or [d.get("location") or {}]):
                part = ", ".join([x for x in (L.get("city"), L.get("region"),
                                              L.get("country")) if x])
                if part:
                    locs.append(part)
            if d.get("remote") and not any("remote" in l.lower() for l in locs):
                # Keep the flag visible in the string too, so downstream location
                # rules that only read text still see it.
                locs.append("Remote")
            txt = clean(d.get("description", "") or "")
            return dict(ats="workable", live=(d.get("state") == "published"),
                        title=d.get("title"), org=acct,
                        location=" | ".join(dict.fromkeys(locs)) or None,
                        jd=txt, pay=pays(txt), remote_txt=bool(d.get("remote")),
                        status=st)
        return dict(ats="workable", live=unresolved(st), status=st,
                    note=gone_note(st))


    # Breezy. The company board is public at /json; individual posting URLs 302, so match
    # the position by the id that prefixes the URL slug.
    m = re.search(OUTER_HOST + r"([\w-]+)\.breezy\.hr/p/([0-9a-f]+)", ou)
    if m:
        org, pid = m.group(1), m.group(2)
        st, body = fetch(f"https://{org}.breezy.hr/json")
        if st == 200 and body:
            board = jload(body, want=list)
            if board is UNREADABLE:
                return unreadable("breezy", st, "the board JSON")
            # A list that holds no posting RECORD is the same unreadable answer as a
            # list that never parsed, and the closure below is destructive, so the two
            # must not share an exit. An empty board is in here on purpose: it is the
            # rule inbox-liveness.py already states, that an absent id is evidence only
            # when the board was read cleanly, and an empty board was not read cleanly.
            postings = [j for j in board if isinstance(j, dict)]
            if not postings:
                return unreadable("breezy", st,
                                  "the board JSON (it parsed, and held no posting)")
            for j in postings:
                if str(j.get("id", "")).lower() != pid.lower():
                    continue
                locs = []
                for L in (j.get("locations") or [j.get("location") or {}]):
                    parts = [(L.get("city") or {}).get("name") if isinstance(L.get("city"), dict) else L.get("city"),
                             (L.get("state") or {}).get("name") if isinstance(L.get("state"), dict) else L.get("state"),
                             (L.get("country") or {}).get("name") if isinstance(L.get("country"), dict) else L.get("country")]
                    s = ", ".join([x for x in parts if x])
                    if L.get("is_remote"):
                        s = (s + " | Remote").strip(" |")
                    if s:
                        locs.append(s)
                sal = j.get("salary") or {}
                paytxt = " ".join(str(sal.get(k, "")) for k in ("min", "max", "currency"))
                return dict(ats="breezy", live=True, title=j.get("name"), org=org,
                            location=" | ".join(dict.fromkeys(locs)) or None,
                            jd=clean(j.get("description", "") or ""),
                            pay=pays(paytxt) or pays(clean(j.get("description", "") or "")),
                            remote_txt=any((L or {}).get("is_remote")
                                           for L in (j.get("locations") or [j.get("location") or {}])))
            return dict(ats="breezy", live=False, note="absent from board = closed")
        return dict(ats="breezy", live=None, status=st, note="board not retrievable")

    # GitHub's own careers site (Avature-backed), not Greenhouse. Paged JSON API.
    m = re.search(OUTER_HOST + r"github\.careers/careers-home/jobs/(\d+)", ou)
    if m:
        want = m.group(1)
        for page in range(1, 8):
            st, body = fetch(f"https://www.github.careers/api/jobs?page={page}&limit=50")
            if st != 200 or not body:
                break
            d = jload(body, need=("jobs",))
            if d is UNREADABLE:
                return unreadable("github", st, f"page {page} of the jobs API")
            rows = d.get("jobs", []) or []
            for r in rows:
                d = r.get("data") or {}
                if str(d.get("req_id") or d.get("slug")) != want:
                    continue
                locs = [x for x in (d.get("location_name"), d.get("full_location")) if x]
                txt = clean(d.get("description", "") or "")
                return dict(ats="github", live=True, title=d.get("title"), org="github",
                            location=" | ".join(dict.fromkeys(locs)) or None,
                            jd=txt, pay=pays(txt),
                            remote_txt=bool(re.search(r"\bremote\b",
                                                     " ".join(locs) + " " + str(d.get("location_type") or ""), re.I)))
            if not rows:
                break
        return dict(ats="github", live=None, status=0,
                    note="req id not found in the first 350 postings; may be closed")

    # iCIMS. The human page is a single-page app whose job content lives in an IFRAME, so a
    # plain fetch of it returns 471KB of bundle and no title, and the resolver gave up. The
    # iframe view is server-rendered: `?in_iframe=1` returns the posting with its title in
    # `<title>`, and a requisition that does not exist answers **HTTP 410**, which is the
    # strongest closure signal there is. Both measured 2026-09-21 against GitHub's tenant.
    m = re.search(OUTER_HOST + r"([\w-]+)\.icims\.com/jobs/(\d+)", ou, re.I)
    if m:
        tenant, jid = m.group(1), m.group(2)
        st, body = fetch(f"https://{tenant}.icims.com/jobs/{jid}/job?in_iframe=1",
                         accept=HTML_ACCEPT)
        # No explicit GONE branch: the tail below already returns live=unresolved(st),
        # which IS False for 404 and 410. A mutation showed the branch that used to sit
        # here could be deleted without any case noticing, which is the definition of a
        # line that is not doing anything.
        if st == 200 and body:
            t = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
            title = clean(t.group(1)) if t else ""
            # iCIMS serves its own not-found page with a 200 in some tenants, so the title
            # has to be read rather than the status trusted on its own.
            if title and not re.search(r"no longer available|does not exist", title, re.I):
                txt = clean(body)
                # clean() leaves the line breaks as a literal backslash-n, so the location
                # phrase has to be cut at one or it swallows the next heading: the first
                # version returned "Remote, United States\n Overview \n GitHub is se".
                loc = re.search(r"you can work from ([^.<]{3,60})", txt)
                return dict(ats="icims", live=True, org=tenant,
                            title=title.split(" in ")[0].split(" | ")[0].strip(),
                            jd=txt, pay=pays(txt),
                            location=(loc.group(1).split("\\n")[0].strip() if loc else None),
                            remote_txt=bool(re.search(r"\bremote\b", txt, re.I)))
            return unreadable("icims", st, "the iframe view (it loaded and named no job)")
        return dict(ats="icims", live=unresolved(st), status=st, note=gone_note(st))

    # No adapter matched. Three last resorts, best first: an authoritative lookup, then
    # an inference, then a bare status code.
    #
    # Several of these hosts are not really adapterless: they are human front ends for a
    # Workday tenant portals.yml already records, and the requisition id is sitting in
    # the URL path. careers.blizzard.com is xboxgaming/Blizzard_External_Careers and
    # careers.adobe.com is adobe/external_experienced, so those reqs get a real Workday
    # verdict with a location, a band and a JD, not a bare status code. Ask the file
    # before probing, the same ordering rule that stopped four live SentinelOne rows
    # being closed on a hostname guess.
    wd = portal_workday(u)
    # Query and fragment stripped BEFORE the id is read. A tracking parameter carrying a
    # req-shaped token is not this posting's requisition, which is the rule req_key() in
    # eval-blockers.py already states in as many words. Without it `?utm_campaign=JR48085`
    # is taken as the req, workday_by_req() then reports a clean miss as live=False, and
    # inbox-liveness --mark retires a row on the strength of a marketing tag.
    rid = WD_REQ_ID.search(u.split("?")[0].split("#")[0])
    if wd and rid:
        got = workday_by_req(wd, rid.group(0))
        if got is not None:
            return got
    # Only now, with every positive rule declined and the file out of answers, is the
    # resolver allowed to guess that a long number in the path is a Greenhouse job id.
    # It declines rather than answering whenever nothing corroborates the guess, so the
    # worst it can do from here is stay silent.
    gh = greenhouse_claim(u, allow_inference=True)
    if gh:
        return gh
    # The tenant said nothing, there was no tenant, and the guess declined. Fall back to
    # the status code of the posting URL itself, which can only ever close a row, never
    # open one.
    return last_resort(u)


# URL shape -> expected ATS. Adding a generic numeric-id fallback for
# company-hosted Greenhouse boards silently hijacked Netflix and SmartRecruiters
# URLs, which also carry long numeric ids, and turned live postings into
# "closed". Routing is asserted now instead of assumed.
ROUTE_CASES = [
    ("https://explore.jobs.netflix.net/careers/job/712200781859-sr-ta?domain=netflix.com", "netflix"),
    # The same Eightfold shape under another tenant. Before this generalised, it fell
    # past every adapter to the Greenhouse guess, which answered "company no longer uses
    # Greenhouse" about NVIDIA.
    ("https://jobs.nvidia.com/careers/job/824350365339-senior-swe", "eightfold"),
    ("https://jobs.smartrecruiters.com/NBCUniversal3/794330812622252", "smartrecruiters"),
    ("https://www.riotgames.com/en/work-with-us/job/8372403/principal-swe", "greenhouse"),
    ("https://careers.airbnb.com/positions/6631030/", "greenhouse"),
    ("https://job-boards.greenhouse.io/cresta/jobs/5055750430", "greenhouse"),
    ("https://jobs.ashbyhq.com/deepgram/0f1db59b-b272-644c-af35-f84c91963e3b", "ashby"),
    ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2391853", "workday"),
    ("https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472", "lever"),
    # The three hosts that fell through to UNSUPPORTED on the 2026-08-24 sweep and
    # forced three packets to be hand-built. amazon.jobs and SuccessFactors also have
    # to beat the generic Greenhouse fallback, which claimed both on the long numeric
    # id in their paths, so these cases guard the routing order as much as the branch.
    ("https://jobs.apple.com/en-us/details/275158197-0670/lead-developer-ai-workflows", "apple"),
    ("https://www.amazon.jobs/en/jobs/11661130/ai-vfx-r-d-lead-ai-studios", "amazon"),
    ("https://jobs.lionsgate.com/Lionsgate/job/Santa-Monica-Director-CA-90404/1104510032/",
     "successfactors"),
    ("https://apply.workable.com/panorama-education/j/9200125A8B/", "workable"),
    ("https://rootstock-software.breezy.hr/p/fe71c039c890-agent-applied-ai-engineer", "breezy"),
    ("https://www.github.careers/careers-home/jobs/5537?lang=en-us", "github"),
    # iCIMS, the last host in a 1264-row inbox that nothing could read. Its human
    # page is a single-page app; the `?in_iframe=1` view is server-rendered.
    ("https://careers-githubinc.icims.com/jobs/5640/login", "icims"),
    # providers/smartrecruiters.mjs rewrites the API ref into THIS shape, and the old
    # ([\w-]+)/(\d+) pattern could not cross the slash before `postings`, so the pipeline's
    # own URLs answered "no API for this host" while the API answered 200 for them.
    ("https://jobs.smartrecruiters.com/Experian/postings/757675447924470", "smartrecruiters"),
    # The other public shape, {id}-{title-slug}, which the same widening has to keep.
    ("https://jobs.smartrecruiters.com/NBCUniversal3/794330812622252-senior-engineer",
     "smartrecruiters"),
    # Company-hosted Greenhouse whose board slug is nothing like its domain. Routing is
    # only half the story here; portal_boards() below is the half that was broken.
    ("https://www.sentinelone.com/jobs/?gh_jid=7260141299", "greenhouse"),
    # An Ashby org whose posting API is switched off. It must still route to ashby, since
    # the fallback that reads the board page lives inside that branch.
    ("https://jobs.ashbyhq.com/whatnot/e8760e88-1ecc-0bb9-564e-a726f5e7f568", "ashby"),
]

# A miniature Ashby detail page. The real one is 52KB; what matters is the shape:
# window.__appData carrying a `posting` object whose reachable location is in
# secondaryLocationNames, plus a brace inside a JSON string to keep the matcher honest.
_ASHBY_PAGE = """
<html><body><script>
  window.__appData = {"organization":{"name":"Whatnot {HQ}"},"posting":{
    "id":"e8760e88-1ecc-0bb9-564e-a726f5e7f568","title":"AI Tooling Engineer",
    "locationName":"San Francisco, CA","workplaceType":null,"isListed":true,
    "secondaryLocationNames":["New York, NY","Los Angeles, CA"],
    "descriptionHtml":"&lt;p&gt;Build agent &amp;amp; eval tooling.&lt;/p&gt;",
    "scrapeableCompensationSalarySummary":"$200K - $260K"}};
</script></body></html>
"""
# The same page after the posting closed. Ashby answers 200 and still ships __appData;
# the `posting` key is simply gone. Reading "200 plus appData" as live would report every
# dead link as a live req.
_ASHBY_GONE = """
<html><body><script>
  window.__appData = {"organization":{"name":"Whatnot"},"jobBoard":{"jobPostings":[]}};
</script></body></html>
"""


# A Greenhouse record whose reachable location is NOT in location.name. This is the
# Crexi shape: a real but commute-blind country string, the actual site in offices[],
# and remote eligibility in metadata. Reading location.name alone turns it into "United
# States", which eval-prep fails as outside the commute ceiling, discarding a role the candidate
# could take with no error and no row.
_GH_HIDDEN_LOC = json.dumps({
    "title": "Staff AI Engineer",
    "location": {"name": "United States"},
    "offices": [{"name": "Los Angeles, CA"}],
    "metadata": [{"name": "Careers page remote eligible", "value": "Yes"}],
    "content": "&lt;p&gt;Build agent tooling. $210,000 - $260,000&lt;/p&gt;"})


def _fake_gh(only_slug=None, page="<html>a careers page naming no ATS at all</html>",
             body=None):
    """A stand-in fetch(): one Greenhouse board exists, everything else 404s.

    The verdict bugs all live at a CALL SITE rather than in a parser, so testing the
    parsers alone is not enough: deleting the portals lookup from resolve() leaves every
    parser test green while the resolver goes back to closing live rows.
    """
    body = body or json.dumps({"title": "Senior AI Platform Engineer",
                               "location": {"name": "United States - Remote"},
                               "content": "&lt;p&gt;Remote, United States. "
                                          "$184,000 - $253,000&lt;/p&gt;"})

    def _f(url, *a, **k):
        if "boards-api.greenhouse.io" in url:
            if only_slug and f"/boards/{only_slug}/" in url:
                return 200, body
            return 404, ""
        return 200, page
    return _f


def _fake_gh_named(slug, backlink_host=None, njobs=3):
    """A board that EXISTS under the guessed slug. `backlink_host` decides whose it is.

    The shape behind the 2026-09-20 false closure. `_fake_gh` cannot express it: there,
    a board either serves the req or does not exist, so "the board exists but belongs to
    somebody else" had no fixture and the bug had nowhere to be caught. Here the board
    answers 200 for its listing and 404 for the id, which is what a Greenhouse board does
    for every id issued by a different ATS, and the listing is the only thing that says
    which company it is.
    """
    listing = json.dumps({"jobs": [
        {"absolute_url": (f"https://{backlink_host}/en/job/{i}" if backlink_host
                          else f"https://job-boards.greenhouse.io/{slug}/jobs/{i}")}
        for i in range(njobs)]})

    def _f(url, *a, **k):
        if "boards-api.greenhouse.io" in url:
            # Order matters: the job URL contains the listing URL as a prefix.
            if re.search(rf"/boards/{slug}/jobs/\d", url):
                return 404, ""
            if f"/boards/{slug}/jobs" in url:
                return 200, listing
            return 404, ""
        return 200, "<html>a client-rendered careers shell naming no ATS</html>"
    return _f


def _fake_gh_split(statuses, listing_ok=(), backlink_host=None):
    """Per-board control over the JOB answer and the LISTING answer, separately.

    `_fake_gh` answers for a whole board at once, so it cannot express the two shapes
    that produced false closures: a board that exists while the job is absent, and one
    candidate board answering the job while a different candidate answers the listing.
    """
    def _f(url, *a, **k):
        mb = re.search(r"/boards/([\w.-]+)/jobs(?:/(\d+))?", url)
        if mb:
            b = mb.group(1)
            if mb.group(2):
                return statuses.get(b, 404), ""
            if b in listing_ok:
                jobs = [{"absolute_url": (f"https://{backlink_host}/job/{i}" if backlink_host
                                          else f"https://job-boards.greenhouse.io/{b}/jobs/{i}")}
                        for i in range(3)]
                return 200, json.dumps({"jobs": jobs})
            return 404, ""
        return 200, "<html>a client-rendered careers shell naming no ATS</html>"
    return _f


def behaviour_cases():
    """The four verdict bugs, pinned offline. Returns (failures, total)."""
    import unittest.mock as mock
    bad, total = 0, 0

    def check(ok, msg):
        nonlocal bad, total
        total += 1
        if not ok:
            bad += 1
            print(f"FAIL  {msg}")

    def with_fetch(fake, url):
        with mock.patch.object(sys.modules[__name__], "fetch", fake):
            return resolve(url)


    # ── BUG 1: portals.yml is the arbiter, not the hostname ──────────────
    # sentinelone.com serves its board under the slug `sentinellabs`. Every hostname
    # guess 404s, and the 404 path then answered "company no longer uses Greenhouse;
    # inbox row is stale", which wrongly closed four live SentinelOne rows. The recorded
    # slug has to come FIRST, and it has to come from the file rather than a constant:
    # asserting against a hardcoded copy would pass with the lookup deleted.
    sl = portal_boards("https://www.sentinelone.com/jobs/?gh_jid=7260141299")
    check(sl[:1] == ["sentinellabs"],
          f"portals.yml must yield sentinellabs first for sentinelone.com, got {sl}")
    # An ATS host identifies the vendor, not the employer. Reading it as identity would
    # match every Greenhouse-hosted entry in the file and return someone else's slug.
    check(portal_boards("https://job-boards.greenhouse.io/cresta/jobs/5055750430") == [],
          "an ATS host must yield no portals identity")
    # A company that is not in the file must return nothing rather than a near match, so
    # the hostname guesses still run and the stale verdict stays reachable for a board
    # that genuinely retired (Unity's did, 2026-07-27, four slugs all 404).
    check(portal_boards("https://careers.no-such-company-exists-here.com/j/1") == [],
          "an unknown company must yield no slug")
    # Every entry in the file must reach the index. Counted from the file itself rather
    # than against a fixed floor, so the guard is exact for any fixture and a parse that
    # silently drops entries cannot pass by staying above an arbitrary number.
    _declared = len(re.findall(r"^  - name:", open(portals_path(), encoding="utf-8").read(),
                               re.M))
    check(_declared > 0 and len(portals_index()) == _declared,
          f"portals.yml parsed to {len(portals_index())} of {_declared} entries; "
          f"the parse is broken")
    # The call site, not just the lookup. Only `sentinellabs` exists in this fake world
    # and the posting page names no ATS, which is EXACTLY the shape that produced the
    # false stale verdict: without the portals lookup, resolve() reaches the same fake
    # and answers stale_ats instead of a live req.
    r = with_fetch(_fake_gh("sentinellabs"),
                   "https://www.sentinelone.com/jobs/?gh_jid=7260141299")
    check(r.get("live") is True and r.get("org") == "sentinellabs",
          f"the recorded slug must resolve the req: {r.get('live')} / {r.get('org')} / "
          f"{r.get('note')}")
    check(not r.get("stale_ats"), "a resolvable req must never be reported as a stale ATS")
    # The stale verdict is REAL and must survive: Unity's Greenhouse board retired
    # 2026-07-27 and four slugs all 404. Here no board exists, portals.yml knows nothing
    # about the company, and the page names no ATS. That row genuinely cannot resolve.
    #
    # The `?gh_jid=` in the URL is load-bearing now rather than incidental. "This company
    # no longer uses Greenhouse" is a PRUNING verdict, and the only thing that can carry
    # it is the company's own declaration that the id was a Greenhouse id to begin with.
    r = with_fetch(_fake_gh(None),
                   "https://careers.no-such-company-exists-here.com/jobs/?gh_jid=1194374")
    check(r.get("stale_ats") is True and r.get("live") is None,
          f"a company that truly left Greenhouse must still be called stale: {r.get('note')}")
    # The other half of that rule, in the same dead world with the same page: an id we
    # merely INFERRED from a path. Nothing here ever said Greenhouse, so there is no
    # basis for a verdict about Greenhouse, least of all the one that prunes the row.
    # This is the SentinelOne shape with portals.yml unable to help: a real board under
    # a slug no hostname guess reaches looks identical to no board at all.
    r = with_fetch(_fake_gh(None),
                   "https://careers.no-such-company-exists-here.com/job/1194374/x")
    check(not r.get("stale_ats") and r.get("live") is None,
          f"an inferred id must never support the stale-ATS pruning verdict: "
          f"stale={r.get('stale_ats')} live={r.get('live')} note={r.get('note')}")
    # A board that exists under the guessed slug but belongs to SOMEBODY ELSE. Measured
    # on 2026-09-20: a live Disney posting answering HTTP 200 was resolved CLOSED,
    # because the Greenhouse board "disney" exists, every Radancy id 404s inside it, and
    # "the board exists" was accepted as proof the 404 meant the job had gone.
    r = with_fetch(_fake_gh_named("disney"),
                   "https://www.disneycareers.com/en/job/burbank/tech-artist/391/90414256275")
    check(r.get("live") is not False,
          f"a board that never links back to the host must not close a row: "
          f"live={r.get('live')} ats={r.get('ats')} note={r.get('note')}")
    # ...and the same shape must still CLOSE when the board really is the company's, or
    # the fix would have bought safety by making the resolver useless. This is the Riot
    # shape, and Airbnb, Coinbase and Samsara are identical: 100% of their postings link
    # back to the host, while the disney board links back to none.
    r = with_fetch(_fake_gh_named("riotgames", backlink_host="www.riotgames.com"),
                   "https://www.riotgames.com/en/work-with-us/job/8372403/principal-swe")
    check(r.get("live") is False and r.get("ats") == "greenhouse",
          f"a board that links back to the host must still close: live={r.get('live')} "
          f"ats={r.get('ats')} note={r.get('note')}")
    # The predicate on its own, including the case host_keys() has to get right: a board
    # whose postings live on the ATS host carries no employer identity to match.
    check(board_owns_host(json.dumps({"jobs": [{"absolute_url": "https://careers.airbnb.com/x"}]}),
                          "https://careers.airbnb.com/positions/6631030/"),
          "a backlink to the same company must be recognised across host noise")
    check(not board_owns_host(
        json.dumps({"jobs": [{"absolute_url": "https://job-boards.greenhouse.io/disney/jobs/1"}]}),
        "https://www.disneycareers.com/en/job/x/391/90414256275"),
        "an ATS-hosted backlink names the vendor, not the employer, and must not count")
    for junk in ("", "not json", "[]", json.dumps({"jobs": "nope"}), None):
        check(board_owns_host(junk, "https://careers.airbnb.com/positions/1/") is False,
              f"an unreadable listing must be False, not an exception: {junk!r}")
    # 410 as well as 404. The ambiguity is a property of the evidence, not of the status,
    # so the stronger "permanently gone" code must clear the same bar.
    r = with_fetch(_fake_gh_split({"disney": 410}, listing_ok=("disney",)),
                   "https://www.disneycareers.com/en/job/burbank/tech-artist/391/90414256275")
    check(r.get("live") is not False,
          f"410 must clear the same ownership bar as 404: live={r.get('live')} "
          f"note={r.get('note')}")
    # The status and the board-exists proof came from DIFFERENT boards. The correct
    # candidate times out, a wrong candidate 404s, and the correct candidate's listing
    # answers 200: three unrelated requests used to assemble into one confident closure.
    # The id is declared here, so this is not caught by the ownership rule above.
    r = with_fetch(_fake_gh_split({"acme-corp": 503, "acmecorp": 404},
                                  listing_ok=("acme-corp",),
                                  backlink_host="careers.acme-corp.com"),
                   "https://careers.acme-corp.com/jobs/?gh_jid=1194374")
    check(r.get("live") is None,
          f"a 404 from one candidate and a 200 listing from another must not combine into "
          f"a closure: live={r.get('live')} note={r.get('note')}")
    # A greenhouse.io address riding inside a query parameter is not a Greenhouse host.
    # Unanchored, this matched the direct-URL pattern and inherited the one confidence
    # level in the function that closes a row on a 404 with no further questions.
    r = with_fetch(_fake_gh_split({}),
                   "https://careers.example-co.com/apply"
                   "?next=https://boards.greenhouse.io/acme/jobs/1194374")
    check(r.get("live") is not False,
          f"a greenhouse.io link inside a parameter must not be read as the host: "
          f"live={r.get('live')} ats={r.get('ats')} note={r.get('note')}")
    # A LABEL boundary, not a suffix. `notgreenhouse.io` ends with "greenhouse.io" and
    # would otherwise reach the branch that closes a row on a 404 without asking anything
    # further. Anchoring to the host was the earlier fix; this is the same rule finer.
    r = with_fetch(_fake_gh_split({"acme": 404}, listing_ok=("acme",)),
                   "https://notgreenhouse.io/acme/jobs/1194374")
    check(r.get("live") is not False,
          f"a host merely ENDING in greenhouse.io is not Greenhouse: live={r.get('live')} "
          f"ats={r.get('ats')} note={r.get('note')}")
    # ...and a real subdomain still is.
    r = with_fetch(_fake_gh_split({"acme": 404}, listing_ok=("acme",)),
                   "https://boards.greenhouse.io/acme/jobs/1194374")
    check(r.get("ats") == "greenhouse" and r.get("live") is False,
          f"a real greenhouse.io subdomain must still close on a 404: {r.get('ats')} "
          f"{r.get('live')}")
    # Finding a job is not finding THIS job. When the slug and the id were both inferred,
    # a 200 whose record names a different employer is a collision, not a match.
    other = json.dumps({"title": "Somebody Else's Job", "location": {"name": "Remote"},
                        "content": "", "absolute_url": "https://jobs.other-co.com/job/1194374"})
    r = with_fetch(_fake_gh("acme", body=other), "https://careers.acme.com/job/1194374/x")
    check(r.get("live") is not True,
          f"a record naming another employer must not resolve this URL: live={r.get('live')} "
          f"title={r.get('title')}")
    mine = json.dumps({"title": "The Right Job", "location": {"name": "Remote"},
                       "content": "", "absolute_url": "https://careers.acme.com/job/1194374/x"})
    r = with_fetch(_fake_gh("acme", body=mine), "https://careers.acme.com/job/1194374/x")
    check(r.get("live") is True and r.get("title") == "The Right Job",
          f"a record that names this employer must still resolve: live={r.get('live')} "
          f"title={r.get('title')}")

    # ── Eightfold: provenance decides closure authority, same rule as a job id ──
    # The tenant `domain` is not derivable from the hostname. Netflix is its own proof
    # (netflix.NET serves netflix.COM) and anywhere.eightfold.ai publishes
    # volkscience.com. A generic adapter that kept the old unresolved(st) would turn a
    # wrong-tenant 404 into CLOSED, which is the defect this file spent the day removing.
    def _gone(*a, **k):
        return 404, ""

    r = with_fetch(_gone, "https://jobs.some-new-tenant.com/careers/job/100112222")
    check(r.get("live") is None and r.get("ats") == "eightfold",
          f"a DERIVED Eightfold domain must never close a row: live={r.get('live')} "
          f"ats={r.get('ats')} note={r.get('note')}")
    r = with_fetch(_gone, "https://jobs.nvidia.com/careers/job/824350365339")
    check(r.get("live") is False,
          f"a RECORDED Eightfold tenant keeps its closure authority: live={r.get('live')}")
    r = with_fetch(_gone,
                   "https://jobs.some-new-tenant.com/careers/job/100112222?domain=acme.io")
    check(r.get("live") is False,
          f"a domain the link itself declares is evidence too: live={r.get('live')}")
    # WHICH url was requested, asserted. Every fake above answers whatever it is asked,
    # so a wrong host or a wrong domain parameter is invisible to all of them: the
    # derivation could be broken in either direction and the cases above stay green.
    seen = []

    def _record(url, *a, **k):
        seen.append(url)
        return 404, ""

    with_fetch(_record, "https://jobs.nvidia.com/careers/job/824350365339-senior-swe")
    check(seen[:1] == ["https://jobs.nvidia.com/api/apply/v2/jobs/824350365339"
                       "?domain=nvidia.com"],
          f"the apply endpoint must be built from the host and the RECORDED domain, "
          f"not guessed: {seen[:1]}")
    # A page that DOES name greenhouse.io in a shape this parser cannot read is not a
    # departure from the ATS, and inferring one from "the slug match failed" retires a row
    # that may still be live. Both pages below name greenhouse.io and yield NO slug, which
    # is the difference the check has to be able to see.
    for page in ('<script src="https://boards.greenhouse.io/embed/job_board/js"></script>',
                 '<a href="https://www.greenhouse.io/privacy-policy">Powered by</a>'):
        r = with_fetch(_fake_gh(None, page=page),
                       "https://careers.no-such-company-exists-here.com/job/1194374/x")
        check(discover_board(page) is None and not r.get("stale_ats"),
              f"a page naming greenhouse.io with no readable slug is not a stale ATS: "
              f"{r.get('note')}")

    # ── BUG 4: the standard embed snippet ────────────────────────────────
    # This is the snippet Greenhouse itself documents. The old pattern knew only
    # `embed/job_board?for=`, so against `/js?for=` its optional group failed and
    # ([\w-]+) captured the word "embed" instead of the slug.
    check(discover_board(
        '<script src="https://boards.greenhouse.io/embed/job_board/js?for=sentinellabs">'
        '</script>') == "sentinellabs", "the /js?for= embed snippet must yield its slug")
    check(discover_board(
        '<script src="https://boards.greenhouse.io/embed/job_board?for=acmeco"></script>'
        ) == "acmeco", "the legacy embed?for= snippet must still yield its slug")
    check(discover_board('<a href="https://job-boards.greenhouse.io/acmeco/jobs/12">x</a>'
                         ) == "acmeco", "a plain board link must yield its slug")
    # A greenhouse.io URL with no slug in it at all must return None rather than a path
    # word: probing a board named "embed" wastes a request AND reads as a discovery.
    check(discover_board('<script src="https://boards.greenhouse.io/embed/job_board/js">'
                         '</script>') is None, "a slugless embed URL must yield nothing")
    check(discover_board("<html>no ats here</html>") is None,
          "a page with no Greenhouse must yield nothing")
    # The call site. Every guessed slug 404s and the page carries the standard snippet,
    # so discovery is the only route to the req. Reading "embed" as the slug here is what
    # turned a live posting into "no valid board".
    r = with_fetch(_fake_gh("acmeco", page='<script src="https://boards.greenhouse.io'
                                           '/embed/job_board/js?for=acmeco"></script>'),
                   "https://careers.no-such-company-exists-here.com/job/1194374/x")
    check(r.get("live") is True and r.get("discovered_board") == "acmeco",
          f"the embedded board must be discovered and used: {r.get('note')}")

    # ── BUG 7: the discovered-board path dropped offices[] and the remote metadata ──
    # The direct Greenhouse branch folds both in; this one built its own result out of
    # location.name and nothing else. A req reading "United States" with offices[]
    # naming Los Angeles and remote metadata "Yes" came back non-remote and outside the
    # commute ceiling, and the gate failing in the TOO STRICT direction discards a
    # reachable role with no error, no warning and no row.
    GH_EMBED_PAGE = ('<script src="https://boards.greenhouse.io'
                     '/embed/job_board/js?for=acmeco"></script>')
    r = with_fetch(_fake_gh("acmeco", page=GH_EMBED_PAGE, body=_GH_HIDDEN_LOC),
                   "https://careers.no-such-company-exists-here.com/job/1194374/x")
    check(r.get("discovered_board") == "acmeco",
          f"the hidden-location case must still reach the discovered board: {r.get('note')}")
    check("Los Angeles, CA" in (r.get("location") or ""),
          f"discovered board dropped offices[]: {r.get('location')!r}")
    check("Remote" in (r.get("location") or ""),
          f"discovered board dropped the remote metadata: {r.get('location')!r}")
    check(r.get("remote_eligible") == "Yes" and r.get("remote_txt") is True,
          f"discovered board dropped remote eligibility: {r.get('remote_eligible')!r} / "
          f"{r.get('remote_txt')!r}")
    check(r.get("offices") == ["Los Angeles, CA"],
          f"discovered board returned no offices[]: {r.get('offices')!r}")
    # The property worth keeping rather than the symptom: ONE record builder, so the two
    # paths cannot answer differently about the same posting again. Compared field by
    # field with the discovery-only keys removed.
    direct = with_fetch(_fake_gh("acmeco", body=_GH_HIDDEN_LOC),
                        "https://job-boards.greenhouse.io/acmeco/jobs/1194374")
    disc_only = {k: v for k, v in r.items() if k != "discovered_board"}
    check(direct.get("live") is True and disc_only == direct,
          f"the direct and discovered paths disagree about one posting:\n"
          f"      direct    {direct}\n      discovered {disc_only}")

    # ── BUG 3: the SmartRecruiters /postings/ form ───────────────────────
    check(smartrecruiters_ref(
        "https://jobs.smartrecruiters.com/Experian/postings/757675447924470")
        == ("Experian", ["757675447924470"]), "the /postings/ form must parse")
    # Not numeric, on purpose: nothing in the resolver may assume the id is digits.
    check(smartrecruiters_ref(
        "https://jobs.smartrecruiters.com/Acme/postings/AB12CD34")
        == ("Acme", ["AB12CD34"]), "a non-numeric id must parse")
    # {id}-{title-slug}: the whole token first, the pre-dash part as the fallback.
    check(smartrecruiters_ref(
        "https://jobs.smartrecruiters.com/NBCUniversal3/794330812622252-sr-engineer")
        == ("NBCUniversal3", ["794330812622252-sr-engineer", "794330812622252"]),
        "the {id}-{slug} form must try both readings")
    check(smartrecruiters_ref("https://jobs.lever.co/magnopus/abc") is None,
          "a non-SmartRecruiters host must not parse as one")

    # ── BUG 2: the Ashby board-page fallback ─────────────────────────────
    # The posting API is opt-in; whatnot answers 404 while its board serves 132 postings.
    # Reading the page is the only way to tell that apart from a dead org.
    got = ashby_from_page(_ASHBY_PAGE, "whatnot",
                          "e8760e88-1ecc-0bb9-564e-a726f5e7f568")
    check(bool(got) and got.get("live") is True, "the detail page must resolve as live")
    check(bool(got) and got.get("title") == "AI Tooling Engineer",
          f"title from the page: {(got or {}).get('title')!r}")
    # The reachable location is the SECONDARY one here, which is the failure every
    # adapter in this file has had at least once: primary reads Bay Area and auto-skips.
    check(bool(got) and "Los Angeles, CA" in (got.get("location") or ""),
          f"secondary locations dropped: {(got or {}).get('location')!r}")
    check(bool(got) and "eval tooling" in (got.get("jd") or ""),
          f"jd not unescaped: {((got or {}).get('jd') or '')[:60]!r}")
    check(bool(got) and got.get("comp_summary") == "$200K - $260K",
          "the K-formatted band must survive verbatim; PAY does not match it")
    # ...and must ALSO reach `pay`, which is the field eval-prep judges comp on. Left in
    # K-notation it reads downstream as "no band posted" for a posting that states one.
    check(bool(got) and got.get("pay") == ["$200,000 - $260,000"],
          f"K-notation band did not reach pay: {(got or {}).get('pay')}")
    check(k_band("$200K \u2013 $260K \u2022 Offers Equity")
          == "$200,000 \u2013 $260,000 \u2022 Offers Equity",
          "the en-dash summary form must expand too")
    # Anything that is not the K shape is left exactly as it is. Guessing at a band is
    # the one error this cannot afford: comp is scored against a hard floor.
    check(k_band("$132,000 - $182,000") == "$132,000 - $182,000",
          "a full-dollar band must pass through untouched")
    check(k_band("$39.54 - $73.16 an hour") == "$39.54 - $73.16 an hour",
          "an hourly rate must pass through untouched")
    # A closed posting: 200, still has __appData, no `posting` key.
    check(ashby_from_page(_ASHBY_GONE, "whatnot", "e8760e88") is None,
          "a page with no posting object must yield nothing")
    # Wrong id on the page means the org redirected somewhere; not this req.
    check(ashby_from_page(_ASHBY_PAGE, "whatnot", "deadbeef-0000") is None,
          "a mismatched id must yield nothing")

    # The call site. A 404 from the opt-in API used to dead-end at "board not
    # retrievable", which blocks eval-prep from ever building a packet for the org.
    AID = "e8760e88-1ecc-0bb9-564e-a726f5e7f568"

    def _ashby_fetch(detail, board):
        def _f(url, *a, **k):
            if "api.ashbyhq.com" in url:
                return 404, ""                       # opt-in posting API, switched off
            return (200, board) if url.endswith("/whatnot") else (200, detail)
        return _f

    r = with_fetch(_ashby_fetch(_ASHBY_PAGE, ""), f"https://jobs.ashbyhq.com/whatnot/{AID}")
    check(r.get("live") is True and "Los Angeles, CA" in (r.get("location") or ""),
          f"the detail page must rescue a 404 from the opt-in API: {r.get('note')}")
    check(len(r.get("jd") or "") > 0, "the fallback must carry the JD, not just a title")
    # Absent from a board that DID parse is the same evidence the API path calls closed.
    other = ('<script>window.__appData = {"jobBoard":{"jobPostings":'
             '[{"id":"someone-else","title":"Other role","locationName":"Berlin"}]}};'
             '</script>')
    r = with_fetch(_ashby_fetch(_ASHBY_GONE, other), f"https://jobs.ashbyhq.com/whatnot/{AID}")
    check(r.get("live") is False, f"absent from a parsed board is closed: {r.get('note')}")
    # Neither page readable is "not checked". An unreadable board must never be reported
    # as an empty one: that is the confident negative this whole toolchain designs against.
    r = with_fetch(_ashby_fetch("", ""), f"https://jobs.ashbyhq.com/whatnot/{AID}")
    check(r.get("live") is None, f"two unreadable pages must stay unknown: {r.get('note')}")

    # ── BUG 5: a failure to READ is not a closure, and is not liveness either ──
    # Six branches ended `live=(st != 404)`, so a timeout (0), a 429, a 500 or a WAF 403
    # all came back live=True. A req certified live on a request that never completed is
    # then treated downstream as though a human had looked at it.
    check(unresolved(404) is False, "a 404 from an endpoint that answered is a closure")
    for st in (0, 401, 403, 429, 500, 503):
        check(unresolved(st) is None,
              f"HTTP {st} is a failed READ and must be unknown, not a liveness verdict")

    # The call sites, because the bug lived at the call site rather than in a parser.
    # One per transport shape: Lever (GET), Workable (GET), Netflix, SmartRecruiters and
    # SuccessFactors all shared the identical expression.
    for url, ats in (("https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472",
                      "lever"),
                     ("https://apply.workable.com/panorama-education/j/9200125A8B/",
                      "workable"),
                     ("https://explore.jobs.netflix.net/careers/job/712200781859-x",
                      "netflix"),
                     ("https://jobs.smartrecruiters.com/Experian/postings/757675447924470",
                      "smartrecruiters")):
        for st in (0, 429, 500):
            r = with_fetch(lambda *a, _s=st, **k: (_s, ""), url)
            check(r.get("ats") == ats and r.get("live") is None,
                  f"{ats}: HTTP {st} must be unknown, got live={r.get('live')}")
        r = with_fetch(lambda *a, **k: (404, ""), url)
        check(r.get("ats") == ats and r.get("live") is False,
              f"{ats}: a real 404 must still be a closure, got live={r.get('live')}")

    # ── BUG 7: a malformed HTTP 200 raised and took the whole batch with it ──────
    # Every direct adapter called json.loads on the response body unguarded, and the
    # main loop has no per-item handler, so one ATS or WAF answering 200 with HTML,
    # truncated JSON or an unexpected shape aborted the entire run before a single
    # result printed. Two properties are asserted per adapter, and the first matters
    # more than the second: resolve() must RETURN, and what it returns must be
    # live=None. A 200 that cannot be parsed is an unreadable response, not a live
    # posting. The malformed-200 case added last round covered workday_reslug() only,
    # which is the one path that already had a try/except.
    JUNK = [
        ("an HTML interstitial", "<html><body>Attention Required | Cloudflare</body></html>"),
        ("truncated JSON", '{"title": "Senior Engineer", "loca'),
        # Valid JSON, wrong shape. This one passes a bare try/except and then raises
        # AttributeError on the .get() a line later, so a guard that only catches the
        # parse still takes the run down.
        ("a bare null", "null"),
        ("a bare string", '"rate limited"'),
        ("an array where an object belongs", "[]"),
    ]
    for url, ats in (
        ("https://job-boards.greenhouse.io/cresta/jobs/5055750430", "greenhouse"),
        ("https://jobs.ashbyhq.com/deepgram/0f1db59b-b272-644c-af35-f84c91963e3b", "ashby"),
        ("https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472", "lever"),
        ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Remote/"
         "X_JR2391853", "workday"),
        ("https://explore.jobs.netflix.net/careers/job/712200781859-sr-ta", "netflix"),
        ("https://jobs.smartrecruiters.com/NBCUniversal3/794330812622252", "smartrecruiters"),
        ("https://apply.workable.com/panorama-education/j/9200125A8B/", "workable"),
        ("https://www.github.careers/careers-home/jobs/5537?lang=en-us", "github"),
    ):
        for label, junk in JUNK:
            try:
                r = with_fetch(lambda *a, _b=junk, **k: (200, _b), url)
            except Exception as e:
                check(False, f"{ats}: {label} at HTTP 200 RAISED {type(e).__name__}: {e}")
                continue
            check(r.get("live") is None,
                  f"{ats}: {label} at HTTP 200 must be unknown, got "
                  f"live={r.get('live')} / {str(r.get('note'))[:70]}")

    # Breezy's board is a bare ARRAY, so its shapes are the mirror image: an object is
    # the wrong shape there, and an array of non-objects crashes on the .get() inside
    # the match loop rather than on the parse.
    BREEZY = "https://rootstock-software.breezy.hr/p/fe71c039c890-agent-applied-ai-engineer"
    for label, junk in [("an HTML interstitial", "<html>WAF</html>"),
                        ("truncated JSON", '[{"id": "fe71c039c890", "name": "Eng'),
                        ("an object where an array belongs", '{"jobs": []}'),
                        ("an array of scalars", '["fe71c039c890", null, 3]')]:
        try:
            r = with_fetch(lambda *a, _b=junk, **k: (200, _b), BREEZY)
        except Exception as e:
            check(False, f"breezy: {label} at HTTP 200 RAISED {type(e).__name__}: {e}")
            continue
        check(r.get("live") is None,
              f"breezy: {label} at HTTP 200 must be unknown, got live={r.get('live')}")

    # ...and a well-formed 200 must still resolve, or the guard above has simply
    # broken every adapter into permanent silence, which no "unknown" verdict shows.
    GOOD_LEVER = json.dumps({"text": "Staff Agent Engineer",
                             "descriptionPlain": "Remote US. $220,000 - $260,000.",
                             "categories": {"location": "Remote - US",
                                            "allLocations": ["Remote - US"]}})
    r = with_fetch(lambda *a, **k: (200, GOOD_LEVER),
                   "https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472")
    check(r.get("live") is True and r.get("title") == "Staff Agent Engineer",
          f"a well-formed Lever 200 must still resolve: {r.get('live')} / {r.get('title')}")

    # The shared helper itself, not only what the callers do with it.
    check(jload('{"a": 1}') == {"a": 1}, "jload must return a parsed object unchanged")
    check(jload("[1, 2]", want=list) == [1, 2], "jload must return a parsed array when asked")
    check(jload("[1, 2]") is UNREADABLE, "an array is not the object the caller wanted")
    check(jload("<html>") is UNREADABLE, "HTML is not JSON")
    check(jload("null") is UNREADABLE, "a bare null is not a posting record")
    check(jload("") is UNREADABLE, "an empty body is not a posting record")

    # ── BUG 8: a dict is not a POSTING, and {} both certified and closed reqs ──────
    # jload checked only the top-level type, so `{}` or {"error": "rate limited"} at
    # HTTP 200 reached every adapter. Lever/Greenhouse/Netflix/SmartRecruiters read that
    # as live=True; Workday (no canApply) and Workable (no state) read the SAME body as
    # live=False. One unread response, two opposite verdicts, neither of which had read
    # a posting.
    check(jload("{}", need=("title",)) is UNREADABLE,
          "an empty object is not a posting, whatever its type says")
    check(jload('{"error": "rate limited"}', need=("jobPostingInfo",)) is UNREADABLE,
          "a WAF error object is not a posting record")
    check(jload('{"jobPostingInfo": null}', need=("jobPostingInfo",)) is UNREADABLE,
          "a required field present as null is still absent")
    check(jload('{"title": "X", "state": "published"}', need=("title", "state"))
          == {"title": "X", "state": "published"},
          "a response carrying every required field must still be returned")
    # An empty search RAN. Requiring truthiness rather than presence would turn a clean
    # "found nothing" into "not checked" and stall workday_reslug for ever.
    check(jload('{"jobPostings": []}', need=("jobPostings",)) == {"jobPostings": []},
          "an empty list in a required field is a clean answer, not an unreadable one")
    # Netflix answers under `job`, under `data`, or at the top level: at least one of.
    check(jload('{"data": {"name": "X"}}', need=(("job", "data", "name"),))
          == {"data": {"name": "X"}}, "an alternatives tuple passes on any one member")
    check(jload('{"unrelated": 1}', need=(("job", "data", "name"),)) is UNREADABLE,
          "an alternatives tuple fails when none of its members is present")

    # ── BUG 8: a top-level name is not deep enough for a NESTED posting record ──
    # `{"jobPostingInfo": {}}` passed the top-level check and Workday then read
    # bool(canApply) off an empty object and reported the unread response as CLOSED.
    # A dotted path is the declaration, walked by _present(), rather than an
    # eleventh hand-written second look.
    check(jload('{"jobPostingInfo": {}}', need=("jobPostingInfo.canApply",)) is UNREADABLE,
          "an empty nested record must not satisfy a nested declaration")
    check(jload('{"jobPostingInfo": {"canApply": true}}',
                need=("jobPostingInfo.canApply",)) == {"jobPostingInfo": {"canApply": True}},
          "a nested field that is present must pass")
    # canApply FALSE is a posting that was read and cannot be applied to. Requiring
    # truthiness here would turn every genuinely closed req into "not checked" and
    # the pipeline would never retire one.
    check(jload('{"jobPostingInfo": {"canApply": false}}',
                need=("jobPostingInfo.canApply",)) is not UNREADABLE,
          "a nested false is a read answer, not an unreadable one")
    check(jload('{"jobPostingInfo": {"canApply": null}}',
                need=("jobPostingInfo.canApply",)) is UNREADABLE,
          "a nested null is still absent")
    check(jload('{"jobPostingInfo": "closed"}', need=("jobPostingInfo.canApply",))
          is UNREADABLE,
          "a scalar in the middle of a path cannot carry the field below it")
    check(jload('{"job": {"name": "X"}}', need=(("job.name", "data.name", "name"),))
          == {"job": {"name": "X"}},
          "an alternatives tuple of dotted paths passes on any one member")
    check(jload('{"job": {}}', need=(("job.name", "data.name", "name"),)) is UNREADABLE,
          "an alternatives tuple of dotted paths fails on an empty nested record")

    # Every adapter's own 200-with-{} verdict, because the loader being right is not the
    # same as the eleven call sites asking it the right question.
    EMPTY_200 = ("{}", 200)
    for label, url in [
        ("workday", "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
                    "/job/US-CA-Remote/X_JR2391853"),
        ("workable", "https://apply.workable.com/fixtureco/j/CD4903E67B"),
        ("lever", "https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472"),
        ("netflix", "https://explore.jobs.netflix.net/careers/job/712200781859-x"),
        ("smartrecruiters", "https://jobs.smartrecruiters.com/NBCUniversal3/794330812622252"),
        ("ashby", "https://jobs.ashbyhq.com/deepgram/0f1db59b-b272-644c-af35-f84c91963e3b"),
    ]:
        r = with_fetch(lambda *a, **k: (EMPTY_200[1], EMPTY_200[0]), url)
        check(r.get("live") is None,
              f"{label}: an empty object at HTTP 200 must be unknown, "
              f"got live={r.get('live')} ({r.get('note')})")

    # Netflix is the one adapter whose posting is NESTED, so its response can satisfy
    # `need` while the record inside it is empty. {"job": {}} passed the loader and
    # then returned live=True with a null title, which is the same unread-as-verdict
    # failure one level down.
    r = with_fetch(lambda *a, **k: (200, '{"job": {}}'),
                   "https://explore.jobs.netflix.net/careers/job/712200781859-x")
    check(r.get("live") is None,
          f"netflix: an empty posting record must be unknown, got live={r.get('live')}")
    # Workday's record is nested the same way, and this is the body that slipped past
    # the top-level check: not live, not closed, and it used to answer CLOSED.
    r = with_fetch(lambda *a, **k: (200, '{"jobPostingInfo": {}}'),
                   "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
                   "/job/US-CA-Remote/X_JR2391853")
    check(r.get("live") is None,
          f"workday: an empty nested posting record must be unknown, "
          f"got live={r.get('live')} ({r.get('note')})")
    # ...and the read answers still come through, so the nested declaration did not
    # turn every real closure into an unknown.
    for label, canapply, want in (("open", "true", True), ("closed", "false", False)):
        r = with_fetch(
            lambda *a, **k: (200, '{"jobPostingInfo": {"canApply": ' + canapply +
                             ', "title": "X", "location": "US, CA, Remote"}}'),
            "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
            "/job/US-CA-Remote/X_JR2391853")
        check(r.get("live") is want,
              f"workday: a read {label} posting must stay live={want}, "
              f"got {r.get('live')} ({r.get('note')})")
    # ── iCIMS, and the schema.org fallback behind it ─────────────────────────────
    # The last two rows in a 1264-row inbox that nothing could settle, 2026-09-21.
    IC = "https://careers-githubinc.icims.com/jobs/5640/login"
    # The line break after the location is deliberate: clean() renders it as a literal
    # backslash-n and the first version of the extractor swallowed the next heading whole,
    # returning "Remote, United States\\n Overview \\n GitHub is se".
    ICPAGE = ("<html><head><title>Staff Developer Advocate, GitHub Security Lab in Remote "
              "| Careers at US Remote</title></head><body>In this role you can work from "
              "Remote, United States\\nOverview\\nUSD $121,800.00 - USD $323,200.00"
              "</body></html>")
    seen = []

    def _icims(url, *a, **k):
        seen.append(url)
        return 200, ICPAGE

    r = with_fetch(_icims, IC)
    check(r.get("ats") == "icims" and r.get("live") is True
          and r.get("title") == "Staff Developer Advocate, GitHub Security Lab",
          f"icims must read the iframe view: {r.get('ats')} {r.get('live')} {r.get('title')}")
    # The iframe view is the whole trick: the human page is a single-page app that carries
    # no title at all, so the URL asked for has to be the `?in_iframe=1` one.
    check(seen and seen[0].endswith("/jobs/5640/job?in_iframe=1"),
          f"icims must request the server-rendered iframe view, asked for {seen[:1]}")
    check(r.get("location") == "Remote, United States",
          f"icims location must stop at the line break: {r.get('location')!r}")
    # A requisition that does not exist answers 410 there, which is the strongest closure
    # signal this file recognises.
    r = with_fetch(lambda *a, **k: (410, ""), IC)
    check(r.get("ats") == "icims" and r.get("live") is False,
          f"an icims 410 must close the row: {r.get('ats')} {r.get('live')}")
    # A tenant that serves its own not-found page with a 200 must not read as live.
    r = with_fetch(lambda *a, **k: (200, "<title>this job may be no longer available"
                                         "</title>"), IC)
    check(r.get("live") is not True,
          f"an icims not-found page at HTTP 200 must not be live: {r.get('live')}")

    # schema.org JobPosting. `validThrough` in the past is the employer's own statement,
    # which is real evidence where a 200 from a client-rendered shell is not.
    LD = ('<script type="application/ld&#x2B;json">{"@graph":[{"@type":"JobPosting",'
          '"title":"Applied Research Scientist","validThrough":"2026-06-29T20:08:18+00:00"}]}'
          '</script>')
    BI_URL = "https://builtin.com/job/applied-research-scientist-engineer/8534252"
    r = jsonld_expired(LD, BI_URL, today="2026-09-21")
    check(r and r.get("live") is False and r.get("title") == "Applied Research Scientist",
          f"an expired JobPosting must close the row: {r}")
    # The `+` in the MIME type is HTML-ESCAPED on the page that prompted this, so matching
    # the raw attribute finds nothing. That escape is the reason the first version missed it.
    check("ld&#x2B;json" in LD, "the fixture must keep the escaped MIME type")
    # Closing direction only. A future date, a missing one and an unparseable one all
    # decline, because a stale JobPosting left on a page is exactly the failure this file
    # keeps designing against and a generic page is the weakest place to take that risk.
    for body, why in ((LD.replace("2026-06-29", "2099-01-01"), "a future validThrough"),
                      ('<script type="application/ld+json">{"@type":"JobPosting",'
                       '"title":"x"}</script>', "no validThrough at all"),
                      ('<script type="application/ld+json">not json</script>',
                       "an unparseable block")):
        r = jsonld_expired(body, BI_URL, today="2026-09-21")
        check(r is None, f"{why} must settle nothing, got {r}")

    # ── The expired record has to BE the requested posting ──
    # A page embeds the job being viewed plus a "related roles" rail, each with its own
    # JobPosting. Closing on whichever expired one is found first retires a live row on a
    # stale neighbour, and inbox-liveness --mark consumes that verdict.
    def ld(*objs):
        return ('<script type="application/ld+json">'
                + json.dumps({"@graph": list(objs)}) + "</script>")

    REQUESTED = {"@type": "JobPosting", "title": "The Requested One",
                 "identifier": {"@type": "PropertyValue", "value": "8534252"},
                 "validThrough": "2099-01-01T00:00:00+00:00"}
    NEIGHBOUR = {"@type": "JobPosting", "title": "Somebody Else's Expired Job",
                 "identifier": {"@type": "PropertyValue", "value": "1111111"},
                 "validThrough": "2026-06-29T20:08:18+00:00"}
    r = jsonld_expired(ld(NEIGHBOUR, REQUESTED), BI_URL, today="2026-09-21")
    check(r is None,
          f"an expired NEIGHBOUR must not close the requested posting: {r}")
    # ...and the same page must still close when it is the requested record that expired.
    r = jsonld_expired(ld(dict(NEIGHBOUR, validThrough="2099-01-01T00:00:00+00:00"),
                          dict(REQUESTED, validThrough="2026-06-29T20:08:18+00:00")),
                       BI_URL, today="2026-09-21")
    check(r and r.get("title") == "The Requested One",
          f"the requested record expiring must still close: {r}")
    # A record naming a DIFFERENT url is excluded outright, even alone on the page.
    r = jsonld_expired(ld({"@type": "JobPosting", "title": "Elsewhere",
                           "url": "https://builtin.com/job/other-role/9253856",
                           "validThrough": "2026-06-29"}), BI_URL, today="2026-09-21")
    check(r is None, f"a record naming another url must not close this one: {r}")
    # ...while its own url, spelled with http and a trailing slash, still matches.
    r = jsonld_expired(ld({"@type": "JobPosting", "title": "Same Posting",
                           "url": "http://www.builtin.com/job/"
                                  "applied-research-scientist-engineer/8534252/",
                           "validThrough": "2026-06-29"}), BI_URL, today="2026-09-21")
    check(r and r.get("title") == "Same Posting",
          f"scheme, www and a trailing slash must not defeat the match: {r}")
    # Two anonymous records cannot be told apart, so the page settles nothing.
    ANON = {"@type": "JobPosting", "title": "Anonymous", "validThrough": "2026-06-29"}
    check(jsonld_expired(ld(ANON, dict(ANON, title="Another")), BI_URL,
                         today="2026-09-21") is None,
          "two records with no identity must be treated as ambiguous")
    # The bounded identifier match: 8534252 must not match inside 19083663.
    check(ld_identity({"identifier": {"value": "8534252"}},
                      "https://builtin.com/job/x/19083663") is not True,
          "an identifier must not match inside a longer number")
    # A non-empty identifier that does NOT appear is a different posting, not an unknown
    # one. Returning None let the single-posting rule treat the record as anonymous and
    # trust its expired date, so a page keeping one stale record for another job could
    # close this row on it.
    check(ld_identity({"identifier": {"value": "9253856"}}, BI_URL) is False,
          "a mismatched identifier must read as a DIFFERENT posting, not as unknown")
    check(ld_identity({"identifier": {"value": ""}}, BI_URL) is None,
          "an empty identifier carries nothing either way")
    r = jsonld_expired(ld({"@type": "JobPosting", "title": "Somebody Else",
                           "identifier": {"value": "9253856"},
                           "validThrough": "2026-06-29"}), BI_URL, today="2026-09-21")
    check(r is None,
          f"a lone record for another posting must not close this row: {r}")

    # ── Every adapter routes on the OUTER url ──────────────────────────────────
    # Found at one call site in inbox-liveness; auditing for the rest found
    # the same shape in twelve adapters here, which means a wrapper reached ANY caller of
    # the resolver rather than just that one. A posting url riding in a redirect or
    # tracking parameter belongs to another row, and resolving it returns ITS verdict for
    # this one.
    LEVER_UUID = "b7fa68ef-a543-549e-5c9b-dcaabf8a9b79"
    for wrapper in (f"https://t.example.com/c?to=https://jobs.lever.co/acme/{LEVER_UUID}",
                    f"https://t.example.com/r/https://jobs.lever.co/acme/{LEVER_UUID}",
                    "https://t.example.com/c?to=https://jobs.ashbyhq.com/acme/"
                    "0f1db59b-b272-644c-af35-f84c91963e3b",
                    "https://t.example.com/c?to=https://builtin.com/job/x/8534252"):
        r = with_fetch(lambda *a, **k: (200, "{}"), wrapper)
        check(r.get("ats") not in ("lever", "ashby", "successfactors"),
              f"an embedded posting must not claim the wrapper: {r.get('ats')} for "
              f"{wrapper[:58]}")
        # ...and the OUTER url's own status must not close the row either. Refusing the
        # wrapper and then probing it was the first fix, on the
        # reasoning that a status probe "can only ever close it", which is the bug stated
        # as the safeguard: a dead click-tracking endpoint answers 404 or 410 while the
        # posting it points at is untouched, and tracking links rot on their own schedule.
        # Both GONE statuses are asserted because last_resort closes on either.
        for gone in (404, 410):
            r = with_fetch(lambda *a, **k: (gone, ""), wrapper)
            check(r.get("live") is None,
                  f"a dead redirect must not close the posting it wrapped ({gone}): "
                  f"{r.get('live')} for {wrapper[:52]}")
    # A plain url with no wrapper still reaches last_resort and still CLOSES on a 410, so
    # the rule above narrowed nothing but the ambiguous case.
    r = with_fetch(lambda *a, **k: (410, ""), "https://careers.example.com/job/18463287")
    check(r.get("live") is False,
          f"an unwrapped url must still close on a 410: {r.get('live')}")

    # ── An empty board closes nothing ───────────────────────────────────────
    # `{"jobs": []}` parses and satisfies need=("jobs",), so the membership loop simply
    # found nothing and read that as absence. A WRONG org slug returns exactly this: the
    # bare `patronus` Ashby board is recorded in CLAUDE.md as a decoy serving an empty
    # array while the real board is `patronusaiinc`.
    ASHBY_URL = "https://jobs.ashbyhq.com/acme/0f1db59b-b272-644c-af35-f84c91963e3b"
    r = with_fetch(lambda *a, **k: (200, json.dumps({"jobs": []})), ASHBY_URL)
    check(r.get("live") is None,
          f"an EMPTY Ashby board must not close a row: {r.get('live')} {r.get('note')}")
    # ...while a board that holds OTHER postings and not this one is a clean absence and
    # still closes, so the rule narrowed nothing but the unread case.
    r = with_fetch(lambda *a, **k: (200, json.dumps(
        {"jobs": [{"id": "0fe63b42-cbe0-cbe0-cbe0-13f944c76c5d", "title": "Other"}]})),
        ASHBY_URL)
    check(r.get("live") is False,
          f"a populated Ashby board without this posting still closes it: {r.get('live')}")

    # ── A locale where the Workday SITE belongs ───────────────────────────────
    # The old `(?:[\w-]{2,5}/)?` locale group is a LENGTH test, which CLAUDE.md already
    # records as wrong because Autodesk's real site is `Ext`. Read the other way it is
    # worse: the engine backtracks the optional group away, reads `en` as the site and
    # fabricates /wday/cxs/nvidia/en/job/..., an endpoint that never existed, whose 404
    # then closed the row. inbox-liveness.py refuses this url by shape and hands it here.
    r = with_fetch(lambda *a, **k: (404, ""),
                   "https://nvidia.wd5.myworkdayjobs.com/en/job/US-CA-Remote/X_JR2620896")
    check(r.get("live") is None,
          f"a locale-only Workday url must not be closed on a fabricated CXS path: "
          f"{r.get('live')} {r.get('note')}")
    # ...and a real site is still read, including one SHORTER than any locale code.
    _WD_OK = json.dumps({"jobPostingInfo": {"title": "Senior Engineer", "canApply": True,
                                            "location": "US, CA, Remote",
                                            "additionalLocations": []}})
    for site in ("NVIDIAExternalCareerSite", "Ext"):
        r = with_fetch(lambda *a, **k: (200, _WD_OK),
                       f"https://nvidia.wd5.myworkdayjobs.com/{site}/job/US-CA-Remote/"
                       f"X_JR2620896")
        check(r.get("ats") == "workday" and r.get("live") is True,
              f"the site {site!r} must still resolve: {r.get('ats')} {r.get('live')}")
    # ...and the locale rule is SHAPE, not length, in the direction that cost eight
    # Autodesk rows: a three-letter site is a site, a two-letter segment is a locale.
    check(WD_LOCALE_ONLY.match("en") and WD_LOCALE_ONLY.match("en-US")
          and not WD_LOCALE_ONLY.match("Ext"),
          "the Workday locale test must read shape, not length")
    # A wrapper the DETECTOR cannot see, because the embedded address carries no scheme of
    # its own and wraps_another_url() counts schemes. Every
    # adapter is anchored at the outer host now, which is the rule inbox-liveness.py took
    # for its board routes earlier. The evidence that this reached here was a
    # case written in THAT file earlier, whose comment says in as many words that the
    # detector cannot see this shape and nothing but the anchor stands between the row and
    # the board: that file was anchored and the resolver it falls back to was not.
    for bare in (f"https://t.example.com/r/jobs.lever.co/acme/{LEVER_UUID}",
                 "https://t.example.com/r/jobs.ashbyhq.com/acme/"
                 "0f1db59b-b272-644c-af35-f84c91963e3b",
                 "https://t.example.com/r/agbo.breezy.hr/p/49a145320531",
                 "https://t.example.com/r/careers.example.icims.com/jobs/12345",
                 "https://t.example.com/r/apply.workable.com/acme/j/01AB66A4B7",
                 "https://t.example.com/r/jobs.apple.com/en-us/details/270740442",
                 "https://t.example.com/r/www.github.careers/careers-home/jobs/5742",
                 "https://t.example.com/r/jobs.smartrecruiters.com/acme/725755327755",
                 "https://t.example.com/r/job-boards.greenhouse.io/cresta/jobs/4233080640"):
        r = with_fetch(lambda *a, **k: (200, json.dumps({"jobs": [{"id": "other"}]})), bare)
        check(r.get("live") is not False,
              f"a scheme-less embedded posting must not close the wrapper row: "
              f"{r.get('ats')} {r.get('live')} for {bare[:56]}")
    # A scheme-less wrapper is also a WRAPPER, not merely a url the adapters decline.
    # Anchoring stops the embedded posting being RESOLVED and
    # does nothing about a branch that reads the OUTER url's status: the SuccessFactors
    # branch closes on `not (st == 200 and body)`, so a tracker answering 404 retired the
    # row with the body never consulted. Both GONE statuses, since that is what closes.
    for gone in (404, 410):
        r = with_fetch(lambda *a, **k: (gone, ""),
                       "https://tracker.example.com/r/foo.successfactors.com/job/x/123456")
        check(r.get("live") is None,
              f"a dead tracker must not close the posting it wrapped ({gone}): "
              f"{r.get('live')} {r.get('note')}")
    # ...while the SuccessFactors adapter keeps its power over a url that IS the posting,
    # including the Lionsgate shape whose host never says SuccessFactors. Removing that
    # is the cost this fix must not pay.
    r = with_fetch(lambda *a, **k: (410, ""),
                   "https://careers.lionsgate.com/job/Santa-Monica/123456")
    check(r.get("live") is False,
          f"an unwrapped SuccessFactors-shaped url must still close on a 410: "
          f"{r.get('live')}")
    # The detector's two halves, asserted directly, because the difference between them is
    # what makes it precise rather than merely strict. A vendor hostname inside a path is
    # a wrapper; the same vendor WORD as a folder on a company's own site is not.
    check(wraps_another_url("https://t.example.com/r/foo.successfactors.com/job/x/1") is True,
          "an embedded vendor hostname makes a url a wrapper")
    check(wraps_another_url("https://careers.acme.com/successfactors/job/x/123456") is False,
          "a vendor WORD as a path folder is not a wrapper; ATS_HOST is loose on purpose "
          "and must not be used against a path")
    check(wraps_another_url("https://jobs.ashbyhq.com/acme/075210ef360cf159e1af") is False,
          "a plain posting url is not a wrapper, and the outer host must not match itself")
    # ...including one stored WITHOUT a scheme, which this toolchain routes on purpose.
    # Cutting `^https?://[^/]*` leaves a bare url untouched, so it reads as wrapping
    # itself and every scheme-less row is refused. Found by an existing routing case in
    # inbox-liveness within a minute of the change, in the over-refusal direction that
    # loses rows quietly.
    check(wraps_another_url("job-boards.greenhouse.io/cresta/jobs/4233080640") is False,
          "a scheme-less posting url is not a url wrapping itself")
    # The trailing separator is what tells a redirect DESTINATION from a passing mention:
    # a path that merely ends in a vendor host names no posting there.
    check(wraps_another_url("https://careers.acme.com/integrations/greenhouse.io") is False,
          "a vendor host named at the END of a path is a mention, not a destination")
    # ...and the vendor half takes the same `/?#` separator set as the mapped half, since
    # a destination with no path still has a query and a fragment to carry an id in.
    for q in ("https://tracker.example.com/c?url=jobs.ashbyhq.com?jid=abc",
              "https://tracker.example.com/c?url=jobs.lever.co%3Fposting%3Dabc",
              "https://tracker.example.com/c?url=boards.greenhouse.io#4233080640"):
        check(wraps_another_url(q) is True,
              f"a path-less vendor destination is still a wrapper: {q[:64]}")
    # The encoded spelling, asserted here and not only in inbox-liveness, since this is
    # where the rule now lives and the caller reads it from here.
    check(wraps_another_url("https://t.example.com/c?to=https%3A%2F%2Fjobs.lever.co/"
                            "acme/075210ef360cf159e1af") is True,
          "a percent-encoded embedded url is still a wrapper")
    # A scheme-less destination in the QUERY, which is the commonest place a tracker puts
    # one and the place cutting the query first could never look.
    # Three spellings, because a rule that reads only the literal one is defeated by a
    # tracker that url-encodes its parameter, which they routinely do.
    for q in ("https://tracker.example.com/c?url=jobs.ashbyhq.com/acme/075210ef360cf159e1af",
              "https://tracker.example.com/c?url=jobs.ashbyhq.com%2Facme%b87e0f0332f7f25054",
              "https://tracker.example.com?url=jobs.ashbyhq.com/acme/075210ef360cf159e1af"):
        check(wraps_another_url(q) is True,
              f"a scheme-less destination in the query is still a wrapper: {q[:62]}")
    # ...and the whole point of it: the row is not closed on the tracker's own status.
    for gone in (404, 410):
        r = with_fetch(lambda *a, **k: (gone, ""),
                       "https://tracker.example.com/c?url=jobs.ashbyhq.com/acme/"
                       "075210ef360cf159e1af")
        check(r.get("live") is None,
              f"a dead tracker carrying its destination in the query must not close the "
              f"row ({gone}): {r.get('live')}")
    # The third spelling above is why the host is cut at `/`, `?` or `#` rather than at a
    # slash alone: with no path, the first slash sits INSIDE the embedded address, so
    # cutting there removes the very host being looked for.
    # And a real posting url with an ordinary query is still not a wrapper.
    check(wraps_another_url("https://boards.greenhouse.io/embed/job_app?for=cresta"
                            "&token=4233080640") is False,
          "a posting url whose own query carries its slug is not a wrapper")

    # ── A mapped COMPANY front end is a destination too ───────────────────────
    # A vendor list cannot be the whole rule: careers.adobe.com and careers.blizzard.com
    # are not ATS hostnames and this resolver maps both to Workday tenants through
    # portals.yml. portal_workday() keys on the PARSED host, so an embedded one matched
    # nothing, fell through to last_resort() and was closed on the tracker's own status.
    #
    # The mapping is STUBBED rather than read: portals.yml is User Layer, and a case that
    # depends on Adobe still being in it tests the file's contents instead of this rule.
    _real_pw = sys.modules[__name__].portal_workday
    try:
        sys.modules[__name__].portal_workday = (
            lambda u: ("Acme", "acme", "wd5", "Ext") if "careers.acme.com" in u else None)
        check(wraps_another_url("https://tracker.example.com/c?url=careers.acme.com/"
                                "us/en/job/R134330/x") is True,
              "a mapped company front end inside a wrapper is still a wrapper")
        # ...in the path as well as the query, and percent-encoded.
        check(wraps_another_url("https://tracker.example.com/r/careers.acme.com/"
                                "us/en/job/R134330/x") is True,
              "a mapped front end embedded in the PATH is a wrapper too")
        check(wraps_another_url("https://tracker.example.com/c?url=careers.acme.com"
                                "%2Fus%2Fen%2Fjob%2FR134330") is True,
              "an encoded mapped front end is a wrapper too")
        # ...while the same host as the OUTER url is simply this row's own posting, which
        # is the direction that must not be lost: those rows are the reason the front-end
        # mapping exists at all.
        check(wraps_another_url("https://careers.acme.com/us/en/job/R134330/x") is False,
              "the mapped front end as the outer host is this row's own posting")
        # A host-shaped segment portals.yml does NOT map is not a wrapper either, so the
        # rule stays a question about this resolver's own mappings rather than a guess
        # about anything that looks like a hostname.
        check(wraps_another_url("https://careers.example.com/r/unknown.vendor.xyz/"
                                "job/1") is False,
              "a host-shaped segment nothing maps is not a wrapper")
        # And the same separator rule as the vendor half, for the same reason: a host
        # named at the END of a path points at no posting, so it is a mention rather than
        # a destination. Stated as a case because the two halves have to agree, and
        # because without one the trailing `/` in EMBEDDED_HOST is a mutation that
        # cannot fail.
        check(wraps_another_url("https://careers.example.com/partners/"
                                "careers.acme.com") is False,
              "a mapped front end named at the end of a path is a mention, not a "
              "destination")
        # ...but a destination with NO PATH is still a destination, because a requisition
        # fits in a query or a fragment. The separator set here has
        # to be the same `/?#` the outer host cut already uses; it was `/` alone, applied
        # one place and not the other.
        for q in ("https://tracker.example.com/c?url=careers.acme.com?job=R185011",
                  "https://tracker.example.com/c?url=careers.acme.com%3Fjob%3DR123456",
                  "https://tracker.example.com/c?url=careers.acme.com#R185011",
                  "https://tracker.example.com/c?url=careers.acme.com%23R185011"):
            check(wraps_another_url(q) is True,
                  f"a path-less mapped destination is still a wrapper: {q[:64]}")
        for gone in (404, 410):
            r = with_fetch(lambda *a, **k: (gone, ""),
                           "https://tracker.example.com/c?url=careers.acme.com"
                           "%3Fjob%3DR123456")
            check(r.get("live") is None,
                  f"a dead tracker carrying a path-less destination must not close the "
                  f"row ({gone}): {r.get('live')}")
        for gone in (404, 410):
            r = with_fetch(lambda *a, **k: (gone, ""),
                           "https://tracker.example.com/c?url=careers.acme.com/us/en/"
                           "job/R134330/x")
            check(r.get("live") is None,
                  f"a dead tracker carrying a mapped front end must not close the row "
                  f"({gone}): {r.get('live')}")
    finally:
        sys.modules[__name__].portal_workday = _real_pw
    # ...and every one of those hosts still resolves as the OUTER url, so the anchor cost
    # no coverage. Asserted per host rather than once, because an anchor written slightly
    # wrong for one provider is a silent loss of that provider's rows.
    for plain, want in ((f"https://jobs.lever.co/acme/{LEVER_UUID}", "lever"),
                        ("https://jobs.ashbyhq.com/acme/"
                         "0f1db59b-b272-644c-af35-f84c91963e3b", "ashby"),
                        ("https://agbo.breezy.hr/p/49a145320531", "breezy"),
                        ("https://www.github.careers/careers-home/jobs/5742", "github"),
                        ("https://apply.workable.com/acme/j/01AB66A4B7", "workable")):
        r = with_fetch(lambda *a, **k: (0, ""), plain)
        check(r.get("ats") == want,
              f"the anchor must not cost {want} its own rows: got {r.get('ats')}")
    # ...and the same posting as the OUTER url still routes, tracking tag and all.
    r = with_fetch(lambda *a, **k: (0, ""),
                   f"https://jobs.lever.co/acme/{LEVER_UUID}?utm_source=linkedin")
    check(r.get("ats") == "lever",
          f"a tracking tag must not stop the real adapter: {r.get('ats')}")
    # The exemption list, asserted in the SOURCE so it cannot quietly grow. Only the
    # Greenhouse gh_jid and Eightfold's `?domain=` may read the query, because those are
    # the two places a posting identity legitimately lives there.
    with open(os.path.abspath(__file__), encoding="utf-8") as _fh2:
        _rsrc = _fh2.read()
    _rbody = _rsrc.split("\ndef resolve(url):", 1)[1].split("\nROUTE_CASES", 1)[0]
    _whole = [x for x in re.findall(r"re\.search\(r?\"[^\"]*\", u[,)]", _rbody)
              if "gh_jid" not in x and "domain=" not in x]
    check(not _whole,
          f"every adapter in resolve() must route on `ou`, not the whole url. The only "
          f"exemptions are the Greenhouse gh_jid and Eightfold's ?domain=, because those "
          f"are the two places a posting identity legitimately lives in a query: {_whole}")
    # And routing on `ou` is only half of it, because `ou` still holds the whole PATH: an
    # adapter searching it unanchored finds its host anywhere along the string, which is
    # how a scheme-less wrapper reached the Ashby adapter. Every
    # pattern naming an ATS host must begin at the outer host. Asserted over the SOURCE
    # rather than through behaviour, because the next adapter has no case here yet and
    # "someone will remember" is what failed in this file three rounds running.
    #
    # Scoped to the patterns matched against `ou`, which is exactly the set that routes a
    # ROW's url. The same host names appear in patterns read against page HTML ("does this
    # page mention another ATS") and against portals.yml entries, and those are matching a
    # document or a config value rather than deciding whose posting this row is, so they
    # are neither anchored nor should be. The first draft of this check scanned the whole
    # file and flagged all six of them.
    # STATED AS AN EXEMPTION LIST, not as a list of known hosts. Keying on the ATS names
    # already in the file makes the check blind to the case it exists for: a NEW adapter
    # for a vendor nobody has heard of yet is exactly what will be added unanchored, and a
    # host list cannot name it in advance. That was not hypothetical, it was the first
    # draft, and a mutation adding an unanchored `newats\.com` route stayed green.
    #
    # So every pattern matched against `ou` must be anchored, and the two that are
    # legitimately not are named here. Opting out is then a visible edit to this tuple
    # rather than the silent default, which is the same shape as the query-exemption list
    # directly above.
    _EXEMPT_UNANCHORED = (
        # A keyword test rather than a host match: does this url mention SuccessFactors at
        # all. Lionsgate IS SuccessFactors and its url never says so, so this branch has
        # to be able to claim a url on shape alone, which is why anchoring it is not the
        # answer here the way it was for the nine host-shaped adapters.
        #
        # THE JUSTIFICATION WRITTEN HERE EARLIER WAS WRONG, and review quoted it back.
        # It said the branch "reads the OUTER url's body and declines
        # unless that body mentions SuccessFactors too, so it cannot answer for an
        # embedded one". That is true of the LIVE path and false of the closing one:
        # `if sf_named or not (st == 200 and body)` returns unresolved(st), so a wrapper
        # whose tracker answered 404 was closed without the body ever being consulted.
        # What actually protects it is wraps_another_url(), which now also sees an
        # embedded ATS host that dropped its scheme, so a url like
        # `https://tracker.example/r/foo.successfactors.com/job/x/123456` never reaches
        # any adapter. The lesson is narrower than the bug: an exemption is only as good
        # as the reason written next to it, and a reason that covers one path through a
        # branch is not a reason.
        'r"successfactors"',
        # The same shape test, anchored at the END rather than at the host, and covered by
        # the same refusal.
        r'r"/job/[^/]+/\d{6,}/?$"',
    )
    # The capture is the PATTERN LITERAL and nothing else: an optional `OUTER_HOST +`
    # followed by one or more adjacent string literals, which is how the multi-line
    # Greenhouse pattern is written. A plain `(.*?)` with re.S looked equivalent and is
    # not, because it spans from one adapter's `re.search(` to a LATER `, ou`, swallowing
    # the code between them and reporting an innocent `\bremote\b` test as an unanchored
    # Lever route. It flagged exactly that on the first run.
    _routing = re.findall(r're\.search\(\s*((?:OUTER_HOST \+ )?r?"[^"]*"'
                          r'(?:\s*r?"[^"]*")*)\s*,\s*ou\s*[,)]', _rbody, re.S)
    # A SCANNER THAT MATCHES NOTHING PASSES EVERYTHING. If the capture above is ever
    # broken by a reformat, the list comprehension below runs over an empty list and the
    # check reports success for a file it never read, which is the vacuous-guard shape
    # this repo keeps finding. So the scan asserts it FOUND the adapters before judging
    # them. Nine host-shaped routes exist today; the floor is deliberately below that so
    # removing one provider is not a test failure, and far enough above zero to catch a
    # capture that has stopped working.
    check(len(_routing) >= 8,
          f"the adapter scan matched only {len(_routing)} routing pattern(s), so it is "
          f"not reading resolve() any more and the anchor check below proves nothing")
    _unanchored = [" ".join(x.split())[:72] for x in _routing
                   if "OUTER_HOST" not in x and not x.strip().startswith('r"^')
                   and " ".join(x.split()) not in _EXEMPT_UNANCHORED]
    check(not _unanchored,
          f"every adapter pattern matched against `ou` must be anchored at the outer "
          f"host, with OUTER_HOST or an explicit ^, or a wrapper carrying that host in "
          f"its path resolves the embedded posting and returns ITS verdict for this row. "
          f"If a pattern genuinely is not a host match, name it in _EXEMPT_UNANCHORED "
          f"with the reason: {_unanchored}")
    # SR_URL is compiled above resolve() rather than inline, so the scan over the function
    # body cannot see it, and it is a row-routing pattern like any other.
    check(all(p.pattern.startswith(OUTER_HOST) for p in SR_URL),
          "both SmartRecruiters patterns must be anchored at the outer host")

    # ── Workday front ends: the id comes from the PATH, and matches on CANONICAL
    # ── ids rather than substrings ─────────────────────────────────────────────
    BLZ_FRONT = "https://careers.blizzard.com/global/en/job/R095439/senior-manager"

    # The CXS search is a POST and the detail is a GET, so BOTH have to be stubbed. The
    # first version of these cases patched only fetch(), which left the search hitting the
    # real Blizzard tenant: they failed for a reason that had nothing to do with the code
    # under test and would have passed or failed on whatever that board holds today.
    WD_DETAIL = json.dumps({"jobPostingInfo": {
        "title": "Senior Manager", "canApply": True, "location": "Irvine, CA",
        "additionalLocations": [], "jobDescription": "<p>Cinematics.</p>"}})

    def with_wd_front(postings, url):
        """A portals.yml Workday front end whose tenant search returns exactly these."""
        with mock.patch.object(sys.modules[__name__], "post",
                               lambda *a, **k: (200, json.dumps({"jobPostings": postings}))), \
             mock.patch.object(sys.modules[__name__], "fetch",
                               lambda *a, **k: (200, WD_DETAIL)):
            return resolve(url)

    # A NEAR match must not answer for the requested req. R095439 against R0334632.
    r = with_wd_front([{"externalPath": "/job/Irvine/Other-Role_R0334632"}], BLZ_FRONT)
    check(r.get("live") is False,
          f"a longer requisition must not satisfy a shorter one: {r.get('live')} "
          f"{r.get('note')}")
    # ...while the SAME req spelled with a separator must still match.
    r = with_wd_front([{"externalPath": "/job/Irvine/Senior-Manager_R-095439"}], BLZ_FRONT)
    check(r.get("ats") == "workday" and r.get("live") is True,
          f"R-095439 and R095439 are one requisition: {r.get('ats')} {r.get('live')}")
    # A tracking parameter alongside a real path req: the PATH must win.
    r = with_wd_front([{"externalPath": "/job/Irvine/Senior-Manager_R095439"}],
                      BLZ_FRONT + "?utm_campaign=JR48085")
    check(r.get("live") is True,
          f"a path requisition must outrank a tracking parameter: {r.get('live')}")
    # And the case that actually reproduces the bug: a mapped front end with NO req in its
    # path, only a req-shaped marketing tag. Unstripped, JR48085 is read as the req, misses
    # on the Blizzard tenant, and workday_by_req closes the row on the strength of it.
    # The first version of this case put a req in the path too, so stripping changed
    # nothing and the mutation stayed green: it asserted the right words about the wrong
    # URL.
    r = with_wd_front([{"externalPath": "/job/Irvine/Senior-Manager_R095439"}],
                      "https://careers.blizzard.com/global/en/search?utm_campaign=JR48085")
    check(r.get("live") is not False,
          f"a req-shaped tracking tag with no path requisition must not close a row: "
          f"{r.get('live')} {r.get('note')}")
    check(canon_req("R-095439") == canon_req("r_095439") == "R095439",
          "canon_req must fold separators and case")

    # ── A full page is not an absence ──────────────────────────────────────────
    # `searchText` is fuzzy, so the exact requisition can rank below twenty partial
    # matches. Reading one page and closing on the id not being in it retires a live row,
    # and inbox-liveness --mark acts on exactly that verdict.
    HIT = {"externalPath": "/job/Irvine/Senior-Manager_R095439"}

    def wd_filler(n, tag="a"):
        """n postings that are not the requested req, with ids that cannot collide."""
        return [{"externalPath": f"/job/Irvine/Filler-{tag}{i}_R09{i:04d}"} for i in range(n)]

    def wd_paged(pages, url=BLZ_FRONT):
        """A tenant serving one (postings, total) per offset. `total` None omits the key."""
        def served(_u, payload):
            page = payload["offset"] // WD_SEARCH_LIMIT
            postings, total = pages[page] if page < len(pages) else ([], None)
            body = {"jobPostings": postings}
            if total is not None:
                body["total"] = total
            return (200, json.dumps(body))
        with mock.patch.object(sys.modules[__name__], "post", served), \
             mock.patch.object(sys.modules[__name__], "fetch",
                               lambda *a, **k: (200, WD_DETAIL)):
            return resolve(url)

    r = wd_paged([(wd_filler(20), 100), (wd_filler(20, "b"), 100),
                  (wd_filler(19, "c") + [HIT], 100)])
    check(r.get("ats") == "workday" and r.get("live") is True,
          f"a requisition ranked onto page 3 must still be found: {r.get('live')} "
          f"{r.get('note')}")
    # The CrowdStrike trap from CLAUDE.md, one layer down: `total` is trustworthy on the
    # FIRST page only. Re-reading it per page lets a later 0 declare the walk finished.
    r = wd_paged([(wd_filler(20), 100), (wd_filler(20, "b"), 0),
                  (wd_filler(19, "c") + [HIT], 0)])
    check(r.get("live") is True,
          f"a later page's total must not end the walk: {r.get('live')} {r.get('note')}")
    # Results still outstanding when the bound is reached: unknown, never closed.
    r = wd_paged([(wd_filler(20, chr(97 + i)), 200) for i in range(WD_SEARCH_PAGES)])
    check(r.get("live") is not False,
          f"a truncated walk must not close a row: {r.get('live')} {r.get('note')}")
    # Served fewer than it claimed, then stopped. One response disagreeing with itself is
    # not an absence, and jload()'s rule says an unread answer settles nothing.
    r = wd_paged([(wd_filler(5), 50)])
    check(r.get("live") is not False,
          f"a board serving less than its own total must not close a row: "
          f"{r.get('live')} {r.get('note')}")
    # ...and the closing direction still works once the result set genuinely ENDS.
    r = wd_paged([(wd_filler(20), 25), (wd_filler(5, "b"), 25)])
    check(r.get("live") is False and "all 25 results" in (r.get("note") or ""),
          f"a req absent from a fully read result set is closed: {r.get('live')} "
          f"{r.get('note')}")

    # ── Identity in the QUERY string ─────────────────────────────────────────
    # A page whose postings differ only by query parameter: discarding the query makes
    # every one of them compare equal, so an expired neighbour closes the live row.
    LIVE_Q = "https://jobs.example.com/apply?id=live"
    check(_same_posting(LIVE_Q, "https://jobs.example.com/apply?id=dead") is False,
          "two postings differing only by query id are not the same posting")
    check(_same_posting(LIVE_Q, LIVE_Q) is True, "a url must match itself")
    r = jsonld_expired(ld({"@type": "JobPosting", "title": "The Dead Neighbour",
                           "url": "https://jobs.example.com/apply?id=dead",
                           "validThrough": "2026-06-29"},
                          {"@type": "JobPosting", "title": "The Live One",
                           "url": LIVE_Q, "validThrough": "2099-01-01"}),
                       LIVE_Q, today="2026-09-21")
    check(r is None,
          f"an expired neighbour identified by query must not close this row: {r}")
    # ...while tracking parameters, which describe the visit and not the posting, must not
    # defeat a match that is otherwise identical.
    check(_same_posting("https://jobs.example.com/apply?id=live&utm_source=linkedin"
                        "&lang=en", LIVE_Q) is True,
          "tracking parameters must not break an otherwise identical match")
    # ── Contradictory expiry records ─────────────────────────────────────────
    # Two records that BOTH pass the identity test above and disagree: a CMS leaving a
    # stale copy beside the live one, or an aggregator embedding its own cache. Closing on
    # whichever came first in the DOM makes liveness depend on markup order, and it fails
    # in the direction that retires a live row. Asserted in BOTH orders, because a rule
    # that reads the first record is right half the time by accident.
    CONTRA = "https://jobs.example.com/apply?id=live"
    for first, second in (("2026-06-29", "2099-01-01"), ("2099-01-01", "2026-06-29")):
        r = jsonld_expired(ld({"@type": "JobPosting", "url": CONTRA,
                               "validThrough": first},
                              {"@type": "JobPosting", "url": CONTRA,
                               "validThrough": second}),
                           CONTRA, today="2026-09-21")
        check(r is None,
              f"contradictory expiry records must settle nothing ({first} then "
              f"{second}): {r}")
    # ...while records that AGREE the posting expired still close it.
    r = jsonld_expired(ld({"@type": "JobPosting", "url": CONTRA,
                           "validThrough": "2026-06-29"},
                          {"@type": "JobPosting", "url": CONTRA,
                           "validThrough": "2026-07-01"}),
                       CONTRA, today="2026-09-21")
    check(r is not None and r.get("live") is False,
          f"two records agreeing the posting expired must still close it: {r}")

    # An UNRECOGNISED parameter is kept, so the list failing behind declines a match rather
    # than inventing one. That is the only direction this is allowed to be wrong in.
    check(_same_posting("https://jobs.example.com/apply?id=live&somethingnew=1",
                        LIVE_Q) is False,
          "an unrecognised parameter must make the comparison stricter, not looser")
    # A hostname is case-insensitive; a PATH is not. `/jobs/ABC` and `/jobs/abc` are two
    # resources, and folding them let an expired neighbour close the requested row.
    check(_same_posting("https://jobs.example.com/jobs/ABC",
                        "https://jobs.example.com/jobs/abc") is False,
          "two paths differing only in case are two postings")
    check(_same_posting("https://JOBS.Example.COM/jobs/ABC",
                        "https://jobs.example.com/jobs/ABC") is True,
          "the HOST is case-insensitive even though the path is not")
    # On a hash-routed careers site the FRAGMENT is the posting identity.
    check(_same_posting("https://careers.example.com/#/jobs/live",
                        "https://careers.example.com/#/jobs/dead") is False,
          "two postings differing only by fragment are two postings")
    check(_same_posting("https://careers.example.com/#/jobs/live",
                        "https://careers.example.com/#/jobs/live") is True,
          "the same hash route must still match itself")
    # ...and an expired record for the dead route must not close the live one.
    HASH_LIVE = "https://careers.example.com/#/jobs/live"
    r = jsonld_expired(ld({"@type": "JobPosting", "title": "The Dead Route",
                           "url": "https://careers.example.com/#/jobs/dead",
                           "validThrough": "2026-06-29"}), HASH_LIVE, today="2026-09-21")
    check(r is None, f"an expired hash route must not close a different one: {r}")

    # End to end through resolve(), which is where the SuccessFactors shape rule used to
    # swallow this URL. builtin.com matches `/job/<slug>/<digits>`, and an adapter that
    # claims a URL it cannot read denies every later reader its turn.
    r = with_fetch(lambda *a, **k: (200, LD),
                   "https://builtin.com/job/applied-research-scientist-engineer/8534252")
    check(r.get("ats") == "jsonld" and r.get("live") is False,
          f"a shape-only SuccessFactors match must fall through to the page's own "
          f"JobPosting: {r.get('ats')} {r.get('live')} {r.get('note')}")

    # The 405 retry, asserted at the TRANSPORT layer, because every other case here mocks
    # fetch() itself and so could never see it. A 405 describes the request: iCIMS answers
    # one to the spoofed Chrome User-Agent this file sends and 200 to a plain client.
    _calls = []

    class _Resp:
        status = 200

        def read(self):
            return b"<title>ok</title>"

        def __enter__(self):
            return self

        def __exit__(self, *e):
            return False

    def _urlopen(req, *a, **k):
        _calls.append(dict(req.headers))
        if len(_calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 405, "Not Allowed", {}, None)
        return _Resp()

    with mock.patch.object(urllib.request, "urlopen", _urlopen):
        st, body = fetch("https://x/y", accept=HTML_ACCEPT)
    check(st == 200 and "ok" in (body or ""),
          f"a 405 must be retried as a plain client, got {st}")
    check(len(_calls) == 2 and not _calls[1],
          f"the retry must send no custom headers at all: {_calls}")

    # The same retry on the CURL path, which is the one that runs when urllib fails at the
    # TLS layer. That is exactly the environment the fallback exists for, so a 405 there
    # left the host unresolvable on the machines that need it most.
    class _Proc:
        def __init__(self, text):
            self.stdout = text

    _cmds = []

    def _run(cmd, *a, **k):
        _cmds.append(cmd)
        return _Proc("<title>ok</title>\n405" if len(_cmds) == 1
                     else "<title>ok</title>\n200")

    with mock.patch.object(urllib.request, "urlopen",
                           lambda *a, **k: (_ for _ in ()).throw(OSError("tls"))), \
            mock.patch.object(subprocess, "run", _run):
        st, body = fetch("https://x/y", accept=HTML_ACCEPT)
    check(st == 200 and "ok" in (body or ""),
          f"curl must retry a 405 as a plain client, got {st}")
    check(len(_cmds) == 2 and "-H" in _cmds[0] and "-H" not in _cmds[1],
          f"the curl retry must drop every -H: {[c.count('-H') for c in _cmds]}")

    # Greenhouse reads the opposite way round from Workday on the same body, which is
    # what made one unread response both certify and close postings.
    r = with_fetch(lambda *a, **k: (200, "{}"),
                   "https://job-boards.greenhouse.io/cresta/jobs/5055750430")
    check(r.get("live") is None,
          f"greenhouse: an empty object at HTTP 200 must be unknown, "
          f"got live={r.get('live')} ({r.get('note')})")

    # The mechanism, asserted in the SOURCE, so a twelfth adapter added next year cannot
    # quietly skip it. Every adapter call that parses a response body must declare the
    # posting shape it needs; the Breezy board is the one exemption, because an array has no
    # fields and its own "parsed but held no posting" check sits directly below it.
    with open(os.path.abspath(__file__), encoding="utf-8") as _fh:
        _src = _fh.read()
    _calls = re.findall(r"jload\((body\w*)([^)]*)\)", _src)
    _bare = [a + b for a, b in _calls if "need=" not in b and "want=list" not in b]
    check(not _bare,
          f"every jload() of a response body must declare need=; bare calls: {_bare}")
    check(len(_calls) >= 11,
          f"the jload call-site scan found only {len(_calls)} calls; the scan is broken")

    # The ORDER of the two greenhouse_claim() passes, asserted in the source for the same
    # reason. It is the property that demoted the host blacklist from the guarantee to an
    # optimisation, and no single resolve() result can observe it: today every adapter
    # whose URLs carry a long numeric id is ALSO named in that blacklist, so moving the
    # guess back to the front breaks nothing that the suite can currently see. That is
    # precisely the reading under which the arrangement quietly reverts, and the twelfth
    # adapter added next year is the one that would pay for it.
    _body = _src.split("\ndef resolve(url):", 1)[1].split("\nROUTE_CASES", 1)[0]
    # find(), not index(): a missing call site must FAIL this check with its message
    # rather than raise out of the suite, since the message is the whole point.
    _declared, _guess = (_body.find("allow_inference=False"), _body.find("allow_inference=True"))
    check(0 <= _declared < _body.find("jobs\\.ashbyhq\\.com"),
          f"the DECLARED-Greenhouse pass must run before the first adapter (at {_declared})")
    check(_guess > _body.find("portal_workday(u)") >= 0,
          "the INFERRED Greenhouse guess must run after every adapter and after the "
          "portals.yml Workday lookup: an inference must never pre-empt a lookup that "
          "could have answered authoritatively")
    check(_body.count("greenhouse_claim(") == 2,
          f"resolve() must call greenhouse_claim exactly twice, once per confidence "
          f"level; found {_body.count('greenhouse_claim(')}")

    # ── BUG 6: workday_reslug could not say whether it had actually read the board ──
    # It returned a bare None both when the tenant search ran cleanly and the req was
    # genuinely absent, and when the search never ran. The caller read every None as
    # "absent from tenant search = closed", so a transient CXS failure retired a live job.
    WD = ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
          "/job/US-CA-Remote/X_JR2391853")
    HIT = json.dumps({"jobPostings": [
        {"externalPath": "/job/US-CA-Remote/Senior-Engineer_JR2391853"}]})
    LIVE = json.dumps({"jobPostingInfo": {"title": "Senior Engineer", "canApply": True,
                                          "location": "US, CA, Remote",
                                          "additionalLocations": [],
                                          "jobDescription": "<p>Agents.</p>"}})

    def with_wd(post_result, detail=(403, ""), live_body=LIVE):
        """403 on the saved path, then whatever the tenant search is made to answer."""
        def _fetch(url, *a, **k):
            return ((200, live_body) if "JR2391853" in url and "Senior-Engineer" in url
                    else detail)
        with mock.patch.object(sys.modules[__name__], "fetch", _fetch), \
             mock.patch.object(sys.modules[__name__], "post",
                               lambda *a, **k: post_result):
            return resolve(WD)

    # The search ran and answered cleanly with nothing. That is real evidence of absence.
    r = with_wd((200, json.dumps({"jobPostings": []})))
    check(r.get("live") is False and "= closed" in (r.get("note") or ""),
          f"a clean search finding nothing is a closure: {r.get('live')} / {r.get('note')}")
    # The search did not run. Same empty hand, no evidence in it.
    for label, res in (("transport failure", (0, "")),
                       ("tenant refused the query", (422, "")),
                       ("server error", (500, "")),
                       ("200 but unparseable JSON", (200, "<html>WAF interstitial</html>"))):
        r = with_wd(res)
        check(r.get("live") is None and "unknown" in (r.get("note") or ""),
              f"{label}: nothing was read, so liveness is unknown, not closed "
              f"(got live={r.get('live')} / {r.get('note')})")
    # ...and the happy path still resolves, so the 2-tuple did not break the rescue.
    r = with_wd((200, HIT))
    check(r.get("live") is True and r.get("reslugged") is True,
          f"a stale slug must still be rescued by the search: {r.get('note')}")
    # The re-slugged branch issues the same bool(canApply) verdict off the same nested
    # record, so it needs the same nested declaration. A search that found the current
    # path and then read an empty record has checked nothing.
    r = with_wd((200, HIT), live_body='{"jobPostingInfo": {}}')
    check(r.get("live") is None,
          f"a re-slugged empty nested record must be unknown, got live={r.get('live')} "
          f"({r.get('note')})")
    # The flag itself, not only what the caller does with it.
    with mock.patch.object(sys.modules[__name__], "post", lambda *a, **k: (0, "")):
        check(workday_reslug("nvidia", "wd5", "S", "job/x/y_JR2391853") == (None, False),
              "an unreadable search must report searched=False")
    with mock.patch.object(sys.modules[__name__], "post",
                           lambda *a, **k: (200, json.dumps({"jobPostings": []}))):
        check(workday_reslug("nvidia", "wd5", "S", "job/x/y_JR2391853") == (None, True),
              "a clean empty search must report searched=True")
    # No req id in the path means there was nothing to search for, so nothing was checked.
    with mock.patch.object(sys.modules[__name__], "post",
                           lambda *a, **k: (200, json.dumps({"jobPostings": []}))):
        check(workday_reslug("nvidia", "wd5", "S", "job/no-id-here") == (None, False),
              "an unextractable req id must report searched=False, not a clean absence")

    # ── BUG 9: only 404 counted as a closure, and 410 Gone is the stronger word ──
    # 410 means the resource existed and was permanently removed, which is a MORE
    # explicit statement than 404, and it was reaching unresolved() as "not retrievable".
    # Measured 2026-09-20: careers.blizzard.com answers 410 for R095439 and
    # careers.adobe.com answers 410 for R134478 and R160381.
    check(unresolved(410) is False, "HTTP 410 Gone is a closure, not a failed read")
    check(unresolved(404) is False, "HTTP 404 must still be a closure")
    check(gone_note(410) == "closed (HTTP 410)",
          f"the note must agree with the verdict: {gone_note(410)!r}")
    check("not retrievable" == gone_note(500),
          f"a 500 is still not retrievable: {gone_note(500)!r}")
    # The six shared call sites, exactly as the 404 loop above covers them. The note is
    # checked too, because live=False under the words "not retrievable" is a verdict
    # nobody downstream would trust or act on.
    for url, ats in (("https://jobs.lever.co/magnopus/3f63e800-a195-3071-ffbc-5586041c6472",
                      "lever"),
                     ("https://apply.workable.com/panorama-education/j/9200125A8B/",
                      "workable"),
                     ("https://explore.jobs.netflix.net/careers/job/712200781859-x",
                      "netflix"),
                     ("https://jobs.smartrecruiters.com/Experian/postings/757675447924470",
                      "smartrecruiters"),
                     ("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
                      "/job/US-CA-Remote/X_JR2391853", "workday"),
                     ("https://jobs.lionsgate.com/Lionsgate/job/Santa-Monica-CA/1104510032/",
                      "successfactors")):
        r = with_fetch(lambda *a, **k: (410, ""), url)
        check(r.get("ats") == ats and r.get("live") is False,
              f"{ats}: HTTP 410 must be a closure, got live={r.get('live')}")
        check("closed" in (r.get("note") or ""),
              f"{ats}: a 410 closure must say so: {r.get('note')!r}")
    # Apple reads its own detail page rather than an API, and a 410 there used to fall
    # through to "re-check the parser before trusting a verdict".
    r = with_fetch(lambda *a, **k: (410, ""),
                   "https://jobs.apple.com/en-us/details/275158197-0670/lead-dev")
    check(r.get("ats") == "apple" and r.get("live") is False,
          f"apple: HTTP 410 must be a closure, got live={r.get('live')}")
    # Greenhouse keeps its guessed-slug ambiguity for 410 as well. A 410 on a board that
    # EXISTS is a closure; a 410 reached through a guessed slug where no board exists is
    # a bad guess, and closing on it is the SentinelOne failure with a different number.
    def _gh410(page="<html>a careers page naming no ATS at all</html>"):
        def _f(url, *a, **k):
            return (410, "") if "boards-api.greenhouse.io" in url else (200, page)
        return _f
    r = with_fetch(_gh410(), "https://job-boards.greenhouse.io/cresta/jobs/5055750430")
    check(r.get("live") is False and r.get("status") == 410,
          f"greenhouse: a 410 on a named board is a closure: {r.get('live')} / {r.get('note')}")
    r = with_fetch(_gh410(), "https://careers.no-such-company-exists-here.com/job/1194374/x")
    check(r.get("live") is None,
          f"greenhouse: a 410 on a GUESSED slug with no board is not a closure: "
          f"{r.get('live')} / {r.get('note')}")

    # ── BUG 10: a host with no adapter was a permanent dead end ──────────────
    # "no API for this host" is honest and it was also terminal: nothing ever looked at
    # those rows again. Seven dashboard rows were unclassifiable this way on 2026-09-20
    # and three of them were permanently gone, one carried at 4.1 for weeks.
    NOADAPTER = "https://jobs.ea.com/en_US/careers/JobDetail/Senior-Tools-Engineer/212777"
    for st in (404, 410):
        r = with_fetch(lambda *a, _s=st, **k: (_s, ""), NOADAPTER)
        check(r.get("ats") == "unsupported" and r.get("live") is False,
              f"an unadapted host answering {st} must be closed, got live={r.get('live')}")
        check(str(st) in (r.get("note") or ""),
              f"the closure must name the status it rests on: {r.get('note')!r}")
    # THE DANGEROUS DIRECTION. A 200 from one of these hosts proves nothing: they are
    # client-rendered careers shells and they serve the same 200 for a retired req as for
    # a live one, which is exactly why they have no adapter. Four of the seven rows
    # measured on 2026-09-20 answered 200 and their true state is still unknown. This
    # tool may only ever retire, never promote.
    for label, st, body in (("a 200 with a full page", 200, "<html>a careers shell</html>"),
                            ("a 200 with an empty body", 200, ""),
                            ("a redirect", 302, ""),
                            ("a WAF 403", 403, ""),
                            ("a rate limit", 429, ""),
                            ("a server error", 500, "")):
        r = with_fetch(lambda *a, _s=st, _b=body, **k: (_s, _b), NOADAPTER)
        check(r.get("live") is None,
              f"an unadapted host: {label} must stay unknown, got live={r.get('live')}")
        check(r.get("live") is not True,
              f"an unadapted host must NEVER be reported live: {label} gave "
              f"live={r.get('live')}")
    # A network failure or a timeout is fetch()'s 0. Nothing was read, so nothing is known,
    # and a probe that cannot complete must not read as a removal.
    r = with_fetch(lambda *a, **k: (0, ""), NOADAPTER)
    check(r.get("live") is None,
          f"an unadapted host: a timeout must be unknown, got live={r.get('live')}")
    # The probe asks one question of a page that may be a heavy client-rendered shell, so
    # it must not sit on the adapters' full budget while doing it.
    seen = {}

    def _timed(url, *a, **k):
        seen["timeout"] = k.get("timeout")
        return 200, ""
    with_fetch(_timed, NOADAPTER)
    check(seen.get("timeout") is not None and seen["timeout"] < 25,
          f"the last-resort probe must pass a short timeout, got {seen.get('timeout')!r}")
    # urllib follows redirects and curl does not, so without -L the fallback transport
    # answered a different question from the primary one, and this verdict IS the status.
    # The needle is BUILT rather than written, because the first spelling of this case
    # found itself in the source and stayed green with the flag deleted. A case that
    # cannot fail is not a case.
    check('"curl", "-s' + 'L"' in _src,
          "the curl fallback must follow redirects, or the two transports answer "
          "different questions and this verdict is the status code")

    # ── BUG 11: several adapterless hosts are Workday front ends ─────────────
    # careers.blizzard.com is the human face of xboxgaming/Blizzard_External_Careers and
    # careers.adobe.com of adobe/external_experienced. The req id is in the URL path and
    # resolves through the tenant's CXS search like any other Workday req, so these rows
    # deserve a real verdict rather than a status code. Read from the FILE, not from a
    # constant: asserting against a hardcoded tenant would pass with the lookup deleted.
    BLZ = "https://careers.blizzard.com/global/en/job/R095439/Senior-Manager-Cinematics"
    check(portal_workday(BLZ) == ("Blizzard Entertainment", "xboxgaming", "wd1",
                                  "Blizzard_External_Careers"),
          f"portals.yml must yield the Blizzard tenant for careers.blizzard.com, "
          f"got {portal_workday(BLZ)}")
    check(portal_workday("https://careers.adobe.com/us/en/job/R134330/x")[1:]
          == ("adobe", "wd5", "external_experienced"),
          f"portals.yml must yield the Adobe tenant: {portal_workday('https://careers.adobe.com/x')}")
    check(portal_workday("https://job-boards.greenhouse.io/cresta/jobs/5055750430") is None,
          "an ATS host must yield no tenant")
    check(portal_workday("https://careers.no-such-company-exists-here.com/job/R185011") is None,
          "an unknown company must yield no tenant")
    # A wrong tenant is not a wasted request the way a wrong Greenhouse slug is: its
    # search runs cleanly, finds nothing and RETIRES a live req. So two tenants matching
    # one host must refuse rather than pick, and the guard is tested on its own because
    # the file happens not to contain such a pair today.
    TWO = [dict(label="Acme Games", keys={"acme"}, loose={"acme"}, slugs=[],
                workday=("acmeone", "wd1", "External")),
           dict(label="Acme Studios", keys={"acme"}, loose={"acme"}, slugs=[],
                workday=("acmetwo", "wd5", "Careers"))]
    with mock.patch.object(sys.modules[__name__], "portals_index", lambda: TWO):
        check(portal_workday("https://careers.acme.com/job/R185011") is None,
              "two tenants matching one host must refuse to guess between them")
    # Two entries recording the SAME tenant are not an ambiguity, they are a duplicate
    # poll, and portals.yml carries one today (two Autodesk entries, both autodesk/Ext).
    with mock.patch.object(sys.modules[__name__], "portals_index",
                           lambda: [TWO[0], dict(TWO[0], label="Acme Games (EU)")]):
        check(portal_workday("https://careers.acme.com/job/R185011")
              == ("Acme Games", "acmeone", "wd1", "External"),
              "two entries recording one tenant must still resolve")
    with mock.patch.object(sys.modules[__name__], "portals_index", lambda: TWO[:1]):
        check(portal_workday("https://careers.acme.com/job/R185011")
              == ("Acme Games", "acmeone", "wd1", "External"),
              "one tenant matching one host must resolve")

    WD_HIT = json.dumps({"jobPostings": [
        {"externalPath": "/job/Irvine/Senior-Manager-Cinematics_R095439"}]})
    WD_LIVE = json.dumps({"jobPostingInfo": {
        "title": "Senior Manager, Cinematics", "canApply": True,
        "location": "Irvine, California", "additionalLocations": ["US, CA, Remote"],
        "jobDescription": "<p>Cinematics TD leadership. $200,000 - $250,000</p>"}})

    def with_tenant(search, detail=(200, WD_LIVE), url=BLZ):
        """The tenant search answers `search`; the CXS detail path answers `detail`."""
        def _f(u2, *a, **k):
            return detail if "/wday/cxs/" in u2 else (200, "<html>front end</html>")
        with mock.patch.object(sys.modules[__name__], "fetch", _f), \
             mock.patch.object(sys.modules[__name__], "post", lambda *a, **k: search):
            return resolve(url)

    r = with_tenant((200, WD_HIT))
    check(r.get("ats") == "workday" and r.get("live") is True,
          f"a Workday-backed host must resolve through its tenant: {r.get('live')} / "
          f"{r.get('note')}")
    check(r.get("title") == "Senior Manager, Cinematics",
          f"the tenant verdict must carry the posting, not just a status: {r.get('title')!r}")
    # The secondary-location rule every adapter in this file has had to learn at least
    # once. This one gets it by sharing workday_record() rather than by remembering to.
    check("US, CA, Remote" in (r.get("location") or ""),
          f"the front-end path dropped additionalLocations: {r.get('location')!r}")
    check(r.get("pay") == ["$200,000 - $250,000"],
          f"the front-end path dropped the band: {r.get('pay')}")
    # A clean search that finds nothing is the evidence this closes on, and it is the
    # verdict that matched the observed 410 for R095439 on 2026-09-20.
    r = with_tenant((200, json.dumps({"jobPostings": []})))
    check(r.get("live") is False and "= closed" in (r.get("note") or ""),
          f"a clean tenant search finding nothing is a closure: {r.get('live')} / "
          f"{r.get('note')}")
    # ...and a search that did NOT run hands the question back to the status probe rather
    # than retiring the row. Same rule as workday_reslug and inbox-liveness: an absent id
    # is evidence only when the board was read cleanly.
    for label, res in (("transport failure", (0, "")),
                       ("tenant refused the query", (422, "")),
                       ("server error", (500, "")),
                       ("200 but unparseable", (200, "<html>WAF</html>")),
                       ("200 with no jobPostings key", (200, '{"total": 0}'))):
        r = with_tenant(res)
        check(r.get("live") is None,
              f"{label}: an unread tenant search must not close the row, got "
              f"live={r.get('live')} ({r.get('note')})")
    # The req was found but its detail record could not be read. Found on the board is
    # not the same as read, and bool(canApply) off an empty record answers CLOSED.
    for label, detail in (("a 403 on the detail path", (403, "")),
                          ("an empty nested record", (200, '{"jobPostingInfo": {}}'))):
        r = with_tenant((200, WD_HIT), detail=detail)
        check(r.get("live") is None,
              f"{label}: the posting was not read, so liveness is unknown, got "
              f"live={r.get('live')}")
    # A Workday-backed host with no requisition id in the URL has nothing to search for,
    # so it must fall through to the probe rather than invent a query.
    r = with_tenant((200, json.dumps({"jobPostings": []})),
                    url="https://careers.blizzard.com/global/en/search")
    check(r.get("ats") == "unsupported" and r.get("live") is None,
          f"no req id means no tenant query: {r.get('ats')} / {r.get('live')}")
    # Salesforce's front end lower-cases the id (/en/jobs/jr343369/), which the shared
    # pattern misses because the sweeps only ever read it off a CXS externalPath.
    check(bool(WD_REQ_ID.search("https://careers.salesforce.com/en/jobs/jr343369/")),
          "a lower-cased front-end req id must still be found")
    # The pattern is READ from the one sanctioned Python copy, not spelled again. This is
    # what keeps this consumer inside the equality assertion pipeline-audit.mjs already
    # makes between workday-sweep.py and req-id-core.mjs.
    _sweep = open(os.path.join(_HERE, "workday-sweep.py"), encoding="utf-8",
                  errors="replace").read()
    _m = re.search(r'REQ_ID = re\.compile\(\s*r"([^"]+)"\s*\)', _sweep)
    check(bool(_m) and WD_REQ_ID.pattern == _m.group(1),
          "the requisition pattern must be the one in workday-sweep.py, not a fifth copy")
    check("JR" in WD_REQ_ID.pattern and "WD" in WD_REQ_ID.pattern,
          f"the pattern read from workday-sweep.py looks wrong: {WD_REQ_ID.pattern!r}")
    return bad, total


def selftest():
    """Route each URL shape and pin the four verdict bugs, WITHOUT hitting the network."""
    import unittest.mock as mock
    global _PORTALS
    # Parse the test fixture, never the user's own file: see portals_path().
    os.environ["CAREER_OPS_PORTALS"] = os.path.join(ROOT, "test-fixtures", "portals.yml")
    _PORTALS = None
    bad = 0
    for url, want in ROUTE_CASES:
        with mock.patch.object(sys.modules[__name__], "fetch", lambda *a, **k: (0, "")), \
             mock.patch.object(sys.modules[__name__], "post", lambda *a, **k: (0, "")):
            got = resolve(url).get("ats")
        if got != want:
            bad += 1
            print(f"FAIL  {url[:74]}\n      routed to {got}, expected {want}")
    print(f"{bad} of {len(ROUTE_CASES)} routing cases failed" if bad
          else f"all {len(ROUTE_CASES)} routing cases pass")
    bbad, btotal = behaviour_cases()
    print(f"{bbad} of {btotal} behaviour cases failed" if bbad
          else f"all {btotal} behaviour cases pass")
    return bad + bbad


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(1 if selftest() else 0)
    if "--stdin" in sys.argv:
        items = json.load(sys.stdin)
    else:
        items = [{"url": a} for a in sys.argv[1:] if not a.startswith("--")]
    out = []
    for n, it in enumerate(items):
        if n:
            # Polite pacing. A few hundred reqs across shared ATS hosts will trip
            # rate limits without it, and a throttled run returns UNKNOWN for the
            # tail, which looks like data rather than an artefact.
            import time as _t
            _t.sleep(0.25)
        if n and n % 50 == 0:
            print(f"  ... {n}/{len(items)}", file=sys.stderr)
        # Belt and braces behind jload(). Every adapter now guards its own parse, but
        # this loop is the only place that knows the other items exist, and an escaping
        # exception here discarded a whole batch before one line printed: the cost of a
        # malformed response was never the bad req, it was the three hundred good ones
        # already resolved and thrown away with it. A req that raises is ONE unknown
        # req. It is reported as unknown rather than swallowed, because "not checked"
        # and "checked and fine" are different answers.
        try:
            r = resolve(it["url"])
        except Exception as e:
            r = dict(ats="error", live=None,
                     note=f"resolver raised {type(e).__name__}: {e}"[:220])
            print(f"  ! {it['url'][:70]} raised {type(e).__name__}; continuing",
                  file=sys.stderr)
        r.update({k: it.get(k) for k in ("role", "source", "score") if it.get(k) is not None})
        r["url"] = it["url"]
        out.append(r)
    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        for r in out:
            state = {True: "LIVE  ", False: "CLOSED", None: "UNKNWN"}[r.get("live")]
            print(f"[{state}] {(r.get('title') or r.get('role') or '')[:66]:66s} {r.get('location','')[:48]}")
            if r.get("pay"):
                print(f"          pay {r['pay']}")
            if r.get("note"):
                print(f"          {r['note']}")
