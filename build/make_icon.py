#!/usr/bin/env python3
"""Generate the app icon (PNG + ICO + ICNS) for LoL Companion.

Design: dark rounded tile with a vertical gradient, a thin border, and a bold
accent-blue lightning bolt with a soft glow — reads cleanly down to 16px.
"""
import os
import subprocess
from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))

BG_TOP = (27, 34, 48)      # #1b2230
BG_BOT = (14, 17, 22)      # #0e1116
BORDER = (38, 44, 54)      # #262c36
ACCENT = (79, 157, 255)    # #4f9dff
ACCENT_HI = (150, 200, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bot):
    g = Image.new("RGB", (size, size), top)
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    for y in range(size):
        row = px[0, y]
        for x in range(size):
            px[x, y] = row
    return g


def make_base():
    radius = int(S * 0.22)
    mask = rounded_mask(S, radius)
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = gradient(S, BG_TOP, BG_BOT).convert("RGBA")
    base.paste(grad, (0, 0), mask)

    # thin inner border
    bd = ImageDraw.Draw(base)
    inset = int(S * 0.03)
    bd.rounded_rectangle(
        [inset, inset, S - 1 - inset, S - 1 - inset],
        radius=int(radius * 0.85), outline=BORDER, width=max(2, S // 170),
    )
    return base, mask


# Lightning bolt polygon (on the 1024 canvas)
BOLT = [
    (596, 150),
    (360, 582),
    (506, 582),
    (430, 876),
    (700, 430),
    (548, 430),
]


def draw_bolt(base, mask):
    # glow layer
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).polygon(BOLT, fill=ACCENT + (255,))
    glow = glow.filter(ImageFilter.GaussianBlur(S // 28))
    base.alpha_composite(glow)

    # solid bolt
    bolt = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bolt).polygon(BOLT, fill=ACCENT + (255,))
    # highlight core (slightly shrunk, lighter)
    hi = [(x, y) for (x, y) in BOLT]
    ImageDraw.Draw(bolt).polygon(hi, outline=ACCENT_HI + (255,), width=max(2, S // 150))
    base.alpha_composite(bolt)

    # clip to rounded tile
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def main():
    base, mask = make_base()
    icon = draw_bolt(base, mask)

    png = os.path.join(HERE, "icon.png")
    icon.save(png)
    print("wrote", png)

    # .ico (multi-size)
    ico = os.path.join(HERE, "icon.ico")
    icon.save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", ico)

    # .icns via iconset + iconutil
    iconset = os.path.join(HERE, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    specs = [
        (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
    ]
    for sz, name in specs:
        icon.resize((sz, sz), Image.LANCZOS).save(os.path.join(iconset, name))
    icns = os.path.join(HERE, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns], check=True)
    print("wrote", icns)


if __name__ == "__main__":
    main()
