# -*- coding: utf-8 -*-
"""PostToolUse hook (Bash|PowerShell matcher): rebuild the local job-board HTML pages
whenever the data they render has actually changed. Reads the hook JSON from stdin;
silent no-op otherwise.

The matcher covers PowerShell as well as Bash: PowerShell is the primary shell on
this machine, so a Bash-only matcher meant the hook never fired for real scans and
the boards were only ever rebuilt by hand (found 2026-08-12). Both tools put the
command string in tool_input.command, so one script serves both.

WHY THIS IS NOT A LIST OF SCRIPT NAMES. It used to fire only on `node scan.mjs` or
`node merge-tracker.mjs`, which is a list that silently falls behind the code. Those
two are not the only writers of data/applications.md: apply-model.mjs --apply,
score-audit.mjs --fix, dedup-tracker.mjs and normalize-statuses.mjs all rewrite it,
and rule 2 of the pipeline contract explicitly permits hand-editing it to update a
status. Every one of those left the pages stale while their timestamps claimed
otherwise, which is the failure this repo keeps paying for: a confident wrong answer
rather than an error. So the gate is now the DATA, not the command. Anything that
changes what the builders read causes a rebuild on the next shell command.

The one thing a fingerprint cannot see is time: apply links rot while a posting stays
open (NVIDIA reposts change the URL suffix), so refresh-job-links.mjs still needs a
periodic nudge. That keeps the old scan/merge match, now purely as the refresh
trigger.

FOUR WAYS THIS SILENTLY CERTIFIES A STALE BOARD, all of them found by review rather
than by the pages looking wrong, and all guarded here:

1. A fingerprint narrower than the builders' real inputs. The dashboard also reads
   data/comp-basis.json, its own HTML template, the output/*prep|kit|packet|session*.md
   packets and the CV PDFs on disk; the ranked board reads a second template. Fingerprint
   only the tracker and reports, and generating a prep packet leaves the board stale for
   good. INPUTS below is the whole list.
2. Data that moves DURING the build. The builders run one after another against live
   files, so a tracker rewrite landing between the first and the last means the pages
   disagree with each other, and recording the post-build fingerprint would bless that
   and guarantee no retry. So the fingerprint is snapshotted once the inputs have settled
   and recorded only if it is UNCHANGED at the end. See should_record().
3. Two hooks at once. Claude Code runs PostToolUse hooks concurrently for parallel tool
   calls, and two rebuilds interleaving their writes into output/*.html corrupts both.
   One lock, and a hook that cannot take it does nothing and records nothing, so the next
   command retries.
4. A stat key instead of the bytes. See INPUTS.

BUILDER ORDER IS LOAD-BEARING. build-home.py scrapes its headline counts back out of
output/prospects-dashboard.html, so home must run AFTER dashboard or index.html reports
the PREVIOUS build's numbers forever. The hook had them backwards while
.claude/commands/job-query.md documented the correct order, so the home page's
"N actionable 4.0+ leads" was always one generation behind.

  python scripts/hooks/rebuild_boards_hook.py --selftest
"""
import errno
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time

# Fires refresh-job-links. NOT the rebuild gate: see the module docstring.
REFRESH_CMD = re.compile(r'node\s+\S*(scan\.mjs|merge-tracker\.mjs)')

