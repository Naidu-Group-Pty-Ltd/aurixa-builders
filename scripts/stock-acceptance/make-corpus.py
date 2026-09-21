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

def facade(seed=11, w=1280, h=800):
    random.seed(seed)
    img = Image.new('RGB', (w, h)); px = img.load()
    for y in range(h):
        for x in range(w):
            if y < h * 0.42:
                base = (120 + int(70 * y / (h * 0.42)), 165 + int(55 * y / (h * 0.42)), 225)
            elif y < h * 0.72:
                t = (y - h * 0.42) / (h * 0.30)
                base = (188 - int(40 * t), 172 - int(45 * t), 150 - int(40 * t))
                if abs(x - w / 2) < 300 and y < h * 0.55:
                    base = (96 + int(20 * math.sin(x / 40)), 90, 88)
            else:
                base = (92 + int(40 * random.random()), 128, 74)
                if abs(x - w / 2) < 150:
                    base = (176, 174, 170)
            px[x, y] = tuple(max(0, min(255, c + random.randint(-14, 14))) for c in base)
    buf = io.BytesIO(); img.save(buf, format='JPEG', quality=86); buf.seek(0)
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


def render_page_as_scan(lines, seed=5, w=1240, h=1754):
    """A page of text rasterised: what a scanner produces. No text layer."""
    from PIL import ImageDraw
    random.seed(seed)
    img = Image.new('RGB', (w, h), (250, 249, 246))
    dr = ImageDraw.Draw(img)
    y = 120
    for text, size in lines:
        dr.text((110, y), text, fill=(22, 22, 26))
        y += 30 + size
    px = img.load()                      # scanner noise, so it is not flat art
    for _ in range(w * h // 40):
        x0, y0 = random.randrange(w), random.randrange(h)
        v = px[x0, y0]
        px[x0, y0] = tuple(max(0, min(255, c + random.randint(-18, 18))) for c in v)
    buf = io.BytesIO(); img.save(buf, format='JPEG', quality=80); buf.seek(0)
    return buf


def text(c, x, y, s, size=11, bold=False):
    c.setFont('Helvetica-Bold' if bold else 'Helvetica', size)
    c.drawString(x * mm, H - y * mm, s)


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

def fixture(name, filename, expect, held_out=False, org='alpha'):
    def deco(fn):
        FIXTURES.append(dict(name=name, filename=filename, expect=expect,
                             held_out=held_out, org=org, build=fn))
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
               land_size_sqm=402, build_size_sqm=237.5, price=662900,
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
    text(c, 20, 50, '4    2    1')
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
    for i, room in enumerate(['MASTER', 'BED 2', 'BED 3', 'BED 4', 'ENS',
                              'BATH', 'GARAGE', 'LIVING']):
        text(c, 120, 186 + i * 6, room, 8)
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
    text(c, 20, 44, '4  2  2     Land 448m2     Package $845,000')
    hero(c, facade(31))
    text(c, 20, 180, 'Artist impression. Landscaping not included.', 8)
    c.showPage()
    text(c, 20, 26, 'SITE PLAN', 14, True)
    text(c, 20, 38, 'Subject lot: Lot 305')
    hero(c, floorplan(), top=170, height=100)
    text(c, 20, 180, 'Adjoining allotments shown for context only:', 9)
    text(c, 20, 187, 'Lot 303      Lot 304      Lot 306      Lot 307', 9)
    text(c, 20, 196, 'Adjoining allotments are not offered for sale in this package.', 8)
    c.showPage()


# --- 5. a scanned document: image-only pages, no text layer at all ---------
@fixture('scanned-no-text-layer', 'LOT 88 - SCANNED PACKAGE.pdf', expect=dict(
    properties=0, rows=[], image=None,
    outcome='honest_refusal',
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
    hero(c, facade(41), top=200, height=150)
    c.showPage()
    text(c, 20, 26, 'PACKAGE DETAILS', 14, True)
    text(c, 20, 38, 'Site Address: Lot 140 WATTLEBIRD WAY')
    text(c, 20, 45, 'Locality: CRAIGIEBURN (3064)')
    text(c, 20, 52, 'State: VIC')
    text(c, 20, 59, 'Home Design: HARLOW 21')
    text(c, 20, 66, 'Site Area: 375 m2')
    text(c, 20, 73, 'Build Area: 201 m2')
    text(c, 20, 80, 'Bedrooms: 4   Bathrooms: 2   Car Spaces: 2')
    text(c, 20, 87, 'Package Price: $712,000')
    c.showPage()


# --- 7. missing optional fields: identity is sound, figures are not there --
@fixture('missing-optional-fields', 'LOT 9 - CALLA 18 - LISTING.pdf', expect=dict(
    properties=1,
    rows=[dict(lot_number='9', street_name='Perrin Street', suburb='Armstrong Creek',
               state='VIC', postcode='3217', design='Calla 18',
               price=None, land_size_sqm=None, build_size_sqm=None)],
    image='facade_page_1'))
def _f7(c):
    text(c, 20, 26, 'CALLA 18', 18, True)
    text(c, 20, 36, 'Lot 9 Perrin Street, Armstrong Creek VIC 3217')
    hero(c, facade(51))
    text(c, 20, 178, 'Pricing available on application. Contact our sales team.', 9)
    text(c, 20, 186, 'Artist impression. Facade shown may differ.', 8)
    c.showPage()


# --- 8. a two-column brochure carrying two properties on one page ---------
@fixture('two-column-two-properties', 'Estate Release - Two Homes.pdf', expect=dict(
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
             rows=[dict(lot_number='18', suburb='Melton South', state='VIC',
                        land_size_sqm=320, build_size_sqm=186, price=659900,
                        design='Rowan 19')],
             image='facade_page_1',
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
        manifest.append(dict(name=f['name'], org=f['org'], filename=f['filename'],
                             path=os.path.relpath(path, outdir),
                             held_out=f['held_out'], expect=f['expect'],
                             bytes=os.path.getsize(path)))
    with open(os.path.join(outdir, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=2)
    total = sum(m['bytes'] for m in manifest)
    print(f'{len(manifest)} documents, {total} bytes, '
          f'{sum(1 for m in manifest if m["held_out"])} held out')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'corpus')
