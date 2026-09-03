/**
 * Polls the printer's own web dashboard API.
 *
 * The plan filed this as the fallback path (section 3.2), but on firmware
 * 0.16.2 it is the one that actually works: MQTT ships disabled out of the box
 * (/api/config reports mqttEnabled:false), so this is the default source until
 * the user turns a broker on. GET /api/status is confirmed against a live
 * print - see docs/API-NOTES.md.
 *
 * Still undocumented and still LAN-only, so the probe list stays: if a firmware
 * update moves the endpoint, the poller re-probes instead of going dark.
 *
 * /api/config is fetched alongside it, but rarely - it carries vatMl (the VAT's
 * capacity, which /api/status never reports) and lowResinMl, without which the
 * resin gauge has no denominator.
 */

var normalize = require('./normalize');

var CANDIDATE_PATHS = [
  '/api/status',                                    // confirmed on 0.16.2
  '/status', '/status.json', '/api/print',
  '/printstatus', '/print_status', '/json', '/data', '/api/printer', '/info'
];

var CONFIG_PATH = '/api/config';
var CONFIG_TTL_MS = 30 * 60 * 1000;   // capacity settings change very rarely
var TIMEOUT_MS = 8000;

function normaliseHost(host) {
  host = String(host || '').trim();
  if (!host) return '';
  if (host.indexOf('http://') !== 0 && host.indexOf('https://') !== 0) {
    host = 'http://' + host;
  }
  while (host.length && host.charAt(host.length - 1) === '/') {
    host = host.substring(0, host.length - 1);
  }
  return host;
}

function getJson(url, onOk, onErr) {
  var xhr = new XMLHttpRequest();
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    try { xhr.abort(); } catch (e) { /* ignore */ }
    onErr('timeout');
  }, TIMEOUT_MS);

  xhr.onload = function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (xhr.status < 200 || xhr.status >= 300) { onErr('HTTP ' + xhr.status); return; }
    var doc;
    try { doc = JSON.parse(xhr.responseText); } catch (e) { onErr('not JSON'); return; }
    onOk(doc);
  };
  xhr.onerror = function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onErr('network');
  };
  try {
    xhr.open('GET', url);
    xhr.send();
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); onErr('bad URL'); }
  }
}

/** A JSON document is "usable" if at least one field maps onto the schema. */
function looksLikeStatus(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (normalize.isTinyMakerStatus(doc)) return true;
  var hits = 0;
  (function walk(o, depth) {
    if (depth > 3 || o === null || typeof o !== 'object') return;
    for (var k in o) {
      if (!o.hasOwnProperty(k)) continue;
      if (o[k] !== null && typeof o[k] === 'object') { walk(o[k], depth + 1); }
      else if (normalize.fieldFor(k)) hits++;
    }
  })(doc, 0);
  return hits >= 2;
}

/**
 * opts: { host, path } - path optional, skips probing when known.
 */
function DashboardPoller(opts) {
  this.host = normaliseHost(opts && opts.host);
  this.path = (opts && opts.path) || null;
  this.config = null;
  this.configFetchedAt = 0;
}

/** Refresh the cached /api/config if it's stale, then run `next`. */
DashboardPoller.prototype._withConfig = function (next) {
  var self = this;
  if (this.config && (Date.now() - this.configFetchedAt) < CONFIG_TTL_MS) {
    next(this.config);
    return;
  }
  getJson(this.host + CONFIG_PATH, function (doc) {
    if (doc && typeof doc === 'object') {
      self.config = doc;
      self.configFetchedAt = Date.now();
    }
    next(self.config);
  }, function () {
    next(self.config);          // config is a nice-to-have, never a blocker
  });
};

DashboardPoller.prototype.endpointUrl = function () {
  return this.path ? this.host + this.path : null;
};

/** onDone(snapshot|null, errorMessage|null) */
DashboardPoller.prototype.poll = function (onDone) {
  var self = this;
  if (!this.host) { onDone(null, 'no printer host'); return; }

  this._withConfig(function (cfg) {
    if (self.path) {
      getJson(self.host + self.path, function (doc) {
        if (!looksLikeStatus(doc)) { self.path = null; self._probe(onDone, null, cfg); return; }
        onDone(normalize.fromStatusDoc(doc, cfg), null);
      }, function (err) {
        self.path = null;                    // endpoint moved or went away
        self._probe(onDone, err, cfg);
      });
      return;
    }
    self._probe(onDone, null, cfg);
  });
};

DashboardPoller.prototype._probe = function (onDone, priorError, cfg) {
  var self = this;
  var i = 0;

  function tryNext() {
    if (i >= CANDIDATE_PATHS.length) {
      onDone(null, priorError || 'no status endpoint');
      return;
    }
    var path = CANDIDATE_PATHS[i++];
    getJson(self.host + path, function (doc) {
      if (looksLikeStatus(doc)) {
        self.path = path;                    // remember the winner
        onDone(normalize.fromStatusDoc(doc, cfg), null);
      } else {
        tryNext();
      }
    }, function () { tryNext(); });
  }
  tryNext();
};

module.exports = {
  DashboardPoller: DashboardPoller,
  normaliseHost: normaliseHost,
  looksLikeStatus: looksLikeStatus,
  CANDIDATE_PATHS: CANDIDATE_PATHS
};
