#pragma once
#include <pebble.h>

// TinyMaker palette (Plan section 4) mapped onto Pebble's 64-colour palette.
// Colour platforms get the white/blue/orange branding; the B&W platforms
// (aplite, diorite) collapse everything to black-on-white so contrast survives.

#ifdef PBL_COLOR
  #define TM_BG            GColorWhite
  #define TM_CHROME        GColorCobaltBlue   // ~#1E5FA8, primary UI / header bar
  #define TM_CHROME_TEXT   GColorWhite
  // #F2811D is between two palette entries: GColorChromeYellow (#FFAA00) is the
  // nearer match AND reads as orange rather than red, which keeps the progress
  // fill clearly distinct from the warning colour below.
  #define TM_ACCENT        GColorChromeYellow // ~#F2811D, reserved for things in motion
  #define TM_TEXT          GColorBlack
  #define TM_MUTED         GColorDarkGray
  // GColorOrange is #FF5500 - a warm red-orange, closest to #D9432B, and an
  // unmistakably different hue from the amber accent at a glance.
  #define TM_WARN          GColorOrange       // ~#D9432B, low-resin / fault states
  #define TM_TRACK         GColorLightGray    // unfilled part of a bar
#else
  #define TM_BG            GColorWhite
  #define TM_CHROME        GColorBlack
  #define TM_CHROME_TEXT   GColorWhite
  #define TM_ACCENT        GColorBlack
  #define TM_TEXT          GColorBlack
  #define TM_MUTED         GColorBlack
  #define TM_WARN          GColorBlack
  #define TM_TRACK         GColorWhite
#endif
