"""
THE CPU-STRESS CORPUS — documents built to be EXPENSIVE, not to be tricky.

WHY IT IS SEPARATE FROM THE ACCEPTANCE CORPUS.

`make-corpus.py` exists to prove the pipeline reads documents CORRECTLY, and
every fixture in it is small on purpose: a shape is a shape at 80 KB, and a
gate that took ten minutes would stop being run. That is the right trade for
correctness and it is exactly why that corpus could not see the 22 September
incident.

MEASURED 22 September 2026, production: a real customer brochure of
**8,530,307 bytes** reached `POST builder-portal-stock -> 546  CPU Time
exceeded` eight seconds into processing. The largest fixture in the
acceptance corpus is 1.4 MB for the WHOLE THIRTY-DOCUMENT set. Nothing in it
is within an order of magnitude of the class that fails, so nothing in it
could ever have failed that way.

So this builds the expensive classes, at production scale, and the profiler
beside it measures what each stage of the importer spends on them. It is a
MEASUREMENT instrument first: the stage boundaries in the importer are
chosen from its numbers rather than from an opinion about which operation
looks costly.

NOTHING HERE IS KEYED ON A CUSTOMER DOCUMENT. No lot number, no design name,
no builder name and no filename from production appears in this file. The
8.5 MB brochure is represented by its SHAPE — many pages, many text runs, a
handful of large photographs — because that is what made it expensive, and
the next document of that shape will be somebody else's.

    usage: python3 scripts/stock-acceptance/make-stress-corpus.py [outdir]
"""
import io, json, os, sys, random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    'corpus', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make-corpus.py'))
_corpus = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_corpus)

facade = _corpus.facade
floorplan = _corpus.floorplan
render_page_as_scan = _corpus.render_page_as_scan
text = _corpus.text
hero = _corpus.hero
mcard = _corpus.mcard
cardhero = _corpus.cardhero
W, H = _corpus.W, _corpus.H
mm = _corpus.mm
canvas = _corpus.canvas
ImageReader = _corpus.ImageReader

OUT = sys.argv[1] if len(sys.argv) > 1 else '/var/tmp/stress-corpus'
L, R = 18, 108

FIXTURES = []


def big_photo(seed, w, h):
    """A facade at PRESS weight, so the bytes are production-sized.

    WHY THE RE-ENCODE. `facade()` is the acceptance corpus's render and it is
    deliberately cheap — a few hundred kilobytes, because a shape is a shape
    at any size and a gate that took ten minutes would stop being run. This
    corpus has the opposite job: the class that killed a production worker was
    8.5 MB, and a fixture six times smaller cannot exercise it.

    So the same render is re-encoded at press quality with no chroma
    subsampling, which is what a builder's press pack actually contains. The
    IMAGE is unchanged — the same generator, the same seed, the same
    statistics the role classifier reads — only its weight is production's.
    Nothing here changes what the pipeline decides about the picture; it
    changes what the pipeline has to spend deciding it.
    """
    from PIL import Image
    src = Image.open(facade(seed, w, h)).convert('RGB')
    buf = io.BytesIO()
    src.save(buf, format='JPEG', quality=96, subsampling=0, optimize=False)
    buf.seek(0)
    return buf


def fixture(name, filename, what, expect):
    """Register one stress document. `what` says which cost it exercises."""
    def deco(fn):
        FIXTURES.append(dict(name=name, filename=filename, what=what,
                             expect=expect, build=fn))
        return fn
    return deco


def _page_of_prose(c, y0, lines, size=8.5):
    """Dense body copy — the cost the positioned-layout reader actually pays."""
    y = y0
    for line in lines:
        text(c, L, y, line, size)
        y += size * 0.42
    return y


WORDS = ('inclusions specification schedule allowance provisional sum tiling '
         'cornice skirting architrave plasterboard insulation batts sarking '
         'downpipe fascia gutter eave lintel bearer joist stumps slab mesh '
         'membrane waterproofing tapware vanity benchtop splashback cooktop '
         'rangehood dishwasher laundry trough linen robe ensuite alfresco '
         'portico garage panel lift sectional remote driveway crossover '
         'landscaping turf letterbox clothesline fencing colorbond capping').split()


