"""Tier-0 ground truth: every property the proof imports, stated once.

Every expectation is authored from the DOCUMENT (what each fixture states),
never from a run of the reader. Each format has its own lot range, so a
property can only have come from the fixture that states it.
"""

COMMON = dict(suburb='Truganina', state='VIC', postcode='3029')

# Facade seeds the PRODUCT'S OWN classifier accepts as a clean photograph
# (`assessMarketplaceEligibility`, version 4), measured before they were used.
# A fixture photograph the rule refuses would make a proof about the fixture;
# a refused seed is never used for a property that is meant to publish.
ELIGIBLE = [102, 104, 201, 205, 206, 211, 212, 301, 307, 309, 311, 312, 314, 318, 319, 326, 329,
            331, 332, 407, 413, 416, 418, 423, 424, 427, 433, 434, 435, 436, 437, 438, 441, 444,
            445, 451, 452, 453, 455, 456, 459, 462, 463, 466, 469, 473, 476, 480, 505, 511, 700,
            701, 718, 728, 729, 730, 735, 736, 745, 755, 757, 758, 759]
_pool = iter(ELIGIBLE)
def next_seed():
    return next(_pool)

def prop(ref, lot, street, design, ptype, beds, baths, car, land, build, price,
         status, completion=None, estate='Kestrel Grove', stage='Stage 3',
         unit=None, description=None, suburb='Truganina', state='VIC', postcode='3029',
         photo_seed=None, plan=False, brochure=False):
    return dict(ref=ref, lot=lot, street=street, design=design, type=ptype,
                beds=beds, baths=baths, car=car, land=land, build=build,
                price=price, status=status, completion=completion, estate=estate,
                stage=stage, unit=unit, description=description, suburb=suburb,
                state=state, postcode=postcode, photo_seed=photo_seed, plan=plan,
                brochure=brochure)

# What the document's words become. Written from the product's DOCUMENTED
# vocabulary (normalise.pure.ts), never from an output.
TYPE = {'House & Land': 'house_and_land', 'House': 'house', 'Townhouse': 'townhouse',
        'Land Only': 'land', 'Apartment': 'apartment', 'Duplex': 'duplex'}
STATUS = {'Available': 'available', 'Under Offer': 'on_hold', 'Deposit Taken': 'reserved',
          'Sold': 'sold', 'Contracted': 'contracted', 'Withdrawn': 'withdrawn'}

def money(price):
    return None if isinstance(price, str) else price

def shown(price):
    return f'${price:,}' if not isinstance(price, str) else price

# ---------------------------------------------------------------------------
# The primary list (CSV, linked photographs, brochures and floor plans), v1.
# ---------------------------------------------------------------------------
CSV_V1 = [
    prop('T0-101', '101', '12 Proofline Way', 'Aspen 25', 'House & Land', 4, 2, 2, 448, 231.5,
         749900, 'Available', 'Dec 2026',
         description='PROOF ONLY — not for sale. Café-style kitchen, north-facing yard.',
         photo_seed=next_seed(), plan=True, brochure=True),
    prop('T0-102', '102', '14 Proofline Way', 'Birch 22', 'House', 4, 2.5, 2, 400, 205.2,
         712500, 'Under Offer', 'Mar 2027', description='PROOF ONLY — not for sale.',
         photo_seed=next_seed(), plan=True),
    prop('T0-103', '103', '16 Proofline Way', 'Cedar 18', 'Townhouse', 3, 2, 1, 250, 168,
         655000, 'Deposit Taken', description='PROOF ONLY — not for sale.', photo_seed=next_seed()),
    prop('T0-104', '104', '18 Proofline Way', 'Duo 30', 'House', 5, 3, 2, 512, 280.75,
         'POA', 'Available', description='PROOF ONLY — not for sale. Price on application.',
         photo_seed=next_seed()),
    prop('T0-105', '7A', '20 Tierzero Crescent', 'Elm 16', 'Townhouse', 3, 2, 1, 180, 150,
         599000, 'Sold', estate='Wren Heights', stage='Stage 1', unit='3',
         suburb='Tarneit', description='PROOF ONLY — not for sale.', photo_seed=next_seed()),
]

