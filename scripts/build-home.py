# -*- coding: utf-8 -*-
"""Build output/latest-listings.html (newest scanned postings from data/scan-history.tsv,
cross-referenced against the tracker) and output/index.html (the career-ops home page
linking all boards). Run:  python scripts/build-home.py"""
import re, os, csv, json, html, datetime, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _candidate  # noqa: E402  (the name on these pages comes from config/profile.yml)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
NAME = html.escape(_candidate.load()['full_name'])
STAMP = datetime.datetime.now().strftime('%b %d, %Y at %I:%M %p').replace(' 0', ' ')

def canon(co):
    b = re.split(r'[(/—] | - | \(', co)[0]
    b = re.split(r'\(', b)[0].strip()
    return b or co

# tracker lookup: company+role -> (num, score, status)
trk = []
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
    trk.append((canon(c[2]).lower(), re.sub(r'[^a-z0-9]', '', c[3].lower())[:24], c[0], c[4], c[5]))

def tracked(co, title):
    nco = canon(co).lower()
    nt = re.sub(r'[^a-z0-9]', '', title.lower())[:24]
    for tco, trole, num, score, status in trk:
        if (nco in tco or tco in nco) and (nt and (nt in trole or trole in nt)):
            return num, score, status
    return None

rows = []
if os.path.exists('data/scan-history.tsv'):
    for ln in open('data/scan-history.tsv', encoding='utf-8'):
        p = ln.rstrip('\n').split('\t')
        if len(p) < 7 or not re.match(r'^\d{4}-\d{2}-\d{2}$', p[1]):
            continue
        url, date, src, title, co, action, loc = p[0], p[1], p[2], p[3], p[4], p[5], p[6]
        t = tracked(co, title)
        rows.append(dict(url=url, date=date, title=title, co=canon(co), loc=loc,
                         num=(t[0] if t else None), score=(t[1] if t else None), status=(t[2] if t else None)))
rows.sort(key=lambda r: r['date'], reverse=True)
rows = rows[:150]

CSS = """
:root{--bg:#0f1419;--card:#1a2230;--line:#2c3a4f;--tx:#e6edf3;--mut:#8b9bb0;--acc:#4da3ff;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--tx);padding:22px;line-height:1.45}
h1{font-size:22px}.sub{color:var(--mut);font-size:13px;margin-top:3px}
.stamp{color:var(--mut);font-size:11.5px;margin-top:5px;opacity:.8}
a{color:var(--acc);text-decoration:none}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12.5px}
th{text-align:left;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #1e2836;vertical-align:top}
tr:hover td{background:#161e2b}
.date{color:var(--mut);white-space:nowrap;font-variant-numeric:tabular-nums}
.co{font-weight:600}.loc{color:var(--mut);font-size:11.5px}
.st{display:inline-block;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600;white-space:nowrap}
.stnew{background:#0d3320;color:#5ee29a}.sttrk{background:#23272e;color:#9fb0c5}
.nav{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.nav a{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:7px 15px;font-size:12.5px;color:var(--tx)}
.nav a:hover{border-color:var(--acc)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin:18px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;display:block;color:var(--tx)}
.card:hover{border-color:var(--acc)}
.card .t{font-size:15px;font-weight:700}.card .d{color:var(--mut);font-size:12px;margin-top:5px}
.card .n{font-size:24px;font-weight:700;color:var(--acc);margin-top:8px}
.foot{color:#566;font-size:11px;margin-top:22px;border-top:1px solid var(--line);padding-top:10px}
"""

NAV = ('<div class="nav"><a href="index.html">🏠 Home</a><a href="prospects-dashboard.html">⭐ Top Prospects</a>'
       '<a href="all-companies-ranked.html">🏢 Companies (fit)</a>'
       '<a href="latest-listings.html">🆕 Latest listings</a></div>')

# latest-listings page
body = ['<h1>Latest scanned listings</h1>',
        '<div class="sub">newest first, from the zero-token portal scanner (data/scan-history.tsv) — cross-referenced against the tracker. '
        'Untracked rows are candidates for the next eval pass.</div>',
        '<div class="stamp">🔄 Last updated %s</div>' % STAMP, NAV,
        '<table><tr><th>Scanned</th><th>Company</th><th>Role</th><th>Location</th><th>Status</th></tr>']