# Everything is hashed by CONTENT, never by (size, mtime). A stat key is blind to a
# same-size rewrite inside one filesystem timestamp tick, and measured on this NTFS
# volume 137 of 200 back-to-back same-size rewrites produced an IDENTICAL
# (size, st_mtime_ns) key. That is not a corner case here: score-audit.mjs --fix turning
# a report's 3.7 into a 3.8 is a same-size rewrite, and so is refresh-job-links.mjs
# swapping a same-length URL suffix. Content costs about 52ms for the whole tree against
# 23ms for a stat sweep, dominated by opening ~570 files rather than by hashing, which is
# noise beside a Windows process spawn. Cheap and blind is the wrong trade in this repo.
#
# Globs, not fixed names, wherever the builders themselves glob, so a new packet counts.
INPUTS = (
    "data/applications.md",       # all three builders
    "data/scan-history.tsv",      # build-home
    "data/comp-basis.json",       # build-dashboard; regenerated BEFORE the snapshot
    "scripts/_dashboard_template.html",
    "scripts/_all_ranked_template.html",
    "reports/*.md",
    "output/*prep*.md",
    "output/*kit*.md",
    "output/*packet*.md",
    "output/*session*.md",
    # The builders read configuration too: the candidate's name and preferred companies
    # (profile.yml), the lane buckets and buttons (lane-vocab.json), the commute tier
    # (location.json), and the presets each falls back to when a config is absent.
    # Editing any of them changes a rendered page, so any of them must rebuild it.
    "config/profile.yml",
    "config/lane-vocab.json",
    "config/location.json",
    "presets/lanes/*.json",
    "presets/locations/*.json",
    # And the code that turns all of that into a page: the builders and the loaders they
    # import. A change to how a lane or a tier is derived changes the page as surely as a
    # change to the data does, and a fingerprint of data alone certifies the old page.
    "scripts/build-*.py",
    "scripts/_lane.py",
    "scripts/_location.py",
    "scripts/_candidate.py",
)
# The dashboard only ever uses these by BASENAME, to resolve a CV mentioned in a packet
# to a real file. Their bytes are not an input, and hashing PDFs to learn nothing would
# be the most expensive part of the sweep.
# Any "<Name>-<variant>-CV.pdf": a superset of what the dashboard resolves, which is
# the safe direction for a fingerprint, since extra inputs only cost a rebuild.
INPUTS_NAME_ONLY = ("output/*-CV.pdf",)

STATE = "data/board-build-state.json"
LOCK = "data/.board-build.lock"
LOCK_STALE_S = 180

# dashboard, then ranked, then home. See BUILDER ORDER in the module docstring: home
# reads the dashboard's own output, so putting it first publishes stale counts.
BUILDERS = ("scripts/build-dashboard.py", "scripts/build-all-ranked.py",
            "scripts/build-home.py")

# The outer hook budget in .claude/settings.json is 90s. These have to SUM to less than
# that, or the hook is killed mid-build and can leave a truncated page behind. Measured
# 2026-08-26: each builder runs in 0.1 to 0.2s and comp-basis in 0.2s, so this is roughly
# fortyfold headroom and still fits: 40 + 15 + 3x8 = 79.
T_REFRESH, T_COMP, T_BUILD = 40, 15, 8


def _base(root, pat):
    """Where a pattern lives. config/* follows CAREER_OPS_CONFIG_DIR exactly as every
    builder's loader does, or a user who sets it edits files the hook never watches."""
    cfg = os.environ.get("CAREER_OPS_CONFIG_DIR")
    if cfg and pat.startswith("config/"):
        return os.path.join(cfg, pat[len("config/"):])
    return os.path.join(root, pat)


def _expand(root, patterns):
    """Absolute paths for `patterns`, deduped and sorted. The globs overlap (a file can
    be both a *prep* and a *packet*), and hashing one twice would still be stable, but
    deduping keeps the digest independent of the pattern order."""
    out = set()
    for pat in patterns:
        if glob.has_magic(pat):
            out.update(glob.glob(_base(root, pat)))
        else:
            out.add(_base(root, pat))
    return sorted(out)


def _label(p, root):
    """The name hashed beside a file's bytes. A config dir on another drive has no path
    relative to the root on Windows, so it falls back to the absolute path."""
    try:
        return os.path.relpath(p, root).replace("\\", "/")
    except ValueError:
        return p.replace("\\", "/")


