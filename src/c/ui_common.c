#include "print_state.h"
#include "colors.h"

GRect g_progress_hit;
GRect g_stale_hit;

static const char *s_phase_names[TM_PHASE_COUNT] = {
  "Idle", "Printing", "Curing", "Lifting", "Peeling",
  "Paused", "Low Resin", "Finished", "Canceled", "Power Loss"
};

const char *tm_phase_name(TmPhase phase) {
  if (phase >= TM_PHASE_COUNT) return "Unknown";
  return s_phase_names[phase];
}

void tm_format_duration(uint32_t seconds, char *buf, size_t buf_len) {
  if (seconds == 0) {
    snprintf(buf, buf_len, "--");
    return;
  }
  uint32_t h = seconds / 3600;
  uint32_t m = (seconds % 3600) / 60;
  uint32_t s = seconds % 60;
  if (h > 0) {
    snprintf(buf, buf_len, "%luh %02lum", (unsigned long)h, (unsigned long)m);
  } else if (m > 0) {
    snprintf(buf, buf_len, "%lum %02lus", (unsigned long)m, (unsigned long)s);
  } else {
    snprintf(buf, buf_len, "%lus", (unsigned long)s);
  }
}

bool tm_is_stale(const PrintState *st) {
  if (!st->have_data) return false;   // "no data yet" is its own state, not stale
  return (time(NULL) - st->last_rx_local) > TM_STALE_AFTER_SEC;
}

// Count the remaining time down locally between bridge updates so the number
// on screen doesn't sit frozen for 15-30 seconds at a time.
uint32_t tm_remaining_now(const PrintState *st) {
  if (st->time_remaining_sec == 0) return 0;
  int32_t elapsed = (int32_t)(time(NULL) - st->remaining_anchor);
  if (elapsed < 0) elapsed = 0;
  if ((uint32_t)elapsed >= st->time_remaining_sec) return 0;
  return st->time_remaining_sec - (uint32_t)elapsed;
}

// A horizontally centred row that is guaranteed to fit the display shape.
// On round watches the usable width is the chord of the circle at whichever
// edge of the row sits furthest from the vertical centre.
GRect tm_row(const TmLayout *lay, int y, int h) {
  int w = lay->bounds.size.w;
  int screen_h = lay->bounds.size.h;
  if (!lay->round) {
    int margin = w >= 200 ? 6 : 4;
    return GRect(margin, y, w - 2 * margin, h);
  }
  int32_t r = w / 2;
  int32_t cy = screen_h / 2;
  int32_t dy_top = cy - y;
  int32_t dy_bot = (y + h) - cy;
  int32_t dy = dy_top > dy_bot ? dy_top : dy_bot;
  if (dy < 0) dy = 0;
  if (dy > r) dy = r;
  int32_t half = 0;
  {
    int32_t v = r * r - dy * dy;
    // integer sqrt, no floating point on Pebble
    int32_t x = r;
    while (x * x > v && x > 0) x--;
    half = x;
  }
  half -= 6;                       // breathing room off the bezel
  if (half < 10) half = 10;
  return GRect(w / 2 - half, y, half * 2, h);
}

void tm_draw_text(GContext *ctx, const char *text, GFont font, GRect box,
                  GTextAlignment align) {
  graphics_draw_text(ctx, text, font, box, GTextOverflowModeTrailingEllipsis,
                     align, NULL);
}

// Progress / resin bar: chrome-coloured outline, accent fill.
void tm_draw_bar(GContext *ctx, GRect box, uint8_t percent, GColor fill) {
  if (percent > 100) percent = 100;
  int radius = box.size.h / 2;

  graphics_context_set_fill_color(ctx, TM_TRACK);
  graphics_fill_rect(ctx, box, radius, GCornersAll);

  if (percent > 0) {
    GRect inner = GRect(box.origin.x, box.origin.y,
                        box.size.w * percent / 100, box.size.h);
    if (inner.size.w < box.size.h) inner.size.w = box.size.h;  // keep the cap round
    graphics_context_set_fill_color(ctx, fill);
    graphics_fill_rect(ctx, inner, radius, GCornersAll);
  }

  graphics_context_set_stroke_color(ctx, TM_CHROME);
  graphics_draw_round_rect(ctx, box, radius);
}

void tm_draw_header(GContext *ctx, const TmLayout *lay, const PrintState *st,
                    const char *title, int page_index) {
  GRect bounds = lay->bounds;

  // Full-width band; on round displays the circle crops it into a neat arc.
  GRect band = GRect(0, lay->header_y, bounds.size.w, lay->header_h);
  graphics_context_set_fill_color(ctx, TM_CHROME);
  graphics_fill_rect(ctx, band, 0, GCornerNone);

  GRect text_row = tm_row(lay, lay->header_y, lay->header_h);
  int dot_r = bounds.size.w >= 200 ? 5 : 4;
  int dot_zone = dot_r * 2 + 8;   // kept clear at both ends so the title stays centred
  GRect title_box = GRect(text_row.origin.x + dot_zone,
                          lay->header_y + (lay->header_h - 18) / 2 - 2,
                          text_row.size.w - 2 * dot_zone, 20);
  graphics_context_set_text_color(ctx, TM_CHROME_TEXT);
  tm_draw_text(ctx, title, lay->font_small, title_box, GTextAlignmentCenter);

  // Freshness dot, right-hand end of the band.
  GPoint dot = GPoint(text_row.origin.x + text_row.size.w - dot_r - 4,
                      lay->header_y + lay->header_h / 2);
  bool stale = tm_is_stale(st);
  graphics_context_set_fill_color(ctx, stale ? TM_WARN : TM_CHROME_TEXT);
  graphics_fill_circle(ctx, dot, dot_r);
  if (!st->have_data) {
    // Hollow dot until the first payload lands.
    graphics_context_set_fill_color(ctx, TM_CHROME);
    graphics_fill_circle(ctx, dot, dot_r - 2);
  }
  g_stale_hit = GRect(dot.x - dot_r - 8, lay->header_y,
                      (dot_r + 8) * 2, lay->header_h);

  // Page indicator pips along the bottom.
  int pip_r = 3;
  int pip_gap = 12;
  int pip_y = lay->pips_y;
  for (int i = 0; i < 2; i++) {
    GPoint p = GPoint(bounds.size.w / 2 + (i == 0 ? -pip_gap / 2 : pip_gap / 2), pip_y);
    if (i == page_index) {
      graphics_context_set_fill_color(ctx, TM_CHROME);
      graphics_fill_circle(ctx, p, pip_r);
    } else {
      graphics_context_set_stroke_color(ctx, TM_MUTED);
      graphics_draw_circle(ctx, p, pip_r);
    }
  }
}
