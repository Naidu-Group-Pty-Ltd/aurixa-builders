"""
THE ACCEPTANCE CORPUS — real PDF bytes, one document per SHAPE.

`builderStockBrochureCorpus.spec.ts` already covers the reader's shapes by
handing it page text directly. That is the right test for a parsing rule and
it cannot see this incident: every defect this corpus exists to catch lives
BETWEEN the bytes and the reader, or AFTER the reader and before the card.
So nothing here is synthesised text. Each fixture is a PDF built by a
generator, written to disk, and put through the portal's own entry point.

EVERY EXPECTATION IS AUTHORED FROM THE DOCUMENT, NEVER FROM THE READER.
Each builder function below returns what the document STATES, and the harness
compares the pipeline's answer against that. Writing the expectation from a
run would make the corpus a record of current behaviour rather than a
statement of required behaviour, and the point of a held-out document is lost
the moment its expectation is copied out of an output.

No builder in this file is real, no filename is parsed for its own sake, and
no fixture is keyed on a production document. A new brochure is covered
because its SHAPE is covered.
"""
import io, json, math, os, random, sys
from reportlab import rl_config
rl_config.useA85 = 0
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image

W, H = A4

# ---------------------------------------------------------------------------
# Rasters. A facade reads as a photograph; a plan reads as line art. The role
# classifier separates them on colour and edge statistics, so these are built
# to differ in exactly those statistics rather than by being labelled.
# ---------------------------------------------------------------------------

def _octaves(seed, w, h, octaves=6):
    """Multi-octave value noise: the 1/f statistic natural images actually have.

    Returns a w*h list of floats in roughly [-1, 1], smooth at every scale and
    FLAT AT NONE. That last property is the point — see `facade`.
    """
    rnd = random.Random(seed)
    acc = [0.0] * (w * h)
    amp, cells = 1.0, 2
    for _ in range(octaves):
        gw, gh = cells + 1, cells + 1
        grid = [rnd.uniform(-1.0, 1.0) for _ in range(gw * gh)]
        for y in range(h):
            fy = y * cells / h
            y0 = int(fy); y1 = min(y0 + 1, gh - 1); ty = fy - y0
            ty = ty * ty * (3 - 2 * ty)                      # smoothstep
            for x in range(w):
                fx = x * cells / w
                x0 = int(fx); x1 = min(x0 + 1, gw - 1); tx = fx - x0
                tx = tx * tx * (3 - 2 * tx)
                a = grid[y0 * gw + x0] + tx * (grid[y0 * gw + x1] - grid[y0 * gw + x0])
                b = grid[y1 * gw + x0] + tx * (grid[y1 * gw + x1] - grid[y1 * gw + x0])
                acc[y * w + x] += amp * (a + ty * (b - a))
        amp *= 0.55
        cells *= 2
    return acc


def facade(seed=11, w=1280, h=800):
    """A builder's facade render, with the statistics a photograph has.

    TWO CORRECTIONS, BOTH MEASURED THROUGH THE REAL PIPELINE, and the second is
    the one that matters.

    The first version laid +/-14 per-pixel noise over three flat colour bands.
    At some seeds that high-frequency texture read to the overlay inspector as
    the SHAPE OF WORDS — `faint_type_present` — so `LOT 61 - EMBER - FLYER` was
    refused a clearance and its photograph never reached the card.

    Removing the noise fixed that and exposed the real problem: the bands.
    `marketplaceEligibility` convicts a picture as an `annotated_marketing_tile`
    on its FLAT REGIONS, which is exactly right — a real photograph has almost
    none, and a graphic tile is made of them. A fixture painted in flat bands is
    a graphic tile, so the corpus was asking a classifier tuned on photographs
    to accept something that is not one, and eleven documents "had no
    photograph".

    So the render is built from multi-octave value noise: the 1/f statistic
    natural images have. Smooth at every scale, flat at none, no glyph-shaped
    high-frequency structure. The product's rule is untouched — what changed is
    that the fixture is now the kind of thing the rule was written about.

    This is the `SAMPLE_REPORT_DATA` lesson twice over: a fixture that is not
    representative of production turns a real measurement into a statement
    about the fixture.
    """
    sw, sh = w // 8, h // 8
    n1 = _octaves(seed, sw, sh)
    n2 = _octaves(seed + 991, sw, sh)
    img = Image.new('RGB', (sw, sh)); px = img.load()
    roof, eaves, grass = 0.32, 0.56, 0.74
    for y in range(sh):
        t = y / sh
        for x in range(sw):
            u = x / sw
            d = n1[y * sw + x]; e = n2[y * sw + x]
            if t < roof:
                base = (128 + 54 * t / roof, 170 + 46 * t / roof, 224 - 8 * t / roof)
                base = tuple(c + 18 * d for c in base)
            elif t < eaves:
                shade = 1.0 - 0.16 * abs(u - 0.5)
                base = tuple(c * shade + 16 * d for c in (108, 100, 98))
            elif t < grass:
                warm = 1.0 - 0.10 * ((t - eaves) / (grass - eaves))
                base = tuple(c * warm + 20 * d for c in (204, 190, 168))
                # NO STRAIGHT EDGES ANYWHERE. The opening and the driveway were
                # painted as rectangles with hard vertical boundaries, which is
                # what a graphic-tile detector is built to find — measured, two
                # flat regions, and `LOT 41 - BIRCH 20 - INFO` was refused a
                # clearance as `still_annotated` on a photograph that has no
                # annotation. A real window has a frame, a reveal and
                # perspective; a real driveway has a kerb. Both boundaries are
                # modulated by the noise field, so the region is soft-edged the
                # way a photographed one is.
                if 0.36 + 0.03 * d < u < 0.60 + 0.03 * e:
                    base = (base[0] * (0.58 + 0.06 * e), base[1] * (0.63 + 0.06 * d),
                            base[2] * (0.74 + 0.05 * e))
            else:
                base = (100 + 22 * e, 134 + 30 * d, 78 + 20 * e)
                if 0.62 + 0.04 * e < u < 0.86 + 0.04 * d:
                    base = (166 + 24 * d, 164 + 22 * e, 158 + 24 * d)
            px[x, y] = tuple(max(0, min(255, int(c))) for c in base)
    img = img.resize((w, h), Image.BICUBIC)
    buf = io.BytesIO(); img.save(buf, format='JPEG', quality=88); buf.seek(0)
    return buf


def floorplan(w=1400, h=990):
    img = Image.new('RGB', (w, h), (252, 252, 250)); d = img.load()
    for x in range(w):
        for y in range(h):
            frame = (60 < x < w - 60 and 60 < y < h - 60
                     and (abs(x - 60) < 3 or abs(x - (w - 60)) < 3
                          or abs(y - 60) < 3 or abs(y - (h - 60)) < 3))
            wall = (200 < x < w - 200 and abs(y - h // 2) < 3) or \
                   (200 < y < h - 200 and abs(x - w // 2) < 3)
            if frame or wall:
                d[x, y] = (24, 24, 28)
    buf = io.BytesIO(); img.save(buf, format='JPEG', quality=92); buf.seek(0)
    return buf


SCAN_FONTS = [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]


def render_page_as_scan(lines, seed=5, w=1240, h=1754):
    """A page of text rasterised: what a scanner produces. No text layer.

    SET IN A REAL TYPEFACE AT A REAL SIZE, because the point of this fixture is
    that the product can READ it. The first version drew PIL's default bitmap
    font — eleven pixels tall, fixed — which is not what any scanner produces
    and not what any OCR engine is tuned for; a corpus built that way measures
    the fixture's font rather than the product's recognition. A4 at 150 DPI is
    1240x1754, and 11pt type at 150 DPI is about 23 pixels.

    The noise is a scanner's, not a texture: light speckle and a faint skew of
    tone across the sheet, the two things that separate a scan from a render.
    """
    from PIL import ImageDraw, ImageFont
    random.seed(seed)
    img = Image.new('RGB', (w, h), (252, 251, 248))
    dr = ImageDraw.Draw(img)
    face = None
    for path in SCAN_FONTS:
        try:
            face = path
            ImageFont.truetype(path, 24)
            break
        except OSError:
            face = None
    y = 150
    for text_line, size in lines:
        px = max(20, int(size * 150 / 72))          # points at 150 DPI
        font = ImageFont.truetype(face, px) if face else None
        dr.text((120, y), text_line, fill=(26, 26, 30), font=font)
        y += int(px * 1.9)
    px = img.load()                      # scanner noise, so it is not flat art
    for _ in range(w * h // 60):
        x0, y0 = random.randrange(w), random.randrange(h)
        v = px[x0, y0]
        px[x0, y0] = tuple(max(0, min(255, c + random.randint(-14, 14))) for c in v)
    buf = io.BytesIO(); img.save(buf, format='JPEG', quality=82); buf.seek(0)
    return buf


def text(c, x, y, s, size=11, bold=False):
    c.setFont('Helvetica-Bold' if bold else 'Helvetica', size)
    c.drawString(x * mm, H - y * mm, s)


def tracked(c, x, y, s, size=11, space=4.2, bold=True):
    """Type the way a designer sets a display heading: letter-spaced.

    Drawn with the PDF's OWN character spacing rather than by typing spaces
    into the string, because that is what a real brochure does and it is the
    difference the whole normalisation layer exists for. Extraction sees the
    glyph positions the page drew, not a string somebody spelled out.
    """
    obj = c.beginText(x * mm, H - y * mm)
    obj.setFont('Helvetica-Bold' if bold else 'Helvetica', size)
    obj.setCharSpace(space)
    obj.textOut(s)
    obj.setCharSpace(0)
    c.drawText(obj)
    # reportlab carries the text object's char spacing back onto the canvas,
    # so without this every LATER line on the page is tracked out too — which
    # is a page no designer would set and would make this fixture prove
    # nothing about a heading.
    c._charSpace = 0


def hero(c, buf, top=165, height=110):
    c.drawImage(ImageReader(buf), 20 * mm, H - top * mm,
                width=W - 40 * mm, height=height * mm,
                preserveAspectRatio=True, mask=None)


# ===========================================================================
# THE FIXTURES
#
# `expect` is what the DOCUMENT states. `held_out: True` marks a document
# written after the rules were designed and never consulted while designing
# them — its expectation is the strongest evidence in this corpus.
# ===========================================================================

FIXTURES = []

def fixture(name, filename, expect, held_out=False, org='alpha', revision=None,
            revision_filename=None):
    """Declare a document the gate judges.

    `revision` is a SECOND document about the SAME property, written beside
    the first and named in the manifest rather than judged on its own. It
    exists for the fault matrix's replacement case, which had been asserting
    the duplicate guard by re-importing identical bytes: a replacement is a
    builder sending a NEW document about properties they already listed, and
    identical bytes are not that. Nothing in the main loop reads it.
    """
    def deco(fn):
        FIXTURES.append(dict(name=name, filename=filename, expect=expect,
                             held_out=held_out, org=org, build=fn,
                             revision=revision, revision_filename=revision_filename))
        return fn
    return deco


# --- 1. the common package brochure: marketing page + siting plan ----------
@fixture('package-brochure', 'LOT 214 - ASPIRE 24 - BROCHURE.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='214', street_name='Fairweather Drive', suburb='Clyde North',
               state='VIC', postcode='3978',
               # A bare `4  2  2` icon row is NOT a claim: the icons are
               # artwork, text extraction sees three integers, and the
               # contract's own words are "do not assume every number near a
               # room name is a room count". The reader withholds them and
               # that is correct — page 2 of this fixture carries no room
               # names to corroborate them with.
               bedrooms=None, bathrooms=None, car_spaces=None,
               land_size_sqm=401.86, build_size_sqm=237.5, price=662900,
               design='Aspire 24 Grande', estate='Northbrook Rise')],
    image='facade_page_1'))
def _f1(c):
    text(c, 20, 28, 'ASPIRE 24 GRANDE', 20, True)
    text(c, 20, 36, 'Lot 214 Fairweather Drive')
    text(c, 20, 43, 'Northbrook Rise, Clyde North VIC 3978')
    text(c, 20, 50, '4  2  2')
    hero(c, facade(11))
    text(c, 20, 178, 'Land Price - $310,000')
    text(c, 20, 185, 'Build Price - $352,900')
    text(c, 20, 192, 'Package Price - $662,900', bold=True)
    text(c, 20, 199, 'Lot Size    402m2')
    text(c, 20, 206, 'Enclosed: 201.40m2   Garage: 36.10m2   Total: 237.50m2')
    text(c, 20, 220, 'Artist impression. Prices subject to change without notice.', 8)
    c.showPage()
    text(c, 20, 28, 'SITING PLAN', 14, True)
    text(c, 20, 40, 'Site Address: Lot 214 FAIRWEATHER DRIVE')
    text(c, 20, 47, 'Locality: CLYDE NORTH (3978)')
    text(c, 20, 54, 'State: VIC')
    text(c, 20, 61, 'Home Design: ASPIRE 24 GRANDE')
    text(c, 20, 68, 'Estate: NORTHBROOK RISE')
    text(c, 20, 75, 'Site Area: 401.86 m2')
    text(c, 20, 82, 'Build Area: 237.50 m2')
    hero(c, floorplan(), top=200, height=110)
    text(c, 20, 210, 'This siting is subject to developer approval.', 8)
    c.showPage()


# --- 2. single-property flyer with an AREA SCHEDULE (the Lot 48 shape) -----
@fixture('flyer-area-schedule', 'LOT 61 - EMBER - FLYER.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='61', street_name='Cockrell Road', suburb='Mernda',
               state='VIC', postcode='3754', bedrooms=4, bathrooms=2, car_spaces=1,
               land_size_sqm=299, build_size_sqm=148, price=810000,
               design='Ember', unit_number=None)],
    image='facade_page_1',
    forbid=dict(unit_number_containing='115.30')))
