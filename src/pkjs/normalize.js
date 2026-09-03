/**
 * Shared normalisation: raw TinyMakerWifi data (from MQTT sensors or the
 * dashboard's status JSON) -> the AppMessage schema in docs/PLAN.md section 6.
 *
 * The exact field names TinyMakerWifi publishes are NOT publicly documented
 * (Plan section 10), so matching is deliberately fuzzy: every candidate name is
 * lower-cased with separators stripped, then tested against a list of aliases.
 * Add aliases here when a real printer turns out to use a different name.
 */

var PHASE = {
  IDLE: 0, PRINTING: 1, CURING: 2, LIFTING: 3, PEELING: 4,
  PAUSED: 5, LOW_RESIN_PAUSE: 6, FINISHED: 7, CANCELED: 8, POWER_LOSS: 9
};

var EVENT = {
  NONE: 0, FINISHED: 1, CANCELED: 2, LOW_RESIN_PAUSE: 3, POWER_LOSS: 4
};

var CONN = {
  UNKNOWN: 0, UNCONFIGURED: 1, CONNECTING: 2, CONNECTED: 3, ERROR: 4
};

function canon(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// field -> alias fragments, checked with indexOf against the canonical name.
var FIELD_ALIASES = {
  phase:        ['printstatus', 'printstate', 'status', 'state', 'phase', 'printerstate'],
  currentLayer: ['currentlayer', 'layercurrent', 'layer', 'curlayer', 'layernum'],
  totalLayers:  ['totallayer', 'layertotal', 'layers', 'totalslices', 'slicecount'],
  percent:      ['percent', 'progress', 'complete'],
  remainingSec: ['remainingsec', 'timeremaining', 'timeleft', 'eta', 'remainingtime'],
  elapsedSec:   ['elapsed', 'runsec', 'runtime', 'printtime', 'timeelapsed'],
  resinUsedMl:  ['resinused', 'usedresin', 'resinconsumed'],
  resinLeftMl:  ['resinleft', 'resinremaining', 'remainingresin', 'resinlevel',
                 'resinml', 'vatremaining', 'vatml'],
  resinLeftPct: ['resinpercent', 'resinpct', 'vatlevel', 'resinlevelpercent'],
  lowResin:     ['lowresin', 'resinlow', 'vatlow', 'resinalert', 'lowresinalert'],
  printName:    ['printname', 'filename', 'jobname', 'modelname', 'file', 'job']
};

/**
 * Which normalised field does this raw key correspond to? Longest alias wins so
 * "resinleftpercent" doesn't get claimed by the shorter "resinleft".
 */
var IGNORED_KEYS = [
  'text',          // layerText / resinText / vatText: display mirrors of real fields
  'phasetotal',    // per-layer phase timers, not the print phase
  'phaseelapsed',
  'lifetime',      // lifetime counters, not this print
  'statecode'      // numeric twin of `state`; the string is less ambiguous
];

function fieldFor(rawKey) {
  var c = canon(rawKey);
  if (!c) return null;
  for (var ig = 0; ig < IGNORED_KEYS.length; ig++) {
    if (c.indexOf(IGNORED_KEYS[ig]) !== -1) return null;
  }
  var best = null, bestLen = 0;
  for (var field in FIELD_ALIASES) {
    if (!FIELD_ALIASES.hasOwnProperty(field)) continue;
    var aliases = FIELD_ALIASES[field];
    for (var i = 0; i < aliases.length; i++) {
      if (c.indexOf(aliases[i]) !== -1 && aliases[i].length > bestLen) {
        best = field;
        bestLen = aliases[i].length;
      }
    }
  }
  return best;
}

var PHASE_WORDS = [
  [PHASE.LOW_RESIN_PAUSE, ['lowresin', 'resinlow', 'outofresin', 'noresin']],
  [PHASE.POWER_LOSS,      ['powerloss', 'poweroutage', 'recovery', 'resumeprompt']],
  [PHASE.CANCELED,        ['cancel', 'abort', 'stopped']],
  [PHASE.FINISHED,        ['finish', 'complete', 'done', 'success']],
  [PHASE.PAUSED,          ['pause', 'hold']],
  [PHASE.PEELING,         ['peel', 'separat']],
  [PHASE.LIFTING,         ['lift', 'raise', 'zmove', 'moving']],
  [PHASE.CURING,          ['cure', 'curing', 'expos', 'uv']],
  [PHASE.PRINTING,        ['print', 'running', 'active', 'busy', 'work']],
  [PHASE.IDLE,            ['idle', 'ready', 'standby', 'stop', 'off']]
];

function toPhase(raw) {
  if (typeof raw === 'number' && raw >= 0 && raw <= 9) return raw | 0;
  var c = canon(raw);
  if (!c) return PHASE.IDLE;
  for (var i = 0; i < PHASE_WORDS.length; i++) {
    var words = PHASE_WORDS[i][1];
    for (var j = 0; j < words.length; j++) {
      if (c.indexOf(words[j]) !== -1) return PHASE_WORDS[i][0];
    }
  }
  return PHASE.IDLE;
}

function toNumber(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw !== 'string') return null;
  // Handles "142", "1h 20m", "01:20:33", "68 %", "142.5ml"
  var hms = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + (hms[3] ? Number(hms[3]) : 0);
  }
  var hm = raw.match(/(\d+)\s*h.*?(\d+)\s*m/i);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
  var m = raw.match(/-?\d+(\.\d+)?/);
  // Number(), never parseInt/parseFloat: PebbleKit JS's parseInt truncates
  // values over three digits (see CLAUDE.md).
  return m ? Number(m[0]) : null;
}

