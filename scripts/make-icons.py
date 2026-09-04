#!/usr/bin/env python3
"""
Generate every icon and store asset for TinyMaker Print Monitor.

One mark, drawn once at 1024px and downsampled, so the 25px watch icon and the
720x320 store banner stay in sync:

  a resin VAT, filled to a level in TinyMaker orange, with the build plate
  lowering into it - "resin level" and "progress" in the same shape.

    python3 scripts/make-icons.py

Outputs:
  resources/images/menu_icon.png   25x25   watch app-list icon (white/orange, transparent)
  icon_25x25.png                   25x25   store small
  icon_80x80.png                   80x80   store
  icon_144x144.png                 144x144 store
  banner_720x320.png               720x320 store banner
"""

import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Palette from docs/PLAN.md section 4.
BLUE = (30, 95, 168, 255)      # #1E5FA8  TinyMaker blue
ORANGE = (242, 129, 29, 255)   # #F2811D  TinyMaker orange
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

S = 1024                       # master canvas; everything below is in these units

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


# --- the mark ---------------------------------------------------------------

# Vat: a trapezoid, wider at the rim. Outer edge is the white body, inner edge
# is the cavity; the gap between them reads as a stroke at every size.
VAT_OUTER = [(150, 450), (874, 450), (806, 920), (218, 920)]
VAT_INNER = [(232, 532), (792, 532), (740, 840), (284, 840)]

# Build plate on its Z stem, dipping toward the rim. Kept deliberately chunky:
# anything thinner disappears at the 25px watch size.
PLATE = (312, 282, 712, 370)
STEM = (478, 104, 546, 282)

RESIN_TOP = 640               # y of the resin surface inside the cavity


def _interp_x(y, top_pt, bottom_pt):
    (x0, y0), (x1, y1) = top_pt, bottom_pt
    return x0 + (x1 - x0) * (y - y0) / float(y1 - y0)


def resin_polygon(level_y=RESIN_TOP):
    left = _interp_x(level_y, VAT_INNER[0], VAT_INNER[3])
    right = _interp_x(level_y, VAT_INNER[1], VAT_INNER[2])
    return [(left, level_y), (right, level_y), VAT_INNER[2], VAT_INNER[3]]


def draw_mark(size, background, body, cavity):
    """Render the mark at `size` px. `cavity` is what shows inside the vat."""
    img = Image.new("RGBA", (S, S), CLEAR)
    d = ImageDraw.Draw(img)

    if background is not None:
        d.rounded_rectangle((0, 0, S - 1, S - 1), radius=196, fill=background)

    d.rounded_rectangle(STEM, radius=26, fill=body)
    d.rounded_rectangle(PLATE, radius=38, fill=body)

    d.polygon(VAT_OUTER, fill=body)
    d.polygon(VAT_INNER, fill=cavity)
    d.polygon(resin_polygon(), fill=ORANGE)

    return img.resize((size, size), Image.LANCZOS)


def store_icon(size):
    """Blue tile, white vat, orange resin - for the app store listing."""
    return draw_mark(size, background=BLUE, body=WHITE, cavity=BLUE)


def menu_icon(size=25):
    """White vat on transparent, for the watch's app list."""
    return draw_mark(size, background=None, body=WHITE, cavity=CLEAR)


# --- banner -----------------------------------------------------------------

def _fit(text, max_w, start_size, min_size=14):
    """Largest font size at which `text` still fits `max_w`."""
    size = start_size
    while size > min_size:
        font = load_font(size)
        if font.getbbox(text)[2] <= max_w:
            return font
        size -= 1
    return load_font(min_size)


def banner(width=720, height=320):
    img = Image.new("RGBA", (width, height), BLUE)
    d = ImageDraw.Draw(img)

    pad = 44
    mark_size = 176
    mark = draw_mark(mark_size, background=None, body=WHITE, cavity=BLUE)
    img.paste(mark, (pad, (height - mark_size) // 2), mark)

    text_x = pad + mark_size + 40
    text_w = width - pad - text_x

    line1 = _fit("TinyMaker", text_w, 58)
    line2 = _fit("Print Monitor", text_w, 58)
    tag = _fit("Layers, time left and resin - live on your wrist", text_w, 24)

    d.text((text_x, 74), "TinyMaker", font=line1, fill=WHITE)
    d.text((text_x, 132), "Print Monitor", font=line2, fill=ORANGE)
    d.text((text_x, 200), "Layers, time left and resin - live on your wrist",
           font=tag, fill=(190, 212, 236, 255))

    # A progress bar echoing the one on the watch face.
    top, h = 240, 10
    d.rounded_rectangle((text_x, top, width - pad, top + h),
                        radius=h // 2, fill=(20, 68, 122, 255))
    d.rounded_rectangle((text_x, top, text_x + int(text_w * 0.62), top + h),
                        radius=h // 2, fill=ORANGE)

    return img.convert("RGB")


def main():
    out = []

    for size in (25, 80, 144):
        path = os.path.join(ROOT, "icon_%dx%d.png" % (size, size))
        store_icon(size).save(path)
        out.append(path)

    menu_path = os.path.join(ROOT, "resources", "images", "menu_icon.png")
    os.makedirs(os.path.dirname(menu_path), exist_ok=True)
    menu_icon(25).save(menu_path)
    out.append(menu_path)

    banner_path = os.path.join(ROOT, "banner_720x320.png")
    banner().save(banner_path)
    out.append(banner_path)

    for path in out:
        print("wrote", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
