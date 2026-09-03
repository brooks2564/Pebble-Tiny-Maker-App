#!/usr/bin/env node
/**
 * Mock TinyMaker printer - Plan section 9's "small standalone script that
 * publishes synthetic status messages", so the watch-side logic can be driven
 * through every phase without tying up a real resin print for two hours.
 *
 * Serves the same /api/status and /api/config shapes as firmware 0.16.2
 * (see docs/API-NOTES.md), and runs a scripted timeline that hits the states a
 * real print rarely reaches on demand: low-resin pause, finished, canceled and
 * a power-loss recovery prompt.
 *
 *   node scripts/mock-printer.js                # normal print, sped up
 *   node scripts/mock-printer.js --scenario lowresin
 *   node scripts/mock-printer.js --scenario finish --port 8080
 *
 * Then point the app's "Printer host" setting at this machine's IP:port.
 */

var http = require('http');

var args = process.argv.slice(2);
function arg(name, fallback) {
  var i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

var PORT = Number(arg('port', 8080));
var SCENARIO = arg('scenario', 'print');
var SPEED = Number(arg('speed', 20));      // layers per real second
var TOTAL_LAYERS = Number(arg('layers', 320));
var VAT_ML = 15;
var LOW_RESIN_ML = 2;

var startedAt = Date.now();
var CYCLE = [
  { code: 1, name: 'Curing',   ms: 14000 },
  { code: 2, name: 'Lifting',  ms: 2500 },
  { code: 3, name: 'Dropping', ms: 2000 }
];

function elapsedSec() { return Math.floor((Date.now() - startedAt) / 1000); }

function currentLayer() {
  return Math.min(TOTAL_LAYERS, Math.floor(elapsedSec() * SPEED / 10));
}

function phaseSlice() {
  var total = CYCLE.reduce(function (a, p) { return a + p.ms; }, 0);
  var into = (Date.now() - startedAt) % total;
  for (var i = 0; i < CYCLE.length; i++) {
    if (into < CYCLE[i].ms) return { p: CYCLE[i], into: into };
    into -= CYCLE[i].ms;
  }
  return { p: CYCLE[0], into: 0 };
}

function status() {
  var layer = currentLayer();
  var run = elapsedSec();
  var slice = phaseSlice();
  var perLayerSec = 18.5;
  var remaining = Math.max(0, Math.round((TOTAL_LAYERS - layer) * perLayerSec));
  var resinUsed = Math.round(layer * 0.026 * 10) / 10;
  var vatLeft = Math.max(0, Math.round((VAT_ML - resinUsed) * 10) / 10);

  var s = {
    ok: true,
    firmwareVersion: '0.16.2-mock',
    busy: true, paused: false, pausing: false,
    resuming: false, stopping: false, dryRun: false,
    canPause: true, canResume: false, canStop: true,
    state: slice.p.name, stateCode: slice.p.code,
    sdJob: '', sdJobName: '', resumePending: null,
    phaseTotalMs: slice.p.ms, phaseElapsedMs: slice.into,
    layerHeight: 0.1, model: 'MockDragon',
    currentLayer: layer, totalLayers: TOTAL_LAYERS,
    layerText: layer + ' / ' + TOTAL_LAYERS,
    resinUsedMl: resinUsed,
    runSecs: run, remainingSecs: remaining,
    vatRemainingMl: vatLeft, vatLow: vatLeft <= LOW_RESIN_ML,
    askRefill: true, webControl: true,
    wifiRssi: -56, ip: '127.0.0.1', uptimeSecs: run
  };

  // Scenarios kick in 20 s after start, so you have time to open the app and
  // watch the transition (and the vibe) actually happen.
  var triggered = run > 20;
  if (SCENARIO === 'lowresin' && triggered) {
    s.paused = true; s.busy = false; s.stateCode = 10;
    s.state = 'Paused'; s.vatLow = true; s.vatRemainingMl = 1.2;
  } else if (SCENARIO === 'finish' && triggered) {
    s.busy = false; s.state = 'Finished'; s.stateCode = 0;
    s.currentLayer = TOTAL_LAYERS; s.remainingSecs = 0;
  } else if (SCENARIO === 'cancel' && triggered) {
    s.busy = false; s.stopping = true; s.state = 'Stopped'; s.stateCode = 0;
  } else if (SCENARIO === 'powerloss' && triggered) {
    s.busy = false; s.state = 'Idle'; s.stateCode = 0;
    s.resumePending = { layer: s.currentLayer, job: 'MockDragon' };
  } else if (SCENARIO === 'idle') {
    s.busy = false; s.state = 'Idle'; s.stateCode = 0;
    s.currentLayer = 0; s.totalLayers = 0; s.remainingSecs = 0; s.runSecs = 0;
  }
  return s;
}

function config() {
  return {
    ok: true, vatMl: VAT_ML, lowResinMl: LOW_RESIN_ML, lowResinPause: true,
    askRefill: true, layerHeight: 0.1, mqttEnabled: false, mqttHost: '',
    mqttPort: 1883, mqttTopic: 'TinyMaker', webDashboardEnabled: true
  };
}

http.createServer(function (req, res) {
  var path = req.url.split('?')[0];
  var body, code = 200;
  if (path === '/api/status')      body = status();
  else if (path === '/api/config') body = config();
  else { code = 404; body = null; }

  if (body === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + path);      // matches the real firmware's 404 body
    return;
  }
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}).listen(PORT, function () {
  console.log('Mock TinyMaker on http://0.0.0.0:' + PORT +
              '  scenario=' + SCENARIO + '  (20s until it triggers)');
  console.log('  GET /api/status   GET /api/config');
});
