"""_candidate.py: who the board is about, read from config/profile.yml.

The board builders used to carry the candidate's name, CV filename and work history as
literals. That is candidate data in the System Layer, which the data contract forbids,
and it made every rendered page and every heuristic about one person. They read it from
here instead.

Two fields matter beyond the display name:

  full_name        -> page titles, and the CV filename slug (`Jane-Smith-*-CV.pdf`)
  past_employers   -> companies from the candidate's OWN history. Report prose mentions
                      them constantly ("seven years at Studio X"), so a builder matching
                      reports to employers, or telling the candidate's own salary figures
                      from a role's posted band, has to know which names are biography.

A missing profile is not an error: a fresh clone renders a neutral board. PyYAML is used
when installed and is not a dependency; the fallback reads the two fields directly.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Where configuration lives. CAREER_OPS_CONFIG_DIR overrides it, which is how the test
# suite runs against no configuration at all regardless of whose files are installed.
CONFIG_DIR = os.environ.get("CAREER_OPS_CONFIG_DIR") or os.path.join(ROOT, "config")
PROFILE = os.path.join(CONFIG_DIR, "profile.yml")
DEFAULT_NAME = "Career-Ops"


def _scalar(raw):
    """One YAML scalar as the fallback parser can read it: double-quoted, single-quoted
    (with '' as an escaped quote), or plain with any trailing comment removed. Quoting is
    what lets a value carry an apostrophe, a colon or a '#', so it has to be honoured."""
    raw = raw.strip()
    m = re.match(r'"((?:[^"\\]|\\.)*)"', raw)
    if m:
        return m.group(1).replace('\\"', '"').replace("\\\\", "\\")
    m = re.match(r"'((?:[^']|'')*)'", raw)
    if m:
        return m.group(1).replace("''", "'")
    return re.sub(r"\s+#.*$", "", raw).strip()


def _parse_minimal(text):
    """candidate.full_name and candidate.past_employers without a YAML library."""
    out = {"full_name": None, "past_employers": []}
    block = re.search(r"^candidate:\s*\n((?:[ \t]+.*\n?|\s*\n)*)", text, re.M)
    if not block:
        return out
    body = block.group(1)
    m = re.search(r"^[ \t]+full_name:[ \t]*(.+)$", body, re.M)
    if m:
        out["full_name"] = _scalar(m.group(1)) or None
    m = re.search(r"^([ \t]+)past_employers:\s*\n((?:\1[ \t]+-.*\n?)*)", body, re.M)
    if m:
        out["past_employers"] = [_scalar(x) for x in
                                 re.findall(r"^[ \t]+-[ \t]*(.+)$", m.group(2), re.M)]
    return out


def _prefs_minimal(text):
    """company_preference as (name, raw weight) pairs, without a YAML library."""
    block = re.search(r"^company_preference:[^\n]*\n((?:(?:[ \t]+[^\n]*)?\n)*)", text, re.M)
    pairs = []
    for line in (block.group(1).split("\n") if block else []):
        if re.match(r"^\s*#", line):
            continue
        # A key may be quoted ("Acme: Labs") or plain with an apostrophe (O'Reilly).
        m = re.match(r"""^\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#\n]+?)\s*:\s*([\d.]+)""", line)
        if m:
            pairs.append((_scalar(m.group(1)), m.group(2)))
    return pairs


def load_prefs(path=PROFILE):
    """`company_preference:` as [(lowercased company prefix, weight 0..1)], longest first.

    The same reading score-model.mjs loadPrefs() gives the block: one `Name: weight` per
    indented line, comments and tier blank lines skipped, weights outside 0..1 ignored,
    matched as a case-insensitive PREFIX so "Acme Games" is not shadowed by "Acme".
    """
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return []
    pairs = None
    try:
        import yaml  # optional
        block = (yaml.safe_load(text) or {}).get("company_preference")
        pairs = list(block.items()) if isinstance(block, dict) else []
    except ImportError:
        pass
    if pairs is None:
        pairs = _prefs_minimal(text)
    out = []
    for name, raw in pairs:
        try:
            v = float(raw)
        except (TypeError, ValueError):
            continue
        name = str(name).strip()
        if name and 0 <= v <= 1:
            out.append((name.lower(), v))
    return sorted(out, key=lambda p: -len(p[0]))


def pref_mark(company, prefs):
    """A board marker from the configured preference: a star for the top tier, a heart
    for the next, nothing otherwise. No preference configured means no markers."""
    c = (company or "").strip().lower()
    for name, v in prefs:
        if c.startswith(name):
            return "⭐" if v >= 0.8 else "♥" if v >= 0.5 else ""
    return ""


