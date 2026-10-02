const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createClient} = require('../chart/evb_google_auth.js');
const EVBData = require('../chart/evb_data.js');
const COLUMNS = ['#', 'Platform / Place', 'EVB / DVB', 'Change date', 'History'];

function fixture({status = 200, fetch: customFetch, storage = null} = {}) {
  let auth, authorized = 0;
  const calls = [], cleared = [], timers = new Map();
  const data = [
    {sheets: [{properties: {title: "EVB's table", gridProperties: {rowCount: 50, columnCount: 8}}}]},
    {valueRanges: [{values: [COLUMNS]}]},
    {valueRanges: [ [[1],[2]], [['SW-A'],['SW-B']], [['DEMO'],['DEMO']], [['9/1'],['9/2']], [[false],[true]] ].map(values => ({values}))}
  ];
  const client = createClient({
    clientId: 'example.apps.googleusercontent.com', spreadsheetId: 'test-sheet', year: 2026, storage,
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
  assert.ok(!html.includes('sessionStorage'));
  assert.match(html, /<script id="public-config">globalThis.EVB_PUBLIC_CONFIG = /);
  assert.doesNotMatch(html, /src="\.\/config.js"/);
});

function memoryStorage() {
  const values = new Map();
  return {values, getItem:key=>values.get(key) ?? null,
    setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
}
const savedSessionKey = 'evb-auth:example.apps.googleusercontent.com:test-sheet:session';

test('remember is opt-in and restores an unexpired session without a Google popup', async () => {
  const storage = memoryStorage();
  const first = fixture({storage});
  first.authorize();
  assert.equal(storage.values.size,0,'No credentials are saved by default');
  first.client.setRemember(true);
  await first.client.read();
  const saved = JSON.parse(storage.getItem(savedSessionKey));
  assert.deepEqual(Object.keys(saved).sort(),['expiresAt','token'],'Sheet records are never persisted');
  assert.equal(saved.token,'test-only-token');
  const reopened = fixture({storage});
  assert.equal(reopened.client.remembering,true);
  assert.equal(reopened.client.restore(),true);
  assert.equal(reopened.authorized,1,'Restoration triggers a fresh authorized Sheets read');
  assert.equal(reopened.auth,undefined,'Restoration does not request a Google popup');
  assert.equal(reopened.client.connected,true);
  await reopened.client.read();
  assert.equal(reopened.calls.length,3);
});

test('expired or invalid remembered sessions are removed', () => {
  for (const saved of ['{invalid',JSON.stringify({token:'old',expiresAt:Date.now()-1}),
    JSON.stringify({token:'old',expiresAt:Date.now()+7200000})]) {
    const storage=memoryStorage(), first=fixture({storage});
    first.client.setRemember(true);
    storage.setItem(savedSessionKey,saved);
    const reopened=fixture({storage});
    assert.equal(reopened.client.restore(),false);
    assert.equal(reopened.client.connected,false);
    assert.equal(storage.getItem(savedSessionKey),null);
  }
});

test('disconnect, expiry, and permission denial remove saved credentials', async () => {
  for (const action of ['disconnect','expiry','denied']) {
    const storage=memoryStorage(), f=fixture({storage,status:action==='denied'?403:200});
    f.client.setRemember(true); f.authorize();
    assert.ok(storage.getItem(savedSessionKey));
    if (action==='disconnect') f.client.disconnect();
    else if (action==='expiry') [...f.timers.values()].find(timer=>timer.ms===3600000).callback();
    else await assert.rejects(f.client.read());
    assert.equal(storage.getItem(savedSessionKey),null);
    assert.equal(fixture({storage}).client.restore(),false);
    if (action==='disconnect') assert.equal(storage.values.size,0,'Disconnect also forgets the preference');
  }
});

test('forgetting a device keeps the current session but stops future restore', () => {
  const storage=memoryStorage(), f=fixture({storage});
  f.client.setRemember(true); f.authorize(); f.client.setRemember(false);
  assert.equal(f.client.connected,true);
  assert.equal(storage.values.size,0);
  assert.equal(fixture({storage}).client.restore(),false);
});

test('blocked browser storage still permits normal sign-in', () => {
  const storage={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
  const f=fixture({storage});
  assert.equal(f.client.setRemember(true),false);
  assert.equal(f.client.restore(),false);
  f.authorize();
  assert.equal(f.client.connected,true);
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

for (const configured of [false, true]) test(`public page boots with ${configured ? 'its generated configuration' : 'missing configuration'} and disconnect clears data`, () => {
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
  let requestedClient, popupRequests = 0;
  const documentEvents = {};
  const context = vm.createContext({
    document:{body:new Element(),getElementById:element,createElement:()=>new Element(),createElementNS:()=>new Element(),addEventListener(name,callback){documentEvents[name]=callback;}},
    ResizeObserver:class{observe(){}}, setTimeout(){}, clearTimeout(){}, setInterval(){},
    AbortController, URL,
    google:{accounts:{oauth2:{initTokenClient(options) {
      requestedClient = options.client_id;
      return {requestAccessToken() {popupRequests++;}};
    }}}}
  });
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/application\/json|src=/.test(match[1])) {
      vm.runInContext(match[2],context);
      if (!configured && /id="public-config"/.test(match[1])) vm.runInContext('EVB_PUBLIC_CONFIG.clientId=""',context);
    }
  }
  const run = source => vm.runInContext(source,context);
  assert.equal(run('data.records.length'),0);
  assert.equal(run('document.body.getAttribute("data-auth-required")'),'true');
  assert.equal(element('login-screen').hidden,false);
  assert.equal(element('connect-google').disabled,!configured);
  assert.equal(element('connect-google').textContent,configured ? 'Sign in with Google' : 'Sign-in not enabled yet');
  if (configured) {
    const expected = JSON.parse(html.match(/<script id="public-config">globalThis.EVB_PUBLIC_CONFIG = ([\s\S]*?);\s*<\/script>/)[1]).clientId;
    element('connect-google').events.click({stopPropagation(){}});
    assert.equal(popupRequests,1,'Click requests the Google sign-in popup');
    assert.equal(requestedClient,expected);
  } else {
    assert.equal(element('login-status').getAttribute('data-state'),'error');
  }
  assert.equal(element('refresh-sheet').disabled,true);
  run('applyData({year:2026,platforms:["DEMO-PLATFORM"],records:[{evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-09-01",number:1,history:false}]});select("DEMO-EVB")');
  assert.equal(element('chart').querySelectorAll().length,1);
  assert.equal(run('document.body.getAttribute("data-auth-required")'),'false');
  assert.equal(element('login-screen').hidden,true);
  assert.match(element('detail-title').textContent,/DEMO-EVB/);
  run('applyData({...data,records:[...data.records,{evb:"DEMO-B",platform:"DEMO-PLATFORM",date:"2026-09-03",number:2,history:false},{evb:"DEMO-C",platform:"DEMO-PLATFORM",date:"2026-09-05",number:3,history:false}]})');
  const choose = id => element('evb-list').children.find(button => button.attrs['data-evb-choice'] === id).events.click({stopPropagation(){}});
  const bright = () => element('chart').querySelectorAll().filter(track => track.style.opacity === '1').map(track => track.attrs['data-evb']).sort();
  const dates = () => element('chart').children.filter(node => node.attrs.class === 'date-tick').map(node => node.attrs['data-date']).sort();
  choose('DEMO-B');
  assert.equal(run('selected.size'),2);
  assert.deepEqual(bright(),['DEMO-B','DEMO-EVB']);
  assert.deepEqual(dates(),['2026-09-01','2026-09-03']);
  assert.equal(element('selection').textContent,'2 selected');
  const table = element('detail-content').children[0].children[0];
  assert.equal(table.children[0].children[0].children[0].textContent,'EVB');
  assert.equal(table.children[1].children.length,2);
  element('search').value='DEMO-C';
  element('search').events.input();
  choose('DEMO-C');
  assert.equal(run('selected.size'),3,'Filtering the list preserves other selections');
  element('search').value='';
  element('search').events.input();
  choose('DEMO-C');
  assert.deepEqual(bright(),['DEMO-B','DEMO-EVB'],'Click again deselects just that device');
  run('zoomTimeline(2);applyData({...data,records:[...data.records]})');
  assert.equal(run('selected.size'),2,'Refresh retains multiple selections');
  assert.equal(run('timelineZoom'),2);
  assert.deepEqual(dates(),['2026-09-01','2026-09-03']);
  documentEvents.click({target:{closest:()=>element('search')}});
  assert.equal(run('selected.size'),2,'Controls do not clear selection');
  documentEvents.click({target:{closest:()=>null}});
  assert.equal(run('selected.size'),0,'Blank page space clears every selection');
  assert.equal(bright().length,3);
  choose('DEMO-B');choose('DEMO-C');
  element('chart').events.click({target:{closest:()=>null}});
  assert.equal(run('selected.size'),0,'Blank chart space clears every selection');
  assert.equal(bright().length,3);
  choose('DEMO-B');choose('DEMO-C');
  run('applyData({...data,records:data.records.filter(record=>record.evb!=="DEMO-B")})');
  assert.deepEqual(bright(),['DEMO-C'],'Refresh drops removed devices and retains remaining selections');
  run('select(null);applyData({...data,records:[{evb:"DEMO-B",platform:"DEMO-PLATFORM",date:"2027-01-01",number:4},{evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-09-01",number:1},{evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-09-02",number:2},{evb:"DEMO-B",platform:"DEMO-PLATFORM",date:"2026-09-02",number:3}]})');
  assert.deepEqual(dates(),['2026-09-01','2026-09-02','2027-01-01'],'Axis contains only unique recorded dates, sorted across years');
  const ticks = () => element('chart').children.filter(node => node.attrs.class === 'date-tick');
  const positions = ticks().map(node => Number(node.attrs.x));
  assert.ok(Math.abs((positions[1]-positions[0])-(positions[2]-positions[1]))<0.001,'One-day and multi-month gaps occupy equal widths');
  assert.deepEqual(ticks().map(node=>node.textContent),dates(),'Cross-year labels include years');
  for (const track of element('chart').querySelectorAll()) {
    for (const circle of track.children.filter(node => node.attrs.cx !== undefined)) {
      const date = circle.children[0].textContent.split(' · ')[2];
      assert.equal(circle.attrs.cx,ticks().find(tick=>tick.attrs['data-date']===date).attrs.x,'Record points align with ordinal date ticks');
    }
  }
  const anchor = run('timelineAnchor()');
  run('zoomTimeline(3)');
  assert.ok(Math.abs(run('timelineAnchor()')-anchor)<1,'Ordinal zoom preserves the date beneath the viewport center');
  run('applyData({...data,records:[...data.records,{evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-10-01",number:5}]})');
  assert.ok(Math.abs(run('timelineAnchor()')-anchor)<1,'Adding a date preserves the viewport anchor');
  choose('DEMO-B');
  assert.deepEqual(dates(),['2026-09-02','2027-01-01']);
  const filteredPositions=ticks().map(node=>Number(node.attrs.x));
  assert.ok(filteredPositions[0]>126,'Selection preserves the original date slots for dimmed lines');
  assert.equal(filteredPositions[1],Number(element('chart').attrs.width)-30);
  run('select(null);applyData({...data,records:[{evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-09-01",number:1}]})');
  assert.deepEqual(dates(),['2026-09-01']);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(element('chart').children)),'Single-date geometry is finite');
  run('applyData({...data,records:Array.from({length:25},(_,i)=>({evb:"DEMO-EVB",platform:"DEMO-PLATFORM",date:"2026-09-"+String(i+1).padStart(2,"0"),number:i+1}))});zoomTimeline(1)');
  assert.equal(dates().length,25,'Dense axes retain every recorded date');
  assert.ok(Number(element('chart').attrs.width)>element('timeline-scroll').clientWidth,'Dense axes scroll horizontally');
  assert.ok(Number(ticks()[1].attrs.x)-Number(ticks()[0].attrs.x)>=64,'Labels retain readable spacing');
  run('applyData({...data,platforms:["BOARD-A","BOARD-B","BOARD-C","BOARD-D"],records:[{evb:"DEMO-EVB",platform:"BOARD-A",date:"2026-09-01",number:1},{evb:"DEMO-EVB",platform:"BOARD-C",date:"2026-09-03",number:2},{evb:"DEMO-B",platform:"BOARD-C",date:"2026-09-02",number:3},{evb:"DEMO-B",platform:"BOARD-D",date:"2026-09-04",number:4},{evb:"DEMO-C",platform:"BOARD-B",date:"2026-09-01",number:5}]})');
  const boardTicks = () => element('chart').children.filter(node => node.attrs.class === 'platform-tick');
  const boards = () => boardTicks().map(node => node.textContent);
  const brightBoards = () => boardTicks().filter(node=>node.attrs.opacity==='1').map(node=>node.textContent);
  const geometry = () => element('chart').querySelectorAll().map(track=>({id:track.attrs['data-evb'],path:track.children.find(node=>node.attrs.class==='trajectory').attrs.d}));
  const allGeometry = geometry();
  const allBoardPositions = boardTicks().map(node=>node.attrs.y);
  const clickLine = id => {
    const line=element('chart').querySelectorAll().find(track=>track.attrs['data-evb']===id);
    element('chart').events.click({target:{closest:()=>line},stopPropagation(){}});
  };
  clickLine('DEMO-EVB');
  assert.deepEqual(bright(),['DEMO-EVB']);
  assert.deepEqual(boards(),['BOARD-A','BOARD-B','BOARD-C','BOARD-D'],'All board rows remain visible');
  assert.deepEqual(brightBoards(),['BOARD-A','BOARD-C'],'Only related board labels stay bright');
  assert.equal(element('evb-list').children.length,3);
  assert.deepEqual(geometry(),allGeometry,'Selecting a line preserves every trajectory and date position');
  assert.deepEqual(boardTicks().map(node=>node.attrs.y),allBoardPositions,'Board positions stay fixed');
  for (const track of element('chart').querySelectorAll()) {
    assert.notEqual(track.style.display,'none','Dimmed lines remain visible and clickable');
    assert.equal(track.style.opacity,track.attrs['data-evb']==='DEMO-EVB'?'1':'0.25');
    const hit=track.children.find(node=>node.attrs.class==='trajectory-hit');
    assert.equal(hit.attrs['pointer-events'],'stroke');
    assert.ok(Number(hit.attrs['stroke-width'])>=8,'Lines have a wider click target');
  }
  clickLine('DEMO-B');
  assert.deepEqual(bright(),['DEMO-B','DEMO-EVB'],'Clicking a dim line adds it to the selection');
  assert.deepEqual(brightBoards(),['BOARD-A','BOARD-C','BOARD-D'],'Multiple selections brighten the union of related boards');
  run('zoomTimeline(2);applyData({...data,records:[...data.records]})');
  assert.deepEqual(bright(),['DEMO-B','DEMO-EVB']);
  assert.deepEqual(brightBoards(),['BOARD-A','BOARD-C','BOARD-D'],'Zoom and refresh preserve highlighting');
  clickLine('DEMO-EVB');
  assert.deepEqual(bright(),['DEMO-B'],'Clicking a bright line again dims it');
  assert.deepEqual(brightBoards(),['BOARD-C','BOARD-D']);
  choose('DEMO-C');
  assert.deepEqual(bright(),['DEMO-B','DEMO-C'],'Sidebar and line selections stay in sync');
  element('chart').events.click({target:{closest:()=>null}});
  assert.deepEqual(brightBoards(),boards(),'Blank chart space restores all board brightness');
  assert.equal(bright().length,3);
  clickLine('DEMO-B');
  documentEvents.click({target:{closest:()=>null}});
  assert.deepEqual(brightBoards(),boards(),'Blank page space restores all board brightness');
  assert.equal(bright().length,3);
  element('disconnect-google').events.click({stopPropagation(){}});
  assert.equal(run('data.records.length'),0);
  assert.equal(run('histories.size'),0);
  assert.equal(run('selected.size'),0);
  assert.equal(run('document.body.getAttribute("data-auth-required")'),'true');
  assert.equal(element('login-screen').hidden,false);
  assert.equal(element('chart').querySelectorAll().length,0);
  assert.equal(element('detail-title').textContent,'EVB details');
  assert.ok(!JSON.stringify(element('chart').children).includes('DEMO-PLATFORM'));
});