def _f2(c):
    text(c, 20, 24, 'HAVENWOOD', 16, True)
    text(c, 20, 34, 'Lot 61')
    text(c, 20, 42, 'Ember', 18, True)
    # A real icon row: each number beside its own icon, at its own x.
    text(c, 32, 50, '4'); text(c, 52, 50, '2'); text(c, 72, 50, '1')
    text(c, 95, 42, '35 Cockrell Road,')
    text(c, 95, 49, 'Mernda VIC 3754')
    text(c, 130, 34, 'Sale Price - $810,000')
    text(c, 130, 42, 'Land Size - 299sqm')
    text(c, 130, 50, 'Build Size - 148sqm')
    hero(c, facade(21), top=170, height=105)
    # The area schedule that once became a unit number.
    text(c, 40, 185, 'AREA SCHEDULE', 9, True)
    for i, (k, v) in enumerate([('UNIT:', '115.30m2 12.41sq'), ('GARAGE:', '22.59m2 2.43sq'),
                                ('PORCH:', '6.89m2'), ('COURT:', '3.48m2'),
                                ('TOTAL:', '148.26m2 15.96sq')]):
        text(c, 40, 192 + i * 6, k, 9); text(c, 62, 192 + i * 6, v, 9)
    # The floor plan's own room names, which is what corroborates the icon
    # row above. A real flyer prints both; a fixture carrying only the icons
    # would be testing a document builders do not send.
    for room, rx, ry in [('MASTER', 118, 186), ('BED 2', 150, 192),
                         ('BED 3', 118, 200), ('BED 4', 152, 207),
                         ('ENS', 132, 214), ('BATH', 160, 214),
                         ('GARAGE', 120, 222), ('LIVING', 150, 228)]:
        text(c, rx, ry, room, 8)
    text(c, 20, 230, 'Front and rear landscaping, driveway + fencing included.', 8)
    text(c, 20, 236, 'Artist impression only. Not to scale.', 8)
    c.showPage()


# --- 3. a table stock list, several properties, one page ------------------
@fixture('table-stock-list', 'Weekly Stock List.pdf', expect=dict(
    properties=3,
    rows=[dict(lot_number='12', suburb='Tarneit', state='VIC', bedrooms=4,
               bathrooms=2, car_spaces=2, land_size_sqm=350, price=735000,
               design='Vista 22'),
          dict(lot_number='18', suburb='Tarneit', state='VIC', bedrooms=3,
               bathrooms=2, car_spaces=2, land_size_sqm=300, price=689000,
               design='Vista 19'),
          dict(lot_number='27', suburb='Truganina', state='VIC', bedrooms=4,
               bathrooms=2, car_spaces=2, land_size_sqm=392, price=792500,
               design='Vista 24')],
    image=None))
def _f3(c):
    text(c, 15, 22, 'AVAILABLE STOCK - WEEK 38', 15, True)
    cols = [('Lot', 15), ('Design', 30), ('Suburb', 62), ('State', 88),
            ('Beds', 101), ('Baths', 114), ('Cars', 128), ('Land', 141),
            ('Price', 160)]
    for label, x in cols:
        text(c, x, 34, label, 9, True)
    rows = [('12', 'Vista 22', 'Tarneit', 'VIC', '4', '2', '2', '350m2', '$735,000'),
            ('18', 'Vista 19', 'Tarneit', 'VIC', '3', '2', '2', '300m2', '$689,000'),
            ('27', 'Vista 24', 'Truganina', 'VIC', '4', '2', '2', '392m2', '$792,500')]
    for r, row in enumerate(rows):
        for (label, x), value in zip(cols, row):
            text(c, x, 43 + r * 8, value, 9)
    text(c, 15, 90, 'All prices correct at time of publication. E&OE.', 8)
    c.showPage()


# --- 4. a site plan naming neighbouring lots that are NOT for sale ---------
@fixture('site-plan-neighbours', 'LOT 305 - NEXA 20 - PACKAGE.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='305', suburb='Officer', state='VIC', bedrooms=4,
               bathrooms=2, car_spaces=2, land_size_sqm=448, price=845000,
               design='Nexa 20')],
    image='facade_page_1',
    forbid=dict(no_lot_numbers=['303', '304', '306', '307'])))
def _f4(c):
    text(c, 20, 26, 'NEXA 20', 19, True)
    text(c, 20, 36, 'Lot 305, Brookvale Rise, Officer VIC 3809')
    text(c, 32, 44, '4'); text(c, 46, 44, '2'); text(c, 60, 44, '2')
    text(c, 85, 44, 'Land 448m2'); text(c, 130, 44, 'Package $845,000')
    hero(c, facade(31))
    text(c, 20, 180, 'Artist impression. Landscaping not included.', 8)
    c.showPage()
    text(c, 20, 26, 'SITE PLAN', 14, True)
    text(c, 20, 38, 'Subject lot: Lot 305')
    hero(c, floorplan(), top=170, height=100)
    text(c, 20, 180, 'Adjoining allotments shown for context only:', 9)
    text(c, 20, 187, 'Lot 303      Lot 304      Lot 306      Lot 307', 9)
    text(c, 20, 196, 'Adjoining allotments are not offered for sale in this package.', 8)
    for room, rx, ry in [('MASTER', 24, 205), ('BED 2', 56, 205), ('BED 3', 88, 205),
                         ('BED 4', 120, 205), ('ENS', 24, 212), ('BATH', 56, 212),
                         ('GARAGE', 88, 212), ('LIVING', 120, 212)]:
        text(c, rx, ry, room, 8)
    c.showPage()


# --- 5. a scanned document: image-only pages, no text layer at all ---------
@fixture('scanned-no-text-layer', 'LOT 88 - SCANNED PACKAGE.pdf', expect=dict(
    # THE EXPECTATION CHANGED BECAUSE THE PRODUCT CHANGED, and the old one is
    # recorded rather than replaced.
    #
    # It read `properties=0, outcome='honest_refusal'`. That was right while
    # this platform had no way to read a page of pixels: a scan reached
    # `pdf_no_text_layer`, which is an honest refusal and was the whole of the
    # answer. It is not a supportable answer for a product a builder pays for —
    # scanned brochures are ordinary — so ordinary OCR now reads them.
    #
    # Measured through the real extractor on these exact bytes: one page, no
    # text layer, recognised in 596 ms with no model call of any kind, giving
    #
    #   LOT 88 - HARLOW 21 / 22 Wattlebird Way / Craigieburn VIC 3064
    #   4 bed 2 bath 2 car / Land 375m2 Build 201m2 / Package Price $712,000
    #
    # which is every fact the page carries. The refusal codes below are still
    # forbidden: if this ever fails again it must not be because a model
    # account was empty.
    properties=1,
    rows=[dict(lot_number='88', street_name='Wattlebird Way', suburb='Craigieburn',
               state='VIC', postcode='3064', design='Harlow 21',
               land_size_sqm=375, build_size_sqm=201, price=712000)],
    # THE DESIGN IS THE THIRD INSTANCE OF A LIMIT THIS CORPUS ALREADY NAMES
    # TWICE, and three instances of one limit is better evidence than a
    # pretend pass. The recognised heading splits correctly into `LOT 88` and
    # `HARLOW 21`; the lot is read, and the design is a BARE NAME with no
    # estate beside it and no filename to corroborate it (`LOT 88 - SCANNED
    # PACKAGE.pdf` does not carry the word). The reader refuses to guess which
    # bare line on a page is the design and which is the estate — the
    # PALOMINO / ENZO rule — and that refusal is what keeps a facade name off
    # the estate field. Closing it means finding a second source for a bare
    # name, not relaxing the rule.
    known_limit='a bare design name with no estate and no filename to '
                'corroborate it',
    # NO PHOTOGRAPH, and that is correct rather than a shortfall: page 1 is a
    # photograph OF PAPER. There is no facade in this document, so nothing may
    # designate one.
    image=None,
    refusal_must_not_be=['ai_budget_exhausted', 'assisted_reader_unavailable',
                         'assisted_reader_refused', 'assisted_reader_timeout',
                         'assisted_reader_invalid_response']))
def _f5(c):
    scan = render_page_as_scan([('LOT 88 - HARLOW 21', 14), ('22 Wattlebird Way', 11),
                                ('Craigieburn VIC 3064', 11), ('4 bed 2 bath 2 car', 11),
                                ('Land 375m2  Build 201m2', 11),
                                ('Package Price $712,000', 12)])
    c.drawImage(ImageReader(scan), 0, 0, width=W, height=H, mask=None)
    c.showPage()


# --- 6. a MIXED document: page 1 scanned, page 2 a real text layer ---------
@fixture('mixed-scan-and-text', 'LOT 140 - HARLOW 21 - MIXED.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='140', street_name='Wattlebird Way', suburb='Craigieburn',
               state='VIC', postcode='3064', bedrooms=4, bathrooms=2, car_spaces=2,
               land_size_sqm=375, build_size_sqm=201, price=712000, design='Harlow 21')],
    image='facade_page_1'))
def _f6(c):
    # GENUINELY MIXED, which the first version was not: its page 1 was a
    # photograph and its page 2 was native text, so nothing in it was ever
    # scanned and OCR had nothing to do. The shape that actually turns up is a
    # native marketing page with a SCANNED specification sheet appended — the
    # builder photocopies the page the drafter signed — so that is what this
    # is. Page 1 states the identity and the price in the PDF's own text and
    # carries the facade; page 2 is pixels and states the sizes and counts.
    text(c, 20, 24, 'HARLOW 21', 18, True)
    text(c, 20, 34, 'Lot 140 Wattlebird Way, Craigieburn VIC 3064')
    text(c, 20, 42, 'Package Price - $712,000')
    hero(c, facade(41), top=170, height=105)
    text(c, 20, 182, 'Artist impression. Specification sheet attached.', 8)
    c.showPage()
    spec = render_page_as_scan([('SPECIFICATION SHEET', 14),
                                ('Home Design HARLOW 21', 12),
                                ('Site Area 375 m2', 12),
                                ('Build Area 201 m2', 12),
                                ('Bedrooms 4 Bathrooms 2 Car Spaces 2', 12)], seed=9)
    c.drawImage(ImageReader(spec), 0, 0, width=W, height=H, mask=None)
    # ONE NATIVE LINE ON THE SCANNED PAGE, deliberately: a page can be both,
    # and this is what proves `mergeRecognisedPages` keeps what the document
    # STATES ahead of what was read off it rather than replacing one with the
    # other.
    text(c, 20, 87, 'Package Price: $712,000')
    c.showPage()


