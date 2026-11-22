#!/usr/bin/env python3
"""Render assets/icon.svg into a multi-size Windows .ico (assets/icon.ico).

Pure-Python + Pillow: parses the SVG rect/path elements in icon.svg,
flattens cubic beziers, rasterizes with 2x supersampling for smooth edges,
and writes ICO sizes 256/128/64/48/32/16.

Usage: python scripts/make_icon.py   (run from the project root)
"""
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG_PATH = ROOT / "assets" / "icon.svg"
ICO_PATH = ROOT / "assets" / "icon.ico"
ICO_SIZES = [256, 128, 64, 48, 32, 16]
SS = 2            # supersampling factor
CANVAS = 512     # SVG viewBox size


def _cubic(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def parse_path(d):
    """Parse an SVG path (M/L/H/V/C/c/h/l/v/Z) into a list of subpath point lists."""
    tokens = re.findall(r"[MmLlHhVvCcZz]|-?\d*\.?\d+", d)
    subpaths, cur, start, curpt = [], [], None, (0.0, 0.0)
    i, cmd = 0, None
    while i < len(tokens):
        tok = tokens[i]
        if tok.isalpha():
            cmd, i = tok, i + 1
            if cmd in "Zz":
                if cur:
                    subpaths.append(cur)
                cur, start = [], None
                continue
        if cmd in "Mm":
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if cmd == "m" and curpt != (0.0, 0.0):
                x, y = curpt[0] + x, curpt[1] + y
            curpt = (x, y)
            if cur:
                subpaths.append(cur)
            cur, start = [curpt], curpt
            cmd = "L" if cmd == "M" else "l"
        elif cmd in "Ll":
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if cmd == "l":
                x, y = curpt[0] + x, curpt[1] + y
            curpt = (x, y)
            cur.append(curpt)
        elif cmd in "Hh":
            x = float(tokens[i])
            i += 1
            if cmd == "h":
                x = curpt[0] + x
            curpt = (x, curpt[1])
            cur.append(curpt)
        elif cmd in "Vv":
            y = float(tokens[i])
            i += 1
            if cmd == "v":
                y = curpt[1] + y
            curpt = (curpt[0], y)
            cur.append(curpt)
        elif cmd in "Cc":
            x1, y1, x2, y2, x, y = (float(t) for t in tokens[i:i + 6])
            i += 6
            if cmd == "c":
                x1, y1 = curpt[0] + x1, curpt[1] + y1
                x2, y2 = curpt[0] + x2, curpt[1] + y2
                x, y = curpt[0] + x, curpt[1] + y
            pts = _cubic(curpt, (x1, y1), (x2, y2), (x, y))
            cur.extend(pts[1:])
            curpt = (x, y)
        else:
            raise ValueError(f"unsupported token {tok!r} in path {d!r}")
    if cur:
        subpaths.append(cur)
    return subpaths


def main():
    tree = ET.parse(SVG_PATH)
    root = tree.getroot()
    ns = {"svg": "http://www.w3.org/2000/svg"}

    def local(tag):
        return tag.split("}")[-1]

    img = Image.new("RGBA", (CANVAS * SS, CANVAS * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def scale(pts):
        return [(x * SS, y * SS) for x, y in pts]

    for el in root.iter():
        tag = local(el.tag)
        fill = el.get("fill", "#000000")
        if tag == "rect":
            x, y = float(el.get("x", 0)), float(el.get("y", 0))
            w, h = float(el.get("width")), float(el.get("height"))
            rx = float(el.get("rx", 0))
            draw.rounded_rectangle(
                [x * SS, y * SS, (x + w) * SS, (y + h) * SS],
                radius=rx * SS, fill=fill,
            )
        elif tag == "path":
            for sub in parse_path(el.get("d")):
                draw.polygon(scale(sub), fill=fill)

    img = img.resize((CANVAS, CANVAS), Image.LANCZOS)
    img.save(ICO_PATH, format="ICO",
             sizes=[(s, s) for s in ICO_SIZES])
    print(f"wrote {ICO_PATH} sizes={ICO_SIZES}")


if __name__ == "__main__":
    main()