function toBool(raw) {
  if (typeof raw === 'boolean') return raw;
  var c = canon(raw);
  return c === 'on' || c === 'true' || c === '1' || c === 'yes' ||
         c === 'problem' || c === 'low' || c === 'alert';
}

function clampInt(n, lo, hi) {
  n = Math.round(n);
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return n;
}

/**
 * Fold a raw key/value into an accumulating normalised object. Unknown keys are
 * ignored, so an unfamiliar firmware build degrades rather than breaking.
 */
function absorb(acc, rawKey, rawValue) {
  var field = fieldFor(rawKey);
  if (!field || rawValue === null || rawValue === undefined || rawValue === '') return acc;

  switch (field) {
    case 'phase':        acc.phase = toPhase(rawValue); break;
    case 'printName':    acc.printName = String(rawValue).substring(0, 24); break;
    case 'lowResin':     acc.lowResin = toBool(rawValue); break;
    default: {
      var n = toNumber(rawValue);
      if (n === null) break;
      // Some firmwares report times in minutes; anything under 1000 for a
      // remaining/elapsed field is far more likely minutes than seconds.
      if ((field === 'remainingSec' || field === 'elapsedSec') &&
          /min/i.test(String(rawKey))) {
        n = n * 60;
      }
      acc[field] = n;
      break;
    }
  }
  return acc;
}

/**
 * Fill in whatever the printer didn't report but we can derive, and clamp
 * everything into the ranges the AppMessage schema declares.
 */