def load(path=PROFILE):
    """{full_name, first_name, file_slug, past_employers} for the configured candidate."""
    data = {"full_name": None, "past_employers": []}
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        text = ""
    if text:
        try:
            import yaml  # optional
            c = (yaml.safe_load(text) or {}).get("candidate") or {}
            data = {"full_name": c.get("full_name"),
                    "past_employers": list(c.get("past_employers") or [])}
        except Exception:
            data = _parse_minimal(text)
    name = (data.get("full_name") or "").strip() or DEFAULT_NAME
    first = name.split()[0] if name != DEFAULT_NAME else ""
    return {
        "full_name": name,
        "first_name": first,
        # "Jane Smith" -> "Jane-Smith", the prefix generate-pdf uses for CV files
        "file_slug": re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-"),
        "past_employers": [e for e in data.get("past_employers", []) if e],
        "configured": name != DEFAULT_NAME,
    }


def _selftest():
    import tempfile
    bad = 0
    sample = ('candidate:\n  full_name: "Jane Smith"\n  email: "j@example.com"\n'
              '  past_employers:\n    - "Studio One"\n    - Studio Two  # comment\n'
              'target_roles:\n  primary: []\n')
    for label, parser in (("minimal", lambda t: _parse_minimal(t)),):
        got = parser(sample)
        if got["full_name"] != "Jane Smith" or got["past_employers"] != ["Studio One",
                                                                           "Studio Two"]:
            bad += 1
            print(f"  FAIL {label} parser: {got}")
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "profile.yml")
        open(p, "w", encoding="utf-8").write(sample)
        c = load(p)
        if (c["file_slug"], c["first_name"], c["configured"]) != ("Jane-Smith", "Jane", True):
            bad += 1
            print(f"  FAIL load(): {c}")
        # A fresh clone has no profile, and that must render, not crash.
        c = load(os.path.join(d, "absent.yml"))
        if c["full_name"] != DEFAULT_NAME or c["configured"] or c["past_employers"]:
            bad += 1
            print(f"  FAIL missing profile must yield the neutral default: {c}")
        # Board markers come from company_preference, never from a list in code.
        open(p, "w", encoding="utf-8").write(
            sample + "company_preference:\n  # top tier\n  Acme: 1.0\n  Acme Games: 0.6\n\n"
            "  Globex: 0.5\n  Initech: 0.2\n  Bogus: 7\nother_key: 1\n")
        prefs = load_prefs(p)
        got = [pref_mark(x, prefs) for x in
               ("Acme Corp", "acme games studio", "Globex", "Initech", "Bogus", "Nobody")]
        if got != ["⭐", "♥", "♥", "", "", ""]:
            bad += 1
            print(f"  FAIL preference markers: {got}")
        if load_prefs(os.path.join(d, "absent.yml")) != []:
            bad += 1
            print("  FAIL missing profile must yield no preferences")
    # Quoting carries apostrophes, colons and '#'. The fallback parser must honour it,
    # because PyYAML is optional and a lost name or company fails silently.
    hostile = ('candidate:\n  full_name: "Zo\u00eb O\'Brien: Senior # Engineer"\n'
               '  past_employers:\n    - McDonald\'s Games\n    - "Studio: Two"\n'
               'company_preference:\n  O\'Reilly Media: 1\n  "Acme: Labs": 0.6\n')
    got = _parse_minimal(hostile)
    if (got["full_name"] != "Zo\u00eb O'Brien: Senior # Engineer"
            or got["past_employers"] != ["McDonald's Games", "Studio: Two"]):
        bad += 1
        print(f"  FAIL minimal parser on quoted scalars: {got}")
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "profile.yml")
        open(p, "w", encoding="utf-8").write(hostile)
        prefs = dict(load_prefs(p))
        if prefs != {"o'reilly media": 1.0, "acme: labs": 0.6}:
            bad += 1
            print(f"  FAIL company names with apostrophes and colons: {prefs}")
    # The same through the no-PyYAML reader, which load_prefs only reaches without PyYAML.
    minimal = {n: float(v) for n, v in _prefs_minimal(hostile)}
    if minimal != {"O'Reilly Media": 1.0, "Acme: Labs": 0.6}:
        bad += 1
        print(f"  FAIL minimal prefs reader: {minimal}")
    print(f"_candidate selftest: 8 checks, {bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    import sys
    sys.exit(_selftest() if "--selftest" in sys.argv else print(load()) or 0)
