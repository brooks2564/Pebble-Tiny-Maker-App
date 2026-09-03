// Screen 1 - phase, layer counter, progress bar, time remaining / finish clock.
#include "print_state.h"
#include "colors.h"

static bool phase_is_active(TmPhase p) {
  return p == TM_PHASE_PRINTING || p == TM_PHASE_CURING ||
         p == TM_PHASE_LIFTING  || p == TM_PHASE_PEELING;
}

static void format_finish_clock(uint32_t epoch, char *buf, size_t len) {
  if (epoch == 0) {
    snprintf(buf, len, "Finish --:--");
    return;
  }
  time_t t = (time_t)epoch;
  struct tm *lt = localtime(&t);
  char clock_buf[12];
  const char *p = clock_buf;
  if (clock_is_24h_style()) {
    strftime(clock_buf, sizeof(clock_buf), "%H:%M", lt);   // 00:17 stays 00:17
  } else {
    strftime(clock_buf, sizeof(clock_buf), "%I:%M %p", lt);
    if (*p == '0') p++;                  // exactly one leading zero: 09:17 -> 9:17
  }
  snprintf(buf, len, "Finish %s", p);
}

void status_page_draw(GContext *ctx, const TmLayout *lay, const PrintState *st) {
  tm_draw_header(ctx, lay, st, lay->bounds.size.w >= 200 ? "TINYMAKER" : "PRINT", 0);

  int y = lay->body_top + lay->gap;
  char buf[40];

  // --- phase -------------------------------------------------------------
  GColor phase_color = TM_TEXT;
  const char *phase_text;
  if (st->conn_state == TM_CONN_UNCONFIGURED) {
    phase_text = "Not set up";
    phase_color = TM_MUTED;
  } else if (!st->have_data) {
    phase_text = (st->conn_state == TM_CONN_ERROR) ? "No link" : "Connecting";
    phase_color = (st->conn_state == TM_CONN_ERROR) ? TM_WARN : TM_MUTED;
  } else {
    phase_text = tm_phase_name(st->phase);
    if (st->phase == TM_PHASE_LOW_RESIN_PAUSE || st->phase == TM_PHASE_CANCELED ||
        st->phase == TM_PHASE_POWER_LOSS) {
      phase_color = TM_WARN;
    } else if (phase_is_active(st->phase)) {
      phase_color = TM_CHROME;
    } else {
      phase_color = TM_MUTED;
    }
  }
  graphics_context_set_text_color(ctx, phase_color);
  tm_draw_text(ctx, phase_text, lay->font_med, tm_row(lay, y, lay->h_med),
               GTextAlignmentCenter);
  y += lay->h_med + lay->gap / 2;

  // --- layer counter -----------------------------------------------------
  if (st->have_data && st->total_layers > 0) {
    snprintf(buf, sizeof(buf), "%u / %u",
             (unsigned)st->current_layer, (unsigned)st->total_layers);
  } else {
    snprintf(buf, sizeof(buf), "-- / --");
  }
  graphics_context_set_text_color(ctx, TM_TEXT);
  tm_draw_text(ctx, buf, lay->font_big, tm_row(lay, y, lay->h_big),
               GTextAlignmentCenter);
  y += lay->h_big + lay->gap;

  // --- progress bar (also the tap-to-refresh target) ---------------------
  GRect bar_row = tm_row(lay, y, lay->bar_h);
  GColor bar_fill = st->low_resin ? TM_WARN : TM_ACCENT;
  tm_draw_bar(ctx, bar_row, st->have_data ? st->percent : 0, bar_fill);
  if (st->refreshing) {
    // Brief confirmation flash so a tap visibly registers.
    graphics_context_set_fill_color(ctx, TM_CHROME);
    graphics_fill_rect(ctx, GRect(bar_row.origin.x, bar_row.origin.y,
                                  bar_row.size.w, bar_row.size.h),
                       bar_row.size.h / 2, GCornersAll);
  }
  g_progress_hit = GRect(bar_row.origin.x, bar_row.origin.y - 10,
                         bar_row.size.w, bar_row.size.h + 20);
  y += lay->bar_h + lay->gap;

  // --- percent + time remaining -----------------------------------------
  char remain[16];
  tm_format_duration(tm_remaining_now(st), remain, sizeof(remain));
  if (st->have_data) {
    snprintf(buf, sizeof(buf), "%u%%   %s", (unsigned)st->percent, remain);
  } else {
    snprintf(buf, sizeof(buf), "--%%   --");
  }
  graphics_context_set_text_color(ctx, TM_TEXT);
  tm_draw_text(ctx, buf, lay->font_small, tm_row(lay, y, lay->h_small),
               GTextAlignmentCenter);
  y += lay->h_small + 1;

  // --- estimated finish clock -------------------------------------------
  format_finish_clock(st->have_data ? st->finish_epoch : 0, buf, sizeof(buf));
  graphics_context_set_text_color(ctx, TM_MUTED);
  tm_draw_text(ctx, buf, lay->font_small, tm_row(lay, y, lay->h_small),
               GTextAlignmentCenter);
  y += lay->h_small + lay->gap / 2;

  // --- footer: stale notice, bridge error, or the print name -------------
  const char *footer = NULL;
  GColor footer_color = TM_MUTED;
  if (tm_is_stale(st)) {
    footer = "Stale data";
    footer_color = TM_WARN;
  } else if (st->conn_state == TM_CONN_ERROR && st->conn_msg[0]) {
    footer = st->conn_msg;
    footer_color = TM_WARN;
  } else if (st->print_name[0]) {
    footer = st->print_name;
  }
  if (footer) {
    graphics_context_set_text_color(ctx, footer_color);
    tm_draw_text(ctx, footer, lay->font_small, tm_row(lay, y, lay->h_small),
                 GTextAlignmentCenter);
  }
}
