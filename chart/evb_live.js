// Live updates replace the SVG only after a complete dataset has been validated.
const source = data.source;
const sheetURL = `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit`;
let lastUpdated = null, activeRequest = false;
let oauthClient = null;
let refreshQueued = false;
$('source-link').href = sheetURL;
$('login-source').href = sheetURL;

function showLogin(visible) {
  if (source.mode !== 'google-oauth') return;
  document.body.setAttribute('data-auth-required', String(visible));
  $('login-screen').hidden = !visible;
}

function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function makeChart(next, requestedWidth) {
  const height = Math.max(670, next.platforms.length * 38 + 98);
  const left = 126, right = 30, top = 36, bottom = 62;
  const rowHeight = (height - top - bottom) / next.platforms.length;
  const ids = [...new Set(next.records.map(r => r.evb))].sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
  const first = Math.min(...next.records.map(r => day(r.date))), last = Math.max(...next.records.map(r => day(r.date)));
  const span = Math.round((last - first) / 86400000);
  const width = requestedWidth || Math.max(1600, span * 48 + left + right);
  const x = date => left + (day(date) - first) / Math.max(86400000, last - first) * (width - left - right);
  const positions = new Map();
  const svg = svgNode('svg', {viewBox: `0 0 ${width} ${height}`});
  svg.append(svgNode('title', {id: 'svg-title'}, 'EVB platform history chart'),
    svgNode('desc', {id: 'svg-description'}, 'Dates are on the horizontal axis and platforms on the vertical axis. Each line represents one EVB.'));
  next.platforms.forEach((platform, level) => {
    const members = ids.filter(evb => next.records.some(r => r.evb === evb && r.platform === platform));
    members.forEach((evb, i) => positions.set(JSON.stringify([platform, evb]), top + (level + .5) * rowHeight +
      (i - (members.length - 1) / 2) * Math.min(5, 27 / Math.max(1, members.length - 1))));
    if (level % 2 === 0) svg.append(svgNode('rect', {x: left, y: top + level * rowHeight, width: width-left-right, height: rowHeight, fill: '#182538'}));
    svg.append(svgNode('text', {x: left-14, y: top+(level+.5)*rowHeight+4, 'text-anchor': 'end', fill: '#bdcbdd'}, platform));
  });
  const focusedRecords = selected ? next.records.filter(record => record.evb === selected) : null;
  const ticks = focusedRecords
    ? new Set(focusedRecords.map(record => Math.round((day(record.date) - first) / 86400000)))
    : new Set([0, span]);
  const sameYear = new Date(first).getUTCFullYear() === new Date(last).getUTCFullYear();
  const tickSpacing = sameYear ? 64 : 100;
  const tickCount = Math.max(1, Math.floor((width - left - right) / tickSpacing));
  if (!focusedRecords) {
    for (let i = 0; i <= span; i += Math.max(1, Math.ceil(span / tickCount))) ticks.add(i);
  }
  let previousLabelX = -Infinity, labelRow = 0;
  [...ticks].sort((a,b) => a-b).forEach(offset => {
    const date = new Date(first + offset * 86400000).toISOString().slice(0,10), px = x(date);
    if (!focusedRecords && offset > 0 && offset < span && width - right - px < tickSpacing) return;
    labelRow = focusedRecords && px - previousLabelX < tickSpacing ? 1 - labelRow : 0;
    previousLabelX = px;
    svg.append(svgNode('path', {class: 'date-grid', 'data-date': date, d: `M ${px} ${top} V ${height-bottom}`, stroke: '#2a394e', fill: 'none'}));
    svg.append(svgNode('text', {class: 'date-tick', 'data-date': date, x: px, y: height-bottom+23+labelRow*16, 'text-anchor': 'middle', fill: '#a6b7cb'},
      sameYear ? date.slice(5).replace('-', '/') : date));
  });
  svg.append(svgNode('text', {x:10,y:18,fill:'#a6b7cb'}, 'Platform / Place'),
    svgNode('text', {x:(left+width-right)/2,y:height-12,'text-anchor':'middle',fill:'#a6b7cb'}, 'Date'));
  ids.forEach((evb, index) => {
    const records = next.records.filter(r => r.evb === evb).sort((a,b) => a.date.localeCompare(b.date));
    const color = `hsl(${(index*137.508+165)%360},70%,${index%3===0?66:74}%)`;
    const group = svgNode('g', {class:'evb-track', 'data-evb':evb});
    group.append(svgNode('title', {}, `EVB ${evb}`));
    const path = records.map((r,i) => `${i?'H':'M'} ${x(r.date)} ${i?'V':''} ${positions.get(JSON.stringify([r.platform,evb]))}`).join(' ') + ` H ${x(new Date(last).toISOString().slice(0,10))}`;
    group.append(svgNode('path', {class:'trajectory', d:path, fill:'none',stroke:color,'stroke-width':1.8,'stroke-linejoin':'round'}));
    records.forEach(r => {
      const circle = svgNode('circle', {cx:x(r.date),cy:positions.get(JSON.stringify([r.platform,evb])),r:3,fill:color,stroke:'#131e2d','stroke-width':1});
      circle.append(svgNode('title', {}, `EVB ${evb} · ${r.platform} · ${r.date} · #${r.number}`)); group.append(circle);
    });
    svg.append(group);
  });
  return svg;
}
const timeline = $('timeline-scroll');
let timelineZoom = 1, viewportWidth = timeline.clientWidth;
function timelineAnchor(anchorX = viewportWidth / 2) {
  const width = Number(chart.getAttribute('width'));
  const fraction = Math.max(0, Math.min(1, (timeline.scrollLeft + anchorX - 126) / Math.max(1, width - 156)));
  return start + fraction * (end - start);
}
function renderTimeline(anchorDate, anchorX = timeline.clientWidth / 2) {
  const hasData = data.records.length > 0;
  $('timeline-controls').hidden = false;
  $('zoom-range').disabled = !hasData;
  $('zoom-out').disabled = !hasData || timelineZoom <= 1;
  $('zoom-in').disabled = !hasData || timelineZoom >= 8;
  $('zoom-fit').disabled = !hasData;
  $('zoom-range').value = Math.round(timelineZoom * 100);
  $('zoom-value').textContent = Math.round(timelineZoom * 100) + '%';
  viewportWidth = timeline.clientWidth;
  if (!hasData || !viewportWidth) return;
  const plotWidth = Math.max(1, viewportWidth - 156) * timelineZoom;
  const svg = makeChart(data, plotWidth + 156);
  chart.setAttribute('viewBox', svg.getAttribute('viewBox'));
  const [, , width, height] = svg.getAttribute('viewBox').split(' ');
  chart.setAttribute('width', width);
  chart.setAttribute('height', height);
  chart.style.width = width + 'px';
  chart.style.minWidth = width + 'px';
  chart.style.height = height + 'px';
  chart.replaceChildren(...svg.childNodes);
  const fraction = Number.isFinite(anchorDate) && end > start ? (anchorDate - start) / (end - start) : 0;
  timeline.scrollLeft = Math.max(0, Math.min(Number(width) - viewportWidth, 126 + fraction * plotWidth - anchorX));
  draw();
}
function zoomTimeline(value, anchorX = timeline.clientWidth / 2) {
  if (!data.records.length) return;
  const anchorDate = timelineAnchor(anchorX);
  timelineZoom = Math.max(1, Math.min(8, value));
  renderTimeline(anchorDate, anchorX);
}
$('timeline-controls').addEventListener('click', event => event.stopPropagation());
$('zoom-range').addEventListener('input', event => zoomTimeline(Number(event.target.value) / 100));
$('zoom-out').addEventListener('click', () => zoomTimeline(timelineZoom / 1.25));
$('zoom-in').addEventListener('click', () => zoomTimeline(timelineZoom * 1.25));
$('zoom-fit').addEventListener('click', () => zoomTimeline(1));
timeline.addEventListener('wheel', event => {
  if (!(event.ctrlKey || event.metaKey) || !data.records.length) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? timeline.clientHeight : 1);
  zoomTimeline(timelineZoom * Math.exp(-Math.max(-200, Math.min(200, delta)) * .005),
    event.clientX - timeline.getBoundingClientRect().left);
}, {passive: false});
new ResizeObserver(() => {
  if (timeline.clientWidth !== viewportWidth) renderTimeline(timelineAnchor());
}).observe(timeline);
renderTimeline();