def prose_lines(count, seed):
    random.seed(seed)
    out = []
    for n in range(count):
        words = [random.choice(WORDS) for _ in range(random.randint(6, 13))]
        out.append(f'{n + 1:03d}  ' + ' '.join(words).upper())
    return out


# --- S1. the many-line document ------------------------------------------
#
# THE CLASS THE PRODUCTION KILL BELONGS TO. That brochure's reading logged
# `ignored_lines: 437` — four hundred and thirty-seven text runs the reader
# normalised, classified and then had nothing to do with. Normalisation is
# per run, so this is the cost that scales with a document's CHATTINESS
# rather than with its page count or its pictures.
@fixture('stress-many-lines', 'INCLUSIONS SCHEDULE - LONG.pdf',
         'text runs: normalisation and the positioned-layout reader',
         dict(properties=1, image='facade_page_1'))
def _s1(c):
    text(c, L, 22, 'HAVENFIELD RISE - STAGE 7', 20, True)
    text(c, L, 34, 'Lot 214 Fairweather Drive', 15, True)
    text(c, L, 42, 'Clyde North VIC 3978')
    text(c, L, 50, 'Home Design'); text(c, L + 40, 50, 'Aspire 24 Grande')
    text(c, L, 57, 'Land Size'); text(c, L + 40, 57, '401.86m2')
    text(c, L, 64, 'Build Size'); text(c, L + 40, 64, '237.5m2')
    text(c, L, 71, 'Price'); text(c, L + 40, 71, '$662,900')
    hero(c, big_photo(211, 2600, 1650), top=80, height=95)
    c.showPage()
    for page in range(6):
        text(c, L, 18, 'INCLUSIONS AND SPECIFICATIONS', 12, True)
        _page_of_prose(c, 26, prose_lines(80, 900 + page))
        c.showPage()


# --- S2. many large photographs -------------------------------------------
#
# The RASTER class on its own: one property, twelve full-bleed renders. Each
# one is decoded, classified and stored, and this is the only fixture where
# that is most of the work.
@fixture('stress-many-images', 'DISPLAY RANGE - GALLERY.pdf',
         'rasters: decode, classify and store',
         dict(properties=1, image='facade_page_1'))
def _s2(c):
    text(c, L, 22, 'OAKMONT PARK', 20, True)
    text(c, L, 32, 'Lot 77 Wren Street', 15, True)
    text(c, L, 40, 'Bendigo VIC 3550')
    text(c, L, 48, 'Home Design'); text(c, L + 40, 48, 'Marlow 22')
    text(c, L, 55, 'Land Size'); text(c, L + 40, 55, '448m2')
    text(c, L, 62, 'Price'); text(c, L + 40, 62, '$812,500')
    hero(c, big_photo(401, 3800, 2400), top=70, height=105)
    c.showPage()
    for n in range(13):
        c.drawImage(ImageReader(big_photo(410 + n * 7, 3400, 2150)),
                    L * mm, H - 180 * mm, width=174 * mm, height=110 * mm,
                    preserveAspectRatio=True, mask=None)
        text(c, L, 190, 'Artist impression only.', 8)
        c.showPage()


# --- S3. one very large photograph ----------------------------------------
#
# The same class as S2 but concentrated: the cost of a single decode at
# production resolution, which is what a builder's press render actually is.
@fixture('stress-one-huge-image', 'HERO RENDER - LARGE.pdf',
         'rasters: one decode at press resolution',
         dict(properties=1, image='facade_page_1'))
def _s3(c):
    text(c, L, 20, 'CARRINGTON GARDENS', 20, True)
    text(c, L, 30, 'Lot 19 Verity Street', 15, True)
    text(c, L, 38, 'Truganina VIC 3029')
    text(c, L, 46, 'Home Design'); text(c, L + 40, 46, 'Verity 19')
    text(c, L, 53, 'Land Size'); text(c, L + 40, 53, '336m2')
    text(c, L, 60, 'Price'); text(c, L + 40, 60, '$671,000')
    hero(c, big_photo(331, 5200, 3300), top=68, height=110)
    c.showPage()


