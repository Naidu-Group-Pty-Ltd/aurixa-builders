# A builder confirms a brochure is theirs

"Brochure details don't match this property" refuses a brochure whose image
page states a lot other than the listing's. The refusal is right: a cover that
names another lot is how another house's photograph reaches a client's card.
It is also sometimes wrong about the builder's own brochure, and only the
person holding the sheet can tell which. This records the two documents that
showed it, what the builder is now offered, what a confirmation changes and
what it never changes, and how an undo takes it back.

## 1. Two properties that look the same on screen

Measured 24 September 2026, on one stock list imported by URL:

| listing | the linked brochure | the truth |
|---|---|---|
| Lot 1037 · Vanta 20 | cover reads `PACKAGE PRICELot 1307 Fuchsia Street,` (the exporter glued the lot to the heading before it); page 2 states `Lot 1037` and `Vanta 20` | its **own** brochure, with a typing error on the cover |
| Lot 1447 · Nex 20 | the **same file** Lot 1744 · Cura 20B links | a **sibling's** brochure, linked on the wrong row. Lot 1744 already shows its photograph |

Both refusals state a lot whose digits are this listing's in a different
order. So a transposition is a hint for the builder and never evidence for
the product. The one fact that tells the two cases apart is checked by the
product: **another live listing already uses this brochure's photograph for
the lot the brochure states** (`brochureInUseByAnotherProperty`).

## 2. What the builder sees

On a mismatch notice, beside the explanation and never instead of it:

- **Use brochure image**, when the link is one document and no other listing
  uses its photograph. It opens a confirmation that names both identities
  ("The brochure's image page identifies Lot 1307, but this listing is Lot 1037
  · VANTA 20"). Where the digits are transposed it says that is often a typing
  error, in the brochure or in the stock list. Where another listing has the
  stated lot it says so. The dialog also says the image still has to pass the
  usual photo checks, and that the confirmation can be undone.
- **The listing's name, and no button**, when another listing already uses the
  brochure's photograph: "This brochure belongs to Lot 1744 · Cura 20B in your
  stock list, which already uses its image, so it can't be used for this
  property as well."

A confirmed brochure is drawn as the confirmation, with the undo: "Brochure
image confirmed by *name* on *date*", followed by what became of it. That is
one of: pending, applied, "still couldn't be used" with the recorded reason,
or "couldn't be read just now". It is drawn whether or not the card has a
picture, because a confirmed brochure is usually what gave it one. Every word
comes from `STOCK_BROCHURE_CONFIRMATION_COPY`.

Confirming needs the same permission as "Add picture" (editing stock).

## 3. What a confirmation changes, and what it does not

It changes one question the cover rule asks. `pageStatesIdentity` counts the
confirmed lot as this listing's, and **every other test stays**: the page must
still carry the package facts, must still be corroborated by the label or the
estate, and must still present one prominent photograph. A page that names a
**third** lot is still refused. The display checks (marketing overlay,
eligibility, sanitization) run exactly as they do for every picture.
The acceptance fixture proved it by accident: its first synthetic facade carried three
flat regions, and the confirmed brochure's image was refused as an annotated
marketing tile, correctly.

Under a confirmation the page is also read the way the finding was read: the
typed reading that sees `PACKAGE PRICELot 1307` glued together
(`TYPED_LOT_DESIGNATION`). Without a confirmation the reading is byte for byte
what it was.

A confirmation is refused when:

| code | why |
|---|---|
| `brochure_in_use` | another live listing already uses this brochure's photograph for the lot it states. Re-read from the database at the moment of the act, not trusted from the page |
| `finding_changed` | the stored answer under that link is no longer the mismatch stating that lot (re-read, replaced, or already answered under a confirmation) |
| `not_confirmable` | the link is a folder, whose file is chosen by the listing's own lot, so "the brochure" there is no one file |
| `busy` | a worker holds the property's claim; the completion would overwrite the requeue |

It never writes property data (price, availability, configuration, address,
status, builder or project linkage) and never writes
`source_provenance_result`.

## 4. Where it lives

`builder_stock_identity_confirmations`: one row per confirmation, keyed by the
link **exactly as the row carries it**. That is the key the stored answer lives
under; two spellings of one file are two questions. There is at most one
standing confirmation per link per property (a partial unique index). An undo
sets `withdrawn_at` and keeps the row. RLS is on, it is service-role only, and
it is written only by `builder_stock_confirm_brochure_image` /
`builder_stock_undo_brochure_image`, which lock the property and check the
stored refusal in the same statement as they write.

The refusal the builder confirmed against is reopened **by reading**, not by
writing: `identityConfirmationHolds` treats an unstamped identity mismatch
stating the confirmed lot as stale. Every answer reached under a confirmation
carries its id (`identity_confirmation`, in the branch record and in the stored
image's `source_detail`). That is what lets an undo reopen exactly the
answers the confirmation produced. Every reader of those answers passes the
standing confirmations through:

- the settler's `openBranches`
- `readStoredRowEvidence` in the fallback accounting
- the builder's notes

If one of them skipped it, a confirmed property would loop between `source`
and `fallback`.

## 5. The wire

The cover rules run in the PDF worker, which deploys on its own lane. A request
is asked under the **lowest protocol that can carry it**: an unconfirmed
election is protocol 2, byte for byte what every deployed worker reads, and
only a confirmed one is protocol 3 (`electionProtocolFor`). The worker answers
in the protocol it was asked in. An answer in any other protocol is
`unreachable`, a retry, because an unconfirmed answer filed as the confirmed
one's would bank "no image" over a brochure the builder said is theirs. A
malformed confirmation is refused with a 400 rather than elected without it.
The canary proves all three against the built bundle.

## 6. Undo

`builder_stock_undo_brochure_image` withdraws the confirmation, makes every
image stored under it `unavailable`, and clears the card if it pointed at one,
all in one transaction. The portal then re-chooses the card from what may
still be shown, and the settler, requeued by the undo, reads the brochure
again under whatever holds. Normally that banks the mismatch again, so the
notice comes back.

A slower worker could still store an image under the confirmation it read before the undo.
Three layers cover that:

1. `chooseAndStorePrimaryImage` and `enforceStrictPrimaryImages` never choose an
   image whose confirmation does not stand. If they cannot check, the card is
   left exactly as it is.
2. Every settler run takes down what a lapsed confirmation left behind before
   anything asks whether the property already holds a picture
   (`withdrawImagesOfLapsedConfirmations`).
3. The fallback accounting does not count such an image as the builder's.

## 7. How it was proven

- Held-out first (`fe3cf25`), failing on `main` for the right reason: unit rules for
  the cover rule, the wire, staleness, the readers and the notes. The page's
  button, dialogs and undo. An acceptance fixture (`SALTBUSH RISE`): a row
  whose own brochure mistypes its lot, a row linking a sibling's brochure,
  and the sibling itself.
- The acceptance gate over real PostgreSQL, PostgREST and the settler: the own
  brochure is confirmed, its photograph served at its own size and stamped;
  undo takes it down and the notice returns. The sibling's is refused naming
  "Lot 3185 · Halo 24", with nothing moved and nothing recorded.
- The worker canary: protocol 2 still elected and answered in 2, a confirmed
  request answered in 3, a malformed confirmation refused 400.
- `stock-source-forensics` has an **as-confirmed** pass: on a real brochure it
  prints whether the builder would be offered the choice, and what the settler
  would elect once they took it. It is read-only.
