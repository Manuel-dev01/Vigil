#!/usr/bin/env python3
"""
Build Vigil's brand files from one source of truth.

    python3 brand/build.py            # SVGs, chain data for the cover, then PNGs (needs Chrome)
    python3 brand/build.py --no-chain # keep the committed cover data

Writes:
  brand/svg/      mark, wordmark and lockups (day and night), the app icon; the wordmark is outlined
                  from Bodoni Moda (OFL-1.1), so the files need no font
  brand/png/      the same rendered at fixed sizes
  docs/cover.data.js   vigil-pay-1's batches and anchors as the chain reports them, with the date
  docs/cover.png  1920x1080, rendered from docs/cover.html (the project page's cover)
  docs/og.png and apps/web/public/og.png   1200x630, rendered from docs/og.html
  apps/web/public/favicon.svg, apple-touch-icon.png

The mark's geometry matches apps/web/src/brand/Mark.tsx. Chrome is found from CHROME, or the
Playwright cache, or the usual macOS path.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "brand")
FONT = os.path.join(ROOT, "apps/web/src/brand/fonts/bodoni-moda-latin-standard-normal.woff2")
PUBLIC = os.path.join(ROOT, "apps/web/public")
DOCS = os.path.join(ROOT, "docs")
REST = "https://api-testnet.qore.host"
ROLLUP = "vigil-pay-1"

# Brand colours (brand/README.md; apps/web/src/brand/brand.css)
NIGHT = "#0a1016"
CHART_NIGHT = "#eae4d6"  # ink on night
INK_DAY = "#0c1319"  # ink on day
LAMP = "#f3b33d"

# The mark, in a 48 x 48 box: beam edges, the sector arc, the lamp.
EDGES = "M21.24 34.11 9 8M26.76 34.11 39 8"
ARC = "M15.81 13.22A28 28 0 0 1 32.19 13.22"
LAMP_C = (24, 40, 3.6)


def mark_paths(ink: str, edge_w: float = 3.2, arc: bool = True, lamp_r: float = LAMP_C[2]) -> str:
    parts = [f'<path d="{EDGES}" fill="none" stroke="{ink}" stroke-width="{edge_w}"/>']
    if arc:
        parts.append(f'<path d="{ARC}" fill="none" stroke="{ink}" stroke-width="2"/>')
    parts.append(f'<circle cx="{LAMP_C[0]}" cy="{LAMP_C[1]}" r="{lamp_r}" fill="{LAMP}"/>')
    return "".join(parts)


def svg(w: float, h: float, body: str, vb: str | None = None) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb or f"0 0 {w:g} {h:g}"}" width="{w:g}" height="{h:g}">{body}</svg>\n'


def wordmark_path(text: str = "VIGIL", size: float = 100, tracking: float = 0.24) -> tuple[str, float, float, float]:
    """The word outlined at Bodoni Moda wght 520, opsz 96. Returns (path d, width, cap height, size)."""
    font = TTFont(FONT)
    font = instancer.instantiateVariableFont(font, {"wght": 520, "opsz": 96})
    upm = font["head"].unitsPerEm
    scale = size / upm
    cap = font["OS/2"].sCapHeight * scale
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    pen = SVGPathPen(gs)
    x = 0.0
    for i, ch in enumerate(text):
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (scale, 0, 0, -scale, x, cap)))
        x += hmtx[g][0] * scale
        if i < len(text) - 1:
            x += tracking * size
    return pen.getCommands(), x, cap, size


def write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    print("wrote", os.path.relpath(path, ROOT))


def build_svgs() -> None:
    out = os.path.join(BRAND, "svg")
    # Mark: day (ink strokes), night (chart strokes), and the app icon tile.
    write(os.path.join(out, "vigil-mark-day.svg"), svg(48, 48, mark_paths(INK_DAY)))
    write(os.path.join(out, "vigil-mark-night.svg"), svg(48, 48, mark_paths(CHART_NIGHT)))
    tile = f'<rect width="48" height="48" rx="9" fill="{NIGHT}"/>' + f'<g transform="translate(4.8 4.2) scale(0.8)">{mark_paths(CHART_NIGHT, 3.6)}</g>'
    write(os.path.join(out, "vigil-icon.svg"), svg(48, 48, tile))
    # Small sizes drop the arc and thicken the edges, so the V and the lamp survive at 16 px.
    fav = f'<rect width="48" height="48" rx="9" fill="{NIGHT}"/>' + mark_paths(CHART_NIGHT, 4.4, arc=False, lamp_r=4.6)
    write(os.path.join(PUBLIC, "favicon.svg"), svg(48, 48, fav))
    write(os.path.join(out, "vigil-favicon.svg"), svg(48, 48, fav))

    d, w, cap, _ = wordmark_path()
    for name, ink in (("day", INK_DAY), ("night", CHART_NIGHT)):
        write(os.path.join(out, f"vigil-wordmark-{name}.svg"), svg(round(w, 2), round(cap, 2), f'<path d="{d}" fill="{ink}"/>'))
        # Lockup: the mark at 1.7 x cap height, then the word, baselines aligned on the lamp's centre.
        m = cap * 1.7
        gap = cap * 0.55
        mark_g = f'<g transform="scale({m / 48:.5f})">{mark_paths(ink)}</g>'
        word_g = f'<g transform="translate({m + gap:.2f} {m * 40 / 48 - cap + cap * 0.06:.2f})"><path d="{d}" fill="{ink}"/></g>'
        write(os.path.join(out, f"vigil-lockup-{name}.svg"), svg(round(m + gap + w, 2), round(m, 2), mark_g + word_g))


def build_cover_data() -> None:
    def get(path: str) -> dict:
        req = urllib.request.Request(f"{REST}/{path}", headers={"User-Agent": "vigil-brand-build"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    batches = get(f"qorechain/rdk/v1/batches/{ROLLUP}")["batches"]
    anchors = get(f"qorechain/multilayer/v1/anchors/{ROLLUP}")["anchors"]
    anchored = {int(a["layer_height"]) for a in anchors}
    rows = [{"i": int(b["batch_index"]), "status": b["status"].lower().replace("batch_status_", ""), "anchored": int(b["batch_index"]) in anchored} for b in batches]
    rows.sort(key=lambda r: r["i"])
    data = {"rollup": ROLLUP, "asOf": datetime.now(timezone.utc).strftime("%-d %b %Y"), "batches": rows}
    write(os.path.join(DOCS, "cover.data.js"), "// Written by brand/build.py from the chain's REST API. Do not edit.\nwindow.COVER = " + json.dumps(data) + ";\n")


def chrome() -> str:
    for c in [os.environ.get("CHROME", "")] + sorted(
        glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")), reverse=True
    ) + ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]:
        if c and os.path.exists(c):
            return c
    sys.exit("Chrome not found: set CHROME to its binary")


def shot(src: str, out: str, w: int, h: int, transparent: bool = False) -> None:
    args = [chrome(), "--headless=new", "--hide-scrollbars", "--disable-gpu", f"--window-size={w},{h}", f"--screenshot={out}", "--virtual-time-budget=3000"]
    if transparent:
        args.append("--default-background-color=00000000")
    subprocess.run(args + ["file://" + src], check=True, capture_output=True)
    print("rendered", os.path.relpath(out, ROOT))


def build_pngs() -> None:
    png = os.path.join(BRAND, "png")
    os.makedirs(png, exist_ok=True)
    tmp = os.path.join(BRAND, ".render")
    os.makedirs(tmp, exist_ok=True)

    def page(name: str, file: str, w: int, h: int, bg: str = "transparent") -> str:
        p = os.path.join(tmp, name + ".html")
        with open(p, "w") as f:
            f.write(f'<!doctype html><html><body style="margin:0;background:{bg}"><img src="{file}" style="display:block;width:{w}px;height:{h}px"></body></html>')
        return p

    svgdir = os.path.join(BRAND, "svg")
    for size in (512, 192):
        shot(page(f"icon{size}", os.path.join(svgdir, "vigil-icon.svg"), size, size), os.path.join(png, f"vigil-icon-{size}.png"), size, size, True)
    shot(page("apple", os.path.join(svgdir, "vigil-icon.svg"), 180, 180), os.path.join(PUBLIC, "apple-touch-icon.png"), 180, 180, True)
    for name in ("day", "night"):
        shot(page(f"mark-{name}", os.path.join(svgdir, f"vigil-mark-{name}.svg"), 512, 512), os.path.join(png, f"vigil-mark-{name}-512.png"), 512, 512, True)
        shot(page(f"lockup-{name}", os.path.join(svgdir, f"vigil-lockup-{name}.svg"), 1200, 256), os.path.join(png, f"vigil-lockup-{name}-1200.png"), 1200, 256, True)
    shot(os.path.join(DOCS, "cover.html"), os.path.join(DOCS, "cover.png"), 1920, 1080)
    shot(os.path.join(DOCS, "og.html"), os.path.join(DOCS, "og.png"), 1200, 630)
    with open(os.path.join(DOCS, "og.png"), "rb") as a, open(os.path.join(PUBLIC, "og.png"), "wb") as b:
        b.write(a.read())


if __name__ == "__main__":
    build_svgs()
    if "--no-chain" not in sys.argv:
        build_cover_data()
    build_pngs()
