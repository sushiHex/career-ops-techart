# -*- coding: utf-8 -*-
"""Build output/all-companies-ranked.html — COMPANIES ranked by best-role fit.
One row per company (collapsed from data/applications.md), ranked by its highest-scoring role.
Run:  python scripts/build-all-ranked.py
"""
import re, os, glob, json, datetime, sys, html as _html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _candidate  # noqa: E402  (the page title comes from config/profile.yml)
import _lane  # noqa: E402  (lane buckets come from config/lane-vocab.json)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

def lane(role):
    # The same lane buckets as the dashboard: the preset's `_board` section.
    return _lane.board_lane(role)[0]

def lane_buttons(active_first=False):
    """Filter buttons for the lanes the preset marks with a `button` label, in order."""
    seen, out = set(), []
    for ln in _lane.section("_board").get("lanes", []):
        if ln.get("button") and ln["name"] not in seen:
            seen.add(ln["name"])
            out.append('<span class="btn" data-lane="%s">%s</span>'
                       % (_html.escape(ln["name"], quote=True), _html.escape(ln["button"])))
    return "\n".join(out)

_PREFS = _candidate.load_prefs()

def star(co):
    # Marker from config/profile.yml company_preference; no list of employers in code.
    return _candidate.pref_mark(co, _PREFS)

ACTIVE = ('Evaluated', 'Applied', 'Responded', 'Interview', 'Offer')
SP = {'Offer': 0, 'Interview': 1, 'Responded': 2, 'Applied': 3, 'Evaluated': 4, 'Rejected': 5, 'Discarded': 6, 'SKIP': 7}

# normalize company names so "Google (Google Cloud)" and "Google" collapse together
def canon(co):
    base = re.split(r'[(/—\-]| - ', co)[0].strip()
    return base or co

groups = {}
# A fresh install has no tracker until the first evaluation is written; say so rather
# than end in a traceback.
if not os.path.exists('data/applications.md'):
    print('NOT BUILT: data/applications.md does not exist yet (evaluate an offer first)')
    sys.exit(0)
for ln in open('data/applications.md', encoding='utf-8'):
    if not ln.strip().startswith('|'):
        continue
    c = [x.strip() for x in ln.strip().strip('|').split('|')]
    if len(c) < 9 or not re.match(r'^\d+$', c[0]):
        continue
    m = re.match(r'([0-9.]+)', c[4]); sc = float(m.group(1)) if m else 0.0
    num, co, role, status, note = c[0], c[2], c[3], c[5], c[8]
    status = re.sub(r'[*`]', '', status).strip()
    # Follow the row's own report link (col 7), not glob-by-number: filenames drifted
    # off-by-one from row numbers, so glob matched the wrong job's report for ~49 rows.
    lm = re.search(r'\]\(([^)]*reports/[^)]+)\)', c[7])
    report = ''
    if lm:
        cand = re.sub(r'^\.\./', '', lm.group(1))
        report = ('../reports/' + os.path.basename(cand)) if os.path.isfile(cand) else ''
    if not report:
        g0 = sorted(glob.glob('reports/%03d-*.md' % int(num)))
        report = ('../reports/' + os.path.basename(g0[0])) if g0 else ''
    key = canon(co)
    g = groups.setdefault(key, dict(co=key, star=star(co), roles=[]))
    if not g['star']:
        g['star'] = star(co)
    g['roles'].append(dict(num=num, sc=sc, role=role, status=status,
                           lane=lane(role), report=report,
                           gate=re.sub(r'\s+', ' ', note)[:280]))

companies = []
for g in groups.values():
    rs = sorted(g['roles'], key=lambda x: (-x['sc'], SP.get(x['status'], 9)))
    best = rs[0]
    n_active = sum(1 for x in rs if x['status'] in ACTIVE)
    companies.append(dict(
        co=g['co'], star=g['star'], sc=best['sc'],
        role=best['role'], status=best['status'], lane=best['lane'],
        num=best['num'], report=best['report'], gate=best['gate'],
        n=len(rs), na=n_active))

companies.sort(key=lambda x: (-x['sc'], -x['na'], -x['n'], x['co'].lower()))
for i, x in enumerate(companies, 1):
    x['rank'] = i

total_roles = sum(x['n'] for x in companies)
gems = sum(1 for x in companies if x['sc'] >= 4.0)
live = sum(1 for x in companies if x['na'] > 0)

TPL = open(os.path.join('scripts', '_all_ranked_template.html'), encoding='utf-8').read()
out = (TPL.replace('__DATA__', json.dumps(companies, ensure_ascii=False))
          .replace('__CANDIDATE__', _html.escape(_candidate.load()['full_name']))
          .replace('__LANE_BUTTONS__', lane_buttons())
          .replace('__COMPANIES__', str(len(companies)))
          .replace('__ROLES__', str(total_roles))
          .replace('__GEMS__', str(gems))
          .replace('__LIVE__', str(live))
          .replace('__DATE__', datetime.datetime.now().strftime('%b %d, %Y at %I:%M %p').replace(' 0', ' ')))
open('output/all-companies-ranked.html', 'w', encoding='utf-8').write(out)
print('wrote output/all-companies-ranked.html  (%d companies, %d roles, %d gems, %d with a live role)'
      % (len(companies), total_roles, gems, live))
