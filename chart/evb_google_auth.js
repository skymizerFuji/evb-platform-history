/* Browser-only Google authorization. Tokens and sheet rows stay in memory. */
(function (root) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const COLUMNS = ['#', 'Platform / Place', 'EVB / DVB', 'Change date', 'History'];
  function columnLetter(index) {
    let result = '';
    while (index > 0) { index--; result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26); }
    return result;
  }
  const tabRange = title => "'" + title.replace(/'/g, "''") + "'!";
  function createClient(options) {
    const request = options.fetch || ((...args) => root.fetch(...args));
    const identity = options.identity || (() => root.google?.accounts?.oauth2);
    const schedule = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    let token = '', expiresAt = 0, timer, version = 0, controller;
    function clear(message) {
      version++;
      token = ''; expiresAt = 0;
      cancel(timer);
      controller?.abort();
      options.onCleared(message);
    }
    function connect() {
      if (!options.clientId) {
        options.onStatus('Google sign-in is not configured yet. Please contact the site administrator.', 'error');
        return;
      }
      const googleAuth = identity();
      if (!googleAuth) {
        options.onStatus('Google sign-in is still loading or was blocked. Reload the page and try again.', 'error');
        return;
      }
      clear('Complete Google sign-in to load the private spreadsheet.');
      const attempt = version;
      try {
        const client = googleAuth.initTokenClient({
          client_id: options.clientId, scope: SCOPE, include_granted_scopes: false,
          callback(response) {
            if (attempt !== version) return;
            if (response.error || !response.access_token || !googleAuth.hasGrantedAllScopes(response, SCOPE)) {
              clear('Read access was not granted. Sign in and allow read-only access to Google Sheets.');
              return;
            }
            const lifetime = Number(response.expires_in);
            if (!Number.isFinite(lifetime) || lifetime <= 0) {
              clear('Google authorization has expired. Please sign in again.');
              return;
            }
            token = response.access_token;
            expiresAt = Date.now() + lifetime * 1000;
            timer = schedule(() => clear('Google authorization expired. Sign in again to view data.'), lifetime * 1000);
            options.onAuthorized();
          },
          error_callback() {
            if (attempt === version) clear('Google sign-in was closed or could not open. Please try again.');
          }
        });
        client.requestAccessToken({prompt: 'select_account'});
      } catch {
        clear('Google sign-in could not start. Please try again.');
      }
    }
    async function read() {
      if (!token || Date.now() >= expiresAt) {
        clear('Sign in with a Google account that can view the source spreadsheet.');
        throw new Error('Google sign-in required.');
      }
      const current = version, bearer = token;
      const currentController = new AbortController();
      controller = currentController;
      const signal = currentController.signal;
      const timeout = schedule(() => currentController.abort(), 30000);
      async function api(path, params) {
        const url = new URL('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(options.spreadsheetId) + path);
        for (const [key, value] of params) url.searchParams.append(key, value);
        const response = await request(url.toString(), {
          headers: {Authorization: 'Bearer ' + bearer}, cache: 'no-store', signal
        });
        if (current !== version) throw new Error('Google session changed.');
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            clear(response.status === 401 ? 'Google authorization expired. Please sign in again.' :
              'This Google account cannot read the spreadsheet, or Sheets access is unavailable. Check access to the source sheet.');
          }
          throw new Error('Google Sheets could not be read (HTTP ' + response.status + ').');
        }
        const body = await response.json();
        if (current !== version) throw new Error('Google session changed.');
        return body;
      }
      try {
        const metadata = await api('', [['fields', 'sheets(properties(title,gridProperties(rowCount,columnCount)))']]);
        const tabs = (metadata.sheets || []).map(sheet => sheet.properties)
          .filter(tab => tab.gridProperties && (!options.sheetName || options.sheetName === tab.title));
        if (!tabs.length) throw new Error('The configured sheet tab was not found.');
        const previews = await api('/values:batchGet', [
          ['valueRenderOption', 'FORMATTED_VALUE'],
          ...tabs.map(tab => ['ranges', tabRange(tab.title) + 'A1:' + columnLetter(tab.gridProperties.columnCount) + Math.min(20, tab.gridProperties.rowCount)])
        ]);
        const matches = [];
        (previews.valueRanges || []).forEach((preview, index) => {
          const rows = preview.values || [];
          const row = rows.findIndex(values => COLUMNS.every(column => values.map(value => String(value).trim()).includes(column)));
          if (row >= 0) matches.push({tab: tabs[index], row, header: rows[row].map(value => String(value).trim())});
        });
        if (matches.length !== 1) throw new Error(matches.length ? 'Multiple EVB tabs found. Ask the site administrator to choose a sheet tab.' : 'No EVB table found in this spreadsheet.');
        const {tab, row, header} = matches[0];
        const indexes = COLUMNS.map(column => header.indexOf(column));
        let rows = [];
        if (row + 2 <= tab.gridProperties.rowCount) {
          // Request only the five chart columns, not owner/department/remarks.
          const columns = await api('/values:batchGet', [
            ['valueRenderOption', 'FORMATTED_VALUE'],
            ...indexes.map(index => {
              const letter = columnLetter(index + 1);
              return ['ranges', tabRange(tab.title) + letter + (row + 2) + ':' + letter + tab.gridProperties.rowCount];
            })
          ]);
          const values = indexes.map((_, index) => columns.valueRanges?.[index]?.values || []);
          rows = Array.from({length: Math.max(0, ...values.map(column => column.length))}, (_, index) =>
            values.map(column => column[index]?.[0] ?? '')).filter(values => values.some(value => String(value).trim()));
        }
        return {rows: [COLUMNS, ...rows], year: options.year, sheetName: tab.title, updatedAt: Date.now()};
      } finally { cancel(timeout); }
    }
    return {connect, read, disconnect: () => clear('Disconnected. Sign in to view the private spreadsheet.'),
      get connected() { return Boolean(token) && Date.now() < expiresAt; }, get version() { return version; }};
  }
  const api = {createClient};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EVBGoogle = api;
})(globalThis);
