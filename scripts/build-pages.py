#!/usr/bin/env python3
"""Build the public UI from source without reading or embedding sheet records."""
import json
import os
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
config = json.loads((root / 'site-config.json').read_text())
config['clientId'] = os.environ.get('GOOGLE_CLIENT_ID') or config['clientId']
if config['clientId'] and not re.fullmatch(r'[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com', config['clientId']):
    raise SystemExit('Expected a web OAuth Client ID ending in .apps.googleusercontent.com.')
source = root / 'chart'
template = (source / 'evb_web_template.html').read_text()
template = template.replace('<body>', '<body data-auth-required="true">')
template = template.replace('id="login-screen" aria-labelledby="login-title" hidden',
                            'id="login-screen" aria-labelledby="login-title"')
template = template.replace('__EVB_LOGIC__', (source / 'evb_data.js').read_text())
template = template.replace('__EVB_LIVE__', (source / 'evb_live.js').read_text())
template = template.replace('<script id="live-sync">', '<script id="google-auth">' +
                            (source / 'evb_google_auth.js').read_text() + '</script>\n<script id="live-sync">')
template = template.replace('<script id="evb-data"',
    '<script src="./config.js"></script>\n<script src="https://accounts.google.com/gsi/client" async defer></script>\n<script id="evb-data"')
payload = {'year': config['year'], 'source': {'spreadsheetId': config['spreadsheetId'],
           'mode': 'google-oauth', 'refreshSeconds': 60}, 'platforms': [], 'records': []}
placeholder = ('<svg id="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 670" '
               'width="1100" height="670" role="img" aria-labelledby="svg-title svg-description">'
               '<title id="svg-title">EVB platform history chart</title>'
               '<desc id="svg-description">Sign in to view authorized Google Sheets data.</desc>'
               '<text x="30" y="180" fill="#a6b7cb" font-size="14">Sign in to view Google Sheets data.</text></svg>')
html = template.replace('__EVB_DATA__', json.dumps(payload).replace('<', '\\u003c')).replace('__EVB_CHART__', placeholder)
assert not re.search(r'__EVB_[A-Z]+__', html)
assert 'class="evb-track"' not in html
public = root / 'public'
public.mkdir(exist_ok=True)
(public / 'evb.html').write_text(html)
(public / 'config.js').write_text('globalThis.EVB_PUBLIC_CONFIG = ' +
    json.dumps({'clientId': config['clientId'], 'sheetName': config['sheetName']}).replace('<', '\\u003c') + ';\n')
print('Public UI generated: no embedded EVB records. Google OAuth ' + ('configured.' if config['clientId'] else 'awaits Client ID.'))
