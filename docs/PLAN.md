# TinyMaker Print Monitor for Pebble — Project Plan v1

> Markdown rendering of `TinyMaker_Pebble_Print_Monitor_Plan.docx`, which
> remains in this folder as the original. Section numbers are referenced
> throughout the source code.
>
> **Phase 0 is now closed** — the data path was confirmed against a live print.
> See [API-NOTES.md](API-NOTES.md) for what was actually found, including where
> reality diverged from the assumptions below.

## 1. Overview

A Pebble watchapp that monitors an active print on a TinyMaker resin printer
running the TinyMakerWifi community firmware. The watch shows current layer /
total layers, time remaining, print phase, and resin level, updated live over
WiFi via a PebbleKit JS bridge on the phone. Touch is used where it fits the
Emery hardware; buttons remain the full fallback so the app works identically on
non-touch Pebble hardware.

## 2. Target platform

Primary target: Pebble Time 2 ("Emery") — 200×228 px, colour, touchscreen +
4 buttons. New UUID for this project. Pebble C SDK v4.9.169, tested in the QEMU
emulator before any hardware install.

Buttons remain fully functional throughout (Up/Select/Down/Back) so the app
degrades gracefully on non-touch platforms — touch is additive, never required.

## 3. Data source & communication architecture

### 3.1 Why not talk to the printer directly

Pebble hardware has no WiFi radio. All networking happens on the phone inside
PebbleKit JS, which relays parsed data to the watch as AppMessage key/value
pairs.

### 3.2 Data source decision

**Primary: MQTT.** TinyMakerWifi already publishes Home Assistant
auto-discovery sensors over MQTT — print state, current layer, resin used, resin
left (+ low-resin alert), and run/remaining time.

**Fallback / prototyping: dashboard polling.** The printer's web dashboard
(`tinymaker.local`) polls a live status source in the browser. Not publicly
documented as a stable API, so treat it as a fast way to get a working
prototype. Inspect the dashboard's network requests to confirm the exact
endpoint and JSON shape before committing to it.

Both paths require the phone to be on the same WiFi network as the printer (for
the dashboard) or able to reach the configured MQTT broker.

> **What Phase 0 found:** this ordering is inverted in practice. MQTT ships
> **disabled** on firmware 0.16.2 (`mqttEnabled: false`, no broker host), so
> dashboard polling of `GET /api/status` is the path that works today. MQTT
> support is implemented and ready for when a broker is set up.

### 3.3 PebbleKit JS bridge responsibilities

- Connect to the MQTT broker (over WebSockets, since PebbleKit JS runs in a
  WebView-like JS context) and subscribe to the relevant topics, **or** poll the
  dashboard endpoint on an interval.
- Parse incoming data into a normalised shape: phase, current layer, total
  layers, percent complete, time remaining, resin left (ml and/or %),
  low-resin flag, print name, last-updated timestamp.
- Rate-limit updates to roughly every 15–30 seconds while a print is active, and
  back off entirely when idle — the printer's single ESP32 serves the dashboard
  "in the gaps between layer moves", so avoid hammering it.
- Detect staleness: if no successful update arrives within ~45–60 seconds, mark
  data as stale rather than silently freezing the last known value.
- Send an AppMessage vibration trigger on: print finished, print canceled,
  low-resin pause, and power-loss recovery prompt.
- Persist the last known broker/host settings via `localStorage`.

## 4. Colour palette

| Role | Colour | Approx. hex | Pebble GColor |
|---|---|---|---|
| Background | White | `#FFFFFF` | `GColorWhite` |
| Primary UI / chrome | TinyMaker Blue | `#1E5FA8` | `GColorCobaltBlue` |
| Accent / progress | TinyMaker Orange | `#F2811D` | `GColorChromeYellow` |
| Primary text | Near-black | `#222222` | `GColorBlack` |
| Secondary text | Mid gray | `#6E6E6E` | `GColorDarkGray` |
| Low-resin / warning | Warm red-orange | `#D9432B` | `GColorOrange` (`#FF5500`) |

Keep the background white, use blue for chrome/labels/borders, and reserve
orange strictly for the active progress indicator and the resin-level accent so
it reads as "things that are moving/changing" rather than decoration.

> The plan's first guess was `GColorOrange` for the accent and
> `GColorSunsetOrange` for the warning. `GColorOrange` is `#FF5500` — a
> red-orange — which left the two roles nearly indistinguishable. Shifting the
> accent to `GColorChromeYellow` (`#FFAA00`, also the closer match to `#F2811D`)
> and the warning to `GColorOrange` keeps both faithful *and* separable at a
> glance. See `src/c/colors.h`.

## 5. App structure & screens

### 5.1 Screen 1 — Status (default)

Print phase text · current layer / total layers · progress bar (orange fill,
doubles as the touch target) · time remaining plus estimated finish clock time ·
stale-data indicator if no update in ~45–60 s.

### 5.2 Screen 2 — Resin & print info

Resin remaining (ml and % of VAT) · low-resin warning state (red-orange) when
the firmware's flag is set · print/model name · elapsed time.

### 5.3 Touch interactions (Emery)

