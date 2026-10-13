#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Render the transparent, tightly-cropped PWA icon set (what Windows shows in the
taskbar, Start, Alt+Tab, Task Manager).

Source : public/icons/pack/masters/transparent-display-2048.png  (mark only, no background)
Output : public/icons/transparent/icon-<N>.png   for every N in SIZES

How each icon is made:
  1. Crop the 2048px master to the mark's own bounding box (drops the empty margin).
  2. Scale it *uniformly* (never stretched) so the mark is the full frame height minus
     a small top/bottom margin (~3.5%) and centre it on a transparent square.
  3. Small sizes (<= 40px) get a touch of sharpening so they don't look mushy.
Every size is rendered straight from the 2048px master, never from another small size.

The opaque dark-tile icons (icon-16/32/64/180/192/256/512/1024.png) are untouched: the
browser-tab favicons and the iOS apple-touch-icon in index.html still use them, and
icon-192/512 stay in the manifest as `maskable` icons for Android's adaptive-icon masks.

SIZES is Microsoft's recommended set for PWAs on Windows: app-icon display-scale sizes
(44/55/66/88/176) + target sizes (16..96, 256), plus 128/192/512.

Usage:  python scripts/build-pwa-icons.py        (from the web/ project root)
Needs:  pip install pillow
"""
import sys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "public/icons/pack/masters/transparent-display-2048.png"
OUT_DIR = ROOT / "public/icons/transparent"

SIZES = [16, 20, 24, 30, 32, 36, 40, 44, 48, 55, 60, 64, 66, 72, 80, 88,
         96, 128, 176, 192, 256, 512]
MARGIN_FRAC = 0.035     # top/bottom breathing room, as a fraction of the frame
SHARPEN_MAX = 40        # sharpen frames up to this size (px)


def load_mark() -> Image.Image:
    im = Image.open(MASTER).convert("RGBA")
    bbox = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bbox:
        sys.exit(f"{MASTER} has no visible pixels")
    return im.crop(bbox)


def render(mark: Image.Image, size: int) -> Image.Image:
    margin = max(1, round(size * MARGIN_FRAC))
    target_h = size - 2 * margin
    scale = target_h / mark.height
    target_w = max(1, round(mark.width * scale))
    # Pillow premultiplies RGBA for LANCZOS, so edges don't pick up dark fringes.
    small = mark.resize((target_w, target_h), Image.LANCZOS)
    if size <= SHARPEN_MAX:
        r, g, b, a = small.split()
        rgb = Image.merge("RGB", (r, g, b)).filter(
            ImageFilter.UnsharpMask(radius=0.6, percent=55, threshold=0)
        )
        small = Image.merge("RGBA", (*rgb.split(), a))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((size - target_w) // 2, (size - target_h) // 2))
    return canvas


def main() -> None:
    if not MASTER.exists():
        sys.exit(f"missing source image: {MASTER}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mark = load_mark()
    for size in SIZES:
        out = OUT_DIR / f"icon-{size}.png"
        render(mark, size).save(out, optimize=True)
        print(f"wrote  {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
