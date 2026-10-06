/* Browser-only Google authorization with optional short-lived session storage. */
(function (root) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const COLUMNS = ['#', 'Platform / Place', 'EVB / DVB', 'Change date', 'History'];
  const columnName = value => {
    const name = String(value ?? '').trim();
    return ['Creadted date', 'Created date'].includes(name) ? 'Change date' : name;
  };
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
    const prefix = 'evb-auth:' + options.clientId + ':' + options.spreadsheetId;
    const preferenceKey = prefix + ':remember', sessionKey = prefix + ':session';
    function cache(method, key, value) {
      try {
        const storage = options.storage === undefined ? root.localStorage : options.storage;
        if (!storage) return null;
        if (method === 'getItem') return storage.getItem(key);
        storage[method](key, value);
        return true;
      } catch { return null; }
    }
    let remembering = cache('getItem', preferenceKey) === 'true';
    // Cache only table coordinates, never records or authorization. Revalidate headers on every read.
    const layoutKey = prefix + ':layout:v1:' + JSON.stringify(options.sheetName || '');
    const layoutLifetime = 24 * 60 * 60 * 1000;
    let layout = null;
    try {
      const saved = JSON.parse(cache('getItem', layoutKey));
      if (saved && typeof saved.title === 'string' && saved.title &&
          (!options.sheetName || options.sheetName === saved.title) &&
          Number.isSafeInteger(saved.row) && saved.row >= 0 && saved.row < 20 &&
          Array.isArray(saved.indexes) && saved.indexes.length === COLUMNS.length &&
          saved.indexes.every(index => Number.isSafeInteger(index) && index >= 0 && index < 18278) &&
          new Set(saved.indexes).size === COLUMNS.length &&
          Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now() &&
          saved.expiresAt <= Date.now() + layoutLifetime) layout = saved;
      else cache('removeItem', layoutKey);
    } catch { cache('removeItem', layoutKey); }
    function forgetLayout() { layout = null; cache('removeItem', layoutKey); }
    function persist() {
      if (remembering && token && expiresAt > Date.now()) {
        if (!cache('setItem', sessionKey, JSON.stringify({token, expiresAt}))) {
          remembering = false;
          cache('removeItem', preferenceKey);
          cache('removeItem', sessionKey);
        }
      }
    }
    function setRemember(value) {
      remembering = Boolean(value);
      if (remembering && !cache('setItem', preferenceKey, 'true')) {
        remembering = false;
        options.onStatus('This browser cannot remember sign-in. You can still sign in for this visit.', 'saved');
      }
      if (remembering) persist();
      else { cache('removeItem', preferenceKey); cache('removeItem', sessionKey); }
      return remembering;
    }
    function expireAfter(delay) {
      timer = schedule(() => clear('Google authorization expired. Sign in again to view data.'), delay);
    }
    function clear(message) {
      version++;
      token = ''; expiresAt = 0;
      cancel(timer);
      controller?.abort();
      cache('removeItem', sessionKey);
      options.onCleared(message);
    }
    function restore() {
      if (!options.clientId || !remembering) { cache('removeItem', sessionKey); return false; }
      let saved;
      try { saved = JSON.parse(cache('getItem', sessionKey)); } catch { /* Discard invalid stored state. */ }
      const remaining = saved?.expiresAt - Date.now();
      if (!saved || typeof saved.token !== 'string' || !saved.token ||
          !Number.isFinite(saved.expiresAt) || remaining <= 0 || remaining > 3600000) {
        cache('removeItem', sessionKey);
        return false;
      }
      version++;
      token = saved.token; expiresAt = saved.expiresAt;
      cancel(timer); expireAfter(remaining);
      // onAuthorized reads Sheets again; saved state alone never reveals records.
      options.onAuthorized();
      return true;
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
            const duration = Math.min(lifetime * 1000, 3600000);
            expiresAt = Date.now() + duration;
            persist(); expireAfter(duration);
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
            forgetLayout();
            clear(response.status === 401 ? 'Google authorization expired. Please sign in again.' :
              'This Google account cannot read the spreadsheet, or Sheets access is unavailable. Check access to the source sheet.');
          }
          const error = new Error('Google Sheets could not be read (HTTP ' + response.status + ').');
          error.status = response.status;
          throw error;
        }
        const body = await response.json();
        if (current !== version) throw new Error('Google session changed.');
        return body;
      }
      async function readLayout(target) {
        const columns = await api('/values:batchGet', [
          ['valueRenderOption', 'FORMATTED_VALUE'],
          ...target.indexes.map(index => {
            const letter = columnLetter(index + 1);
            // Open-ended ranges include new rows without another metadata request.
            return ['ranges', tabRange(target.title) + letter + (target.row + 1) + ':' + letter];
          })
        ]);
        const values = target.indexes.map((_, index) => columns.valueRanges?.[index]?.values || []);
        if (!values.every((column, index) => columnName(column[0]?.[0]) === COLUMNS[index])) return null;
        const rows = Array.from({length: Math.max(0, ...values.map(column => column.length - 1))}, (_, index) =>
          values.map(column => column[index + 1]?.[0] ?? '')).filter(values => values.some(value => String(value).trim()));
        return {rows: [COLUMNS, ...rows], year: options.year, sheetName: target.title, updatedAt: Date.now()};
      }
      try {
        if (layout && layout.expiresAt > Date.now()) {
          try {
            const result = await readLayout(layout);
            if (result) return result;
          } catch (error) {
            // Deleted/renamed tabs or removed columns invalidate an A1 range (HTTP 400).
            if (error.status !== 400) throw error;
          }
        }
        forgetLayout();
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
          const rows = (preview.values || []).map(values => values.map(columnName));
          const row = rows.findIndex(values => COLUMNS.every(column => values.includes(column)));
          if (row >= 0) matches.push({tab: tabs[index], row, header: rows[row]});
        });
        if (matches.length !== 1) throw new Error(matches.length ? 'Multiple EVB tabs found. Ask the site administrator to choose a sheet tab.' : 'No EVB table found in this spreadsheet.');
        const {tab, row, header} = matches[0];
        const indexes = COLUMNS.map(column => header.indexOf(column));
        const target = {title: tab.title, row, indexes, expiresAt: Date.now() + layoutLifetime};
        const result = await readLayout(target);
        if (!result) throw new Error('The sheet columns changed while loading. Please refresh data.');
        layout = target;
        cache('setItem', layoutKey, JSON.stringify(target));
        return result;
      } finally { cancel(timeout); }
    }
    return {connect, read, restore, setRemember,
      disconnect() { forgetLayout(); setRemember(false); clear('Disconnected. Sign in to view the private spreadsheet.'); },
      get remembering() { return remembering; },
      get connected() { return Boolean(token) && Date.now() < expiresAt; }, get version() { return version; }};
  }
  const api = {createClient};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EVBGoogle = api;
})(globalThis);
