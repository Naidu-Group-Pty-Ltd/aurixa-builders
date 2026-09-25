#!/usr/bin/env python3
"""The isolated production proof's copies of the SALTBUSH RISE brochures.

`heldout-a-row-whose-own-brochure-mistypes-its-lot-and-a-row-that-links-another`
is the acceptance fixture for "Use brochure image": a row whose own brochure's
cover mistypes its lot (Lot 2046 · Orion 22, cover `PACKAGE PRICELot 2064`,
glued as the measured exporter glued it) and a sibling's brochure linked on
another row (Lot 3185 · Halo 24's, linked by Lot 3158 as well).

The corpus draws every document afresh on each run and reportlab stamps each
file with the moment it was drawn, so the production proof imports THESE
files: the same fixture functions the gate judges, drawn with reportlab's
`invariant` switch, which fixes the timestamp and the document id and
therefore the bytes. Re-running this writes the identical files. Nothing in
them is any customer's.

    python3 scripts/stock-acceptance/make-confirmation-proof-fixtures.py
"""
import hashlib
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('make_corpus', os.path.join(HERE, 'make-corpus.py'))
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)

NAME = 'heldout-a-row-whose-own-brochure-mistypes-its-lot-and-a-row-that-links-another'
OUT = os.path.join(HERE, '..', 'ops', 'fixtures')
FILES = {
    'SaltbushRiseLot2046BrochureFixture': 'saltbush-lot-2046-own-brochure.pdf',
    'SaltbushRiseLot3185BrochureFixture': 'saltbush-lot-3185-brochure.pdf',
}

sheet = next(s for s in corpus.SHEETS if s['name'] == NAME)
for file_id, out_name in FILES.items():
    _filename, build = sheet['linked'][file_id]
    path = os.path.join(OUT, out_name)
    c = corpus.canvas.Canvas(path, pagesize=corpus.A4, invariant=1)
    build(c)
    c.save()
    with open(path, 'rb') as fh:
        data = fh.read()
    print(f'{os.path.relpath(path)} {len(data)} bytes sha256 {hashlib.sha256(data).hexdigest()}')
