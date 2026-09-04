#!/usr/bin/env bash
# Publish TinyMaker Print Monitor to the Pebble App Store.
#
# Requires an interactive login first (opens a browser):
#
#     pebble login
#
# Then, from the project root:
#
#     ./scripts/publish.sh
#
# This creates the listing but does NOT make it visible - add --is-published
# below, or publish from the store dashboard once the listing looks right.

set -euo pipefail
cd "$(dirname "$0")/.."

pebble build

pebble publish \
  --non-interactive \
  --no-gif-all-platforms \
  --name "TinyMaker Print Monitor" \
  --category "tools" \
  --source "https://github.com/brooks2564/Pebble-Tiny-Maker-App" \
  --icon-small icon_80x80.png \
  --icon-large icon_144x144.png \
  --screenshots store/emery_screenshot.png store/emery_resin.png \
                store/gabbro_screenshot.png store/chalk_screenshot.png \
                store/basalt_screenshot.png store/aplite_screenshot.png \
  --description "Watch a print on your TinyMaker resin printer from your wrist. Live layer count, progress bar, time remaining and estimated finish time, plus resin left in the VAT with a low-resin warning. Vibrates when a print finishes, pauses for low resin, is cancelled, or needs power-loss recovery. Reads the printer over its web API or MQTT; your phone does the networking. Requires the TinyMakerWifi community firmware and a phone on the same WiFi as the printer. Note: the app must be open to poll - use the printer's own Telegram/Discord notifications for unattended alerts." \
  --release-notes "First release. Two pages - print status (phase, layer counter, progress, time remaining, finish clock) and resin (VAT level, low-resin banner, print name, elapsed time). Touch and button controls, all seven Pebble platforms."