function applyData(next) {
  const anchorDate = timelineAnchor();
  data = {...next, source};
  rebuildIndex();
  showLogin(false);
  renderTimeline(anchorDate);
  updateSummary();
  select(selected && histories.has(selected) ? selected : null);
}
function updateStatus(message, state) {
  $('sync-status').textContent = message;
  $('sync-status').setAttribute('data-state', state);
  if (source.mode === 'google-oauth') {
    $('login-status').textContent = message;
    $('login-status').setAttribute('data-state', state);
    $('connect-google').disabled = state === 'loading';
    $('connect-google').textContent = state === 'loading' ? 'Loading your timeline…' : 'Sign in with Google';
  }
}
function updatedLabel() {
  return lastUpdated ? new Date(lastUpdated).toLocaleString('en-GB', {hour12:false}) : 'not yet synced';
}
function clearLiveData(message) {
  refreshQueued = false;
  showLogin(true);
  data = {...data, records: [], platforms: []};
  rebuildIndex(); lastUpdated = null;
  const width = timeline.clientWidth || 1100;
  chart.setAttribute('viewBox', `0 0 ${width} 670`);
  chart.setAttribute('width', width); chart.setAttribute('height', 670);
  chart.style.width = width + 'px'; chart.style.minWidth = width + 'px'; chart.style.height = '670px';
  timeline.scrollLeft = 0;
  chart.replaceChildren(
    svgNode('title', {id: 'svg-title'}, 'EVB platform history chart'),
    svgNode('desc', {id: 'svg-description'}, 'Sign in to load authorized Google Sheets data.'),
    svgNode('text', {x: 20, y: 180, fill: '#a6b7cb', 'font-size': 14}, 'Sign in to view Google Sheets data.')
  );
  updateSummary(); select(null);
  $('disconnect-google').hidden = true;
  $('refresh-sheet').disabled = true;
  updateStatus(message, 'saved');
}
function readPrivateSheet() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Google Sheets did not respond in time. Please retry.')), 30000);
    google.script.run.withSuccessHandler(result => {clearTimeout(timeout); resolve(result);})
      .withFailureHandler(error => {clearTimeout(timeout); reject(new Error(error.message || 'Google Sheets access failed.'));})
      .getSheetData();
  });
}
async function refreshSheet() {
  if (activeRequest) return;
  if (source.mode === 'google-oauth' && !oauthClient?.connected) return;
  if (source.mode !== 'google-oauth' && (source.mode !== 'apps-script' || typeof google === 'undefined' || !google.script?.run)) {
    updateStatus('Local snapshot · Open the deployed company app to sync Google Sheets.', 'saved');
    return;
  }
  activeRequest = true; $('refresh-sheet').disabled = true;
  const sessionVersion = oauthClient?.version;
  updateStatus('Updating from Google Sheets…', 'loading');
  try {
    const result = source.mode === 'google-oauth' ? await oauthClient.read() : await readPrivateSheet();
    if (oauthClient && sessionVersion !== oauthClient.version) return;
    const next = EVBData.fromRows(result.rows, result.year);
    applyData(next);
    lastUpdated = result.updatedAt;
    updateStatus(`Updated ${updatedLabel()} · ${result.sheetName} · Auto-refresh every ${source.refreshSeconds}s`, 'live');
  } catch (error) {
    if (oauthClient && sessionVersion !== oauthClient.version) return;
    updateStatus(`${error.message} ${lastUpdated ? 'Keeping the last successful chart from '+updatedLabel()+'.' : 'Sign in with your company account and confirm you can open the source sheet.'}`, 'error');
  } finally {
    activeRequest = false;
    $('refresh-sheet').disabled = oauthClient ? !oauthClient.connected : false;
    if (refreshQueued) { refreshQueued = false; if (oauthClient?.connected) refreshSheet(); }
  }
}
$('refresh-sheet').addEventListener('click', event => {event.stopPropagation(); refreshSheet();});
$('source-link').addEventListener('click', event => event.stopPropagation());
if (source.mode === 'google-oauth') {
  const config = globalThis.EVB_PUBLIC_CONFIG || {};
  oauthClient = EVBGoogle.createClient({
    clientId: config.clientId || '', spreadsheetId: source.spreadsheetId,
    sheetName: config.sheetName || '', year: data.year,
    onCleared: clearLiveData, onStatus: updateStatus,
    onAuthorized() {
      $('disconnect-google').hidden = false;
      if (activeRequest) refreshQueued = true; else refreshSheet();
    }
  });
  $('connect-google').hidden = false;
  $('connect-google').addEventListener('click', event => {event.stopPropagation(); oauthClient.connect();});
  $('disconnect-google').addEventListener('click', event => {event.stopPropagation(); oauthClient.disconnect();});
  clearLiveData(config.clientId ? 'Sign in with a Google account that can view the source spreadsheet.' :
    'Google sign-in is not configured yet. Please contact the site administrator.');
  setInterval(() => {if (!document.hidden && oauthClient.connected) refreshSheet();}, source.refreshSeconds * 1000);
} else if (source.mode === 'apps-script') {
  refreshSheet();
  setInterval(() => {if (!document.hidden) refreshSheet();}, source.refreshSeconds * 1000);
} else {
  $('refresh-sheet').disabled = true;
  updateStatus('Local snapshot · Open the deployed company app to sync Google Sheets.', 'saved');
}