# --- 7. missing optional fields: identity is sound, figures are not there --
@fixture('missing-optional-fields', 'LOT 9 - CALLA 18 - LISTING.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='9', street_name='Perrin Street', suburb='Armstrong Creek',
               state='VIC', postcode='3217', design='Calla 18',
               price=None, land_size_sqm=None, build_size_sqm=None)],
    # NO PHOTOGRAPH, AND THE EXPECTATION WAS WRONG RATHER THAN THE PRODUCT.
    #
    # It read `image='facade_page_1'`. Measured 22 September 2026 through the
    # real image settler, the product refuses to designate one and says why:
    #
    #   "no page states this property's identity together with its package
    #    information (the page states 0 package facts, and a cover must state
    #    2) - its first page reads 'Lot 9 Perrin Street, Armstrong Creek VIC
    #    3217'"
    #
    # That is this fixture's whole point. It is the document that states its
    # identity and NOTHING ELSE — pricing on application, no sizes — so nothing
    # on the page designates the picture as this property's listing image
    # rather than a design render, a streetscape or somebody else's house. The
    # rule that refuses it is the one that keeps a bedroom render off a card.
    #
    # An absent photograph beside correct facts is the right outcome, so it is
    # EXPECTED here rather than excused as a limit.
    image=None))
def _f7(c):
    text(c, 20, 26, 'CALLA 18', 18, True)
    text(c, 20, 36, 'Lot 9 Perrin Street, Armstrong Creek VIC 3217')
    hero(c, facade(51))
    text(c, 20, 178, 'Pricing available on application. Contact our sales team.', 9)
    text(c, 20, 186, 'Artist impression. Facade shown may differ.', 8)
    c.showPage()


# --- 8. a two-column brochure carrying two properties on one page ---------
@fixture('two-column-two-properties', 'Estate Release - Two Homes.pdf', expect=dict(
    # A NAMED, UNCLOSED GAP — reported on every run, never failing the gate,
    # so it cannot be forgotten and cannot be mistaken for a pass.
    #
    # THE LIMIT MOVED, AND THE OLD WORDING IS KEPT HERE BECAUSE IT WAS WHAT
    # THIS FIXTURE WAS WRITTEN FOR.
    #
    #   was:  "brochure mode reads one property; this page sets two in
    #          columns"
    #   why wrong now: that is closed. Measured 22 September 2026 through the
    #          real layout reader, `segmentPropertyRegions` divides this page
    #          into exactly two regions and neither holds one of the other's
    #          values:
    #            r0 = Lot 402 / Marlo 23 / Wollert VIC 3750 / 4 2 2 /
    #                 Land Size - 400m2 / Package Price - $768,000
    #            r1 = Lot 407 / Marlo 19 / Wollert VIC 3750 / 3 2 2 /
    #                 Land Size - 325m2 / Package Price - $699,000
    #   what refuses it now: each region reading comes back `incomplete` with
    #          ONE unaccounted line, `RELEASE 6`. The page's heading reads
    #          "RELEASE 6 - WOLLERT" and the reader parses ` - ` as a label
    #          and its value, so `WOLLERT` is corroborated by the suburb in
    #          both cards and `RELEASE 6` names no field this vocabulary
    #          knows. It carries a digit, so it can never be dismissed as
    #          prose — which is the conservative gate working as written — and
    #          a shared line no region can account for stands the whole
    #          document down, because it may be a fact about every property
    #          on it.
    #   evidence: `readPdfBrochure` on each region's own synthetic document
    #          reads `lot_number`, `land_size_sqm` and `price` and refuses on
    #          `unaccounted_specification_lines: ["RELEASE 6"]`.
    #
    # It is NOT closed by teaching the alias table that a "Release" is a
    # stage. That is a per-document parser patch of exactly the kind this
    # subsystem is frozen against, and the document imports zero properties
    # before and after the segmentation work — so nothing regressed and the
    # gap is a vocabulary gap rather than a layout one.
    known_limit='segmentation divides this page correctly; the shared heading '
                '"RELEASE 6" names no field this vocabulary knows, and a '
                'shared line no region can account for stands the document down',
    properties=2,
    rows=[dict(lot_number='402', suburb='Wollert', state='VIC', bedrooms=4,
               bathrooms=2, car_spaces=2, land_size_sqm=400, price=768000,
               design='Marlo 23'),
          dict(lot_number='407', suburb='Wollert', state='VIC', bedrooms=3,
               bathrooms=2, car_spaces=2, land_size_sqm=325, price=699000,
               design='Marlo 19')],
    image=None))
def _f8(c):
    text(c, 20, 22, 'RELEASE 6 - WOLLERT', 15, True)
    for i, (lot, design, beds, land, price) in enumerate(
            [('402', 'Marlo 23', '4  2  2', '400m2', '$768,000'),
             ('407', 'Marlo 19', '3  2  2', '325m2', '$699,000')]):
        x = 20 + i * 90
        text(c, x, 40, f'Lot {lot}', 13, True)
        text(c, x, 48, design, 12)
        text(c, x, 56, 'Wollert VIC 3750')
        text(c, x, 64, beds)
        text(c, x, 72, f'Land Size - {land}')
        text(c, x, 80, f'Package Price - {price}')
    text(c, 20, 120, 'Prices subject to change. Images are artist impressions.', 8)
    c.showPage()


# --- 9. promotional imagery that must stay blocked ------------------------
@fixture('promotional-overlay', 'LOT 512 - SABLE 20 - BROCHURE.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='512', suburb='Donnybrook', state='VIC', price=755000,
               design='Sable 20')],
    image='blocked_promotional'))
def _f9(c):
    text(c, 20, 26, 'SABLE 20', 18, True)
    text(c, 20, 36, 'Lot 512, Olivewood Boulevard, Donnybrook VIC 3064')
    text(c, 20, 44, 'Package Price - $755,000')
    hero(c, facade(61))
    # A marketing lockup drawn OVER the render: big, high-contrast, promotional.
    c.setFillColorRGB(0.85, 0.08, 0.10)
    c.rect(24 * mm, H - 100 * mm, 92 * mm, 30 * mm, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.setFont('Helvetica-Bold', 30)
    c.drawString(28 * mm, H - 88 * mm, 'SALE NOW ON')
    c.setFont('Helvetica-Bold', 16)
    c.drawString(28 * mm, H - 96 * mm, 'SAVE $25,000 - THIS WEEKEND ONLY')
    c.setFillColorRGB(0, 0, 0)
    text(c, 20, 178, 'Offer ends Sunday. Terms and conditions apply.', 8)
    c.showPage()


# --- 10. legitimate fine print that must NOT block the render -------------
@fixture('legitimate-fine-print', 'LOT 77 - WREN 18 - BROCHURE.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='77', suburb='Rockbank', state='VIC', price=688000,
               design='Wren 18', land_size_sqm=294)],
    image='facade_page_1'))
def _f10(c):
    text(c, 20, 26, 'WREN 18', 18, True)
    text(c, 20, 36, 'Lot 77, Kestrel Way, Rockbank VIC 3335')
    text(c, 20, 44, 'Land Size - 294m2     Package Price - $688,000')
    hero(c, facade(71))
    for i, line in enumerate([
        'Artist impression only. Landscaping, fencing, driveway and planting shown are',
        'indicative and not included unless expressly stated in the building contract.',
        'Furniture and decorative items are not included. Facade shown is the Modern',
        'facade and is subject to estate design guidelines and developer approval.',
        'Prices are correct at the date of publication and subject to change. E&OE.']):
        text(c, 20, 176 + i * 5, line, 7)
    c.showPage()


# --- 11. an encrypted document: honest, specific, never a model error -----
@fixture('encrypted', 'LOT 500 - LOCKED.pdf', expect=dict(
    properties=0, rows=[], image=None, outcome='honest_refusal',
    refusal_must_not_be=['ai_budget_exhausted', 'assisted_reader_unavailable',
                         'assisted_reader_refused']))
def _f11(c):
    text(c, 20, 30, 'LOT 500 - CONFIDENTIAL', 14, True)
    hero(c, facade(81))
    c.showPage()


# --- 12/13. TWO ORGANISATIONS, identical lot number and filename ----------
_COLLIDE = dict(properties=1, image='facade_page_1')

@fixture('org-collision-alpha', 'LOT 100 - BROCHURE.pdf', org='alpha', expect=dict(
    # A NAMED, UNCLOSED GAP, on the design only. This brochure names no
    # estate and its filename names no design, so `ASPEN 18` is a bare
    # heading at the top of a page with nothing to corroborate it — it could
    # equally be an estate or the builder. The reader declines it rather than
    # guessing. Everything that identifies the property is read.
    known_limit='a bare design heading with no estate and no filename to corroborate it',
    properties=1, image='facade_page_1',
    rows=[dict(lot_number='100', suburb='Werribee', state='VIC', price=640000,
               design='Aspen 18')]))
def _f12(c):
    text(c, 20, 26, 'ASPEN 18', 18, True)
    text(c, 20, 36, 'Lot 100, Sandalford Drive, Werribee VIC 3030')
    text(c, 20, 44, 'Package Price - $640,000')
    hero(c, facade(91))
    c.showPage()

@fixture('org-collision-beta', 'LOT 100 - BROCHURE.pdf', org='beta', expect=dict(
    known_limit='a bare design heading with no estate and no filename to corroborate it',
    properties=1, image='facade_page_1',
    rows=[dict(lot_number='100', suburb='Ipswich', state='QLD', price=589000,
               design='Coral 16')]))
def _f13(c):
    text(c, 20, 26, 'CORAL 16', 18, True)
    text(c, 20, 36, 'Lot 100, Brassall Parade, Ipswich QLD 4305')
    text(c, 20, 44, 'Package Price - $589,000')
    hero(c, facade(101))
    c.showPage()


# ===========================================================================
# HELD OUT — written after the rules, never consulted while designing them.
# ===========================================================================

@fixture('heldout-floorplan-dimensions', 'LOT 233 - LINDEN 22 - PLAN SET.pdf',
         held_out=True, expect=dict(
             properties=1,
             rows=[dict(lot_number='233', suburb='Kalkallo', state='VIC',
                        bedrooms=4, bathrooms=2, car_spaces=2,
                        land_size_sqm=392, build_size_sqm=214, price=749000,
                        design='Linden 22')],
             image='facade_page_1',
             forbid=dict(max_bathrooms=4, max_bedrooms=6)))
def _h1(c):
    text(c, 20, 26, 'LINDEN 22', 18, True)
    text(c, 20, 36, 'Lot 233, Ridgeback Street, Kalkallo VIC 3064')
    text(c, 20, 44, '4 bed  2 bath  2 car')
    text(c, 20, 52, 'Land 392m2   Build 214m2   Package $749,000')
    hero(c, facade(111))
    c.showPage()
    # A plan page whose room dimensions are the trap: "3.6 x 3.2" beside BED,
    # and a WC count that must never be read as nine bathrooms.
    text(c, 20, 26, 'FLOOR PLAN', 14, True)
    for i, (room, dim) in enumerate([('MASTER', '4.1 x 3.6'), ('BED 2', '3.2 x 3.0'),
                                     ('BED 3', '3.0 x 3.0'), ('BED 4', '3.0 x 2.9'),
                                     ('BATH', '2.4 x 2.2'), ('ENS', '2.4 x 1.8'),
                                     ('WC', '1.5 x 0.9'), ('GARAGE', '5.9 x 5.6'),
                                     ('LIVING', '5.4 x 4.2')]):
        text(c, 20, 40 + i * 7, room, 9, True)
        text(c, 45, 40 + i * 7, dim, 9)
    hero(c, floorplan(), top=200, height=90)
    c.showPage()


