"""
A builder's brochure cover, small enough to commit and real enough to elect.

WHAT IT HAS TO BE, and why each part is here rather than being a simpler file:
a page whose TEXT states the lot, the design and the estate, because the
election designates a cover from what the page says; and ONE large embedded
raster that reads as a photograph rather than as line art, because the role
classifier separates a facade from a floor plan on colour and edge statistics
and a flat fill would be classified as a plan. The image is generated noise
shaped like a sky, a roofline and a lawn — it is not a photograph of anything,
which is the point: nothing here depends on a real property's imagery.
"""
import io, math, random, sys
from reportlab import rl_config
# Real builder brochures embed their rasters with a single image filter.
# reportlab wraps every stream in ASCII85 by default, which produces
# `/Filter [ /ASCII85Decode /DCTDecode ]` — a shape the live library does not
# contain, and one the extractor is right not to accept. Turning it off is what
# makes this fixture representative rather than convenient.
rl_config.useA85 = 0
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image

random.seed(717)
W, H = 1280, 800
img = Image.new('RGB', (W, H))
px = img.load()
for y in range(H):
    for x in range(W):
        if y < H * 0.42:                      # sky: blue, softly banded
            base = (120 + int(70 * y / (H * 0.42)), 165 + int(55 * y / (H * 0.42)), 225)
        elif y < H * 0.72:                    # the house: warm render tones
            t = (y - H * 0.42) / (H * 0.30)
            base = (188 - int(40 * t), 172 - int(45 * t), 150 - int(40 * t))
            if abs(x - W / 2) < 300 and y < H * 0.55:
                base = (96 + int(20 * math.sin(x / 40)), 90, 88)   # roof
        else:                                 # lawn and driveway
            base = (92 + int(40 * random.random()), 128, 74)
            if abs(x - W / 2) < 150:
                base = (176, 174, 170)
        px[x, y] = tuple(max(0, min(255, c + random.randint(-14, 14))) for c in base)

jpeg = io.BytesIO()
img.save(jpeg, format='JPEG', quality=86)
jpeg.seek(0)

out = sys.argv[1]
# `--heavy` builds a document the SIZE of the ones that were killed on the
# Supabase edge: twelve pages, each carrying its own full-bleed raster, so the
# election pays a realistic decode bill rather than a toy one. It is generated
# rather than committed — eight megabytes of synthetic noise has no business
# in a git history.
HEAVY = '--heavy' in sys.argv