# v2 of the same list: the re-upload. Every change is one a builder makes.
CSV_V2 = [
    # price and status change; brochure unchanged
    dict(CSV_V1[0], price=739900, status='Under Offer'),
    # bedrooms and build size change; a DIFFERENT facade photograph
    dict(CSV_V1[1], beds=5, build=210.0, photo_seed=next_seed()),
    # CSV_V1[2] (T0-103) is REMOVED from the list
    # POA becomes a price; description changes
    dict(CSV_V1[3], price=799000, description='PROOF ONLY — not for sale. Now priced.'),
    # unchanged, except its house size cell is left BLANK (an update never erases)
    dict(CSV_V1[4], build=None),
    # a new property
    prop('T0-106', '106', '22 Proofline Way', 'Fern 20', 'House', 4, 2, 2, 420, 198,
         689000, 'Available', description='PROOF ONLY — not for sale.', photo_seed=next_seed()),
]

def lots(start, n, designs, **kw):
    out = []
    for i in range(n):
        lot = str(start + i)
        out.append(prop(f'T0-{lot}', lot, f'{10 + 2 * i} Formatcheck Street', designs[i],
                        'House', 3 + i, 2, 2, 350 + 25 * i, 180.5 + 10 * i,
                        600000 + 12500 * i, 'Available',
                        description='PROOF ONLY — not for sale.', photo_seed=next_seed(), **kw))
    return out

FORMATS = {
    # key: (lots, designs)
    'xlsx': lots(201, 2, ['Gum 21', 'Gum 23'], estate='Kestrel Grove'),
    'xlsx-defaultns': lots(211, 2, ['Gum 25', 'Gum 27']),
    'xls': lots(301, 2, ['Hazel 19', 'Hazel 21']),
    'xlsm': lots(311, 2, ['Iris 18', 'Iris 20']),
    'tsv': lots(321, 2, ['Juniper 22', 'Juniper 24']),
    'txt': lots(331, 2, ['Karri 17', 'Karri 19']),
    'docx': lots(401, 2, ['Laurel 25', 'Laurel 27']),
    'doc': lots(411, 2, ['Maple 20', 'Maple 22']),
    'odt': lots(421, 2, ['Nutmeg 18', 'Nutmeg 20']),
    'ods': lots(431, 2, ['Olive 23', 'Olive 25']),
    'rtf': lots(441, 2, ['Pine 21', 'Pine 23']),
    'pptx': lots(451, 2, ['Quince 19', 'Quince 21']),
    'html': lots(461, 2, ['Rowan 22', 'Rowan 24']),
    'json': lots(471, 2, ['Sage 18', 'Sage 20']),
    'xml': lots(481, 2, ['Tamarind 20', 'Tamarind 22']),
    'pdf-schedule': lots(501, 3, ['Umber 24', 'Umber 26', 'Umber 28']),
    'pdf-brochure': lots(511, 1, ['Violet 30']),
    'png': lots(601, 2, ['Willow 19', 'Willow 21']),
    'jpg': lots(611, 2, ['Xanthe 20', 'Xanthe 22']),
    'webp': lots(621, 2, ['Yarrow 18', 'Yarrow 20']),
    'gif': lots(631, 2, ['Zinnia 22', 'Zinnia 24']),
}

HEADERS = ['Stock Ref', 'Estate', 'Stage', 'Lot', 'Unit', 'Street Address', 'Suburb', 'State',
           'Postcode', 'Design', 'Type', 'Beds', 'Baths', 'Car', 'Land Size (m2)',
           'House Size (m2)', 'Package Price', 'Status', 'Completion', 'Description']

def row_cells(p):
    def n(v):
        if v is None: return ''
        if isinstance(v, float) and v.is_integer(): return str(int(v))
        return str(v)
    return [p['ref'], p['estate'], p['stage'], p['lot'], p['unit'] or '', p['street'],
            p['suburb'], p['state'], p['postcode'], p['design'], p['type'], n(p['beds']),
            n(p['baths']), n(p['car']), n(p['land']), n(p['build']), shown(p['price']),
            p['status'], p['completion'] or '', p['description'] or '']

def expected(p):
    """What the product must store for this property, field by field."""
    return {
        'external_reference': p['ref'], 'development_name': p['estate'],
        'project_name': p['stage'], 'lot_number': p['lot'], 'unit_number': p['unit'],
        'address_line': p['street'], 'suburb': p['suburb'], 'state': p['state'],
        'postcode': p['postcode'], 'house_design': p['design'],
        'property_type': TYPE[p['type']], 'bedrooms': p['beds'], 'bathrooms': p['baths'],
        'car_spaces': p['car'], 'land_size_sqm': p['land'], 'building_size_sqm': p['build'],
        'price': money(p['price']),
        'price_display': p['price'] if isinstance(p['price'], str) else None,
        'availability_status': STATUS[p['status']],
        'expected_completion': p['completion'], 'description': p['description'],
    }
