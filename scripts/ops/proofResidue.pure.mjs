/**
 * ===========================================================================
 * A FILE IS REMOVED ONLY WHEN IT IS RECOGNISABLY A PROOF'S.
 * ===========================================================================
 *
 * The residue sweep (`storage-residue-sweep.mjs`) is handed files that the
 * database has already disowned. Each one is in a stock bucket, its path names
 * an organisation that no longer exists, and no row points at it. That is
 * necessary and it is not enough. An operator may delete a real builder, and
 * that builder's files would pass all three tests. So a file is removed only
 * where its path is one a PROOF writes. Everything else is kept and counted,
 * and never guessed at.
 *
 * The four shapes are the ones measured on 28 Sep 2026: 112 files, every one
 * recognised.
 *
 *   smoke stock list  `stock-lists/<org>/<upload>/smoke-stock.csv` (or
 *                     `smoke-stock-brochure.csv`): the copy the product keeps of
 *                     the list `production-smoke.mjs` imports by URL.
 *   proof facade      `builder-supplied/<org>/<item>/facade.(png|jpg)`: the
 *                     picture a proof adds through "Add picture" (smoke:
 *                     `facade.png`; Tier-0 formats: `facade.jpg`).
 *   sanitised copy    `builder-supplied/<org>/<item>/sanitized/v<n>/<uuid>.png`:
 *                     the product's own copy of a picture. It counts only
 *                     beside a proof facade in the same folder, because a real
 *                     builder's pictures are sanitised the same way.
 *   brochure picture  `<org>/…/lot-717-enzo-brochure.pdf-page<n>-….jpg`: a
 *                     picture the product read out of the smoke brochure, a
 *                     fixture of this repository
 *                     (`workers/builder-stock-pdf-worker/scripts/fixtures/`).
 */
const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LIST_BUCKET = 'builder-stock-lists';
const IMAGE_BUCKET = 'builder-stock-images';

const SMOKE_LIST = new RegExp(`^stock-lists/${U}/${U}/smoke-stock(-brochure)?\\.csv$`, 'i');
const FACADE = new RegExp(`^(builder-supplied/${U}/${U})/facade\\.(png|jpg)$`, 'i');
const SANITISED = new RegExp(`^(builder-supplied/${U}/${U})/sanitized/v[0-9]+/${U}\\.png$`, 'i');
const BROCHURE_PICTURE = new RegExp(`^${U}/.+/lot-717-enzo-brochure\\.pdf-page[0-9]+-[^/]+\\.(jpe?g|png)$`, 'i');

/**
 * Sort disowned files into what may be removed and what is kept.
 * `files` is `{ bucket, name }[]`. The result names every file exactly once.
 */
export function planResidueSweep(files) {
  const facadeFolders = new Set(files
    .filter((f) => f.bucket === IMAGE_BUCKET)
    .map((f) => FACADE.exec(f.name)?.[1])
    .filter(Boolean));
  const remove = [];
  const keep = [];
  for (const file of files) {
    const kind = kindOf(file, facadeFolders);
    if (kind) remove.push({ ...file, kind });
    else keep.push({ ...file, reason: 'not recognisably a proof artefact' });
  }
  const byKind = {};
  for (const file of remove) byKind[file.kind] = (byKind[file.kind] ?? 0) + 1;
  return { remove, keep, byKind };
}

function kindOf({ bucket, name }, facadeFolders) {
  const path = String(name ?? '');
  if (path.includes('..') || path.startsWith('/')) return null;
  if (bucket === LIST_BUCKET && SMOKE_LIST.test(path)) return 'smoke stock list';
  if (bucket !== IMAGE_BUCKET) return null;
  if (FACADE.test(path)) return 'proof facade';
  const folder = SANITISED.exec(path)?.[1];
  if (folder && facadeFolders.has(folder)) return 'sanitised copy of a proof facade';
  if (BROCHURE_PICTURE.test(path)) return 'picture read out of the smoke brochure';
  return null;
}
