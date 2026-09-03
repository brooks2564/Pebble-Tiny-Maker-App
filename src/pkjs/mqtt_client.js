/**
 * Minimal MQTT 3.1.1 client over WebSockets, written from scratch because
 * PebbleKit JS has no package manager at runtime and the usual mqtt.js bundle
 * is far too large for the phone-side sandbox.
 *
 * Supports exactly what this app needs: CONNECT, SUBSCRIBE, inbound PUBLISH at
 * QoS 0/1, PINGREQ keepalive, DISCONNECT. Publishing from the watch is not
 * implemented - the app is read-only by design (Plan section 5.5).
 *
 * WebSocket availability inside the Pebble phone app is an open risk (Plan
 * section 10), so isSupported() lets the bridge fall back to dashboard polling.
 */

var CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4,
    SUBSCRIBE = 8, SUBACK = 9, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;

var CONNACK_ERRORS = {
  1: 'bad protocol version',
  2: 'client id rejected',
  3: 'broker unavailable',
  4: 'bad user/password',
  5: 'not authorised'
};

function isSupported() {
  return typeof WebSocket !== 'undefined';
}

// ---- byte plumbing --------------------------------------------------------

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function utf8String(bytes, start, end) {
  var out = '', i = start;
  while (i < end) {
    var c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else {
      out += String.fromCharCode(((c & 0x0f) << 12) |
                                 ((bytes[i++] & 0x3f) << 6) |
                                 (bytes[i++] & 0x3f));
    }
  }
  return out;
}

function pushString(arr, str) {
  var b = utf8Bytes(str);
  arr.push((b.length >> 8) & 0xff, b.length & 0xff);
  for (var i = 0; i < b.length; i++) arr.push(b[i]);
}

function remainingLength(n) {
  var out = [];
  do {
    var digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    out.push(digit);
  } while (n > 0);
  return out;
}

function packet(type, flags, payload) {
  var head = [(type << 4) | flags].concat(remainingLength(payload.length));
  var buf = new Uint8Array(head.length + payload.length);
  buf.set(head, 0);
  buf.set(payload, head.length);
  return buf.buffer;
}

// ---- client ---------------------------------------------------------------

/**
 * opts: { url, username, password, clientId, keepalive }
 * handlers: { onConnect, onMessage(topic, payload), onError(msg), onClose }
 */
function MqttClient(opts, handlers) {
  this.opts = opts || {};
  this.h = handlers || {};
  this.ws = null;
  this.connected = false;
  this.nextPacketId = 1;
  this.pingTimer = null;
  this.keepalive = this.opts.keepalive || 45;
  this.closedByUs = false;
}

MqttClient.prototype._fail = function (msg) {
  if (this.h.onError) this.h.onError(msg);
  this.close();
};

MqttClient.prototype.connect = function () {
  if (!isSupported()) {
    this._fail('no WebSocket');
    return;
  }
  var self = this;
  try {
    this.ws = new WebSocket(this.opts.url, 'mqtt');
  } catch (e) {
    this._fail('bad broker URL');
    return;
  }
  this.ws.binaryType = 'arraybuffer';

  this.ws.onopen = function () { self._sendConnect(); };
  this.ws.onerror = function () { self._fail('broker unreachable'); };
  this.ws.onclose = function () {
    self.connected = false;
    self._stopPing();
    if (!self.closedByUs && self.h.onClose) self.h.onClose();
  };
  this.ws.onmessage = function (evt) {
    var bytes = new Uint8Array(evt.data);
    self._consume(bytes);
  };
};

MqttClient.prototype._sendConnect = function () {
  var p = [];
  pushString(p, 'MQTT');
  p.push(4);                                  // protocol level 3.1.1

  var flags = 0x02;                           // clean session
  var user = this.opts.username, pass = this.opts.password;
  if (user) flags |= 0x80;
  if (user && pass) flags |= 0x40;
  p.push(flags);
  p.push((this.keepalive >> 8) & 0xff, this.keepalive & 0xff);

  pushString(p, this.opts.clientId || ('pebble-tm-' + Math.floor(Math.random() * 100000)));
  if (user) pushString(p, user);
  if (user && pass) pushString(p, pass);

  this.ws.send(packet(CONNECT, 0, p));
};

MqttClient.prototype._startPing = function () {
  var self = this;
  this._stopPing();
  this.pingTimer = setInterval(function () {
    if (self.ws && self.connected) self.ws.send(packet(PINGREQ, 0, []));
  }, Math.max(10, this.keepalive - 10) * 1000);
};

MqttClient.prototype._stopPing = function () {
  if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
};

MqttClient.prototype.subscribe = function (topics) {
  if (!this.connected) return;
  var id = this.nextPacketId++;
  if (this.nextPacketId > 65535) this.nextPacketId = 1;
  var p = [(id >> 8) & 0xff, id & 0xff];
  for (var i = 0; i < topics.length; i++) {
    pushString(p, topics[i]);
    p.push(0);                                // QoS 0 is plenty for status
  }
  this.ws.send(packet(SUBSCRIBE, 2, p));
};

MqttClient.prototype.close = function () {
  this.closedByUs = true;
  this._stopPing();
  if (this.ws) {
    try {
      if (this.connected) this.ws.send(packet(DISCONNECT, 0, []));
      this.ws.close();
    } catch (e) { /* already gone */ }
    this.ws = null;
  }
  this.connected = false;
};

// A single WebSocket frame can carry several MQTT packets, or split one.
MqttClient.prototype._consume = function (bytes) {
  this._buf = this._buf ? concat(this._buf, bytes) : bytes;
  for (;;) {
    if (this._buf.length < 2) return;
    var mult = 1, len = 0, i = 1, digit;
    do {
      if (i >= this._buf.length) return;       // length header still incomplete
      digit = this._buf[i++];
      len += (digit & 127) * mult;
      mult *= 128;
    } while ((digit & 128) !== 0);

    var total = i + len;
    if (this._buf.length < total) return;      // body still incomplete
    this._handle(this._buf.subarray(0, total), i, len);
    this._buf = this._buf.subarray(total);
  }
};

function concat(a, b) {
  var out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

MqttClient.prototype._handle = function (pkt, bodyStart, bodyLen) {
  var type = pkt[0] >> 4;
  var flags = pkt[0] & 0x0f;

  if (type === CONNACK) {
    var code = pkt[bodyStart + 1];
    if (code !== 0) {
      this._fail(CONNACK_ERRORS[code] || ('connack ' + code));
      return;
    }
    this.connected = true;
    this._startPing();
    if (this.h.onConnect) this.h.onConnect();
    return;
  }

  if (type === PUBLISH) {
    var qos = (flags >> 1) & 3;
    var p = bodyStart;
    var tlen = (pkt[p] << 8) | pkt[p + 1];
    p += 2;
    var topic = utf8String(pkt, p, p + tlen);
    p += tlen;
    var packetId = 0;
    if (qos > 0) {
      packetId = (pkt[p] << 8) | pkt[p + 1];
      p += 2;
    }
    var payload = utf8String(pkt, p, bodyStart + bodyLen);
    if (qos === 1 && this.ws) {
      this.ws.send(packet(PUBACK, 0, [(packetId >> 8) & 0xff, packetId & 0xff]));
    }
    if (this.h.onMessage) this.h.onMessage(topic, payload);
    return;
  }

  // SUBACK / PUBACK / PINGRESP need no action beyond keeping the socket alive.
};

module.exports = {
  MqttClient: MqttClient,
  isSupported: isSupported,
  _utf8Bytes: utf8Bytes,
  _utf8String: utf8String,
  _remainingLength: remainingLength
};
