#!/usr/bin/env python3
"""The isolated production proof's copy of `heldout-scanned-brochure`.

The acceptance corpus draws every document afresh on each run, and reportlab
stamps each file with the moment it was drawn, so no two runs share bytes. The
production proof has to import a document whose digest it can check before it
sends it, so it imports THIS file: the same fixture function the gate judges,
drawn with reportlab's `invariant` switch, which fixes the timestamp and the
document id and therefore the bytes. Re-running this writes the identical file.

    python3 scripts/stock-acceptance/make-scan-proof-fixture.py
"""
import hashlib
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('make_corpus', os.path.join(HERE, 'make-corpus.py'))
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)

NAME = 'heldout-scanned-brochure'
OUT = os.path.join(HERE, '..', 'ops', 'fixtures', 'scanned-brochure-lot-57.pdf')

entry = next(f for f in corpus.FIXTURES if f['name'] == NAME)
c = corpus.canvas.Canvas(OUT, pagesize=corpus.A4, invariant=1)
entry['build'](c)
c.save()
with open(OUT, 'rb') as fh:
    data = fh.read()
print(f'{os.path.relpath(OUT)} {len(data)} bytes sha256 {hashlib.sha256(data).hexdigest()}')
