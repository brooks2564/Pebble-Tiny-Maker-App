# TinyMakerWifi API notes

Plan Phase 0 ("confirm the data path") — resolved against a **live print**, not
documentation. Everything below was captured directly from the printer on the
local network while a job was running.

| | |
|---|---|
| Firmware | `0.16.2`, build `a046c71`, built `Aug 3 2026` |
| Host | `tinymaker.local` (mDNS) → `192.168.0.192` |
| Captured | 2026-09-02 |

## Which path actually works

**Dashboard polling — the working path today.** `GET /api/status` returns the
full print state as JSON. The plan filed this as the prototyping fallback; on
this firmware it is the only path that works out of the box.

**MQTT — not available yet.** `/api/config` reports:

```
mqttEnabled     = False
mqttConfigured  = False
mqttHost        = ''
mqttPort        = 1883
mqttTopic       = 'TinyMaker'
```

MQTT ships **disabled**. Turning it on needs a broker plus the printer
configured to publish to it. Two further things to note when that happens:

- The printer publishes to plain TCP port 1883. PebbleKit JS can only speak
  WebSockets, so the broker must also expose a WebSocket listener (Mosquitto's
  `listener 9001` + `protocol websockets`), and that is the URL to enter in the
  app's settings — not `mqtt://host:1883`.
- Whether the Pebble phone app's JS sandbox exposes `WebSocket` at all is still
  unverified on real hardware (Plan section 10). `mqtt_client.isSupported()`
  checks at runtime and the bridge falls back to dashboard polling if it isn't.

## `GET /api/status`

Live capture, mid-print:

```json
{
  "ok": true,
  "firmwareVersion": "0.16.2",
  "busy": true, "paused": false, "pausing": false,
  "resuming": false, "stopping": false, "dryRun": false,
  "state": "Curing", "stateCode": 1,
  "sdJob": "", "sdJobName": "", "resumePending": null,
  "phaseTotalMs": 14000, "phaseElapsedMs": 13829,
  "layerHeight": 0.1, "model": "CuteDragon",
  "currentLayer": 64, "totalLayers": 320, "layerText": "64 / 320",
  "resinUsedMl": 1.7, "resinText": "1.7 / ~8.3 ml",
  "runSecs": 1686, "runTime": "28m 6s",
  "remainingSecs": 5876, "remainingTime": "1h 37m",
  "vatRemainingMl": 13.3, "vatText": "13.3 ml", "vatLow": false,
  "askRefill": true, "webControl": true,
  "lifetimePrintSecs": 52861, "uvLedSecs": 31926,
  "wifiRssi": -56, "ip": "192.168.0.192", "uptimeSecs": 2308
}
```

### Observed `state` / `stateCode` pairs

Sampled across ~30 s of a running print:

| `stateCode` | `state` | Mapped to |
|---|---|---|
| 1 | `Curing` | `TM_PHASE_CURING` |
| 2 | `Lifting` | `TM_PHASE_LIFTING` |
| 3 | `Dropping` | `TM_PHASE_PEELING` |
| 10 | *(paused for refill)* | `TM_PHASE_LOW_RESIN_PAUSE` |

Code 10 is confirmed from the dashboard's own JS, which shows
*"Print paused – refill the resin vat, then press Resume."* on
`stateCode === 10`. Codes for idle / finished / cancelled were not observed
(the printer never left the print loop during capture), so the adapter also
falls back to matching the `state` string and the `busy` / `stopping` /
`resumePending` booleans.

### Field traps

These caused real mis-reads before the exact adapter was written, and are why
`normalize.js` ignores some keys outright:

| Key | Trap |
|---|---|
| `vatRemainingMl` | Contains "remaining" but is **resin, not time**. Naive matching turned 13.3 ml into "13 seconds left". |
| `phaseTotalMs`, `phaseElapsedMs` | The **per-layer** phase timer, not the print phase. Matching on "phase" read 14000 as a phase enum and showed *Idle* during an active print. |
| `layerText`, `resinText`, `vatText` | Pre-formatted display mirrors of real numeric fields. Ignored. |
| `lifetimePrintSecs`, `lifetimePrintTime` | Lifetime totals across all prints, not this one. Ignored. |
| `stateCode` | Numeric twin of `state`. The string is less ambiguous; the code is only consulted for the special case 10. |
| `runTime` / `remainingTime` | Human strings (`"28m 6s"`). Always prefer the `*Secs` siblings. |
| `askRefill` | A **preference** ("prompt to refill between prints"), not a live alert. It reads `true` on a full vat. Use `vatLow` instead. |
| `model` | On this capture it held the **print's** name (`CuteDragon`) while `sdJobName` was empty — used as the print-name fallback. |

## `GET /api/config`

Polled rarely (30 min TTL). Only two fields matter to this app, but they are
required — `/api/status` never reports the VAT's capacity, so without them the
resin gauge has no denominator:

| Key | Live value | Use |
|---|---|---|
| `vatMl` | `15` | Denominator for `RESIN_LEFT_PCT` (13.3 / 15 → 89%) |
| `lowResinMl` | `2` | Secondary low-resin threshold alongside `vatLow` |

## Other endpoints seen in the dashboard

Not used by this app (it is read-only by design), listed for future reference:
`/api/print/start`, `/api/vat/refilled`, `/api/resume/accept`,
`/api/resume/lift`, `/api/resume/discard`, `/api/files`,
`/api/files/model/preview`, `/api/update`, `/api/connect/*`.

`/api/resume/*` is what a power-loss recovery prompt needs — confirming the
plan's note that recovery is not something the watch can action itself.

## Endpoints that do **not** exist

`/status`, `/status.json`, `/api/print`, `/printstatus`, `/print_status`,
`/json`, `/data`, `/api/printer`, `/info` all return `Not found: <path>`.
They remain in the poller's probe list only as a hedge against a future
firmware moving the endpoint.
