const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createClient} = require('../chart/evb_google_auth.js');
const EVBData = require('../chart/evb_data.js');
const COLUMNS = ['#', 'Platform / Place', 'EVB / DVB', 'Change date', 'History'];

function fixture({status = 200, fetch: customFetch} = {}) {
  let auth, authorized = 0;
  const calls = [], cleared = [], timers = new Map();
  const data = [
    {sheets: [{properties: {title: "EVB's table", gridProperties: {rowCount: 50, columnCount: 8}}}]},
    {valueRanges: [{values: [COLUMNS]}]},
    {valueRanges: [ [[1],[2]], [['SW-A'],['SW-B']], [['DEMO'],['DEMO']], [['9/1'],['9/2']], [[false],[true]] ].map(values => ({values}))}
  ];
  const client = createClient({
    clientId: 'example.apps.googleusercontent.com', spreadsheetId: 'test-sheet', year: 2026,
    identity: () => ({initTokenClient(config) {auth = config; return {requestAccessToken() {}};}, hasGrantedAllScopes: response => response.granted !== false}),
    fetch: customFetch || (async (url, options) => {calls.push({url, options}); return {ok:status === 200, status, json:async () => data[(calls.length - 1) % 3]};}),
    setTimeout: (callback, ms) => {const id = Symbol(); timers.set(id, {callback, ms}); return id;},
    clearTimeout: id => timers.delete(id),
    onAuthorized: () => authorized++, onCleared: message => cleared.push(message), onStatus: message => cleared.push(message)
  });
  function authorize(extra = {}) {client.connect(); auth.callback({access_token:'test-only-token',expires_in:3600,...extra});}
  return {client, authorize, calls, cleared, timers, get auth() {return auth;}, get authorized() {return authorized;}};
}

test('public website has no initial records, platform names, or pre-rendered tracks', () => {
  const html = fs.readFileSync(new URL('../public/evb.html', `file://${__filename}`), 'utf8');
  const payload = JSON.parse(html.match(/id="evb-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.records, []);
  assert.deepEqual(payload.platforms, []);
  assert.equal(payload.source.mode, 'google-oauth');
  assert.ok(!html.includes('class="evb-track"'));
  assert.ok(!html.includes('localStorage'));
  assert.ok(!html.includes('sessionStorage'));
  assert.match(html, /src="\.\/config.js"/);
});

test('no Google Sheets request is made without authorization', async () => {
  const f = fixture();
  await assert.rejects(f.client.read(), /sign-in required/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.client.connected, false);
});

test('authorized requests use bearer headers and select only five data columns', async () => {
  const f = fixture(); f.authorize();
  const result = await f.client.read();
  assert.equal(f.authorized, 1);
  assert.equal(EVBData.fromRows(result.rows, result.year).records.length, 2);
  assert.equal(result.sheetName, "EVB's table");
  for (const call of f.calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer test-only-token');
    assert.equal(call.options.cache, 'no-store');
    assert.ok(!call.url.includes('test-only-token'));
  }
  assert.deepEqual(new URL(f.calls[2].url).searchParams.getAll('ranges'),
    ['A','B','C','D','E'].map(letter => "'EVB''s table'!" + letter + '2:' + letter + '50'));
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} clears the session and displayed records`, async () => {
    const f = fixture({status}); f.authorize();
    const previous = f.client.version;
    await assert.rejects(f.client.read(), /could not be read/);
    assert.equal(f.client.connected, false);
    assert.ok(f.client.version > previous);
    assert.equal(f.cleared.length, 2);
  });
}

test('declined scope and expired tokens cannot authorize reading', () => {
  const f = fixture(); f.authorize({granted:false});
  assert.equal(f.client.connected, false);
  assert.equal(f.authorized, 0);
  f.authorize();
  [...f.timers.values()].find(timer => timer.ms === 3600000).callback();
  assert.equal(f.client.connected, false);
  assert.match(f.cleared.at(-1), /expired/);
});

test('disconnect prevents an in-flight response from restoring data', async () => {
  let finish;
  const f = fixture({fetch: () => new Promise(resolve => {finish = resolve;})}); f.authorize();
  const reading = f.client.read();
  f.client.disconnect();
  finish({ok:true,status:200,json:async () => ({sheets:[]})});
  await assert.rejects(reading, /session changed/);
  assert.equal(f.client.connected, false);
});

test('disconnect also invalidates a delayed Google sign-in callback', () => {
  const f = fixture(); f.client.connect();
  const callback = f.auth.callback;
  f.client.disconnect();
  callback({access_token:'stale',expires_in:3600});
  assert.equal(f.authorized, 0);
  assert.equal(f.client.connected, false);
});

test('public page initializes empty and disconnect removes rendered data and details', () => {
  const html = fs.readFileSync(new URL('../public/evb.html', `file://${__filename}`), 'utf8');
  class Element {
    constructor() {this.children=[]; this.attrs={}; this.style={}; this.events={}; this.value=''; this.clientWidth=1000; this.scrollLeft=0;}
    setAttribute(key,value) {this.attrs[key]=String(value);}
    getAttribute(key) {return this.attrs[key];}
    removeAttribute(key) {delete this.attrs[key];}
    append(...nodes) {this.children.push(...nodes);}
    replaceChildren(...nodes) {this.children=nodes;}
    get childNodes() {return this.children;}
    addEventListener(key,callback) {this.events[key]=callback;}
    querySelectorAll() {return this.children.filter(node => node.attrs.class === 'evb-track');}
  }
  const elements = new Map();
  const element = id => {if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id);};
  element('evb-data').textContent = html.match(/id="evb-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  element('chart').setAttribute('width',1100);
  const context = vm.createContext({
    document:{body:new Element(),getElementById:element,createElement:()=>new Element(),createElementNS:()=>new Element(),addEventListener(){}},
    ResizeObserver:class{observe(){}}, setTimeout(){}, clearTimeout(){}, setInterval(){},
    AbortController, URL, EVB_PUBLIC_CONFIG:{clientId:''}
  });
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/application\/json|src=/.test(match[1])) vm.runInContext(match[2],context);
  }
  const run = source => vm.runInContext(source,context);
  assert.equal(run('data.records.length'),0);
  assert.equal(run('document.body.getAttribute("data-auth-required")'),'true');
  assert.equal(element('login-screen').hidden,false);
  assert.equal(element('refresh-sheet').disabled,true);
  run('applyData({year:2026,platforms:["DEMO-PLATFORM"],records:[{evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-09-01",number:1,history:false}]});select("DEMO-EVB")');
  assert.equal(element('chart').querySelectorAll().length,1);
  assert.equal(run('document.body.getAttribute("data-auth-required")'),'false');
  assert.equal(element('login-screen').hidden,true);
  assert.match(element('detail-title').textContent,/DEMO-EVB/);
  element('disconnect-google').events.click({stopPropagation(){}});
  assert.equal(run('data.records.length'),0);
  assert.equal(run('histories.size'),0);
  assert.equal(run('selected'),null);
  assert.equal(run('document.body.getAttribute("data-auth-required")'),'true');
  assert.equal(element('login-screen').hidden,false);
  assert.equal(element('chart').querySelectorAll().length,0);
  assert.equal(element('detail-title').textContent,'EVB details');
  assert.ok(!JSON.stringify(element('chart').children).includes('DEMO-PLATFORM'));
});