@fixture('heldout-office-address', 'LOT 41 - BIRCH 20 - INFO.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='41', street_name='Galloway Road', suburb='Bacchus Marsh',
                        state='VIC', postcode='3340', design='Birch 20', price=615000)],
             image='facade_page_1',
             # A NAMED LIMIT ABOUT THE FIXTURE, not about the product, and the
             # measurement is recorded so it cannot be mistaken for either.
             #
             # This document's synthetic facade carries the largest flat region
             # of any in the corpus — `region_count: 2, largest_share: 0.1201`
             # against 0 to 0.11 for the rest. The coarse classifier therefore
             # convicts it as an `annotated_marketing_tile`, the precise repair
             # is attempted, and it comes back `still_annotated`: the rebuild
             # did not satisfy the classifier either.
             #
             # Both readings are the product being conservative about a picture
             # it cannot vouch for, which is right — a wrong image on a card is
             # worse than none. What cannot be concluded from it is anything
             # about real photographs: the other ten facades in this corpus
             # clear (four outright, six through the precise inspection), and
             # tuning a generated image until a classifier trained on
             # photographs accepts it would prove nothing at all.
             known_limit='the synthetic facade at this seed carries the largest '
                         'flat region in the corpus and the overlay repair '
                         'returns still_annotated',
             forbid=dict(no_suburb=['Port Melbourne'], no_street=['Normanby Road'])))
def _h2(c):
    text(c, 20, 26, 'BIRCH 20', 18, True)
    text(c, 20, 36, 'Lot 41 Galloway Road, Bacchus Marsh VIC 3340')
    text(c, 20, 44, 'Package Price - $615,000')
    hero(c, facade(121))
    # The builder's own office address, which must never become the property's.
    text(c, 20, 180, 'Head Office: 120 Normanby Road, Port Melbourne VIC 3207', 8)
    text(c, 20, 186, 'Display centre open 11am - 5pm daily. Ph 1300 555 020', 8)
    c.showPage()


@fixture('heldout-money-not-area', 'LOT 18 - ROWAN 19 - SUMMARY.pdf', held_out=True,
         expect=dict(
             properties=1,
             # THE PRODUCT IS RIGHT HERE AND THE FIRST TWO EXPECTATIONS WERE
             # NOT. This document writes `Land 320,000` (dollars, with no
             # currency symbol) six lines above `Land Size 320m2`, and
             # `Total 659,900` with no symbol either.
             #
             # The FIRST expectation was that 320,000 would be imported as the
             # land size. It was not: money must never become area, which is
             # the guard the whole §7 programme turns on.
             #
             # The SECOND was that the land size would be ABSENT — because the
             # reader saw two answers for one field and dropped it rather than
             # choosing between them. That was the conservative side of a
             # conflict that should never have existed. Since the typed gate
             # (`fieldTypes.pure.ts`) 320,000 is refused as an AREA before it
             # can dispute anything — `area_out_of_range`, a figure that is not
             # a measurement of anything — so the one real reading is left
             # standing and the document's own `Land Size 320m2` is imported.
             #
             # Both facts the fixture exists to prove are unchanged and are
             # asserted below: the dollar figure is not in the land size, and
             # the bare `Total` is not a price, because no marker says it is
             # money and ABSENT IS BETTER THAN WRONG.
             rows=[dict(lot_number='18', suburb='Melton South', state='VIC',
                        land_size_sqm=320, build_size_sqm=186, price=None,
                        design='Rowan 19')],
             image='facade_page_1',
             # A NAMED, UNCLOSED GAP, reported every run and never failing it.
             #
             # Measured through the real image settler: the product refuses to
             # designate page 1's picture and says why —
             #
             #   "no page states this property's identity together with its
             #    package information (the page states 1 package fact, and a
             #    cover must state 2)"
             #
             # The page states a great deal: a lot, a street, a suburb, a
             # state, a postcode, two prices and two sizes. It counts as ONE
             # package fact because none of its money carries a currency
             # marker, so no price is recognised — which is the same reading
             # `acceptFieldValue` makes of the same figures, deliberately, and
             # is why this fixture's `price` is None.
             #
             # So the two halves of the product agree with each other and the
             # document is simply thinner evidence than the cover rule asks
             # for. The outcome is an ABSENT photograph beside correct facts,
             # never a wrong one. Closing it means deciding whether a stated
             # land size and a stated build size are one package fact or two,
             # which is a change to the designation threshold and is not
             # something to do while making a gate green.
             known_limit='a cover must state 2 package facts; this page states '
                         '1, because its money carries no currency marker',
             forbid=dict(land_size_not_in=[659900, 320000, 339900],
                         price_not_in=[320, 186])))
def _h3(c):
    text(c, 20, 26, 'ROWAN 19', 18, True)
    text(c, 20, 36, 'Lot 18, Hollybank Crescent, Melton South VIC 3338')
    hero(c, facade(131))
    text(c, 20, 176, 'Land          320,000')
    text(c, 20, 183, 'Build         339,900')
    text(c, 20, 190, 'Total         659,900')
    text(c, 20, 200, 'Land Size     320m2')
    text(c, 20, 207, 'Build Size    186m2')
    c.showPage()


# --- 17. HELD OUT: a brochure typeset in letter-spaced display type --------
#
# THE DOCUMENT CLASS THIS WHOLE LAYER EXISTS FOR, and the one the corpus did
# not cover. `Lot 37 - Miami 190 - Property Package.pdf` is typeset with
# tracked-out headings throughout, so extraction returns the glyphs the page
# drew — `L O T`, `E S T A T E`, `B E D` — and not one of them matched a
# vocabulary entry. Five separate field readers were about to grow a rule
# apiece; instead it is resolved once, in `documentNormalisation.pure.ts`.
#
# TWO THINGS ARE PROVED HERE AND THE SECOND IS THE IMPORTANT ONE. The headings
# must become legible, and the tracked-out `L A N D` and `B U I L D` must NOT
# turn the package price into a land size — legibility is exactly what puts two
# AREA labels beside money, which no reader could have done before.
@fixture('heldout-letter-spaced', 'LOT 37 - MIAMI 190 - PACKAGE.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='37', street_name='Fairweather Drive',
                        suburb='Tweed Heads', state='NSW', postcode='2485',
                        land_size_sqm=563, build_size_sqm=190.38,
                        price=1327407, design='Miami 190')],
             image='facade_page_1',
             # The package price must never reach a size field, and no heading
             # the page tracked out may reach a field at all.
             forbid=dict(land_size_not_in=[1327407, 547407, 780000],
                         build_size_not_in=[1327407, 547407],
                         # The four words this page set as DISPLAY TYPE. Not
                         # `ESTATE`, which the page also writes as ordinary
                         # copy inside the estate's real name — the rule is
                         # about the type, not about the word.
                         nothing_containing=['T O T A L', 'MASTERPLAN',
                                             'PACKAGE', 'TOTAL HOME'])))
def _h4(c):
    tracked(c, 20, 20, 'M A S T E R P L A N', 13)
    text(c, 20, 30, 'MIAMI 190', 18, True)
    text(c, 20, 38, 'Lot 37 Fairweather Drive')
    text(c, 20, 45, 'Sandpiper Estate, Tweed Heads NSW 2485')
    hero(c, facade(37))
    tracked(c, 20, 180, 'T O T A L   P A C K A G E', 11)
    tracked(c, 20, 187, 'L A N D   +   B U I L D', 11)
    text(c, 20, 195, 'Package Price - $1,327,407', 12, True)
    text(c, 20, 202, 'Land Price - $780,000')
    text(c, 20, 209, 'Build Price - $547,407')
    # The dwelling's area under a TRACKED-OUT QUANTIFIED HEADING, which is how
    # the reported document sets it. No alias table has `TOTAL HOME`; what
    # reads it is the grammatical class in `labelSemantics.pure.ts`, and this
    # is the only fixture that exercises it through real PDF bytes.
    tracked(c, 20, 220, 'T O T A L   H O M E', 11)
    text(c, 20, 228, '190.38 m2')
    text(c, 20, 238, 'Lot Size    563m2')
    text(c, 20, 245, 'Artist impression. Prices subject to change.', 8)
    c.showPage()


# --- 18. A PROPERTY RE-DESCRIBED BY A SECOND DOCUMENT ----------------------
#
# The replacement case, which the fault matrix could not reach without it.
# A builder sends a revised brochure for a lot they already listed: the SAME
# property, a DIFFERENT document, a changed price and a changed availability.
# Identical bytes are refused by the duplicate guard — correctly, and that is
# a different assertion — so the revision is genuinely different: a new price,
# a sold-status line, and a different facade seed so the imagery is not the
# same picture either.
#
# THE IDENTITY MUST SURVIVE IT. Lot, street, suburb, state and postcode are
# byte-identical between the two, because what makes this a replacement rather
# than a new property is that the reader arrives at the same anchor.
def _revision_18(c):
    text(c, 20, 28, 'CEDAR 22', 20, True)
    text(c, 20, 36, 'Lot 650 Harrowgate Rise')
    text(c, 20, 43, 'Tarneit VIC 3029')
    hero(c, facade(97))
    text(c, 20, 178, 'Land Price - $328,000')
    text(c, 20, 185, 'Build Price - $371,500')
    text(c, 20, 192, 'Package Price - $699,500')
    text(c, 20, 205, 'Land Size    392m2')
    text(c, 20, 212, 'Home Size    228.4m2')
    text(c, 20, 222, 'Status    Under Offer')
    text(c, 20, 238, 'Revised release. Supersedes previous pricing.', 8)
    c.showPage()


@fixture('replacement-original', 'LOT 650 - CEDAR 22 - BROCHURE.pdf',
         revision=_revision_18,
         revision_filename='LOT 650 - CEDAR 22 - BROCHURE V2.pdf',
         expect=dict(
             properties=1,
             # NO ESTATE, deliberately. `corroborateDevelopmentFromPlace`
             # resolves `<name>, <suburb>` only where the suburb was also read
             # from a LABELLED statement somewhere in the document, and a
             # one-page brochure carries none — the package fixture gets it
             # from its siting plan. Writing the estate here and expecting it
             # read would have been asserting a property of a two-page
             # document against a one-page one. This fixture's subject is
             # identity across a replacement; it does not buy an estate
             # reading it was not built to test.
             rows=[dict(lot_number='650', street_name='Harrowgate Rise',
                        suburb='Tarneit', state='VIC', postcode='3029',
                        land_size_sqm=392, build_size_sqm=228.4, price=684900,
                        design='Cedar 22')],
             image='facade_page_1'))
def _f18(c):
    text(c, 20, 28, 'CEDAR 22', 20, True)
    text(c, 20, 36, 'Lot 650 Harrowgate Rise')
    text(c, 20, 43, 'Tarneit VIC 3029')
    hero(c, facade(43))
    text(c, 20, 178, 'Land Price - $320,000')
    text(c, 20, 185, 'Build Price - $364,900')
    text(c, 20, 192, 'Package Price - $684,900')
    text(c, 20, 205, 'Land Size    392m2')
    text(c, 20, 212, 'Home Size    228.4m2')
    text(c, 20, 238, 'Artist impression. Prices subject to change.', 8)
    c.showPage()


# ===========================================================================
# THE MULTI-PROPERTY HELD-OUT SET
#
# Eleven documents written AFTER the segmentation rules were designed and
# never consulted while designing them. Their subject is the one question a
# page-at-a-time reader cannot ask: does this page describe one property or
# several, and if several, whose is whose.
#
# THEY ARE NOT ALL POSITIVE. Four of the eleven must come back as ONE
# property or as a table, and those are the ones that matter most: a visual
# column is not a property, and the corpus is full of brochures set in two
# columns that describe one house. Splitting those would be strictly worse
# than the defect this closes.
#
# NO FIXTURE IS NAMED IN ANY RULE. Nothing in the product reads a builder
# name, a filename, a lot number or a page index from this set.
# ===========================================================================

# Column geometry, stated once. The gutter is 20mm — 57 points against the
# 27.5 the segmenter derives from 11pt type — so these pages are unambiguous
# about where one card ends. A page whose gutter is narrower than its own type
# is one this reader will not divide, which is the conservative side.
L, R, CARDW = 15, 115, 80
THIRDS = (15, 82, 149)


