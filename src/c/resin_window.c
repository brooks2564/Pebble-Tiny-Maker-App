// Screen 2 - resin gauge, low-resin warning, print name, elapsed time.
#include "print_state.h"
#include "colors.h"

void resin_page_draw(GContext *ctx, const TmLayout *lay, const PrintState *st) {
  tm_draw_header(ctx, lay, st, "RESIN", 1);

  int y = lay->body_top + lay->gap;
  char buf[40];

  // --- resin percentage, large -------------------------------------------
  if (st->have_data) {
    snprintf(buf, sizeof(buf), "%u%%", (unsigned)st->resin_left_pct);
  } else {
    snprintf(buf, sizeof(buf), "--%%");
  }
  graphics_context_set_text_color(ctx, st->low_resin ? TM_WARN : TM_TEXT);
  tm_draw_text(ctx, buf, lay->font_big, tm_row(lay, y, lay->h_big),
               GTextAlignmentCenter);
  y += lay->h_big + lay->gap / 2;

  // --- VAT gauge ----------------------------------------------------------
  GRect gauge = tm_row(lay, y, lay->bar_h);
  tm_draw_bar(ctx, gauge, st->have_data ? st->resin_left_pct : 0,
              st->low_resin ? TM_WARN : TM_ACCENT);
  y += lay->bar_h + lay->gap;

  // --- millilitres --------------------------------------------------------
  if (st->have_data) {
    snprintf(buf, sizeof(buf), "%u ml in VAT", (unsigned)st->resin_left_ml);
  } else {
    snprintf(buf, sizeof(buf), "-- ml in VAT");
  }
  graphics_context_set_text_color(ctx, TM_TEXT);
  tm_draw_text(ctx, buf, lay->font_small, tm_row(lay, y, lay->h_small),
               GTextAlignmentCenter);
  y += lay->h_small + lay->gap / 2;

  // --- low-resin banner ----------------------------------------------------
  // Only claims vertical space when it actually appears, so the page closes up
  // on a healthy VAT instead of showing a gap where a warning might go.
  if (st->low_resin) {
    GRect banner = tm_row(lay, y, lay->h_small + 6);
    graphics_context_set_fill_color(ctx, TM_WARN);
    graphics_fill_rect(ctx, banner, 4, GCornersAll);
    graphics_context_set_text_color(ctx, TM_CHROME_TEXT);
    tm_draw_text(ctx, "LOW RESIN",
                 lay->font_small,
                 GRect(banner.origin.x, banner.origin.y + 1,
                       banner.size.w, banner.size.h),
                 GTextAlignmentCenter);
    y += lay->h_small + 6 + lay->gap / 2;
  } else {
    y += lay->gap;
  }

  // --- print name ---------------------------------------------------------
  graphics_context_set_text_color(ctx, TM_CHROME);
  tm_draw_text(ctx, st->print_name[0] ? st->print_name : "No active print",
               lay->font_small, tm_row(lay, y, lay->h_small),
               GTextAlignmentCenter);
  y += lay->h_small + 1;

  // --- elapsed ------------------------------------------------------------
  char elapsed[16];
  tm_format_duration(st->elapsed_sec, elapsed, sizeof(elapsed));
  snprintf(buf, sizeof(buf), "Elapsed %s", elapsed);
  graphics_context_set_text_color(ctx, TM_MUTED);
  tm_draw_text(ctx, buf, lay->font_small, tm_row(lay, y, lay->h_small),
               GTextAlignmentCenter);
}
