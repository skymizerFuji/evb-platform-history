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
function recordedDates(next) {
  return [...new Set(next.records.map(record => record.date))].sort();
}
function dateSpacing(dates) {
  return dates.length && dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4) ? 100 : 64;
}
// Interpolate only for preserving the viewport anchor between ordinal date slots.
function dateSlot(timestamp, dates) {
  if (dates.length < 2 || timestamp <= day(dates[0])) return 0;
  for (let i = 1; i < dates.length; i++) {
    if (timestamp <= day(dates[i])) return i - 1 + (timestamp - day(dates[i - 1])) / (day(dates[i]) - day(dates[i - 1]));
  }
  return dates.length - 1;
}
function makeChart(next, requestedWidth) {
  const visibleRecords = next.records.filter(record => !selected.size || selected.has(record.evb));
  const usedPlatforms = new Set(visibleRecords.map(record => record.platform));
  const platforms = next.platforms;
  const height = Math.max(670, platforms.length * 38 + 98);
  const left = 126, right = 30, top = 36, bottom = 62;
  const rowHeight = (height - top - bottom) / Math.max(1, platforms.length);
  const ids = [...new Set(next.records.map(r => r.evb))].sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
  const dates = recordedDates(next), slots = new Map(dates.map((date, index) => [date, index]));
  const width = requestedWidth || Math.max(1600, (dates.length - 1) * dateSpacing(dates) + left + right);
  const x = date => left + slots.get(date) / Math.max(1, dates.length - 1) * (width - left - right);
  const positions = new Map();
  const labels = [];
  const svg = svgNode('svg', {viewBox: `0 0 ${width} ${height}`});
  svg.append(svgNode('title', {id: 'svg-title'}, 'EVB platform history chart'),
    svgNode('desc', {id: 'svg-description'}, 'Recorded dates are equally spaced on the horizontal axis, regardless of elapsed time. Platforms are on the vertical axis. Each line represents one EVB.'));
  platforms.forEach((platform, level) => {
    const members = ids.filter(evb => next.records.some(r => r.evb === evb && r.platform === platform));
    members.forEach((evb, i) => positions.set(JSON.stringify([platform, evb]), top + (level + .5) * rowHeight +
      (i - (members.length - 1) / 2) * Math.min(5, 27 / Math.max(1, members.length - 1))));
    const opacity = !selected.size || usedPlatforms.has(platform) ? 1 : .3;
    if (level % 2 === 0) svg.append(svgNode('rect', {x: left, y: top + level * rowHeight, width: width-left-right, height: rowHeight, fill: '#182538', opacity}));
    svg.append(svgNode('text', {class: 'platform-tick', 'data-platform': platform, x: left-14, y: top+(level+.5)*rowHeight+4, 'text-anchor': 'end', fill: '#bdcbdd', opacity}, platform));
  });
  const sameYear = dateSpacing(dates) === 64;
  const focusedDates = new Set(visibleRecords.map(record => record.date));
  dates.forEach(date => {
    if (!focusedDates.has(date)) return;
    const px = x(date);
    svg.append(svgNode('path', {class: 'date-grid', 'data-date': date, d: `M ${px} ${top} V ${height-bottom}`, stroke: '#2a394e', fill: 'none'}));
    svg.append(svgNode('text', {class: 'date-tick', 'data-date': date, x: px, y: height-bottom+23, 'text-anchor': 'middle', fill: '#a6b7cb'},
      sameYear ? date.slice(5).replace('-', '/') : date));
  });
  svg.append(svgNode('text', {x:10,y:18,fill:'#a6b7cb'}, 'Platform / Place'),
    svgNode('text', {x:(left+width-right)/2,y:height-12,'text-anchor':'middle',fill:'#a6b7cb'}, 'Date'));
  ids.forEach((evb, index) => {
    const records = next.records.filter(r => r.evb === evb).sort((a,b) => a.date.localeCompare(b.date));
    const color = `hsl(${(index*137.508+165)%360},70%,${index%3===0?66:74}%)`;
    const group = svgNode('g', {class:'evb-track', 'data-evb':evb});
    group.append(svgNode('title', {}, `EVB ${evb}`));
    const path = records.map((r,i) => `${i?'H':'M'} ${x(r.date)} ${i?'V':''} ${positions.get(JSON.stringify([r.platform,evb]))}`).join(' ') + ` H ${x(dates[dates.length - 1])}`;
    group.append(svgNode('path', {class:'trajectory-hit', d:path, fill:'none',stroke:'transparent','stroke-width':8,'pointer-events':'stroke','aria-hidden':'true'}));
    group.append(svgNode('path', {class:'trajectory', d:path, fill:'none',stroke:color,'stroke-width':1.8,'stroke-linejoin':'round'}));
    records.forEach(r => {
      const circle = svgNode('circle', {cx:x(r.date),cy:positions.get(JSON.stringify([r.platform,evb])),r:3,fill:color,stroke:'#131e2d','stroke-width':1});
      circle.append(svgNode('title', {}, `EVB ${evb} · ${r.platform} · ${r.date} · #${r.number}`)); group.append(circle);
    });
    if (selected.has(evb)) labels.push({evb, color, points: records.map(record => ({
      x: x(record.date), y: positions.get(JSON.stringify([record.platform, evb]))
    }))});
    svg.append(group);
  });
  return {svg, labels};
}
const timeline = $('timeline-scroll');
let timelineZoom = 1, viewportWidth = timeline.clientWidth, renderedDates = [];
let lineLabels = [], lineLabelLayer = null;
function updateLineLabels() {
  if (!lineLabelLayer) return;
  lineLabelLayer.replaceChildren();
  const chartRight = Number(chart.getAttribute('width')) - 30;
  const visibleLeft = Math.max(126, timeline.scrollLeft + 8);
  const visibleRight = Math.min(chartRight, timeline.scrollLeft + timeline.clientWidth - 8);
  const maxY = Number(chart.getAttribute('height')) - 62;
  const occupied = [];
  for (const {evb, color, points} of lineLabels) {
    // Attach to the longest horizontal part currently in view, including a lone point.
    const segments = points.map((point, index) => ({
      left: Math.max(point.x, visibleLeft),
      right: Math.min(points[index + 1]?.x ?? chartRight, visibleRight),
      y: point.y
    })).filter(segment => segment.right >= segment.left).sort((a,b) => (b.right-b.left)-(a.right-a.left));
    if (!segments.length) continue;
    const segment = segments[0], name = `EVB ${evb}`, halfWidth = name.length * 3.6 + 5;
    const px = Math.max(visibleLeft + halfWidth, Math.min(visibleRight - halfWidth, (segment.left + segment.right) / 2));
    let py = segment.y - 10;
    for (let attempt = 0; attempt < lineLabels.length * 2 + 4; attempt++) {
      const candidate = segment.y + (attempt % 2 ? 20 + Math.floor(attempt / 2) * 18 : -10 - Math.floor(attempt / 2) * 18);
      if (candidate < 16 || candidate > maxY) continue;
      py = candidate;
      if (!occupied.some(box => Math.abs(px-box.x) < halfWidth+box.halfWidth && Math.abs(py-box.y) < 18)) break;
    }
    occupied.push({x:px,y:py,halfWidth});
    const anchorX = Math.max(segment.left, Math.min(segment.right, px));
    lineLabelLayer.append(svgNode('path', {d:`M ${anchorX} ${segment.y} L ${px} ${py < segment.y ? py + 4 : py - 13}`,fill:'none',stroke:color,'stroke-width':1,opacity:.65}));
    lineLabelLayer.append(svgNode('text', {class:'evb-line-label','data-evb-label':evb,x:px,y:py,
      'text-anchor':'middle','font-size':12,'font-weight':700,fill:color,stroke:'#131e2d',
      'stroke-width':4,'stroke-linejoin':'round','paint-order':'stroke'},name));
  }
}
function timelineAnchor(anchorX = viewportWidth / 2) {
  if (!renderedDates.length) return NaN;
  const width = Number(chart.getAttribute('width'));
  const fraction = Math.max(0, Math.min(1, (timeline.scrollLeft + anchorX - 126) / Math.max(1, width - 156)));
  const slot = fraction * (renderedDates.length - 1), index = Math.floor(slot);
  const from = day(renderedDates[index]), to = day(renderedDates[Math.min(index + 1, renderedDates.length - 1)]);
  return from + (slot - index) * (to - from);
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
  if (!hasData) {renderedDates = [];lineLabels = [];lineLabelLayer = null;}
  if (!hasData || !viewportWidth) return;
  const dates = recordedDates(data);
  const plotWidth = Math.max(1, viewportWidth - 156, (dates.length - 1) * dateSpacing(dates)) * timelineZoom;
  const {svg, labels} = makeChart(data, plotWidth + 156);
  chart.setAttribute('viewBox', svg.getAttribute('viewBox'));
  const [, , width, height] = svg.getAttribute('viewBox').split(' ');
  chart.setAttribute('width', width);
  chart.setAttribute('height', height);
  chart.style.width = width + 'px';
  chart.style.minWidth = width + 'px';
  chart.style.height = height + 'px';
  chart.replaceChildren(...svg.childNodes);
  lineLabels = labels;
  lineLabelLayer = svgNode('g', {class:'line-labels','pointer-events':'none'});
  chart.append(lineLabelLayer);
  const fraction = Number.isFinite(anchorDate) ? dateSlot(anchorDate, dates) / Math.max(1, dates.length - 1) : 0;
  renderedDates = dates;
  timeline.scrollLeft = Math.max(0, Math.min(Number(width) - viewportWidth, 126 + fraction * plotWidth - anchorX));
  draw();
  updateLineLabels();
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
timeline.addEventListener('scroll', updateLineLabels, {passive:true});
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
  selected = new Set([...selected].filter(evb => histories.has(evb)));
  showLogin(false);
  renderTimeline(anchorDate);
  updateSummary();
  updateSelection(false);
}
function updateStatus(message, state) {
  $('sync-status').textContent = message;
  $('sync-status').setAttribute('data-state', state);
  if (source.mode === 'google-oauth') {
    const configured = Boolean(globalThis.EVB_PUBLIC_CONFIG?.clientId);
    $('login-status').textContent = message;
    $('login-status').setAttribute('data-state', configured ? state : 'error');
    $('connect-google').disabled = !configured || state === 'loading';
    $('connect-google').textContent = !configured ? 'Sign-in not enabled yet' :
      state === 'loading' ? 'Loading your timeline…' : 'Sign in with Google';
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
      $('remember-google').checked = oauthClient.remembering;
      $('disconnect-google').hidden = false;
      if (activeRequest) refreshQueued = true; else refreshSheet();
    }
  });
  $('remember-google').checked = oauthClient.remembering;
  $('remember-google').addEventListener('change', event => {
    $('remember-google').checked = oauthClient.setRemember(event.target.checked);
  });
  $('connect-google').hidden = false;
  $('connect-google').addEventListener('click', event => {event.stopPropagation(); oauthClient.connect();});
  $('disconnect-google').addEventListener('click', event => {
    event.stopPropagation(); oauthClient.disconnect(); $('remember-google').checked = false;
  });
  clearLiveData(config.clientId ? 'Sign in with a Google account that can view the source spreadsheet.' :
    'Google sign-in has not been enabled for this website yet. Please contact the site administrator to finish setup.');
  oauthClient.restore();
  setInterval(() => {if (!document.hidden && oauthClient.connected) refreshSheet();}, source.refreshSeconds * 1000);
} else if (source.mode === 'apps-script') {
  refreshSheet();
  setInterval(() => {if (!document.hidden) refreshSheet();}, source.refreshSeconds * 1000);
} else {
  $('refresh-sheet').disabled = true;
  updateStatus('Local snapshot · Open the deployed company app to sync Google Sheets.', 'saved');
}