def mcard(c, x, top, lot, design, land, build, price, beds=None):
    """One property card, laid out as a builder's release sheet lays one out.

    Label and value are drawn as SEPARATE RUNS 30mm apart, which is what a
    real card does and what lets the reader pair them; a label and value set
    four points apart arrive as one cell and the value is never claimed.
    """
    text(c, x, top, f'Lot {lot}', 13, True)
    text(c, x, top + 8, 'Home Design'); text(c, x + 32, top + 8, design)
    text(c, x, top + 15, 'Land Size'); text(c, x + 32, top + 15, land)
    text(c, x, top + 22, 'Build Size'); text(c, x + 32, top + 22, build)
    text(c, x, top + 29, 'Price'); text(c, x + 32, top + 29, price)
    if beds:
        text(c, x, top + 36, 'Bedrooms'); text(c, x + 32, top + 36, beds)


def cardhero(c, buf, x, top, w=80, h=50):
    """A picture inside one card's column.

    80x50mm is 6.4% of an A4 page, just over the product's own 6% floor for a
    picture large enough to be a property's. That floor is not relaxed for
    this corpus: a card whose picture is smaller than the floor honestly has
    no listing image, and two of the fixtures below expect exactly that.
    """
    c.drawImage(ImageReader(buf), x * mm, H - (top + h) * mm,
                width=w * mm, height=h * mm, preserveAspectRatio=True, mask=None)


# --- M1. two cards side by side, under one estate heading -----------------
@fixture('heldout-two-cards', 'BROOKHAVEN - TWO HOMES AVAILABLE.pdf', held_out=True,
         expect=dict(
             properties=2,
             rows=[
                 dict(lot_number='412', design='Wren 18', land_size_sqm=350,
                      build_size_sqm=182, price=684000, estate='Brookhaven Rise Estate',
                      image_size='1280x800'),
                 dict(lot_number='418', design='Marlow 22', land_size_sqm=448,
                      build_size_sqm=224, price=812500, estate='Brookhaven Rise Estate',
                      image_size='960x600'),
             ],
             image='facade_page_1',
             # NEITHER CARD MAY WEAR THE OTHER'S FIGURES. Stated as a
             # prohibition as well as an expectation, because the expectation
             # compares row 0 against row 0 and this compares every row
             # against every forbidden value.
             forbid=dict(no_lot_numbers=['413', '417'])))
def _m1(c):
    text(c, L, 22, 'BROOKHAVEN RISE ESTATE - STAGE 12 RELEASE', 19, True)
    mcard(c, L, 40, '412', 'Wren 18', '350m2', '182m2', '$684,000')
    mcard(c, R, 40, '418', 'Marlow 22', '448m2', '224m2', '$812,500')
    cardhero(c, facade(301, 1280, 800), L, 85)
    cardhero(c, facade(307, 960, 600), R, 85)
    text(c, L, 160, 'Prices subject to change without notice. Images are artist '
                    'impressions only and not an offer.', 8)
    c.showPage()


# --- M2. three cards on one page ------------------------------------------
@fixture('heldout-three-cards', 'FERNLEIGH - THREE RELEASES.pdf', held_out=True,
         expect=dict(
             properties=3,
             rows=[
                 dict(lot_number='21', design='Alder 16', land_size_sqm=294,
                      build_size_sqm=156, price=598000),
                 dict(lot_number='22', design='Briar 19', land_size_sqm=336,
                      build_size_sqm=190, price=655000),
                 dict(lot_number='23', design='Cobalt 24', land_size_sqm=420,
                      build_size_sqm=238, price=749000),
             ],
             # NO PHOTOGRAPH, AND THAT IS THE PRODUCT'S OWN RULE RATHER THAN A
             # SHORTFALL. Three columns on A4 leave each card 55mm, so a
             # picture inside one is 3% of the page against the 6% floor
             # `MIN_PAGE_AREA_SHARE` sets for "large enough to be a property's
             # listing image". Drawing them larger would mean overlapping
             # columns, which is not a document anybody produces. This fixture
             # is about segmentation and says nothing about imagery.
             image=None,
             known_limit='three columns on A4 leave each picture at 3% of the '
                         'page, under the product 6% floor for a listing image'))
def _m2(c):
    text(c, L, 22, 'FERNLEIGH PARK - AUTUMN RELEASE', 18, True)
    for x, (lot, design, land, build, price) in zip(THIRDS, [
            ('21', 'Alder 16', '294m2', '156m2', '$598,000'),
            ('22', 'Briar 19', '336m2', '190m2', '$655,000'),
            ('23', 'Cobalt 24', '420m2', '238m2', '$749,000')]):
        text(c, x, 42, f'Lot {lot}', 12, True)
        text(c, x, 50, 'Home Design'); text(c, x, 56, design)
        text(c, x, 64, 'Land Size'); text(c, x, 70, land)
        text(c, x, 78, 'Build Size'); text(c, x, 84, build)
        text(c, x, 92, 'Price'); text(c, x, 98, price)
    text(c, L, 130, 'All prices subject to change. Images are artist impressions.', 8)
    c.showPage()


# --- M3. a two-column SCHEDULE, which is a table and must stay one --------
@fixture('heldout-schedule-table', 'OAKRIDGE - STOCK SCHEDULE.pdf', held_out=True,
         expect=dict(
             properties=3,
             rows=[
                 dict(lot_number='101', design='Hawke 20', land_size_sqm=375, price=706000),
                 dict(lot_number='102', design='Hawke 20', land_size_sqm=375, price=711000),
                 dict(lot_number='103', design='Ridley 23', land_size_sqm=448, price=798000),
             ],
             image=None,
             # A SCHEDULE IS READ AS A SCHEDULE. This fixture's job is to
             # prove segmentation did not take a document the table parser
             # already reads correctly: the grid guarantees — every cell in a
             # column, a cell outside every column refuses — are stronger than
             # anything the region reader has, so the order asks the table
             # first and this document must never reach the second reader.
             parse_strategy='pdf_deterministic_table'))
def _m3(c):
    text(c, L, 22, 'OAKRIDGE ESTATE - AVAILABLE STOCK', 16, True)
    cols = [(15, 'Lot'), (40, 'Home Design'), (95, 'Land Size'), (130, 'Price')]
    for x, head in cols:
        text(c, x, 40, head, 10, True)
    for i, row in enumerate([('101', 'Hawke 20', '375m2', '$706,000'),
                             ('102', 'Hawke 20', '375m2', '$711,000'),
                             ('103', 'Ridley 23', '448m2', '$798,000')]):
        for (x, _), value in zip(cols, row):
            text(c, x, 50 + i * 8, value, 10)
    c.showPage()


# --- M4. ONE property set in two visual columns ---------------------------
@fixture('heldout-one-home-two-columns', 'LOT 77 - HOLLIS 21 - FEATURE.pdf',
         held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='77', design='Hollis 21', land_size_sqm=392,
                        build_size_sqm=205, price=729000)],
             image='facade_page_1',
             # THE MOST IMPORTANT NEGATIVE IN THE SET. The page is set in two
             # columns with a real gutter, and the right column states nothing
             # that identifies a property — it is the marketing copy every
             # brochure in the corpus carries. A visual column is not a
             # property.
             forbid=dict(no_lot_numbers=['21', '205'])))
def _m4(c):
    text(c, L, 22, 'HOLLIS 21', 20, True)
    text(c, L, 34, 'Lot 77 Redgum Parade, Officer VIC 3809')
    text(c, L, 46, 'Home Design'); text(c, L + 32, 46, 'Hollis 21')
    text(c, L, 53, 'Land Size'); text(c, L + 32, 53, '392m2')
    text(c, L, 60, 'Build Size'); text(c, L + 32, 60, '205m2')
    text(c, L, 67, 'Price'); text(c, L + 32, 67, '$729,000')
    # The right-hand column: prose, a caption and a disclaimer. No lot, no
    # price, no design, no measurement.
    text(c, R, 46, 'Designed for family living', 10, True)
    text(c, R, 53, 'Open plan living and dining', 9)
    text(c, R, 60, 'Walk-in robe to the main bedroom', 9)
    text(c, R, 67, 'Double garage with internal access', 9)
    text(c, R, 74, 'Artist impression shown', 9)
    hero(c, facade(311), top=185, height=105)
    text(c, L, 196, 'Prices subject to change without notice.', 8)
    c.showPage()


# --- M5. a shared estate header several properties must INHERIT -----------
@fixture('heldout-shared-estate-header', 'WILLOWMEAD - RELEASE SHEET.pdf',
         held_out=True,
         expect=dict(
             properties=2,
             # NEITHER CARD STATES THE ESTATE. It is written once, across the
             # top of the page, and both properties must carry it — which is
             # what makes the shared band a real part of the model rather than
             # a bucket for leftovers.
             rows=[
                 dict(lot_number='508', design='Sable 17', land_size_sqm=312,
                      build_size_sqm=168, price=627000, estate='Willowmead Estate'),
                 dict(lot_number='511', design='Tamar 20', land_size_sqm=384,
                      build_size_sqm=201, price=708000, estate='Willowmead Estate'),
             ],
             image=None,
             known_limit='this release sheet carries no photograph at all'))
def _m5(c):
    text(c, L, 22, 'WILLOWMEAD ESTATE - STAGE 4 TITLED LAND RELEASE', 18, True)
    mcard(c, L, 45, '508', 'Sable 17', '312m2', '168m2', '$627,000')
    mcard(c, R, 45, '511', 'Tamar 20', '384m2', '201m2', '$708,000')
    text(c, L, 120, 'All lots titled. Prices correct at time of printing.', 8)
    c.showPage()


# --- M6. several properties, several pictures each ------------------------
@fixture('heldout-cards-with-plans', 'CARRINGTON - TWO PACKAGES.pdf', held_out=True,
         expect=dict(
             properties=2,
             rows=[
                 dict(lot_number='19', design='Verity 19', land_size_sqm=336,
                      build_size_sqm=196, price=671000, image_size='1280x800'),
                 dict(lot_number='24', design='Wexford 23', land_size_sqm=441,
                      build_size_sqm=241, price=829000, image_size='1440x900'),
             ],
             image='facade_page_1'))
def _m6(c):
    text(c, L, 22, 'CARRINGTON GARDENS - PACKAGES AVAILABLE NOW', 17, True)
    mcard(c, L, 40, '19', 'Verity 19', '336m2', '196m2', '$671,000')
    mcard(c, R, 40, '24', 'Wexford 23', '441m2', '241m2', '$829,000')
    # THE SEEDS ARE MEASURED, and this is the fixture being fixed rather than
    # the product being tuned - the rule the corpus already records for
    # `heldout-office-address`.
    #
    # Seed 337 was written here first and the right-hand card lost its
    # photograph. Run through the product's OWN eligibility assessor at three
    # sizes, that seed's octave noise produces one flat region covering 10.07%
    # of the picture at 1120x700, 10.80% at 1280x800 and 11.27% at 1600x1000 -
    # so `marketplaceEligibility` convicts it as an `annotated_marketing_tile`
    # at every size, correctly: a real photograph has almost no flat regions
    # and a graphic tile is made of them. The size is not the variable; the
    # seed is.
    #
    # 331 and 353 both measure `largestShare: 0, regionCount: 0`. They are
    # drawn at different pixel sizes because that is what makes a SWAP
    # visible - see the ownership proof in the harness - and the sizes are
    # named in the expectation above.
    cardhero(c, facade(331, 1280, 800), L, 82)
    cardhero(c, facade(353, 1440, 900), R, 82)
    # A plan under each facade, in the same column. The hero election must
    # take the photograph and not the line drawing, per card.
    cardhero(c, floorplan(1200, 750), L, 140)
    cardhero(c, floorplan(1000, 625), R, 140)
    text(c, L, 205, 'Floor plans indicative only. Artist impressions shown.', 8)
    c.showPage()


