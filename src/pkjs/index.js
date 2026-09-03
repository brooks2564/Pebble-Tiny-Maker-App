/**
 * TinyMaker Print Monitor - PebbleKit JS bridge.
 *
 * Pebble hardware has no WiFi radio, so all networking lives here on the phone
 * (Plan section 3.1). This module:
 *   - connects to the MQTT broker over WebSockets and learns the printer's
 *     sensors from Home Assistant auto-discovery, or polls the dashboard as a
 *     fallback (Plan section 3.2)
 *   - normalises whatever it gets into the AppMessage schema (Plan section 6)
 *   - rate-limits while printing and backs off while idle (Plan section 3.3)
 *   - flags staleness rather than letting the watch freeze on old numbers
 *   - derives one-shot EVENTs so the watch can vibe without re-deriving state
 */

var Clay = require('@rebble/clay');
var clayConfig = require('../../config.json');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var normalize = require('./normalize');
var mqtt = require('./mqtt_client');
var haDiscovery = require('./ha_discovery');
var dashboard = require('./dashboard_poll');

var CONN = normalize.CONN;
var PHASE = normalize.PHASE;

// Send at most this often even if data keeps changing; a phase change or a
// manual refresh bypasses it.
var MIN_SEND_GAP_MS = 8000;
// If the source goes quiet this long, tell the watch so it can show "stale".
var STALE_AFTER_MS = 50000;

var settings = null;
var mqttClient = null;
var registry = null;
var poller = null;
var pollTimer = null;
var staleTimer = null;

var lastSentAt = 0;
var lastPhase = -1;
var lastSnapshot = null;
var connState = CONN.UNKNOWN;
var connMsg = '';
var usingDashboard = false;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

var DEFAULTS = {
  source: 'auto',
  mqttUrl: '',
  mqttUser: '',
  mqttPass: '',
  mqttPrefix: 'homeassistant',
  mqttTopic: '',
  dashHost: 'tinymaker.local',
  dashPath: '',
  activeInterval: '20',
  idleInterval: '180',
  vibrate: true
};

function loadSettings() {
  var out = {};
  for (var k in DEFAULTS) {
    if (!DEFAULTS.hasOwnProperty(k)) continue;
    var stored = null;
    try { stored = localStorage.getItem('tm_' + k); } catch (e) { stored = null; }
    if (stored === null || stored === undefined) {
      out[k] = DEFAULTS[k];
    } else if (typeof DEFAULTS[k] === 'boolean') {
      out[k] = stored === 'true';
    } else {
      out[k] = stored;
    }
  }
  return out;
}

function saveSettings(values) {
  for (var k in DEFAULTS) {
    if (!DEFAULTS.hasOwnProperty(k)) continue;
    if (!(k in values)) continue;
    var v = values[k];
    if (v === null || v === undefined) continue;
    // JSON.stringify is the only safe number->string conversion in this JS
    // engine (see CLAUDE.md); booleans and strings pass through cleanly.
    var s = (typeof v === 'string') ? v : JSON.stringify(v);
    try { localStorage.setItem('tm_' + k, s); } catch (e) { /* full/blocked */ }
  }
}

function intervalMs(snapshot) {
  var active = snapshot && normalize.isActive(snapshot.phase);
  var secs = Number(active ? settings.activeInterval : settings.idleInterval);
  if (!isFinite(secs) || secs < 5) secs = active ? 20 : 180;
  return secs * 1000;
}

function isConfigured() {
  if (settings.source === 'mqtt')      return !!settings.mqttUrl;
  if (settings.source === 'dashboard') return !!settings.dashHost;
  return !!(settings.mqttUrl || settings.dashHost);
}

// ---------------------------------------------------------------------------
// Sending to the watch
// ---------------------------------------------------------------------------

function setConn(state, msg) {
  connState = state;
  connMsg = String(msg || '').substring(0, 24);
}

function sendConnOnly() {
  Pebble.sendAppMessage({
    CONN_STATE: connState,
    CONN_MSG: connMsg
  }, null, function (e) {
    console.log('TM: conn send failed: ' + (e && e.error && e.error.message));
  });
}

function sendSnapshot(snapshot, opts) {
  opts = opts || {};
  var now = Date.now();
  var phaseChanged = snapshot.phase !== lastPhase;

  if (!opts.force && !phaseChanged && (now - lastSentAt) < MIN_SEND_GAP_MS) {
    return;
  }

  var event = normalize.EVENT.NONE;
  if (lastPhase >= 0 && settings.vibrate) {
    event = normalize.eventFor(lastPhase, snapshot.phase);
  }

  var payload = {
    PHASE: snapshot.phase,
    CURRENT_LAYER: snapshot.currentLayer,
    TOTAL_LAYERS: snapshot.totalLayers,
    PERCENT_COMPLETE: snapshot.percent,
    TIME_REMAINING_SEC: snapshot.remainingSec,
    ELAPSED_SEC: snapshot.elapsedSec,
    FINISH_EPOCH: snapshot.finishEpoch,
    RESIN_USED_ML: snapshot.resinUsedMl,
    RESIN_LEFT_ML: snapshot.resinLeftMl,
    RESIN_LEFT_PCT: snapshot.resinLeftPct,
    LOW_RESIN_FLAG: snapshot.lowResin ? 1 : 0,
    PRINT_NAME: snapshot.printName,
    LAST_UPDATE_EPOCH: snapshot.lastUpdateEpoch,
    CONN_STATE: connState,
    CONN_MSG: connMsg
  };
  if (event !== normalize.EVENT.NONE) payload.EVENT = event;

  lastSentAt = now;
  lastPhase = snapshot.phase;
  lastSnapshot = snapshot;

  Pebble.sendAppMessage(payload, null, function (e) {
    console.log('TM: send failed: ' + (e && e.error && e.error.message));
  });

  scheduleStaleCheck();
  reschedulePoll(snapshot);
}