# --- S4. many pages -------------------------------------------------------
#
# The DOCUMENT class scaled by page count rather than by runs: the page tree
# walk, the text layer read and the positioned layout read all pay per page.
@fixture('stress-many-pages', 'FULL CONTRACT PACK.pdf',
         'document: page tree, text layer and positioned layout per page',
         dict(properties=1, image='facade_page_1'))
def _s4(c):
    text(c, L, 22, 'MERIDIAN ESTATE', 20, True)
    text(c, L, 32, 'Lot 305 Nexa Road', 15, True)
    text(c, L, 40, 'Craigieburn VIC 3064')
    text(c, L, 48, 'Home Design'); text(c, L + 40, 48, 'Nexa 20')
    text(c, L, 55, 'Land Size'); text(c, L + 40, 55, '392m2')
    text(c, L, 62, 'Price'); text(c, L + 40, 62, '$742,000')
    hero(c, big_photo(501, 2400, 1500), top=70, height=95)
    c.showPage()
    for page in range(23):
        text(c, L, 18, f'SCHEDULE OF FINISHES - SHEET {page + 2}', 11, True)
        _page_of_prose(c, 26, prose_lines(34, 1700 + page), size=9)
        c.showPage()


# --- S5. the production shape: many pages AND many photographs ------------
#
# THE COMBINATION, which is what an 8.5 MB builder brochure actually is and
# what the acceptance corpus has nothing like. If any single class is safe
# and the combination is not, this is the fixture that says so.
@fixture('stress-heavy-brochure', 'PACKAGE BROCHURE - FULL.pdf',
         'document AND raster together, at production scale',
         dict(properties=1, image='facade_page_1'))
def _s5(c):
    text(c, L, 22, 'ASHFORD RISE', 20, True)
    text(c, L, 32, 'Lot 550 Hawke Parade', 15, True)
    text(c, L, 40, 'Officer VIC 3809')
    text(c, L, 48, 'Home Design'); text(c, L + 40, 48, 'Hawke 20')
    text(c, L, 55, 'Land Size'); text(c, L + 40, 55, '512m2')
    text(c, L, 62, 'Build Size'); text(c, L + 40, 62, '286m2')
    text(c, L, 69, 'Price'); text(c, L + 40, 69, '$727,155')
    hero(c, big_photo(601, 3800, 2400), top=78, height=100)
    c.showPage()
    for page in range(14):
        text(c, L, 18, 'SPECIFICATION', 12, True)
        _page_of_prose(c, 26, prose_lines(48, 2300 + page))
        c.drawImage(ImageReader(big_photo(620 + page * 5, 3400, 2150)),
                    L * mm, H - 250 * mm, width=174 * mm, height=110 * mm,
                    preserveAspectRatio=True, mask=None)
        c.showPage()
    c.drawImage(ImageReader(floorplan(2400, 1700)),
                L * mm, H - 200 * mm, width=174 * mm, height=123 * mm,
                preserveAspectRatio=True, mask=None)
    c.showPage()


# --- S6. a scanned document of real length --------------------------------
#
# OCR at a page count that costs something. Recognition is the most expensive
# thing in the pipeline per page and the acceptance corpus recognises one.
@fixture('stress-scanned-pages', 'SCANNED PACKAGE - MULTI.pdf',
         'document: recognition over several pages',
         dict(properties=1, image=None))
def _s6(c):
    pages = [
        [('LOT 88 - HARLOW 21', 14), ('22 Wattlebird Way', 11),
         ('Craigieburn VIC 3064', 11), ('4 bed 2 bath 2 car', 11),
         ('Land 375m2  Build 201m2', 11), ('Package Price $712,000', 12)],
    ]
    for n in range(4):
        pages.append([(line, 10) for line in prose_lines(26, 3100 + n)])
    for lines in pages:
        c.drawImage(ImageReader(render_page_as_scan(lines)), 0, 0,
                    width=W, height=H, preserveAspectRatio=False, mask=None)
        c.showPage()