- Swipe left/right to move between Status and Resin — mirrors Up/Down.
- Tap the progress bar to force an immediate refresh, with a brief flash to
  confirm the tap registered.
- Tap the stale-data indicator to see the last-updated timestamp as an overlay.

### 5.4 Button interactions (all platforms)

- **Up / Down** — switch between the two screens (same destination as a swipe).
- **Select** — force refresh (same action as tapping the progress bar).
- **Back** — exit the app.

### 5.5 Notifications

- **Print finished** — distinct vibe + a summary screen (total time, resin used)
  shown until dismissed.
- **Low-resin pause** — distinct vibe + switches to the Resin screen
  automatically.
- **Print canceled** — short vibe + status text update.
- **Power-loss recovery prompt** — vibe + note that action is needed on the
  dashboard or printer; the watch is read-only here.

## 6. AppMessage key schema

| Key | Type | Description |
|---|---|---|
| `PHASE` | uint8 | Idle=0, Printing=1, Curing=2, Lifting=3, Peeling=4, Paused=5, LowResinPause=6, Finished=7, Canceled=8, PowerLossPrompt=9 |
| `CURRENT_LAYER` | uint16 | Current layer index |
| `TOTAL_LAYERS` | uint16 | Total layers in the active model |
| `PERCENT_COMPLETE` | uint8 | 0–100, derived JS-side |
| `TIME_REMAINING_SEC` | uint32 | Seconds remaining, 0 if unknown/idle |
| `FINISH_EPOCH` | uint32 | Unix timestamp of estimated finish |
| `RESIN_LEFT_ML` | uint16 | Estimated resin remaining, ml |
| `RESIN_LEFT_PCT` | uint8 | Estimated resin remaining, % of VAT |
| `LOW_RESIN_FLAG` | uint8 | 1 if the firmware's low-resin condition is active |
| `PRINT_NAME` | cstring (~24) | Active model name, truncated JS-side |
| `LAST_UPDATE_EPOCH` | uint32 | Freshness timestamp for staleness checks |
| `EVENT` | uint8 | One-shot flag for finished / canceled / low-resin-pause / power-loss-prompt |

**Added during implementation** (documented in the README):
`ELAPSED_SEC`, `RESIN_USED_ML`, `CONN_STATE`, `CONN_MSG`, `REQUEST_REFRESH`.

## 7. Implementation phases

0. **Confirm the data path** — verify MQTT sensors, or capture the dashboard's
   live-polling request during a real print. Done — see API-NOTES.md.
1. **Skeleton app** — new project/UUID, static two-screen UI, verify layout and
   touch/button navigation in QEMU. Done.
2. **PebbleKit JS bridge** — MQTT or dashboard client, normalisation, AppMessage
   sending, polling cadence, backoff, staleness. Done.
3. **Live data on-watch** — bind keys to the UI, stale indicator and its
   tap-to-reveal timestamp. Done.
4. **Notifications & events** — vibe patterns and screen behaviour, finished
   summary screen. Done.
5. **Polish & real-world testing** — run an actual print end-to-end with the
   watch nearby; tune poll interval and staleness threshold; battery check;
   confirm colour rendering. *Partially done: verified against a live print via
   the emulator; not yet run on watch hardware for a full print.*

## 8. Repo & file structure

| Path | Purpose |
|---|---|
| `src/c/main.c` | App init, window, timers, buttons, touch, AppMessage |
| `src/c/status_window.c` | Screen 1 |
| `src/c/resin_window.c` | Screen 2 |
| `src/c/ui_common.c` | Shared layout helpers, header, bars |
| `src/c/colors.h` | Palette constants from section 4 |
| `src/c/app_message_keys.h` | Mirrored copy of the AppMessage schema |
| `src/c/print_state.h` | Normalised state struct + layout metrics |
| `src/pkjs/index.js` | PebbleKit JS entry point |
| `src/pkjs/mqtt_client.js` | MQTT-over-WebSockets client |
| `src/pkjs/ha_discovery.js` | Home Assistant auto-discovery topic learning |
| `src/pkjs/dashboard_poll.js` | Dashboard-polling client |
| `src/pkjs/normalize.js` | Raw source data to AppMessage schema |
| `package.json` | Message keys, UUID, target platforms |

## 9. Testing plan

- QEMU emulator for all UI/layout/navigation work.
- A standalone script publishing synthetic status messages, so watch-side logic
  can be exercised without an active resin print — `scripts/mock-printer.js`.
- At least one full real print monitored end-to-end on hardware before
  considering this done.

## 10. Open questions / risks

| Risk | Status |
|---|---|
| MQTT topic names/payload shapes need confirming | **Open** — MQTT is disabled on the printer; the HA-discovery reader is written but unexercised |
| MQTT needs broker infrastructure | **Confirmed** — no broker configured; dashboard polling used instead |
| Dashboard endpoint is unofficial and could change | **Accepted** — `/api/status` confirmed on 0.16.2; the poller re-probes if it moves |
| PebbleKit JS WebSocket support unverified | **Open** — checked at runtime, falls back to polling |
| TinyMaker brand hex values are approximations | **Open** — still not sampled from an official source |
