/* CSV/Google Sheets normalization shared by the page and its tests. */
(function (root) {
  'use strict';
  const natural = (a, b) => a.localeCompare(b, 'en', {numeric: true});
  const text = value => String(value ?? '').trim();
  function parseCSV(source) {
    if (/^\s*</.test(source)) throw new Error('Google returned a sign-in page instead of CSV. Check the sheet sharing settings.');
    const rows = []; let row = [], cell = '', quoted = false;
    source = source.replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '"') {
        if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
        else if (quoted || cell === '') quoted = !quoted;
        else throw new Error('Invalid CSV quoting.');
      } else if (!quoted && c === ',') { row.push(cell); cell = ''; }
      else if (!quoted && (c === '\n' || c === '\r')) {
        row.push(cell); rows.push(row); row = []; cell = '';
        if (c === '\r' && source[i + 1] === '\n') i++;
      } else cell += c;
    }
    if (quoted) throw new Error('Incomplete CSV response.');
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function parseDate(value, year) {
    let y = year, m, d, match;
    if ((match = text(value).match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) {
      m = +match[1]; d = +match[2]; if (match[3]) y = +match[3];
    } else if ((match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
      y = +match[1]; m = +match[2]; d = +match[3];
    } else throw new Error(`Unrecognized date: ${text(value)}. Use M/D or YYYY-MM-DD.`);
    const day = new Date(Date.UTC(y, m - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d)
      throw new Error(`Invalid date: ${text(value)}.`);
    return day.toISOString().slice(0, 10);
  }
  function fromRows(rows, year) {
    const required = ['#', 'Platform / Place', 'EVB / DVB', 'Change date', 'History'];
    const headerIndex = rows.findIndex(row => required.every(column => row.map(text).includes(column)));
    if (headerIndex < 0) throw new Error('The sheet must contain #, Platform / Place, EVB / DVB, Change date, and History columns.');
    const columns = rows[headerIndex].map(text);
    const groups = new Map(), platforms = new Set();
    rows.slice(headerIndex + 1).forEach((row, index) => {
      if (!row.some(value => text(value))) return;
      const value = column => text(row[columns.indexOf(column)]);
      const evb = value('EVB / DVB'), platform = value('Platform / Place');
      const number = value('#');
      if (!evb || !platform || !/^\d+$/.test(number) || !Number.isSafeInteger(+number))
        throw new Error(`Row ${headerIndex + index + 2}: missing EVB/platform or invalid #.`);
      const record = {evb, platform, number: +number, date: parseDate(value('Change date'), year),
        history: !['', 'false', '0', 'no', 'unchecked', '☐'].includes(value('History').toLowerCase())};
      const key = JSON.stringify([evb, record.date]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record); platforms.add(platform);
    });
    if (!groups.size) throw new Error('The sheet contains no EVB records.');
    const records = [...groups.values()].map(group => {
      const largest = Math.max(...group.map(r => r.number));
      let candidates = group.filter(r => r.number === largest);
      const unchecked = candidates.filter(r => !r.history);
      if (unchecked.length) candidates = unchecked;
      if (new Set(candidates.map(r => r.platform)).size > 1)
        throw new Error(`Conflicting platforms for ${group[0].evb} on ${group[0].date}, #${largest}, after applying the History rule.`);
      return candidates[candidates.length - 1];
    }).sort((a, b) => natural(a.evb, b.evb) || a.date.localeCompare(b.date));
    return {year, platforms: [...platforms].sort(natural), records};
  }
  const api = {parseCSV, parseDate, fromRows, fromCSV: (csv, year) => fromRows(parseCSV(csv), year)};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EVBData = api;
})(globalThis);
