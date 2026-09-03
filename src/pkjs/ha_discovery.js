/**
 * Home Assistant MQTT auto-discovery reader.
 *
 * TinyMakerWifi publishes HA discovery configs (Plan section 3.2) but the exact
 * topic and field names aren't documented, so rather than hard-coding topics we
 * subscribe to the discovery tree, learn each sensor's state_topic from its
 * retained config payload, and subscribe to those.
 *
 * Handles the two shapes HA configs come in:
 *   - one state topic per sensor, raw scalar payload
 *   - one shared state topic carrying JSON, with each sensor pulling a key out
 *     of it via value_template: "{{ value_json.current_layer }}"
 */

var normalize = require('./normalize');

function discoveryTopics(prefix) {
  prefix = prefix || 'homeassistant';
  return [
    prefix + '/+/+/config',      // <prefix>/<component>/<object_id>/config
    prefix + '/+/+/+/config'     // <prefix>/<component>/<node_id>/<object_id>/config
  ];
}

// "{{ value_json.current_layer }}" / "{{ value_json['resin left'] }}" -> key
function jsonKeyFromTemplate(tpl) {
  if (!tpl) return null;
  var dotted = tpl.match(/value_json\.([A-Za-z0-9_]+)/);
  if (dotted) return dotted[1];
  var bracketed = tpl.match(/value_json\[\s*['"]([^'"]+)['"]\s*\]/);
  if (bracketed) return bracketed[1];
  return null;
}

function expandTilde(value, base) {
  if (!value) return value;
  if (value.charAt(0) === '~') return (base || '') + value.substring(1);
  if (value.length && value.charAt(value.length - 1) === '~') {
    return value.substring(0, value.length - 1) + (base || '');
  }
  return value;
}

/**
 * Parse one retained discovery config payload.
 * Returns { stateTopic, jsonKey, name } or null if it isn't usable.
 */
function parseConfig(topic, payload) {
  var cfg;
  try {
    cfg = JSON.parse(payload);
  } catch (e) {
    return null;                             // empty payload = sensor removed
  }
  if (!cfg || typeof cfg !== 'object') return null;

  var base = cfg['~'] || cfg.base_topic || '';
  var stateTopic = expandTilde(cfg.state_topic || cfg.stat_t, base);
  if (!stateTopic) return null;

  var name = cfg.name || cfg.object_id || cfg.unique_id || cfg.uniq_id || '';
  if (!name) {
    // fall back to the object_id segment of homeassistant/<comp>/[node/]<obj>/config
    var parts = topic.split('/');
    name = parts.length >= 2 ? parts[parts.length - 2] : topic;
  }

  var jsonKey = jsonKeyFromTemplate(cfg.value_template || cfg.val_tpl);

  return {
    stateTopic: stateTopic,
    jsonKey: jsonKey,
    name: String(name)
  };
}

/**
 * Tracks discovered entities and folds incoming state payloads into a raw
 * accumulator that normalize.finalize() turns into the AppMessage schema.
 */
function Registry(discoveryPrefix) {
  this.prefix = discoveryPrefix || 'homeassistant';
  this.byStateTopic = {};   // stateTopic -> [entity, ...]
  this.raw = {};            // normalised-field-name -> latest raw value
}

Registry.prototype.isDiscoveryTopic = function (topic) {
  return topic.indexOf(this.prefix + '/') === 0 &&
         topic.lastIndexOf('/config') === topic.length - '/config'.length;
};

/**
 * Feed a discovery config in. Returns the new state topic to subscribe to, or
 * null when it's one we already follow / can't use.
 */
Registry.prototype.addConfig = function (topic, payload) {
  var ent = parseConfig(topic, payload);
  if (!ent) return null;
  // Only keep sensors whose name maps onto something the watch displays.
  if (!normalize.fieldFor(ent.name) && !normalize.fieldFor(ent.jsonKey || '')) {
    return null;
  }
  var isNew = !this.byStateTopic[ent.stateTopic];
  if (isNew) this.byStateTopic[ent.stateTopic] = [];
  this.byStateTopic[ent.stateTopic].push(ent);
  return isNew ? ent.stateTopic : null;
};

/**
 * Feed a state payload in. Returns true if anything the watch cares about
 * changed, so the caller knows whether to re-send.
 */
Registry.prototype.addState = function (topic, payload) {
  var entities = this.byStateTopic[topic];
  var changed = false;

  if (!entities) {
    // Not a discovered topic - a manually configured JSON state topic. Absorb
    // the whole document.
    var doc = null;
    try { doc = JSON.parse(payload); } catch (e) { doc = null; }
    if (doc && typeof doc === 'object') {
      for (var k in doc) {
        if (doc.hasOwnProperty(k) && normalize.fieldFor(k)) {
          this.raw[k] = doc[k];
          changed = true;
        }
      }
    }
    return changed;
  }

  var parsed = null, tried = false;
  for (var i = 0; i < entities.length; i++) {
    var ent = entities[i];
    var value = payload;
    if (ent.jsonKey) {
      if (!tried) {
        tried = true;
        try { parsed = JSON.parse(payload); } catch (e) { parsed = null; }
      }
      if (!parsed || !(ent.jsonKey in parsed)) continue;
      value = parsed[ent.jsonKey];
    }
    var key = ent.jsonKey || ent.name;
    if (this.raw[key] !== value) {
      this.raw[key] = value;
      changed = true;
    }
  }
  return changed;
};

/** Current best-known status in AppMessage-schema form. */
Registry.prototype.snapshot = function () {
  return normalize.fromObject(this.raw);
};

Registry.prototype.hasData = function () {
  for (var k in this.raw) { if (this.raw.hasOwnProperty(k)) return true; }
  return false;
};

module.exports = {
  discoveryTopics: discoveryTopics,
  jsonKeyFromTemplate: jsonKeyFromTemplate,
  parseConfig: parseConfig,
  Registry: Registry
};