for r in rows:
    st = ('<span class="st sttrk">tracked #%s · %s</span>' % (r['num'], html.escape(r['status'] or ''))) if r['num'] \
         else '<span class="st stnew">no tracker entry (bulk-triaged or pending)</span>'
    body.append('<tr><td class="date">%s</td><td class="co">%s</td><td><a href="%s">%s</a></td><td class="loc">%s</td><td>%s</td></tr>'
                % (r['date'], html.escape(r['co']), html.escape(r['url']), html.escape(r['title'][:80]), html.escape(r['loc'][:40]), st))
body.append('</table><div class="foot">Regenerate: <code>node scan.mjs && python scripts/build-home.py</code></div>')
page = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s - Latest Listings</title><style>%s</style></head><body>%s</body></html>' % (NAME, CSS, ''.join(body))
open('output/latest-listings.html', 'w', encoding='utf-8').write(page)

# home page
n_new = sum(1 for r in rows if not r['num'])
gems = prepped = 0
# These two numbers are scraped back out of the dashboard page, so this page must be
# built AFTER build-dashboard.py or it reports the previous run's figures. The hook now
# orders them that way; see scripts/hooks/rebuild_boards_hook.py.
#
# The pattern deliberately skips whatever sits BETWEEN the two counts. It used to demand
# "N actionable 4.0+ leads &middot; N packets ready" verbatim, and when the dashboard
# headline gained a "near miss 3.8-3.9" segment the match broke and this page rendered
# "- leads - prepped" from then on. Nothing said so, because a failed scrape was
# indistinguishable from a zero.
try:
    txt = open('output/prospects-dashboard.html', encoding='utf-8').read()
    m = re.search(r'(\d+) actionable 4\.0\+.{0,200}?(\d+) packets ready', txt)
    if m:
        gems, prepped = m.group(1), m.group(2)
    else:
        print('  WARNING: could not read the lead counts out of '
              'output/prospects-dashboard.html. The headline wording in '
              'scripts/_dashboard_template.html has probably drifted away from the '
              'pattern above, and the home page will show a dash instead of a number.')
except Exception as e:
    print('  WARNING: could not open output/prospects-dashboard.html (%s); build it '
          'first, then rebuild this page.' % e)
home = ['<h1>Career-Ops — %s</h1>' % NAME,
        '<div class="sub">your job-search command center · all pages are local files, regenerated by the scripts below</div>',
        '<div class="stamp">🔄 Last updated %s</div>' % STAMP,
        '<div class="cards">',
        '<a class="card" href="prospects-dashboard.html"><div class="t">⭐ Top Prospects</div><div class="d">actionable 4.0+ roles, filterable by tier/lane, with packets</div><div class="n">%s leads · %s prepped</div></a>' % (gems or '—', prepped or '—'),
        '<a class="card" href="latest-listings.html"><div class="t">🆕 Latest Listings</div><div class="d">newest scanned postings, tracked vs not-yet-evaluated</div><div class="n">%d recent · %d unevaluated</div></a>' % (len(rows), n_new),
        '<a class="card" href="all-companies-ranked.html"><div class="t">🏢 Companies by Fit</div><div class="d">every company ranked by its best-role fit score</div></a>',
        '</div>',
        '<div class="foot">Refresh data: <code>node scan.mjs</code> (new listings) · <code>python scripts/build-dashboard.py</code> (prospects) · '
        '<code>python scripts/build-all-ranked.py</code> (fit ranking) · <code>python scripts/build-home.py</code> (this page + latest listings)<br>'
        'Terminal alternative: <code>cd dashboard && .\\career-dashboard.exe --path ..</code> (career-ops built-in TUI)</div>']
page = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Career-Ops Home</title><style>%s</style></head><body>%s</body></html>' % (CSS, ''.join(home))
open('output/index.html', 'w', encoding='utf-8').write(page)
print('wrote output/latest-listings.html (%d rows, %d unevaluated) + output/index.html' % (len(rows), n_new))