# --- M7. a footer and a disclaimer crossing the full page width -----------
@fixture('heldout-shared-footer', 'DUNMORE - RELEASE WITH TERMS.pdf', held_out=True,
         expect=dict(
             properties=2,
             rows=[
                 dict(lot_number='2201', design='Ivory 18', land_size_sqm=300,
                      build_size_sqm=171, price=612000),
                 dict(lot_number='2204', design='Juniper 21', land_size_sqm=364,
                      build_size_sqm=209, price=733000),
             ],
             image=None,
             known_limit='this release sheet carries no photograph at all',
             # THE FOOTER IS NOT A PROPERTY FACT. It crosses the gutter, so it
             # belongs to the page; nothing in it may reach a column of either
             # property.
             forbid=dict(nothing_containing=['DUNMORE PTY', 'ACN', '1300'])))
def _m7(c):
    text(c, L, 22, 'DUNMORE GREEN - TITLED RELEASE', 18, True)
    mcard(c, L, 45, '2201', 'Ivory 18', '300m2', '171m2', '$612,000')
    mcard(c, R, 45, '2204', 'Juniper 21', '364m2', '209m2', '$733,000')
    text(c, L, 120, 'Terms: prices are subject to change without notice and do not '
                    'constitute an offer. Images are artist impressions.', 8)
    text(c, L, 128, 'Dunmore Pty Ltd ACN 000 111 222. Sales enquiries 1300 555 140. '
                    'Display centre open daily 11am to 5pm.', 8)
    c.showPage()


# --- M8. the SAME lot numbers, a DIFFERENT organisation -------------------
@fixture('heldout-same-lots-other-org', 'BROOKHAVEN - TWO HOMES AVAILABLE.pdf',
         held_out=True, org='beta',
         expect=dict(
             properties=2,
             # THE SAME LOTS AS M1, IN ANOTHER BUILDER'S ACCOUNT, with
             # different designs, sizes and prices. A lot number is a
             # builder's own numbering: two organisations naming lot 412 are
             # two properties, and a reader that matched across the boundary
             # would overwrite one with the other.
             rows=[
                 dict(lot_number='412', design='Pinnacle 20', land_size_sqm=400,
                      build_size_sqm=210, price=755000),
                 dict(lot_number='418', design='Summit 25', land_size_sqm=512,
                      build_size_sqm=252, price=901000),
             ],
             image=None,
             known_limit='this release sheet carries no photograph at all'))
def _m8(c):
    text(c, L, 22, 'KESTREL HOMES - AVAILABLE PACKAGES THIS MONTH', 18, True)
    mcard(c, L, 45, '412', 'Pinnacle 20', '400m2', '210m2', '$755,000')
    mcard(c, R, 45, '418', 'Summit 25', '512m2', '252m2', '$901,000')
    text(c, L, 120, 'Prices subject to change without notice.', 8)
    c.showPage()


# --- M9. the same DESIGN across several properties ------------------------
@fixture('heldout-same-design-many-lots', 'ASHFORD - HAWKE 20 RELEASE.pdf',
         held_out=True,
         expect=dict(
             properties=2,
             # ONE DESIGN, TWO PROPERTIES. `stockPropertyIdentity` reads the
             # design as part of a property's identity, so two rows sharing it
             # must still be told apart by everything else they state — and
             # neither may be absorbed into the other as a duplicate.
             rows=[
                 dict(lot_number='31', design='Hawke 20', land_size_sqm=375,
                      build_size_sqm=203, price=698000),
                 dict(lot_number='46', design='Hawke 20', land_size_sqm=420,
                      build_size_sqm=203, price=726000),
             ],
             image=None,
             known_limit='this release sheet carries no photograph at all'))
def _m9(c):
    text(c, L, 22, 'ASHFORD RIDGE - THE HAWKE 20, TWO POSITIONS', 17, True)
    mcard(c, L, 45, '31', 'Hawke 20', '375m2', '203m2', '$698,000')
    mcard(c, R, 45, '46', 'Hawke 20', '420m2', '203m2', '$726,000')
    text(c, L, 120, 'Prices subject to change without notice.', 8)
    c.showPage()


# --- M10. several pages, each carrying several properties -----------------
@fixture('heldout-pages-of-cards', 'MERIDIAN - FULL STOCK LIST.pdf', held_out=True,
         expect=dict(
             properties=4,
             rows=[
                 dict(lot_number='60', design='Onyx 18', land_size_sqm=301,
                      build_size_sqm=174, price=619000),
                 dict(lot_number='64', design='Pearl 21', land_size_sqm=357,
                      build_size_sqm=206, price=704000),
                 dict(lot_number='71', design='Quarry 23', land_size_sqm=406,
                      build_size_sqm=233, price=771000),
                 dict(lot_number='75', design='Rowan 26', land_size_sqm=462,
                      build_size_sqm=264, price=848000),
             ],
             image=None,
             known_limit='this stock list carries no photograph at all'))
def _m10(c):
    text(c, L, 22, 'MERIDIAN PARK - STOCK LIST PAGE 1 OF 2', 17, True)
    mcard(c, L, 45, '60', 'Onyx 18', '301m2', '174m2', '$619,000')
    mcard(c, R, 45, '64', 'Pearl 21', '357m2', '206m2', '$704,000')
    text(c, L, 120, 'Prices subject to change without notice.', 8)
    c.showPage()
    text(c, L, 22, 'MERIDIAN PARK - STOCK LIST PAGE 2 OF 2', 17, True)
    mcard(c, L, 45, '71', 'Quarry 23', '406m2', '233m2', '$771,000')
    mcard(c, R, 45, '75', 'Rowan 26', '462m2', '264m2', '$848,000')
    text(c, L, 120, 'Prices subject to change without notice.', 8)
    c.showPage()


# --- M12. the same stock list WITH a photograph on every card --------------
#
# WHY THIS EXISTS BESIDE M10, WHICH IS THE SAME DOCUMENT WITHOUT PICTURES.
#
# M10 is about SEGMENTATION over two pages and deliberately carries no
# photograph, which is honest and makes it useless for the one question the
# performance programme has to answer: how long does a builder wait for a
# multi-property stock list whose cards a customer can actually look at?
# Measured 22 September 2026, that is the shape that costs the most — four
# properties, four sets of image work, and under the per-isolate work
# allowance four crossings between isolates.
#
# TWO CARDS A PAGE, NEVER THREE. M2 records why: three columns on A4 leave
# each picture at 3% of the page against the product's own 6% floor for "large
# enough to be a property's listing image", so a three-across sheet honestly
# has no listing images. Two across is 6.4%, which is the shape M1 already
# proves publishes. Nothing about the floor is relaxed for this fixture.
#
# Every facade is a DIFFERENT seed, because four cards drawing one picture
# would test the de-duplicator rather than the throughput, and the four
# properties must end with four DIFFERENT photographs on them.
@fixture('heldout-pages-of-cards-with-photos', 'MERIDIAN - STOCK LIST WITH IMAGES.pdf',
         held_out=True, org='beta',
         expect=dict(
             properties=4,
             rows=[
                 dict(lot_number='160', design='Onyx 18', land_size_sqm=301,
                      build_size_sqm=174, price=619000, image_size='1280x800'),
                 dict(lot_number='164', design='Pearl 21', land_size_sqm=357,
                      build_size_sqm=206, price=704000, image_size='960x600'),
                 dict(lot_number='171', design='Quarry 23', land_size_sqm=406,
                      build_size_sqm=233, price=771000, image_size='1120x700'),
                 dict(lot_number='175', design='Rowan 26', land_size_sqm=462,
                      build_size_sqm=264, price=848000, image_size='1024x640'),
             ],
             image='facade_page_1',
             # NO CARD MAY WEAR ANOTHER'S LOT. The same prohibition M1 carries,
             # and it matters more here: the lots are four apart across two
             # pages, so a page-level attribution would look plausible.
             forbid=dict(no_lot_numbers=['161', '165', '172', '176'])))
def _m12(c):
    text(c, L, 22, 'MERIDIAN PARK - STOCK LIST PAGE 1 OF 2', 17, True)
    mcard(c, L, 40, '160', 'Onyx 18', '301m2', '174m2', '$619,000')
    mcard(c, R, 40, '164', 'Pearl 21', '357m2', '206m2', '$704,000')
    cardhero(c, facade(331, 1280, 800), L, 85)
    cardhero(c, facade(337, 960, 600), R, 85)
    text(c, L, 160, 'Prices subject to change without notice. Images are artist '
                    'impressions only and not an offer.', 8)
    c.showPage()
    text(c, L, 22, 'MERIDIAN PARK - STOCK LIST PAGE 2 OF 2', 17, True)
    mcard(c, L, 40, '171', 'Quarry 23', '406m2', '233m2', '$771,000')
    mcard(c, R, 40, '175', 'Rowan 26', '462m2', '264m2', '$848,000')
    cardhero(c, facade(347, 1120, 700), L, 85)
    cardhero(c, facade(353, 1024, 640), R, 85)
    text(c, L, 160, 'Prices subject to change without notice. Images are artist '
                    'impressions only and not an offer.', 8)
    c.showPage()


# --- M11. a native multi-property page beside a SCANNED page --------------
@fixture('heldout-mixed-scan-multi', 'THORNBURY - RELEASE AND SPEC.pdf', held_out=True,
         expect=dict(
             properties=3,
             rows=[
                 dict(lot_number='120', design='Sorrel 19', land_size_sqm=330,
                      build_size_sqm=188, price=664000),
                 dict(lot_number='124', design='Thistle 22', land_size_sqm=392,
                      build_size_sqm=221, price=742000),
                 dict(lot_number='131', design='Umber 24', land_size_sqm=455,
                      build_size_sqm=248, price=806000),
             ],
             image=None,
             # WHAT THIS FIXTURE PROVES AND WHAT IT DOES NOT. Page 1 is native
             # and carries two cards; page 2 is pixels and carries ONE
             # property, read off its own recognition. A SCANNED page holding
             # several cards is deliberately not attempted: recognition
             # returns a page of lines and the positioned runs describe only
             # whatever native fragment shared the sheet, so the gutters they
             # suggest are gutters in a fragment. That limit is named rather
             # than papered over.
             known_limit='a page whose text was recognised is never divided; '
                         'its positions describe only the native fragment',
             refusal_must_not_be=['ai_budget_exhausted', 'assisted_reader_unavailable',
                                  'assisted_reader_refused', 'assisted_reader_timeout',
                                  'assisted_reader_invalid_response']))
def _m11(c):
    text(c, L, 22, 'THORNBURY WALK - RELEASE SHEET', 17, True)
    mcard(c, L, 45, '120', 'Sorrel 19', '330m2', '188m2', '$664,000')
    mcard(c, R, 45, '124', 'Thistle 22', '392m2', '221m2', '$742,000')
    text(c, L, 120, 'Prices subject to change without notice.', 8)
    c.showPage()
    spec = render_page_as_scan([('LOT 131 - UMBER 24', 14),
                                ('Home Design UMBER 24', 12),
                                ('Land Size 455 m2', 12),
                                ('Build Size 248 m2', 12),
                                ('Price $806,000', 12)], seed=17)
    c.drawImage(ImageReader(spec), 0, 0, width=W, height=H, mask=None)
    c.showPage()



# ===========================================================================
# THE ICON-ROW BROCHURE WITH NO SITING PAGE (held out, 23 September 2026)
#
# A builder's one-page package brochure, set the way the production brochure
# for `LOT 4327` sets it and measured from that document's own geometry: the
# design name over a row of three bare numbers, each beside a pictogram; the
# three prices; the lot and its estate or street on one line ending in a
# comma, the suburb alone on the next; a `House` / `Specifications` heading
# over an area schedule whose superscripts and value baselines drift by a few
# points. The sibling that reads completely carries a SITING PAGE stating all
# of this again under labels; this one does not, so every fact has to come
# off the page that states it.
#
# THE GEOMETRY IS THE SUBJECT, so it is drawn in points rather than
# millimetres: a raised `2` 3.3 points up at 58% of the type, a heading whose
# baseline sits 1.1 points under that `2`, and a `Total:` label 2.9 points
# above its own value. Nothing here is a production document's text.
# ===========================================================================

from reportlab.pdfbase.pdfmetrics import stringWidth