function scheduleStaleCheck() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(function () {
    // The watch flags staleness off its own clock too, but saying so explicitly
    // means the user sees *why* the numbers stopped moving.
    setConn(CONN.ERROR, usingDashboard ? 'printer not answering' : 'broker quiet');
    sendConnOnly();
  }, STALE_AFTER_MS);
}

// ---------------------------------------------------------------------------
// MQTT path
// ---------------------------------------------------------------------------

function startMqtt(onFailure) {
  if (!settings.mqttUrl) { onFailure('no broker URL'); return; }
  if (!mqtt.isSupported()) { onFailure('no WebSocket support'); return; }

  registry = new haDiscovery.Registry(settings.mqttPrefix);
  setConn(CONN.CONNECTING, 'connecting to broker');
  sendConnOnly();

  var settled = false;
  mqttClient = new mqtt.MqttClient({
    url: settings.mqttUrl,
    username: settings.mqttUser,
    password: settings.mqttPass,
    clientId: 'pebble-tinymaker'
  }, {
    onConnect: function () {
      settled = true;
      usingDashboard = false;
      setConn(CONN.CONNECTED, 'broker ok');
      sendConnOnly();

      var topics = haDiscovery.discoveryTopics(settings.mqttPrefix);
      if (settings.mqttTopic) topics.push(settings.mqttTopic);
      mqttClient.subscribe(topics);
      scheduleStaleCheck();
    },

    onMessage: function (topic, payload) {
      if (registry.isDiscoveryTopic(topic)) {
        var newTopic = registry.addConfig(topic, payload);
        if (newTopic) mqttClient.subscribe([newTopic]);
        return;
      }
      if (!registry.addState(topic, payload)) return;
      sendSnapshot(registry.snapshot());
    },

    onError: function (msg) {
      if (settled) {
        setConn(CONN.ERROR, msg);
        sendConnOnly();
      }
      onFailure(msg);
    },

    onClose: function () {
      setConn(CONN.ERROR, 'broker disconnected');
      sendConnOnly();
      // Reconnect on the idle cadence rather than hammering the socket.
      setTimeout(start, Number(settings.idleInterval) * 1000 || 180000);
    }
  });

  mqttClient.connect();
}

// ---------------------------------------------------------------------------
// Dashboard-polling path
// ---------------------------------------------------------------------------

function startDashboard() {
  usingDashboard = true;
  poller = new dashboard.DashboardPoller({
    host: settings.dashHost,
    path: settings.dashPath || null
  });
  setConn(CONN.CONNECTING, 'polling dashboard');
  sendConnOnly();
  pollNow();
}

function pollNow(force) {
  if (!poller) return;
  poller.poll(function (snapshot, err) {
    if (err || !snapshot) {
      setConn(CONN.ERROR, err || 'no data');
      sendConnOnly();
      reschedulePoll(lastSnapshot);
      return;
    }
    setConn(CONN.CONNECTED, 'dashboard ok');
    sendSnapshot(snapshot, { force: force });
  });
}

// The ESP32 serves the dashboard in the gaps between layer moves (Plan section
// 3.3), so poll gently and back right off when nothing is printing.
function reschedulePoll(snapshot) {
  if (pollTimer) clearTimeout(pollTimer);
  if (!poller) return;
  pollTimer = setTimeout(function () { pollNow(); }, intervalMs(snapshot));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function stopAll() {
  if (mqttClient) { mqttClient.close(); mqttClient = null; }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  poller = null;
  registry = null;
}

function start() {
  stopAll();
  settings = loadSettings();

  if (!isConfigured()) {
    setConn(CONN.UNCONFIGURED, 'open app settings');
    sendConnOnly();
    return;
  }

  if (settings.source === 'dashboard') {
    startDashboard();
    return;
  }

  startMqtt(function (msg) {
    console.log('TM: MQTT unavailable (' + msg + ')');
    if (settings.source === 'mqtt') {
      setConn(CONN.ERROR, msg);
      sendConnOnly();
      return;
    }
    if (mqttClient) { mqttClient.close(); mqttClient = null; }
    if (settings.dashHost) {
      startDashboard();
    } else {
      setConn(CONN.ERROR, msg);
      sendConnOnly();
    }
  });
}

// ---------------------------------------------------------------------------
// Pebble events
// ---------------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('TinyMaker Monitor pkjs ready');
  start();
});

Pebble.addEventListener('appmessage', function (e) {
  if (!e.payload || !e.payload.REQUEST_REFRESH) return;
  console.log('TM: manual refresh requested');
  if (poller) {
    pollNow(true);
  } else if (registry && registry.hasData()) {
    sendSnapshot(registry.snapshot(), { force: true });
  } else {
    start();               // nothing cached yet - rebuild the connection
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  try {
    var parsed = clay.getSettings(e.response, false);
    var values = {};
    for (var k in parsed) {
      if (parsed.hasOwnProperty(k) && parsed[k] && 'value' in parsed[k]) {
        values[k] = parsed[k].value;
      }
    }
    saveSettings(values);
    lastPhase = -1;        // don't fire an event off a settings change
    start();
  } catch (err) {
    console.log('TM: bad config response: ' + err);
  }
});