function finalize(acc) {
  var out = {
    phase: acc.phase === undefined ? PHASE.IDLE : acc.phase,
    currentLayer: 0, totalLayers: 0, percent: 0,
    remainingSec: 0, elapsedSec: 0, finishEpoch: 0,
    resinUsedMl: 0, resinLeftMl: 0, resinLeftPct: 0,
    lowResin: !!acc.lowResin,
    printName: acc.printName || '',
    lastUpdateEpoch: Math.floor(Date.now() / 1000)
  };

  if (acc.currentLayer != null) out.currentLayer = clampInt(acc.currentLayer, 0, 65535);
  if (acc.totalLayers  != null) out.totalLayers  = clampInt(acc.totalLayers, 0, 65535);
  if (acc.remainingSec != null) out.remainingSec = clampInt(acc.remainingSec, 0, 4000000000);
  if (acc.elapsedSec   != null) out.elapsedSec   = clampInt(acc.elapsedSec, 0, 4000000000);
  if (acc.resinUsedMl  != null) out.resinUsedMl  = clampInt(acc.resinUsedMl, 0, 65535);
  if (acc.resinLeftMl  != null) out.resinLeftMl  = clampInt(acc.resinLeftMl, 0, 65535);
  if (acc.resinLeftPct != null) out.resinLeftPct = clampInt(acc.resinLeftPct, 0, 100);

  if (acc.percent != null) {
    out.percent = clampInt(acc.percent, 0, 100);
  } else if (out.totalLayers > 0) {
    out.percent = clampInt(out.currentLayer * 100 / out.totalLayers, 0, 100);
  }

  if (out.remainingSec > 0) {
    out.finishEpoch = Math.floor(Date.now() / 1000) + out.remainingSec;
  }

  // A low-resin flag during a pause is its own phase on the watch.
  if (out.lowResin && out.phase === PHASE.PAUSED) {
    out.phase = PHASE.LOW_RESIN_PAUSE;
  }

  return out;
}

/** Normalise a flat object of raw key/value pairs in one go. */
function fromObject(obj) {
  var acc = {};
  (function walk(o, prefix, depth) {
    if (depth > 3 || o === null || typeof o !== 'object') return;
    for (var k in o) {
      if (!o.hasOwnProperty(k)) continue;
      var v = o[k];
      if (v !== null && typeof v === 'object') {
        walk(v, k, depth + 1);
      } else {
        absorb(acc, k, v);
        if (prefix) absorb(acc, prefix + k, v);
      }
    }
  })(obj, '', 0);
  return finalize(acc);
}

// ---------------------------------------------------------------------------
// Exact adapter for TinyMakerWifi's /api/status
//
// Captured from a live print on firmware 0.16.2 (build a046c71) - see
// docs/API-NOTES.md. Fuzzy matching is kept below as the fallback for MQTT
// sensor names and for firmware revisions that move things around, but when a
// document is recognisably this shape the exact mapping wins: it knows that
// vatRemainingMl is resin and not time, that lifetime* counters aren't this
// print, and that stateCode 10 specifically means paused for a refill.
// ---------------------------------------------------------------------------

// Observed stateCode/state pairs: 1 Curing, 2 Lifting, 3 Dropping, 10 refill pause.
var TM_STATE_PHASE = {
  curing: PHASE.CURING,
  exposing: PHASE.CURING,
  lifting: PHASE.LIFTING,
  lift: PHASE.LIFTING,
  dropping: PHASE.PEELING,
  peeling: PHASE.PEELING,
  retracting: PHASE.PEELING,
  homing: PHASE.PRINTING,
  printing: PHASE.PRINTING,
  idle: PHASE.IDLE,
  ready: PHASE.IDLE,
  finished: PHASE.FINISHED,
  complete: PHASE.FINISHED,
  done: PHASE.FINISHED,
  stopped: PHASE.CANCELED,
  cancelled: PHASE.CANCELED,
  canceled: PHASE.CANCELED
};

function isTinyMakerStatus(doc) {
  return !!doc && typeof doc === 'object' &&
         doc.ok === true &&
         ('stateCode' in doc) && ('currentLayer' in doc) && ('totalLayers' in doc);
}

function tinyMakerPhase(doc) {
  if (doc.resumePending) return PHASE.POWER_LOSS;
  if (doc.stateCode === 10) return PHASE.LOW_RESIN_PAUSE;
  if (doc.paused || doc.pausing) {
    return doc.vatLow ? PHASE.LOW_RESIN_PAUSE : PHASE.PAUSED;
  }
  if (doc.stopping) return PHASE.CANCELED;

  var mapped = TM_STATE_PHASE[canon(doc.state)];
  if (mapped !== undefined) return mapped;
  return doc.busy ? PHASE.PRINTING : PHASE.IDLE;
}