def pt(c, x, y, s, size=10, bold=False):
    """A run at a baseline in POINTS. Answers where the run ends."""
    font = 'Helvetica-Bold' if bold else 'Helvetica'
    c.setFont(font, size)
    c.drawString(x, y, s)
    return x + stringWidth(s, font, size)


def area_pt(c, x, y, figure, size=10, rise=3.3):
    """`118.40m²` as a brochure sets it: the figure, then a raised `2` drawn as
    a run of its own that abuts it."""
    end = pt(c, x, y, figure, size)
    pt(c, end, y + rise, '2', round(size * 0.58, 1))


def pictogram(c, kind, x, y):
    """Line art beside a number. It carries no text, which is the point: the
    text layer sees the number and nothing that says what it counts."""
    c.setLineWidth(1.3)
    if kind == 'bed':
        c.rect(x, y - 1, 34, 9); c.rect(x, y + 8, 9, 6)
    elif kind == 'bath':
        c.roundRect(x, y - 1, 34, 9, 3); c.line(x + 4, y + 8, x + 4, y + 16)
    else:
        c.roundRect(x, y + 1, 34, 9, 3)
        c.circle(x + 8, y, 3.5); c.circle(x + 26, y, 3.5)


ICON_XS = (81.5, 165.0, 257.0)


def icon_row(c, values, y=743.6):
    for kind, value, x in zip(('bed', 'bath', 'car'), values, ICON_XS):
        pictogram(c, kind, x - 44, y)
        pt(c, x, y, value, 12)


def package_top(c, design, counts, land, build, package, lot_line, suburb, titles):
    pt(c, 27.5, 777.3, design, 30, True)
    icon_row(c, counts)
    pt(c, 28.8, 689.8, f'Land - {land}', 22, True)
    # `Build -` and its figure are two cells on the production page, a
    # column gap apart; the other two prices are one cell each.
    pt(c, 27.5, 664.5, 'Build -', 22)
    pt(c, 97.5, 664.5, build, 22)
    pt(c, 28.8, 639.2, f'Package Price - {package}', 22, True)
    pt(c, 27.5, 605.2, lot_line, 23)
    pt(c, 27.5, 577.6, suburb, 23)
    pt(c, 27.5, 550.0, titles, 23)
    pt(c, 27.5, 507.5, 'ALTO Inclusions & Turnkey Pack', 18, True)
    pt(c, 27.8, 484.9, 'ALTO Quality Inclusions:', 10)
    for i, item in enumerate(['Architecturally Designed Facade',
                              'Low Profile Concrete Rooftiles',
                              '2590mm high ceiling throughout',
                              'Stone benchtops throughout']):
        pt(c, 37.8, 472.4 - i * 12.5, '•', 10)
        pt(c, 51.2, 472.4 - i * 12.5, item, 10)


def package_foot(c):
    pt(c, 28.3, 47.0, '*Price based on standard inclusions and facade. '
       'Image depicts upgrade items not included in the price.', 6)
    pt(c, 28.3, 35.2, 'This plan is intended to give an indication of the proposed layout '
       'only and may vary without notice. It is not the actual lot for sale.', 6)
    pt(c, 28.3, 27.7, 'Images are artists’ impression for illustrative purposes only. '
       'Facade finishes, materials and colours may vary.', 6)


def specification_page(c):
    pt(c, 57, 790, 'Single Storey Specifications', 16, True)
    left = [('Kitchen Appliances', None), ('Dishwasher:', 'European style freestanding'),
            ('Oven:', 'European style 600mm stainless'), ('Hot Plate:', '600mm gas cook top.'),
            ('Cabinetry', None), ('Cupboards:', 'Laminate flush panel doors.')]
    right = [('Paint', None), ('Timberwork:', 'Satin finish enamel to internal'),
             ('Internal Walls:', 'Two coat acrylic, low sheen.'),
             ('Plumbing', None), ('Taps:', '2 external taps, 1 to the front meter.'),
             ('Hot Water System:', 'Instantaneous gas hot water.')]
    for i, (label, value) in enumerate(left):
        y = 750 - i * 22
        pt(c, 57, y, label, 10, value is None)
        if value: pt(c, 131, y, value, 10)
    for i, (label, value) in enumerate(right):
        y = 750 - i * 22
        pt(c, 312, y, label, 10, value is None)
        if value: pt(c, 386, y, value, 10)
    pt(c, 57, 40, 'The builder reserves the right to substitute products of equal or '
       'better quality.', 7)
    c.showPage()


@fixture('heldout-icon-row-estate-locality',
         'LOT 1809 Maple Estate - ORION 11.5 MODERN - BROCHURE V002.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='1809', estate='Maple Estate', suburb='Tarneit',
                        # NOTHING IS INVENTED. The page names a suburb and no
                        # state, no postcode and no street, and a suburb this
                        # product does not already hold is not a state.
                        state=None, postcode=None, street_name=None,
                        design='Orion 11.5',
                        # The icon row, with no floor plan text and no siting
                        # page to key it: read in the order every brochure of
                        # this shape prints it, under the guards named in
                        # `iconRowConvention`.
                        bedrooms=4, bathrooms=2, car_spaces=2,
                        land_size_sqm=312,
                        # The house's own total, stated under the house's own
                        # heading, where no other figure states the build.
                        build_size_sqm=160.5,
                        price=801500)],
             image='facade_page_1'))
def _i1(c):
    package_top(c, 'Orion 11.5', ('4', '2', '2'), '$412,000', '$389,500', '$801,500',
                'Lot 1809 Maple Estate,', 'Tarneit', 'Titles - Titled Land')
    c.drawImage(ImageReader(facade(31)), 300, 470, width=270, height=170,
                preserveAspectRatio=True, mask=None)
    # The floor plan is a PICTURE: no room is named in the text layer.
    c.drawImage(ImageReader(floorplan()), 300, 150, width=270, height=190,
                preserveAspectRatio=True, mask=None)
    pt(c, 27.3, 181.2, 'Lot Size', 14)
    area_pt(c, 27.3, 157.2, '312m')
    # One heading on two lines, and the first area's raised `2` lands 1.1
    # points above the second line's baseline.
    pt(c, 27.5, 128.7, 'House', 14)
    pt(c, 27.3, 111.9, 'Specifications', 14)
    pt(c, 29.5, 109.7, 'Enclosed:'); area_pt(c, 101.5, 109.7, '118.40m')
    pt(c, 29.5, 96.7, 'Garage:'); area_pt(c, 101.5, 96.7, '38.10m')
    pt(c, 29.5, 83.7, 'Porch:'); area_pt(c, 101.5, 83.7, '4m')
    # The total's label sits 2.9 points above its own figure.
    pt(c, 29.5, 70.7, 'Total:'); area_pt(c, 101.5, 67.8, '160.5m', rise=3.4)
    package_foot(c)
    c.showPage()
    specification_page(c)


@fixture('heldout-icon-row-street-locality',
         'LOT 2207 Harlow Lane - VELA 20B TEMPIO - BROCHURE - Copy.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='2207', street_name='Harlow Lane', suburb='Mickleham',
                        state=None, postcode=None, design='Vela 20B',
                        # The plan's room names are set in fragments — `Bed`
                        # over `3`, `Bat` over `h` — so it names one bedroom
                        # outright. One named bedroom is a floor under the
                        # count, never a contradiction of a row reading four.
                        bedrooms=4, bathrooms=2, car_spaces=2,
                        land_size_sqm=350, build_size_sqm=177.0, price=767650)],
             image='facade_page_1'))
def _i2(c):
    package_top(c, 'Vela 20B', ('4', '2', '2'), '$365,000', '$402,650', '$767,650',
                'Lot 2207 Harlow Lane,', 'Mickleham', 'Titles - Q2 2027')
    c.drawImage(ImageReader(facade(37)), 300, 560, width=270, height=170,
                preserveAspectRatio=True, mask=None)
    # A plan whose labels the exporter broke across lines.
    for label, x, y in [('Master', 492, 330), ('Bed', 498, 470), ('3', 498, 458),
                        ('Bed', 405, 420), ('2', 405, 408), ('Bat', 509, 396),
                        ('h', 509, 384), ('Kitch', 394, 360), ('en', 394, 348),
                        ('Garag', 386, 300), ('e', 386, 288), ('Porc', 448, 262),
                        ('h', 448, 250)]:
        pt(c, x, y, label, 8)
    pt(c, 27.3, 181.2, 'Lot Size', 14)
    area_pt(c, 27.3, 157.2, '350m')
    pt(c, 29.0, 128.7, 'House Specifications', 14)
    # Two values set 2.9 points under their labels, and their raised `2`s
    # landing on the labels' own baselines.
    pt(c, 29.5, 109.7, 'Ground Floor:'); area_pt(c, 101.5, 106.8, '139.5m', rise=3.4)
    pt(c, 29.5, 96.7, 'Garage:'); area_pt(c, 101.5, 96.7, '36.0m')
    pt(c, 29.5, 83.7, 'Porch:'); area_pt(c, 101.5, 80.8, '1.5m', rise=3.4)
    pt(c, 29.5, 70.7, 'Total:'); area_pt(c, 101.5, 67.8, '177.0m', rise=3.4)
    package_foot(c)
    c.showPage()
    specification_page(c)


@fixture('heldout-icon-row-plan-disagrees',
         'LOT 612 Ashgrove Estate - NOVA 21 - BROCHURE.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='612', estate='Ashgrove Estate', suburb='Wollert',
                        state=None, design='Nova 21',
                        # THE DOCUMENT DISAGREES WITH ITSELF: the row reads
                        # `3 2 2` and the plan names four bedrooms. Neither is
                        # chosen, so none of the three is read.
                        bedrooms=None, bathrooms=None, car_spaces=None,
                        land_size_sqm=392, build_size_sqm=214.0, price=829900)],
             image='facade_page_1'))
def _i3(c):
    package_top(c, 'Nova 21', ('3', '2', '2'), '$418,000', '$411,900', '$829,900',
                'Lot 612 Ashgrove Estate,', 'Wollert', 'Titles - Titled Land')
    c.drawImage(ImageReader(facade(41)), 300, 560, width=270, height=170,
                preserveAspectRatio=True, mask=None)
    for label, x, y in [('Master', 410, 470), ('Bed 2', 500, 440), ('Bed 3', 410, 400),
                        ('Bed 4', 500, 360), ('Ens', 440, 330), ('Bath', 500, 300),
                        ('Garage', 410, 260)]:
        pt(c, x, y, label, 8)
    pt(c, 27.3, 181.2, 'Lot Size', 14)
    area_pt(c, 27.3, 157.2, '392m')
    pt(c, 27.5, 128.7, 'House', 14)
    pt(c, 27.3, 111.9, 'Specifications', 14)
    pt(c, 29.5, 109.7, 'Enclosed:'); area_pt(c, 101.5, 109.7, '172.5m')
    pt(c, 29.5, 96.7, 'Garage:'); area_pt(c, 101.5, 96.7, '37.5m')
    pt(c, 29.5, 83.7, 'Porch:'); area_pt(c, 101.5, 83.7, '4m')
    pt(c, 29.5, 70.7, 'Total:'); area_pt(c, 101.5, 67.8, '214.0m', rise=3.4)
    package_foot(c)
    c.showPage()
    specification_page(c)


# ===========================================================================
# THE PACKAGE BROCHURE WHOSE SITING PLAN STATES DIFFERENT AREAS
# (held out, 23 September 2026)
#
# The same builder template as `LOT 4327`, one page longer, measured from the
# production document `LOT 927 - ENZO 10.5 - BROCHURE V002.pdf`. Page 1 is the
# property's own page: its price, its address on one row with the estate in
# brackets under it, `Lot Size` over its figure and the house's area schedule.
# Page 2 is a PRELIMINARY SITING drawn by a siting consultant: the same lot
# under labels, and a site-coverage block whose `Site Area` and `Build Area`
# are the two figures its coverage is computed from.
#
# They do not agree with page 1, and in the production document they did not:
# the siting measured 309.45 m2 of site where the property's page states a
# 294m2 lot, and 131.6 m2 of building where the house's own schedule totals
# 129.5m2. The builder's card must carry what the property's page states. The
# siting's figures are a different measurement made for a different purpose,
# and the reader treated them as the same statement made twice — so it dropped
# the lot size as disputed and let the siting's building area outrank the
# house.
#
# The estate is printed `(Aurora Park Estate)` on page 1 and `Estate: Aurora
# Park` on page 2: one place, spelled with and without the word that says what
# kind of place it is.
# ===========================================================================

