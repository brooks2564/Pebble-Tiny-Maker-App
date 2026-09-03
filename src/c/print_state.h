#pragma once
#include <pebble.h>
#include "app_message_keys.h"

// Normalised print status as last received from the phone bridge, plus the
// local bookkeeping the UI needs (staleness, refresh flash).
typedef struct {
  TmPhase     phase;
  uint16_t    current_layer;
  uint16_t    total_layers;
  uint8_t     percent;
  uint32_t    time_remaining_sec;
  uint32_t    elapsed_sec;
  uint32_t    finish_epoch;
  uint16_t    resin_used_ml;
  uint16_t    resin_left_ml;
  uint8_t     resin_left_pct;
  bool        low_resin;
  char        print_name[TM_PRINT_NAME_MAX];
  uint32_t    last_update_epoch;   // printer/phone clock, for the tap overlay
  TmConnState conn_state;
  char        conn_msg[TM_CONN_MSG_MAX];

  bool        have_data;           // any status message received this session
  time_t      last_rx_local;       // watch clock, what staleness is measured on
  time_t      remaining_anchor;    // watch clock at which time_remaining_sec was true
  bool        refreshing;          // a manual refresh is in flight (spinner)
} PrintState;

// Layout metrics derived once per draw so both pages agree on margins and
// fonts across a 144x168 aplite and a 260x260 gabbro.
typedef struct {
  GRect bounds;
  bool  round;
  int   header_y;
  int   header_h;
  int   body_top;      // first free y below the header band
  int   pips_y;
  int   gap;
  int   bar_h;
  GFont font_big;
  GFont font_med;
  GFont font_small;
  int   h_big;
  int   h_med;
  int   h_small;
} TmLayout;

// Where the progress bar and the freshness dot ended up on the last draw, so
// the touch handler knows what the finger actually hit.
extern GRect g_progress_hit;
extern GRect g_stale_hit;

const char *tm_phase_name(TmPhase phase);
void tm_format_duration(uint32_t seconds, char *buf, size_t buf_len);
bool tm_is_stale(const PrintState *st);
uint32_t tm_remaining_now(const PrintState *st);

GRect tm_row(const TmLayout *lay, int y, int h);
void tm_draw_text(GContext *ctx, const char *text, GFont font, GRect box,
                  GTextAlignment align);
void tm_draw_bar(GContext *ctx, GRect box, uint8_t percent, GColor fill);
void tm_draw_header(GContext *ctx, const TmLayout *lay, const PrintState *st,
                    const char *title, int page_index);

void status_page_draw(GContext *ctx, const TmLayout *lay, const PrintState *st);
void resin_page_draw(GContext *ctx, const TmLayout *lay, const PrintState *st);