# --- S7. a large multi-property sheet -------------------------------------
#
# Segmentation and the reader multiplied by the number of cards, with a
# photograph on each so the raster class scales with it.
@fixture('stress-multi-property', 'STOCK LIST - FULL RELEASE.pdf',
         'document AND raster, multiplied by property count',
         dict(properties=8, image='facade_page_1'))
def _s7(c):
    lots = [('160', 'Onyx 18', '301m2', '174m2', '$619,000'),
            ('164', 'Pearl 21', '357m2', '206m2', '$704,000'),
            ('171', 'Quarry 23', '406m2', '233m2', '$771,000'),
            ('175', 'Rowan 26', '462m2', '264m2', '$848,000'),
            ('182', 'Sable 19', '330m2', '188m2', '$664,000'),
            ('186', 'Thistle 22', '392m2', '221m2', '$742,000'),
            ('193', 'Umber 24', '455m2', '248m2', '$806,000'),
            ('197', 'Verity 27', '498m2', '271m2', '$869,000')]
    for page in range(4):
        text(c, L, 22, f'MERIDIAN PARK - STOCK LIST PAGE {page + 1} OF 4', 17, True)
        left, right = lots[page * 2], lots[page * 2 + 1]
        mcard(c, L, 40, *left)
        mcard(c, R, 40, *right)
        cardhero(c, big_photo(701 + page * 11, 2200, 1375), L, 85)
        cardhero(c, big_photo(707 + page * 11, 2000, 1250), R, 85)
        text(c, L, 160, 'Prices subject to change without notice. Images are '
                        'artist impressions only and not an offer.', 8)
        c.showPage()


# --- S8. dense positioned layout ------------------------------------------
#
# Text set in COLUMNS rather than lines, which is what makes the positioned
# reader work: every run carries its own x, and `layoutLines` has to group
# them. A document of this shape costs far more in the layout read than its
# page count suggests.
@fixture('stress-positioned-grid', 'AREA SCHEDULE - GRID.pdf',
         'document: positioned layout grouping',
         dict(properties=1, image='facade_page_1'))
def _s8(c):
    text(c, L, 20, 'WILLOWMEAD', 20, True)
    text(c, L, 30, 'Lot 41 Birch Avenue', 15, True)
    text(c, L, 38, 'Pakenham VIC 3810')
    text(c, L, 46, 'Home Design'); text(c, L + 40, 46, 'Birch 20')
    text(c, L, 53, 'Land Size'); text(c, L + 40, 53, '368m2')
    text(c, L, 60, 'Price'); text(c, L + 40, 60, '$688,400')
    hero(c, big_photo(801, 2400, 1500), top=68, height=90)
    c.showPage()
    random.seed(4242)
    for page in range(5):
        text(c, L, 16, 'AREA SCHEDULE', 11, True)
        y = 24
        for row in range(52):
            for col in range(7):
                text(c, L + col * 25, y, f'{random.randint(10, 9999)}', 7)
            y += 5
        c.showPage()


def build(entry, path):
    c = canvas.Canvas(path, pagesize=A4 if False else (W, H))
    entry['build'](c)
    c.save()


if __name__ == '__main__':
    from reportlab.lib.pagesizes import A4
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    total = 0
    for entry in FIXTURES:
        path = os.path.join(OUT, entry['filename'])
        build(entry, path)
        size = os.path.getsize(path)
        total += size
        manifest.append(dict(name=entry['name'], filename=entry['filename'],
                             path=entry['filename'], what=entry['what'],
                             expect=entry['expect'], bytes=size))
        print(f"{entry['name']:26} {size:>10,} bytes   {entry['what']}")
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
    print(f"\n{len(FIXTURES)} stress documents, {total:,} bytes total")