# ---- the two text-free shapes -------------------------------------------
#
# A REAL PRODUCTION SHAPE, NOT A CONTRIVANCE. Lot 208 / `46 Satinwood Crescent
# Donnybrook` is a brochure exported entirely as artwork: every page yields
# zero characters to text extraction, so the election cannot read the property
# out of the document and falls back to the builder's own folder having named
# the file for this one lot — which licenses page 1 as a structural cover.
# What then decides the outcome is whether that page presents ONE photograph.
#
# `--text-free-hero` does, and must still elect. `--text-free-blank` does not,
# and is the deterministic refusal `TEXT_FREE_COVER_NOT_ELECTED` exists for.
# Neither draws a single character, which is the property that makes them
# text-free — so nothing here may call `drawString`.
#
# `--text-free-plan` is the LOT 208 SHAPE ITSELF, and it is the one the retry
# budget turns on. Measured on the real document (4,178,756 bytes, the byte
# size production recorded on all fourteen attempts): coverPages [1], ONE
# decoded asset of 2,375,240 bytes, pageOrderAuthoritative, no unread streams,
# and the cover rule refusing it with "every picture on the property cover is
# a plan or a graphic rather than a photograph of the property". The decode
# SUCCEEDED; the picture simply is not a photograph of a house.
#
# `--text-free-blank` is deliberately NOT that. It embeds no raster at all, so
# it yields zero assets — which is exactly what a starved or failed decode
# yields, and the two cannot be told apart. It is here to prove that shape
# stays on the generic allowance.
TEXT_FREE_HERO = '--text-free-hero' in sys.argv
TEXT_FREE_BLANK = '--text-free-blank' in sys.argv
TEXT_FREE_PLAN = '--text-free-plan' in sys.argv
if TEXT_FREE_HERO or TEXT_FREE_BLANK or TEXT_FREE_PLAN:
    c = canvas.Canvas(out, pagesize=A4)
    pw, ph = A4
    if TEXT_FREE_PLAN:
        # A drawn plan rasterised: near-white ground, thin dark rules, no
        # sky/lawn colour statistics. The role classifier separates a facade
        # from a plan on colour and edge statistics, so this materialises as a
        # real asset and is then refused as "a plan or a graphic".
        pw_, ph_ = 1400, 990
        plan = Image.new('RGB', (pw_, ph_), (252, 252, 250))
        d = plan.load()
        for x in range(pw_):
            for y in range(ph_):
                on_frame = (60 < x < pw_ - 60 and 60 < y < ph_ - 60
                            and (abs(x - 60) < 3 or abs(x - (pw_ - 60)) < 3
                                 or abs(y - 60) < 3 or abs(y - (ph_ - 60)) < 3))
                on_wall = (200 < x < pw_ - 200 and abs(y - ph_ // 2) < 3) or \
                          (200 < y < ph_ - 200 and abs(x - pw_ // 2) < 3)
                if on_frame or on_wall:
                    d[x, y] = (24, 24, 28)
        buf_ = io.BytesIO(); plan.save(buf_, format='JPEG', quality=92); buf_.seek(0)
        c.drawImage(ImageReader(buf_), 20 * mm, ph - 165 * mm,
                    width=pw - 40 * mm, height=110 * mm,
                    preserveAspectRatio=True, mask=None)
    elif TEXT_FREE_HERO:
        # One large raster and nothing else: the cover rule's "the only
        # photograph the property cover presents" case.
        c.drawImage(ImageReader(jpeg), 20 * mm, ph - 165 * mm,
                    width=pw - 40 * mm, height=110 * mm,
                    preserveAspectRatio=True, mask=None)
    else:
        # Vector line art only — no embedded raster at all, so the cover page
        # presents no photograph and the election has nothing it may take.
        c.setStrokeColorRGB(0.2, 0.2, 0.2)
        c.setLineWidth(1.2)
        c.rect(20 * mm, ph - 165 * mm, pw - 40 * mm, 110 * mm)
        for i in range(12):
            y = ph - (60 + i * 8) * mm
            c.line(28 * mm, y, pw - 28 * mm, y)
    c.showPage()
    c.save()
    print(out)
    sys.exit(0)

c = canvas.Canvas(out, pagesize=A4)
pw, ph = A4
c.setFont('Helvetica-Bold', 22)
c.drawString(20 * mm, ph - 28 * mm, 'LOT 717 - ENZO 10.5 MODERN')
c.setFont('Helvetica', 13)
c.drawString(20 * mm, ph - 37 * mm, 'WATSONS REACH ESTATE, LOGAN RESERVE QLD 4133')
c.drawString(20 * mm, ph - 45 * mm, '4 bed  2 bath  2 car   |   Land 375 sqm   |   House 212 sqm')
# The facade render, drawn once and large: the cover rule reads emphasis.
c.drawImage(ImageReader(jpeg), 20 * mm, ph - 165 * mm,
            width=pw - 40 * mm, height=110 * mm, preserveAspectRatio=True, mask=None)
c.setFont('Helvetica', 11)
c.drawString(20 * mm, ph - 178 * mm, 'Artist impression. Facade shown is the Modern facade.')
c.showPage()
if HEAVY:
    # Filler pages with their own rasters. None of them can win: the cover rule
    # already designated page 1, and these state no identity.
    for page in range(10):
        noise = Image.new('RGB', (1100, 780))
        np_ = noise.load()
        for y in range(780):
            for x in range(1100):
                np_[x, y] = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
        buf = io.BytesIO(); noise.save(buf, format='JPEG', quality=92); buf.seek(0)
        c.setFont('Helvetica-Bold', 15)
        c.drawString(20 * mm, ph - 26 * mm, f'SPECIFICATION SHEET {page + 1}')
        c.drawImage(ImageReader(buf), 20 * mm, ph - 150 * mm,
                    width=pw - 40 * mm, height=110 * mm, preserveAspectRatio=True, mask=None)
        c.showPage()
# A closing page so the document is not a single-page special case.
c.setFont('Helvetica-Bold', 16)
c.drawString(20 * mm, ph - 28 * mm, 'INCLUSIONS')
c.setFont('Helvetica', 11)
for i, line in enumerate(['Ducted air conditioning', 'Stone benchtops throughout',
                          'Landscaping and fencing', 'Driveway and letterbox']):
    c.drawString(20 * mm, ph - (40 + i * 7) * mm, f'- {line}')
c.showPage()
c.save()
print(out)