def fingerprint(root):
    """A digest of everything the three builders read.

    Must be deterministic across calls on an unchanged tree, or the hook rebuilds the
    whole board on every shell command. Nothing a builder WRITES may appear here: the
    pages are output/*.html and the packet globs are *.md, so they do not overlap.
    """
    h = hashlib.sha1()
    for p in _expand(root, INPUTS):
        h.update(_label(p, root).encode("utf-8"))
        try:
            with open(p, "rb", buffering=0) as fh:
                h.update(fh.readall())
        except OSError:
            # Unreadable is its own state, and a different one from empty, so it has to
            # move the digest rather than be skipped.
            h.update(b"\0unreadable")
    for p in _expand(root, INPUTS_NAME_ONLY):
        h.update(os.path.basename(p).encode("utf-8"))
    return h.hexdigest()


def should_record(built, snap, after):
    """Record the fingerprint only when the build is complete AND the inputs held still.

    A partial build must not be recorded or the next command would not retry it. Neither
    must a build whose inputs moved underneath it: the builders run sequentially, so a
    tracker rewrite landing mid-run leaves the three pages disagreeing, and blessing that
    fingerprint is a promise the board is current when it provably is not.
    """
    return len(built) == len(BUILDERS) and snap == after


def acquire_lock(root):
    """O_EXCL lock so two concurrent hooks cannot interleave writes into output/*.html.
    Returns the path on success, None if another hook holds it."""
    p = os.path.join(root, LOCK)
    try:
        os.close(os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        return p
    except OSError as e:
        if e.errno != errno.EEXIST:
            return None
    # A hook killed by the outer 90s timeout would otherwise wedge every later rebuild,
    # so a lock older than the whole budget is treated as abandoned.
    try:
        if time.time() - os.path.getmtime(p) > LOCK_STALE_S:
            os.remove(p)
            os.close(os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return p
    except OSError:
        pass
    return None


def release_lock(p):
    try:
        os.remove(p)
    except OSError:
        pass


def read_state(root):
    try:
        with open(os.path.join(root, STATE), encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("fingerprint")
    except Exception:
        return None


def write_state(root, fp):
    """Atomic: a torn state file reads back as None, which forces a rebuild on every
    later command until something repairs it."""
    p = os.path.join(root, STATE)
    tmp = p + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            json.dump({"fingerprint": fp}, fh)
        os.replace(tmp, p)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _run(root, argv, timeout):
    try:
        return subprocess.run(argv, cwd=root, capture_output=True, timeout=timeout,
                              text=True, encoding="utf-8", errors="replace")
    except Exception:
        return None


def settle_inputs(root, refresh):
    """Bring every generated input up to date BEFORE the snapshot is taken.

    Both of these WRITE things the fingerprint reads, so running them after the snapshot
    would make the build look as though its inputs had moved, and nothing would ever be
    recorded. Returns the refresh summary line, if there is one worth showing.
    """
    links = ""
    if refresh:
        # Cached with a TTL and time-budgeted; exits 0 even on network failure and must
        # never block a build.
        r = _run(root, ["node", os.path.join(root, "refresh-job-links.mjs"), "--quiet"],
                 T_REFRESH)
        tail = ((r.stdout if r else "") or "").strip().splitlines()
        if tail and not tail[-1].startswith("links: 0 fixed, 0 newly closed"):
            links = tail[-1]
    # The base-vs-total sidecar, so the board never shows a bare figure that could be
    # read as total comp when it is base.
    _run(root, ["node", os.path.join(root, "comp-basis.mjs"), "--quiet"], T_COMP)
    return links


def build(root):
    built = []
    for s in BUILDERS:
        r = _run(root, [sys.executable, os.path.join(root, s)], T_BUILD)
        if r is not None and r.returncode == 0:
            built.append(os.path.basename(s).replace("build-", "").replace(".py", ""))
    return built


def _selftest():
    import shutil
    import tempfile
    bad = 0

    ran = []

    def check(cond, msg):
        ran.append(1)
        if not cond:
            print("  FAIL " + msg)
        return 0 if cond else 1

    CMDS = [
        ("node scan.mjs", True),
        ("node ./merge-tracker.mjs", True),
        ("node C:/Users/jane/repos/career-ops-techart/merge-tracker.mjs", True),
        ("cd /d/x && node scan.mjs --quiet", True),
        # A mention is not a run. This is why the pattern is anchored on `node`.
        ("grep -n foo scan.mjs", False),
        ("cat merge-tracker.mjs", False),
        # These write the tracker and must NOT be the refresh trigger, but they DO have
        # to reach the rebuild through the fingerprint (asserted below).
        ("node score-audit.mjs --fix", False),
        ("node apply-model.mjs --apply", False),
    ]
    for cmd, want in CMDS:
        bad += check(bool(REFRESH_CMD.search(cmd)) == want,
                     "REFRESH_CMD(%r) = %s, want %s" % (cmd, not want, want))

    # build-home.py scrapes output/prospects-dashboard.html for its headline counts, so
    # running it first publishes the PREVIOUS build's numbers on index.html. The hook
    # shipped with exactly that order while job-query.md documented the right one.
    bad += check(BUILDERS.index("scripts/build-home.py")
                 > BUILDERS.index("scripts/build-dashboard.py"),
                 "build-home.py must run AFTER build-dashboard.py; it reads that page")

    # The whole hook gets 90s from .claude/settings.json. If the internal budget can
    # exceed it the hook is killed mid-build and can leave a truncated page behind.
    bad += check(T_REFRESH + T_COMP + len(BUILDERS) * T_BUILD < 90,
                 "internal timeout budget (%ds) exceeds the 90s hook budget"
                 % (T_REFRESH + T_COMP + len(BUILDERS) * T_BUILD))

    # Nothing a builder WRITES may be an input, or the hook re-triggers itself forever.
    bad += check(not any(p.endswith(".html") and p.startswith("output/") for p in INPUTS),
                 "an output/*.html page is inside INPUTS; the hook would re-trigger itself")

    # REMOVAL is the half a derived per-entry case cannot see: an entry deleted from INPUTS
    # is simply never iterated. So derive what must be there from the builders themselves:
    # every scripts/_*.py loader a builder imports, and the presets those loaders fall back
    # to when no config exists.
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for b in BUILDERS:
        try:
            src = open(os.path.join(os.path.dirname(here), b), encoding="utf-8").read()
        except OSError:
            continue
        for mod in sorted(set(re.findall(r"^\s*import\s+([_\w, ]+)", src, re.M))):
            for name in (m.strip() for m in mod.split(",")):
                if name.startswith("_"):
                    bad += check("scripts/%s.py" % name in INPUTS,
                                 "%s imports %s but scripts/%s.py is not in INPUTS"
                                 % (b, name, name))
    for pat in ("presets/lanes/*.json", "presets/locations/*.json", "config/profile.yml",
                "config/lane-vocab.json", "config/location.json"):
        bad += check(pat in INPUTS, "%s is read by the builders' loaders and is not in INPUTS" % pat)
    # And every path a builder names itself, in a glob.glob() or open() call: each must be
    # covered by some INPUTS (or name-only) pattern. "%03d" and "%s" become a sample.
    #
    # A regex matching only a QUOTED first argument used to be the whole scan, and it was
    # blind by construction to anything else: `open(f, ...)` inside a loop, `open(rp, ...)`
    # off a resolved path, `open(TPL_PATH, ...)` off a variable, `open(os.path.join(...))`
    # inline. All four already exist in the builders today, reading files that ARE in
    # INPUTS, and every one of them was invisible to the old scan; a FIFTH one reading
    # something NOT in INPUTS would have been just as invisible. Walking the AST instead
    # sees every open()/glob.glob() call regardless of what its argument looks like, so a
    # literal is checked against INPUTS as before and anything else must be named,
    # verbatim, on the allow-list below, or the scan fails loudly instead of saying nothing.
    import ast
    import fnmatch

    # A "%s"/"%03d"-templated string is still effectively a literal path for this check;
    # the sample substitution below already exists to read it. Only the CONSTANT half (the
    # left side of the %) is a path, so that is what gets checked against INPUTS.
    def _first_arg(node):
        """('literal', path) for a plain or %-formatted string constant, else ('expr', src)."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return "literal", node.value
        if (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod)
                and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str)):
            return "literal", node.left.value
        return "expr", ast.unparse(node)

    # Pin the classifier itself, since it is the part that decides whether a call gets
    # checked against INPUTS or against the allow-list, and a mistake here would silently
    # move a real read from one bucket to the other.
    def _kind_of(src):
        return _first_arg(ast.parse(src, mode="eval").body)
    bad += check(_kind_of("'reports/%03d-*.md'") == ("literal", "reports/%03d-*.md"),
                 "a plain string constant must classify as a literal path")
    bad += check(_kind_of("'reports/%03d-*.md' % n") == ("literal", "reports/%03d-*.md"),
                 "a %-formatted string keeps its constant half as the literal path, "
                 "since the sample substitution already reads %03d and %s")
    bad += check(_kind_of("rp")[0] == "expr", "a bare name must classify as an expression")
    bad += check(_kind_of("os.path.join('a', 'b')")[0] == "expr",
                 "a call, even one built from string literals, is not itself a literal")

    # Reads that are not a plain path: a loop or resolved variable already scoped by a
    # literal glob just above it, or a template path assembled with os.path.join(). Each
    # entry names exactly what a human reading the diff would see, so a rewritten
    # expression (even one that reads the same file) falls through to the FAIL below
    # exactly like a brand new read would, which is the point: nothing here is allowed to
    # go stale quietly.
    NONLITERAL_ALLOW = {
        ("scripts/build-dashboard.py", "f"):
            "loop variable from the glob.glob() calls just above it, over output/*prep*.md, "
            "*kit*.md, *packet*.md and *session*.md, all in INPUTS",
        ("scripts/build-dashboard.py", "rp"):
            "either the tracker's own report link (data/applications.md, in INPUTS) or a "
            "glob over reports/%03d-*.md (reports/*.md is in INPUTS)",
        ("scripts/build-dashboard.py", "TPL_PATH"):
            "os.path.join('scripts', '_dashboard_template.html'), in INPUTS by name",
        ("scripts/build-all-ranked.py", "os.path.join('scripts', '_all_ranked_template.html')"):
            "the ranked-board template, in INPUTS by name",
    }

    read_any, literals = False, 0
    for b in BUILDERS:
        try:
            src = open(os.path.join(os.path.dirname(here), b), encoding="utf-8").read()
        except OSError:
            continue
        read_any = True
        try:
            tree = ast.parse(src)
        except SyntaxError as e:
            bad += check(False, "%s could not be parsed to scan its reads: %s" % (b, e))
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            is_open = isinstance(node.func, ast.Name) and node.func.id == "open"
            is_glob = (isinstance(node.func, ast.Attribute) and node.func.attr == "glob"
                      and isinstance(node.func.value, ast.Name) and node.func.value.id == "glob")
            if not (is_open or is_glob):
                continue
            kind, val = _first_arg(node.args[0])
            if kind == "literal":
                if val.startswith("output/") and val.endswith(".html"):
                    continue   # what a builder WRITES
                literals += 1
                sample = val.replace("%03d", "001").replace("%s", "Name").replace("*", "zz")
                bad += check(any(fnmatch.fnmatch(sample, p) for p in INPUTS + INPUTS_NAME_ONLY),
                             "%s:%d reads %r and no INPUTS pattern covers it"
                             % (b, node.lineno, val))
            else:
                literals += 1
                bad += check((b, val) in NONLITERAL_ALLOW,
                             "%s:%d reads a non-literal argument (%s) that is not on the "
                             "explicit allow-list, so this scan cannot tell what it covers"
                             % (b, node.lineno, val))
    bad += check(read_any, "no builder source could be read, so none of the checks above ran")
    # A scan that matches nothing passes everything. The three builders name at least ten
    # data paths today (tracker, reports, comp-basis, scan history, the packet globs).
    bad += check(literals >= 10, "the builder-literal scan found only %d paths; the pattern no "
                 "longer reads the builders, so the coverage check above proved nothing" % literals)

    # should_record is the guard against certifying a board the data outran.
    bad += check(should_record(["a", "b", "c"], "X", "X"), "a clean build must record")
    bad += check(not should_record(["a", "b"], "X", "X"),
                 "a PARTIAL build must not record, or the next command will not retry")
    bad += check(not should_record(["a", "b", "c"], "X", "Y"),
                 "inputs that moved DURING the build must not be recorded; the pages "
                 "disagree with each other and the board would be certified stale")

    root = tempfile.mkdtemp(prefix="boardhook-")
    # The cases below write config/* under the temp root; an inherited config dir (the test
    # suite sets one) would send the hook to read somewhere else. Restored in finally.
    saved_cfg = os.environ.pop("CAREER_OPS_CONFIG_DIR", None)
    try:
        for d in ("data", "reports", "output", "scripts", "config",
                  os.path.join("presets", "lanes"), os.path.join("presets", "locations")):
            os.makedirs(os.path.join(root, d))

        def put(rel, body):
            with open(os.path.join(root, rel), "w", encoding="utf-8") as fh:
                fh.write(body)

        put("data/applications.md", "| 1 | Acme | 4.0/5 |\n")
        put("data/scan-history.tsv", "url\tfirst_seen\n")
        put("data/comp-basis.json", '{"1":{"basis":"base"}}')
        put("scripts/_dashboard_template.html", "<html>__DATA__</html>")
        put("scripts/_all_ranked_template.html", "<html>__DATA__</html>")
        put("reports/001-acme-2026-08-01.md", "**URL:** https://example.com\n")

        base = fingerprint(root)

        # THE ANTI-LOOP PROPERTY. An unchanged tree must fingerprint identically, or
        # every shell command triggers a full rebuild.
        bad += check(fingerprint(root) == base,
                     "fingerprint is not stable across two calls on an unchanged tree; "
                     "the boards would rebuild on every shell command")

        # A page the builders WRITE must not perturb the digest.
        put("output/prospects-dashboard.html", "<html>rebuilt</html>")
        bad += check(fingerprint(root) == base,
                     "a rebuilt output/*.html page changed the fingerprint; the hook "
                     "would re-trigger itself forever")

        # Every input the three builders read, one at a time. Each of these was outside
        # the fingerprint at first, and each would have left the board stale for good.
        for rel, body, why in (
                ("data/applications.md", "| 1 | Acme | 3.7/5 |\n",
                 "a tracker rewrite (score-audit --fix) would go unseen"),
                ("data/scan-history.tsv", "url\tfirst_seen\nhttps://x\t2026-08-26\n",
                 "a new scan row would never reach the home page"),
                ("data/comp-basis.json", '{"1":{"basis":"total"}}',
                 "the dashboard reads this sidecar for the base-vs-total label"),
                ("scripts/_dashboard_template.html", "<html>v2 __DATA__</html>",
                 "editing the dashboard template would never take effect"),
                ("scripts/_all_ranked_template.html", "<html>v2 __DATA__</html>",
                 "editing the ranked template would never take effect"),
                ("config/profile.yml", "candidate:\n  full_name: Jane Smith\n",
                 "renaming the candidate would never reach the page titles"),
                ("config/lane-vocab.json", '{"_board": {"lanes": []}}',
                 "changing the lane buckets would never reach the boards"),
                ("config/location.json", '{"commute": {"label": "Austin"}}',
                 "changing the commute area would never re-tier the dashboard"),
                ("presets/lanes/general.json", '{"_board": {"lanes": []}}',
                 "an unconfigured install renders from the preset, so it is an input"),
                ("scripts/build-dashboard.py", "# builder v2\n",
                 "a change to a builder would leave its old page certified"),
                ("scripts/_location.py", "# loader v2\n",
                 "a change to how a tier is derived would never re-tier the board"),
                ("output/acme-prep.md", "prep packet\n",
                 "creating a prep packet is what marks a row prepped on the dashboard"),
                ("reports/002-beta-2026-08-02.md", "**URL:** https://example.com/2\n",
                 "a new report would never appear"),
        ):
            prev = fingerprint(root)
            put(rel, body)
            bad += check(fingerprint(root) != prev, "%s is not in the fingerprint: %s"
                         % (rel, why))

        # Every INPUTS entry, derived rather than listed: one synthetic file per pattern
        # must move the digest, so an entry added or dropped later cannot go unguarded.
        # A hand-written list above had no case for three of the entries.
        for pat in INPUTS:
            rel = pat.replace("*", "zz-selftest")
            path = os.path.join(root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            had = open(path, "rb").read() if os.path.exists(path) else None
            prev = fingerprint(root)
            put(rel, "synthetic %s\n" % rel)
            bad += check(fingerprint(root) != prev,
                         "INPUTS entry %r does not reach the fingerprint" % pat)
            # Put the tree back, so the cases below see the files they were written for.
            if had is None:
                os.remove(path)
            else:
                with open(path, "wb") as fh:
                    fh.write(had)

        # CAREER_OPS_CONFIG_DIR moves config/* for the builders, so it moves it here too.
        alt = tempfile.mkdtemp(prefix="boardhook-cfg-")
        try:
            os.environ["CAREER_OPS_CONFIG_DIR"] = alt
            prev = fingerprint(root)
            with open(os.path.join(alt, "location.json"), "w", encoding="utf-8") as fh:
                fh.write('{"commute": {"label": "Elsewhere"}}')
            bad += check(fingerprint(root) != prev,
                         "a config file under CAREER_OPS_CONFIG_DIR is not watched")
        finally:
            os.environ.pop("CAREER_OPS_CONFIG_DIR", None)
            shutil.rmtree(alt, ignore_errors=True)

        # The CV PDFs count by NAME only: the dashboard resolves a mention to a real file
        # and never opens it, so hashing PDFs would cost the most and learn the least.
        with open(os.path.join(root, "output", "Jane-Smith-AI-CV.pdf"), "wb") as fh:
            fh.write(b"%PDF-1.4 first")
        named = fingerprint(root)
        with open(os.path.join(root, "output", "Jane-Smith-AI-CV.pdf"), "wb") as fh:
            fh.write(b"%PDF-1.4 second draft, same name")
        bad += check(fingerprint(root) == named,
                     "a CV PDF's BYTES moved the fingerprint; only its name is an input")
        with open(os.path.join(root, "output", "Jane-Smith-TA-CV.pdf"), "wb") as fh:
            fh.write(b"%PDF-1.4")
        bad += check(fingerprint(root) != named, "a NEW CV PDF must move the fingerprint")

        # THE SAME-SIZE REWRITE. A (size, mtime) key cannot see a rewrite that keeps the
        # length and lands inside one filesystem tick, and 137 of 200 such rewrites
        # collided when measured here. score-audit.mjs --fix turning a report's 3.7 into
        # a 3.8 is exactly that shape. The collision is FORCED with utime rather than
        # raced for: written back to back the two writes share a tick only about five
        # times in six, and a guard that flaky is not a guard.
        rp = os.path.join(root, "reports", "001-acme-2026-08-01.md")
        put("reports/001-acme-2026-08-01.md", "**final:** 3.7\n")
        st0 = os.stat(rp)
        before_same_size = fingerprint(root)
        put("reports/001-acme-2026-08-01.md", "**final:** 3.8\n")
        os.utime(rp, ns=(st0.st_atime_ns, st0.st_mtime_ns))
        bad += check(fingerprint(root) != before_same_size,
                     "a same-size report rewrite did not move the fingerprint; "
                     "score-audit --fix would leave the board stale")

        # A byte-identical rewrite should NOT cost a rebuild.
        settled = fingerprint(root)
        put("data/applications.md", "| 1 | Acme | 3.7/5 |\n")
        put("data/applications.md", "| 1 | Acme | 3.7/5 |\n")
        bad += check(fingerprint(root) == settled,
                     "a byte-identical tracker rewrite changed the fingerprint")

        # State: round trip, then the two ways it can be absent.
        write_state(root, settled)
        bad += check(read_state(root) == settled,
                     "the fingerprint did not survive a state-file round trip")
        put(STATE, "{ this is not json")
        bad += check(read_state(root) is None,
                     "a torn state file must read as None and force a rebuild")
        os.remove(os.path.join(root, STATE))
        bad += check(read_state(root) is None,
                     "a missing state file must read as None, not a stale value")

        # The lock is what keeps two concurrent hooks from interleaving their writes.
        h1 = acquire_lock(root)
        bad += check(h1 is not None, "the first hook must be able to take the lock")
        bad += check(acquire_lock(root) is None,
                     "a second concurrent hook took the lock; two rebuilds would "
                     "interleave their writes into output/*.html")
        release_lock(h1)
        h2 = acquire_lock(root)
        bad += check(h2 is not None, "the lock was not released")
        # A hook killed by the outer timeout must not wedge every later rebuild.
        old = time.time() - (LOCK_STALE_S + 60)
        os.utime(os.path.join(root, LOCK), (old, old))
        bad += check(acquire_lock(root) is not None,
                     "an abandoned lock is never stolen; one killed hook would block "
                     "every rebuild from then on")
    finally:
        shutil.rmtree(root, ignore_errors=True)
        if saved_cfg is not None:
            os.environ["CAREER_OPS_CONFIG_DIR"] = saved_cfg

    # Counted, not written down: a literal here stayed at 26 while checks were added.
    print("rebuild-boards-hook selftest: %d refresh-trigger cases + %d structural and "
          "fingerprint properties, %d failure(s)" % (len(CMDS), len(ran) - len(CMDS), bad))
    return 1 if bad else 0


def main():
    if "--selftest" in sys.argv[1:]:
        return _selftest()

    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    cmd = ((data.get("tool_input") or {}).get("command") or "")
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    # Before onboarding there is no tracker, so there is no board to build. Running the
    # builders then would fail on every shell command of a fresh clone.
    if not os.path.exists(os.path.join(root, "data", "applications.md")):
        return 0

    refresh = bool(REFRESH_CMD.search(cmd))
    if not refresh and fingerprint(root) == read_state(root):
        return 0

    # Another hook is already rebuilding. Do nothing and record nothing, so whatever this
    # command changed is still pending and the next one picks it up.
    lock = acquire_lock(root)
    if lock is None:
        return 0
    try:
        links = settle_inputs(root, refresh)
        snap = fingerprint(root)          # after the generated inputs have settled
        built = build(root)
        after = fingerprint(root)
    finally:
        release_lock(lock)

    if should_record(built, snap, after):
        write_state(root, after)
        msg = "📊 Job boards auto-rebuilt: " + ", ".join(built)
        if links:
            msg += "  |  🔗 " + links
        print(json.dumps({"systemMessage": msg, "suppressOutput": True}))
    elif len(built) != len(BUILDERS):
        # Nothing recorded, so the next command retries. Silence here would let the board
        # drift with nothing ever saying so.
        print(json.dumps({
            "systemMessage": "⚠️ Job-board rebuild incomplete (%d of %d built: %s). The "
                             "pages are stale; run the builders by hand to see the error."
                             % (len(built), len(BUILDERS), ", ".join(built) or "none"),
            "suppressOutput": True}))
    else:
        # Built cleanly, but the tracker or a report moved while it ran, so the three
        # pages may disagree. Not recorded, so the next command rebuilds from a settled
        # tree. Not worth a warning: it is self-correcting and expected during a batch.
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
