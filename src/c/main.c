// TinyMaker Print Monitor - watchapp entry point.
//
// The watch is a display for a normalised print status that arrives from the
// phone (src/pkjs) over AppMessage; see docs/PLAN.md sections 3 and 6. Two
// pages share one window so switching between them is instant on both touch
// and button hardware.

#include <pebble.h>
#include "print_state.h"
#include "colors.h"

#define PAGE_STATUS 0
#define PAGE_RESIN  1
#define PAGE_COUNT  2

#define UI_TICK_MS       5000   // foreground-only: refresh countdown + staleness
#define REFRESH_FLASH_MS 400
#define OVERLAY_MS       3000

static Window   *s_window;
static Layer    *s_canvas;
static AppTimer *s_ui_timer;
static AppTimer *s_flash_timer;

static PrintState s_state;
static TmLayout   s_layout;
static int        s_page = PAGE_STATUS;

static time_t s_overlay_until;   // "last updated" overlay
static bool   s_summary_visible; // finished-print summary, dismissed by the user

#ifndef touch_service_subscribe
// Swipe tracking (touch hardware only)
static int16_t s_touch_x0, s_touch_y0;
static bool    s_touch_active;
#endif

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

static void compute_layout(GRect bounds) {
  TmLayout *l = &s_layout;
  l->bounds = bounds;
  l->round  = PBL_IF_ROUND_ELSE(true, false);

  bool big = bounds.size.w >= 200;
  l->font_big   = fonts_get_system_font(big ? FONT_KEY_GOTHIC_28_BOLD
                                            : FONT_KEY_GOTHIC_24_BOLD);
  l->font_med   = fonts_get_system_font(big ? FONT_KEY_GOTHIC_24_BOLD
                                            : FONT_KEY_GOTHIC_18_BOLD);
  l->font_small = fonts_get_system_font(big ? FONT_KEY_GOTHIC_18
                                            : FONT_KEY_GOTHIC_14);
  l->h_big   = big ? 32 : 26;
  l->h_med   = big ? 27 : 21;
  l->h_small = big ? 21 : 17;
  l->bar_h   = big ? 14 : 10;
  l->header_h = big ? 26 : 20;
  l->gap = l->round ? (big ? 5 : 2) : (big ? 7 : 4);

  // Round displays lose the corners, so the band is pushed off the bezel and
  // the pips come up to match.
  l->header_y = l->round ? bounds.size.h * 9 / 100 : 0;
  l->body_top = l->header_y + l->header_h;
  l->pips_y   = l->round ? bounds.size.h - l->header_y - 6
                         : bounds.size.h - 12;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

static void draw_modal_box(GContext *ctx, const char *line1, const char *line2,
                           const char *line3) {
  const TmLayout *l = &s_layout;
  int lines = 1 + (line2 ? 1 : 0) + (line3 ? 1 : 0);
  int box_h = 16 + lines * (l->h_small + 2);
  int box_y = l->bounds.size.h / 2 - box_h / 2;
  GRect box = tm_row(l, box_y, box_h);

  graphics_context_set_fill_color(ctx, TM_BG);
  graphics_fill_rect(ctx, box, 6, GCornersAll);
  graphics_context_set_stroke_color(ctx, TM_CHROME);
  graphics_draw_round_rect(ctx, box, 6);

  int y = box.origin.y + 8;
  const char *lines_arr[3] = { line1, line2, line3 };
  for (int i = 0; i < 3; i++) {
    if (!lines_arr[i]) continue;
    graphics_context_set_text_color(ctx, i == 0 ? TM_CHROME : TM_TEXT);
    tm_draw_text(ctx, lines_arr[i], l->font_small,
                 GRect(box.origin.x + 4, y, box.size.w - 8, l->h_small),
                 GTextAlignmentCenter);
    y += l->h_small + 2;
  }
}

static void draw_last_update_overlay(GContext *ctx) {
  char stamp[24];
  if (s_state.last_update_epoch == 0) {
    snprintf(stamp, sizeof(stamp), "never");
  } else {
    time_t t = (time_t)s_state.last_update_epoch;
    strftime(stamp, sizeof(stamp),
             clock_is_24h_style() ? "%H:%M:%S" : "%I:%M:%S %p", localtime(&t));
  }
  char age[24];
  if (s_state.have_data) {
    char dur[16];
    tm_format_duration((uint32_t)(time(NULL) - s_state.last_rx_local), dur, sizeof(dur));
    snprintf(age, sizeof(age), "%s ago", dur);
  } else {
    snprintf(age, sizeof(age), "no data yet");
  }
  draw_modal_box(ctx, "Last update", stamp, age);
}

static void draw_summary_overlay(GContext *ctx) {
  char total[24], resin[24];
  char dur[16];
  tm_format_duration(s_state.elapsed_sec, dur, sizeof(dur));
  snprintf(total, sizeof(total), "Took %s", dur);
  snprintf(resin, sizeof(resin), "%u ml used", (unsigned)s_state.resin_used_ml);
  draw_modal_box(ctx, "Print finished", total, resin);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  compute_layout(bounds);

  graphics_context_set_fill_color(ctx, TM_BG);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  if (s_page == PAGE_RESIN) {
    resin_page_draw(ctx, &s_layout, &s_state);
  } else {
    status_page_draw(ctx, &s_layout, &s_state);
  }

  if (s_summary_visible) {
    draw_summary_overlay(ctx);
  } else if (s_overlay_until > time(NULL)) {
    draw_last_update_overlay(ctx);
  }
}

static void redraw(void) {
  if (s_canvas) layer_mark_dirty(s_canvas);
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

static void ui_tick(void *data) {
  s_ui_timer = app_timer_register(UI_TICK_MS, ui_tick, NULL);
  redraw();
}

static void flash_done(void *data) {
  s_flash_timer = NULL;
  s_state.refreshing = false;
  redraw();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

static void request_refresh(void) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_uint8(iter, MESSAGE_KEY_REQUEST_REFRESH, 1);
    app_message_outbox_send();
  }
  s_state.refreshing = true;
  if (s_flash_timer) app_timer_cancel(s_flash_timer);
  s_flash_timer = app_timer_register(REFRESH_FLASH_MS, flash_done, NULL);
  redraw();
}

static void set_page(int page) {
  if (page < 0) page = PAGE_COUNT - 1;
  if (page >= PAGE_COUNT) page = 0;
  s_page = page;
  redraw();
}

static bool dismiss_overlays(void) {
  if (s_summary_visible) { s_summary_visible = false; redraw(); return true; }
  if (s_overlay_until > time(NULL)) { s_overlay_until = 0; redraw(); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Buttons - full parity with the touch gestures (Plan section 5.4)
// ---------------------------------------------------------------------------

static void up_click(ClickRecognizerRef r, void *ctx)     { if (!dismiss_overlays()) set_page(s_page - 1); }
static void down_click(ClickRecognizerRef r, void *ctx)   { if (!dismiss_overlays()) set_page(s_page + 1); }
static void select_click(ClickRecognizerRef r, void *ctx) { if (!dismiss_overlays()) request_refresh(); }

static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

// ---------------------------------------------------------------------------
// Touch - additive only; every gesture has a button equivalent (Plan 5.3/5.4).
// On non-touch platforms the SDK #defines the touch service away to a no-op,
// so the whole block compiles out and the buttons carry the app unchanged.
// ---------------------------------------------------------------------------

#ifndef touch_service_subscribe
#define TM_HAS_TOUCH 1
#endif

#ifdef TM_HAS_TOUCH
static bool hit(GRect box, int16_t x, int16_t y) {
  return x >= box.origin.x && x <= box.origin.x + box.size.w &&
         y >= box.origin.y && y <= box.origin.y + box.size.h;
}

static void touch_handler(const TouchEvent *event, void *context) {
  switch (event->type) {
    case TouchEvent_Touchdown:
      s_touch_x0 = event->x;
      s_touch_y0 = event->y;
      s_touch_active = true;
      break;

    case TouchEvent_Liftoff: {
      if (!s_touch_active) return;
      s_touch_active = false;
      int dx = event->x - s_touch_x0;
      int dy = event->y - s_touch_y0;
      int adx = dx < 0 ? -dx : dx;
      int ady = dy < 0 ? -dy : dy;

      if (adx > s_layout.bounds.size.w / 4 && adx > ady) {
        if (!dismiss_overlays()) set_page(dx < 0 ? s_page + 1 : s_page - 1);
        return;
      }
      if (dismiss_overlays()) return;

      if (hit(g_stale_hit, event->x, event->y)) {
        s_overlay_until = time(NULL) + OVERLAY_MS / 1000;
        redraw();
      } else if (s_page == PAGE_STATUS && hit(g_progress_hit, event->x, event->y)) {
        request_refresh();
      }
      break;
    }

    default:
      break;
  }
}
#endif  // TM_HAS_TOUCH

// ---------------------------------------------------------------------------
// Events / vibrations (Plan section 5.5)
// ---------------------------------------------------------------------------

static void handle_event(TmEvent ev) {
  static const uint32_t finished[]  = { 200, 120, 200, 120, 500 };
  static const uint32_t canceled[]  = { 120, 100, 120 };
  static const uint32_t low_resin[] = { 80, 80, 80, 80, 80, 80, 400 };
  static const uint32_t power_loss[]= { 500, 150, 120, 150, 500 };

  switch (ev) {
    case TM_EVENT_FINISHED:
      vibes_enqueue_custom_pattern((VibePattern){ .durations = (uint32_t *)finished,
                                                  .num_segments = ARRAY_LENGTH(finished) });
      s_summary_visible = true;
      break;
    case TM_EVENT_CANCELED:
      vibes_enqueue_custom_pattern((VibePattern){ .durations = (uint32_t *)canceled,
                                                  .num_segments = ARRAY_LENGTH(canceled) });
      break;
    case TM_EVENT_LOW_RESIN_PAUSE:
      vibes_enqueue_custom_pattern((VibePattern){ .durations = (uint32_t *)low_resin,
                                                  .num_segments = ARRAY_LENGTH(low_resin) });
      s_page = PAGE_RESIN;   // take the user straight to the resin gauge
      break;
    case TM_EVENT_POWER_LOSS:
      vibes_enqueue_custom_pattern((VibePattern){ .durations = (uint32_t *)power_loss,
                                                  .num_segments = ARRAY_LENGTH(power_loss) });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// AppMessage
// ---------------------------------------------------------------------------

static void inbox_received(DictionaryIterator *iter, void *context) {
  bool got_status = false;
  Tuple *t;

  if ((t = dict_find(iter, MESSAGE_KEY_PHASE))) {
    s_state.phase = (TmPhase)t->value->uint8;
    got_status = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_CURRENT_LAYER)))    s_state.current_layer = t->value->uint16;
  if ((t = dict_find(iter, MESSAGE_KEY_TOTAL_LAYERS)))     s_state.total_layers = t->value->uint16;
  if ((t = dict_find(iter, MESSAGE_KEY_PERCENT_COMPLETE))) s_state.percent = t->value->uint8;
  if ((t = dict_find(iter, MESSAGE_KEY_ELAPSED_SEC)))      s_state.elapsed_sec = t->value->uint32;
  if ((t = dict_find(iter, MESSAGE_KEY_FINISH_EPOCH)))     s_state.finish_epoch = t->value->uint32;
  if ((t = dict_find(iter, MESSAGE_KEY_RESIN_USED_ML)))    s_state.resin_used_ml = t->value->uint16;
  if ((t = dict_find(iter, MESSAGE_KEY_RESIN_LEFT_ML)))    s_state.resin_left_ml = t->value->uint16;
  if ((t = dict_find(iter, MESSAGE_KEY_RESIN_LEFT_PCT)))   s_state.resin_left_pct = t->value->uint8;
  if ((t = dict_find(iter, MESSAGE_KEY_LOW_RESIN_FLAG)))   s_state.low_resin = t->value->uint8 != 0;
  if ((t = dict_find(iter, MESSAGE_KEY_LAST_UPDATE_EPOCH))) s_state.last_update_epoch = t->value->uint32;

  if ((t = dict_find(iter, MESSAGE_KEY_TIME_REMAINING_SEC))) {
    s_state.time_remaining_sec = t->value->uint32;
    s_state.remaining_anchor = time(NULL);
    got_status = true;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_PRINT_NAME))) {
    strncpy(s_state.print_name, t->value->cstring, TM_PRINT_NAME_MAX - 1);
    s_state.print_name[TM_PRINT_NAME_MAX - 1] = '\0';
  }
  if ((t = dict_find(iter, MESSAGE_KEY_CONN_STATE))) {
    s_state.conn_state = (TmConnState)t->value->uint8;
  }
  if ((t = dict_find(iter, MESSAGE_KEY_CONN_MSG))) {
    strncpy(s_state.conn_msg, t->value->cstring, TM_CONN_MSG_MAX - 1);
    s_state.conn_msg[TM_CONN_MSG_MAX - 1] = '\0';
  }

  if (got_status) {
    s_state.have_data = true;
    s_state.last_rx_local = time(NULL);
    s_state.refreshing = false;
    if (s_flash_timer) { app_timer_cancel(s_flash_timer); s_flash_timer = NULL; }
  }

  if ((t = dict_find(iter, MESSAGE_KEY_EVENT))) {
    handle_event((TmEvent)t->value->uint8);
  }

  redraw();
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  compute_layout(bounds);

  s_canvas = layer_create(bounds);
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);

#ifdef TM_HAS_TOUCH
  touch_service_subscribe(touch_handler, NULL);
#endif
  s_ui_timer = app_timer_register(UI_TICK_MS, ui_tick, NULL);
}

static void window_unload(Window *window) {
#ifdef TM_HAS_TOUCH
  touch_service_unsubscribe();
#endif
  if (s_ui_timer)    { app_timer_cancel(s_ui_timer);    s_ui_timer = NULL; }
  if (s_flash_timer) { app_timer_cancel(s_flash_timer); s_flash_timer = NULL; }
  layer_destroy(s_canvas);
  s_canvas = NULL;
}

static void init(void) {
  memset(&s_state, 0, sizeof(s_state));
  s_state.conn_state = TM_CONN_UNKNOWN;

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_open(512, 64);

  s_window = window_create();
  window_set_background_color(s_window, TM_BG);
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);
}

static void deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