/**
 * cfg is the printer's /api/config, used only for vatMl (the VAT's capacity,
 * which /api/status never reports) and lowResinMl. Optional - without it the
 * resin percentage is simply omitted.
 */
function fromTinyMakerStatus(doc, cfg) {
  cfg = cfg || {};
  var now = Math.floor(Date.now() / 1000);

  var out = {
    phase: tinyMakerPhase(doc),
    currentLayer: clampInt(doc.currentLayer || 0, 0, 65535),
    totalLayers: clampInt(doc.totalLayers || 0, 0, 65535),
    percent: 0,
    remainingSec: clampInt(doc.remainingSecs || 0, 0, 4000000000),
    elapsedSec: clampInt(doc.runSecs || 0, 0, 4000000000),
    finishEpoch: 0,
    resinUsedMl: clampInt(doc.resinUsedMl || 0, 0, 65535),
    resinLeftMl: clampInt(doc.vatRemainingMl || 0, 0, 65535),
    resinLeftPct: 0,
    lowResin: false,
    printName: String(doc.sdJobName || doc.sdJob || doc.model || '').substring(0, 24),
    lastUpdateEpoch: now
  };

  if (out.totalLayers > 0) {
    out.percent = clampInt(out.currentLayer * 100 / out.totalLayers, 0, 100);
  }
  if (out.remainingSec > 0) {
    out.finishEpoch = now + out.remainingSec;
  }

  var vatMl = Number(cfg.vatMl);
  if (isFinite(vatMl) && vatMl > 0) {
    out.resinLeftPct = clampInt(Number(doc.vatRemainingMl || 0) * 100 / vatMl, 0, 100);
  }

  var lowResinMl = Number(cfg.lowResinMl);
  out.lowResin = !!doc.vatLow ||
                 (isFinite(lowResinMl) && lowResinMl > 0 &&
                  Number(doc.vatRemainingMl) <= lowResinMl);
  // Note: cfg.askRefill is a "prompt between prints" preference, NOT a live
  // low-resin alert - deliberately not consulted here.

  if (out.lowResin && out.phase === PHASE.PAUSED) out.phase = PHASE.LOW_RESIN_PAUSE;

  return out;
}

/** Normalise any status document, preferring the exact adapter when it fits. */
function fromStatusDoc(doc, cfg) {
  return isTinyMakerStatus(doc) ? fromTinyMakerStatus(doc, cfg) : fromObject(doc);
}

/**
 * One-shot event derived from a phase transition, so the watch can vibe without
 * re-deriving state itself (Plan section 6, EVENT).
 */
function eventFor(prevPhase, nextPhase) {
  if (prevPhase === nextPhase) return EVENT.NONE;
  switch (nextPhase) {
    case PHASE.FINISHED:        return EVENT.FINISHED;
    case PHASE.CANCELED:        return EVENT.CANCELED;
    case PHASE.LOW_RESIN_PAUSE: return EVENT.LOW_RESIN_PAUSE;
    case PHASE.POWER_LOSS:      return EVENT.POWER_LOSS;
    default:                    return EVENT.NONE;
  }
}

function isActive(phase) {
  return phase === PHASE.PRINTING || phase === PHASE.CURING ||
         phase === PHASE.LIFTING  || phase === PHASE.PEELING ||
         phase === PHASE.PAUSED   || phase === PHASE.LOW_RESIN_PAUSE;
}

module.exports = {
  PHASE: PHASE,
  EVENT: EVENT,
  CONN: CONN,
  canon: canon,
  fieldFor: fieldFor,
  toPhase: toPhase,
  toNumber: toNumber,
  toBool: toBool,
  absorb: absorb,
  finalize: finalize,
  fromObject: fromObject,
  isTinyMakerStatus: isTinyMakerStatus,
  fromTinyMakerStatus: fromTinyMakerStatus,
  fromStatusDoc: fromStatusDoc,
  eventFor: eventFor,
  isActive: isActive
};