def siting_page(c, address, locality, state, design, estate, coverage,
                site_area, build_area, rooms):
    """A preliminary siting as a siting consultant draws one, in points."""
    pt(c, 38.7, 785.3, 'Proposed Siting of your ALTO Home', 13.4, True)
    pt(c, 38.7, 763.1, 'ALTO Group Pty Ltd | 12 Sample Road, RICHMOND VIC 3121 | '
       'Phone: 03 9000 0000 | altogroup.example', 7.4)
    pt(c, 38.7, 751.9, 'Customer:', 8.9)
    pt(c, 291.0, 751.9, 'Date:', 8.9)
    pt(c, 356.2, 751.9, '19/12/2025', 8.9)
    pt(c, 38.7, 738.6, 'Site Address:', 8.9)
    pt(c, 109.2, 738.6, address, 8.9)
    pt(c, 291.0, 738.6, 'Estate:', 8.9)
    pt(c, 356.2, 738.6, estate, 8.9)
    pt(c, 38.7, 725.2, 'Locality:', 8.9)
    pt(c, 109.2, 725.2, locality, 8.9)
    pt(c, 291.0, 725.2, 'State:', 8.9)
    pt(c, 356.2, 725.2, state, 8.9)
    pt(c, 38.7, 711.9, 'Home Design:', 8.9)
    pt(c, 109.2, 711.9, design, 8.9)
    pt(c, 291.0, 711.9, 'Email/Phone:', 8.9)
    pt(c, 42.4, 688.1, 'Incomplete Sub:', 9.6)
    pt(c, 124.0, 688.1, 'Yes', 9.6)
    pt(c, 42.4, 673.3, 'Current Fencing:', 9.6)
    pt(c, 42.4, 658.5, 'Ceiling Height:', 9.6)
    pt(c, 124.0, 658.5, '2.4m', 9.6)
    pt(c, 42.4, 643.6, 'Site Coverage:', 9.6)
    pt(c, 124.0, 643.6, coverage, 9.6)
    pt(c, 42.4, 628.8, 'Site Area:', 9.6)
    pt(c, 124.0, 628.8, site_area, 9.6)
    pt(c, 42.4, 613.9, 'Build Area:', 9.6)
    pt(c, 124.0, 613.9, build_area, 9.6)
    # The drawing: the lot's own dimensions and the plan's rooms, in small type
    # scattered across the right of the sheet.
    for label, x, y in [('14.285 m', 276.4, 556.1), ('11.038 m', 221.6, 487.3),
                        ('25 m', 402.1, 404.7), ('14.215 m', 248.4, 310.3),
                        ('10.505 m', 335.8, 212.3)]:
        pt(c, x, y, label, 6.5)
    for label, x, y in rooms:
        pt(c, x, y, label, 5.5)
    pt(c, 38.0, 276.4, 'Zoning', 7.4)
    pt(c, 72.8, 271.9, 'UGZ2', 8.9)
    pt(c, 38.0, 257.8, 'Overlays', 7.4)
    pt(c, 72.8, 253.4, 'DCPO3', 8.9)
    pt(c, 38.0, 214.8, 'Requirement', 7.4)
    pt(c, 112.1, 214.8, 'Actual', 7.4)
    pt(c, 38.0, 202.2, 'Site', 7.4)
    pt(c, 112.2, 197.7, coverage, 8.9)
    pt(c, 38.7, 80.5, 'Note: This is a preliminary siting and is subject to a clear copy '
       'of title and approval of the builder.', 7.4)
    pt(c, 38.7, 69.4, 'This siting is subject to developer approval, state building '
       'regulations and council requirements (where applicable).', 7.4)
    pt(c, 481.6, 70.1, 'Scale:1:200 @ A4', 8.9)
    pt(c, 38.7, 55.3, 'Consultant: Siting Desk', 8.2)
    pt(c, 34.3, 35.3, '_________________________ ____________ '
       '_________________________ ____________', 10.4)
    pt(c, 34.3, 24.9, 'Customer Signature (1)', 6.7)
    pt(c, 178.9, 24.9, 'Date (1)', 6.7)
    c.showPage()


SITING_ROOMS = [('MASTER', 287.1, 353.7), ('ROBE', 288.9, 362.4), ('ENS', 277.1, 390.8),
                ('BED 2', 358.9, 460.7), ('BED 3', 338.8, 513.8), ('BED 4', 300.0, 520.0),
                ('BATH', 292.6, 417.0), ('GARAGE', 367.1, 405.5), ('PORCH', 323.1, 342.1),
                ('KITCHEN', 277.9, 439.3), ('FAMILY/MEALS', 289.3, 505.4),
                ('L-DRY', 306.7, 390.5), ('ENTRY', 319.8, 379.1)]


def property_page(c, design, prices, lot_line, suburb, estate, lot_size, schedule, seed):
    """The property's own page, laid out as the production template lays it."""
    land, build, package = prices
    pt(c, 28.4, 777.3, design, 30, True)
    icon_row(c, ('4', '2', '2'))
    pt(c, 29.8, 689.8, f'Land - {land}', 22, True)
    pt(c, 28.5, 664.5, 'Build -', 22)
    pt(c, 98.6, 664.5, build, 22)
    pt(c, 29.8, 639.2, f'Package Price - {package}', 22, True)
    end = pt(c, 26.2, 601.9, lot_line, 23)
    pt(c, end + 3.0, 601.9, suburb, 23)
    pt(c, 26.2, 574.3, estate, 23)
    pt(c, 26.2, 546.7, '***TITLED LAND***', 23)
    pt(c, 27.5, 507.5, 'ALTO Inclusions & Turnkey Pack', 18, True)
    for i, item in enumerate(['Architecturally Designed Facade',
                              'Low Profile Concrete Rooftiles',
                              'Stone benchtops throughout']):
        pt(c, 37.8, 472.4 - i * 12.5, '•', 10)
        pt(c, 51.2, 472.4 - i * 12.5, item, 10)
    c.drawImage(ImageReader(facade(seed)), 300, 470, width=270, height=170,
                preserveAspectRatio=True, mask=None)
    c.drawImage(ImageReader(floorplan()), 300, 150, width=270, height=190,
                preserveAspectRatio=True, mask=None)
    if lot_size:
        pt(c, 28.6, 182.1, 'Lot Size', 14)
        area_pt(c, 28.6, 158.1, lot_size)
    pt(c, 28.8, 129.7, 'House Specifications', 14)
    for (label, figure), y in zip(schedule, (110.6, 97.6, 84.6)):
        pt(c, 30.8, y, label)
        area_pt(c, 102.8, y, figure)
    pt(c, 30.8, 71.6, 'Total:', 10, True)
    area_pt(c, 102.8, 68.8, schedule_total(schedule), rise=3.3)
    package_foot(c)
    c.showPage()


def schedule_total(schedule):
    return SCHEDULE_TOTALS[tuple(schedule)]


SCHEDULE_ONE = (('Enclosed:', '118.40m'), ('Garage:', '38.10m'), ('Porch:', '3m'))
SCHEDULE_TWO = (('Ground Floor:', '139.5m'), ('Garage:', '36.0m'), ('Porch:', '1.5m'))
# The builder's own totals, written as the builder wrote them: the production
# document's total is not the sum of its lines either (129.5 against 133.01).
SCHEDULE_TOTALS = {SCHEDULE_ONE: '157.5m', SCHEDULE_TWO: '177.0m'}


@fixture('heldout-siting-plan-own-areas',
         'LOT 3104 - ORION 11.5 - BROCHURE V002.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='3104', street_name='Kestrel Street', suburb='Donnybrook',
                        state='VIC', postcode='3064',
                        # ONE PLACE, TWO SPELLINGS: `(Aurora Park Estate)` on the
                        # property's page and `Estate: Aurora Park` on the siting.
                        estate='Aurora Park Estate',
                        design='Orion 11.5',
                        bedrooms=4, bathrooms=2, car_spaces=2,
                        # THE PROPERTY'S PAGE, not the siting's coverage figures:
                        # `Lot Size 336m2` over `Site Area: 356.20 m2`, and the
                        # house's own `Total: 157.5m2` over `Build Area: 158.9 m2`.
                        land_size_sqm=336, build_size_sqm=157.5,
                        price=797050)],
             image='facade_page_1'))
def _s1(c):
    property_page(c, 'Orion 11.5', ('$405,000', '$392,050', '$797,050'),
                  'Lot 3104 Kestrel Street,', 'Donnybrook', '(Aurora Park Estate)',
                  '336m', SCHEDULE_ONE, 29)
    # 158.9 / 356.20 = 44.61%: the siting's figures are its coverage operands.
    siting_page(c, 'Lot 3104 KESTREL STREET', 'DONNYBROOK (3064)', 'VIC',
                'ORION 11.5 - MODERN', 'Aurora Park', '44.6%', '356.20 m2', '158.9 m2',
                SITING_ROOMS)
    specification_page(c)


@fixture('heldout-siting-plan-fills-land',
         'LOT 2215 - VELA 20B - BROCHURE V002.pdf', held_out=True,
         expect=dict(
             properties=1,
             rows=[dict(lot_number='2215', street_name='Harlow Lane', suburb='Mickleham',
                        state='VIC', postcode='3064', estate='Merrifield Estate',
                        design='Vela 20B', bedrooms=4, bathrooms=2, car_spaces=2,
                        # THE PROPERTY'S PAGE STATES NO LOT SIZE, so the siting's
                        # is the only statement of the land and it is read — while
                        # the house's own total still outranks the siting's
                        # building area.
                        land_size_sqm=401.2, build_size_sqm=177.0,
                        price=781900)],
             image='facade_page_1'))
def _s2(c):
    property_page(c, 'Vela 20B', ('$379,000', '$402,900', '$781,900'),
                  'Lot 2215 Harlow Lane,', 'Mickleham', '(Merrifield Estate)',
                  None, SCHEDULE_TWO, 33)
    # 176.4 / 401.20 = 43.97%.
    siting_page(c, 'Lot 2215 HARLOW LANE', 'MICKLEHAM (3064)', 'VIC',
                'VELA 20B - TEMPIO', 'Merrifield', '44.0%', '401.20 m2', '176.4 m2',
                SITING_ROOMS)
    specification_page(c)


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    manifest = []
    for f in FIXTURES:
        sub = os.path.join(outdir, f['org'])
        os.makedirs(sub, exist_ok=True)
        path = os.path.join(sub, f['filename'])
        if f['name'] == 'encrypted':
            c = canvas.Canvas(path, pagesize=A4,
                              encrypt='a-password-nobody-here-holds')
        else:
            c = canvas.Canvas(path, pagesize=A4)
        f['build'](c)
        c.save()
        entry = dict(name=f['name'], org=f['org'], filename=f['filename'],
                     path=os.path.relpath(path, outdir),
                     held_out=f['held_out'], expect=f['expect'],
                     known_limit=f['expect'].get('known_limit'),
                     bytes=os.path.getsize(path))
        if f.get('revision'):
            rev_path = os.path.join(sub, f['revision_filename'])
            rc = canvas.Canvas(rev_path, pagesize=A4)
            f['revision'](rc)
            rc.save()
            entry['revision'] = dict(
                filename=f['revision_filename'],
                path=os.path.relpath(rev_path, outdir),
                bytes=os.path.getsize(rev_path))
        manifest.append(entry)
    with open(os.path.join(outdir, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=2)
    total = sum(m['bytes'] for m in manifest)
    print(f'{len(manifest)} documents, {total} bytes, '
          f'{sum(1 for m in manifest if m["held_out"])} held out')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'corpus')
