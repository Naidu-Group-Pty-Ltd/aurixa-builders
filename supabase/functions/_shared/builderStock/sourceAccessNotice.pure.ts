/**
 * BUILDER STOCK — SOME OF A SOURCE BEING UNREADABLE IS NOT THE SOURCE BEING
 * UNREADABLE.
 *
 * A Google Sheets import asks two questions, and they have nothing to do with
 * each other:
 *
 *     CAN WE READ THE PROPERTY ROWS?          the requested gid's CSV
 *     CAN WE ALSO RECOVER THE LINK TARGETS?   the workbook export
 *
 * A document shared so that anyone with the link may view it answers the first
 * and can still refuse the second — measured on a live builder list, `gviz`
 * 200 and every `export?format=…` 401. Treating those as one question has two
 * bad answers available and this takes neither: failing the upload over
 * optional metadata, or telling a builder to go and change their Drive
 * sharing before the product will work.
 *
 * THE RULE. Rows readable is a successful import. Link targets unreadable is a
 * NON-BLOCKING SOURCE-ACCESS ERROR: recorded on the upload, shown in the
 * portal, and never a reason to stop the import. What it is ALSO recorded on,
 * now, is every row the import writes (`link_discovery` — see
 * `suppliedEvidence.pure.ts`), and that stamp is what the fallback gate reads.
 *
 * WHAT THIS PARAGRAPH USED TO SAY, AND WHY IT WAS WRONG. It said the ladder
 * "falls through to verified web imagery and Street View exactly as it does
 * for a property whose builder supplied nothing", and that zero recovered
 * links "is the same arithmetic as a row that carries no links at all". It is
 * not the same arithmetic. A row whose links we could not read has an UNKNOWN
 * number of builder sources, and unknown is never zero: treating the two
 * alike bought external imagery against stock lists whose brochures were
 * sitting in plain sight — the measured case being a live builder list whose
 * every export answers 401 while fourteen properties each carry four document
 * links. OUR FAILURE IS NOT NO EVIDENCE. Such rows now read
 * `retryable_failure`: the cards WAIT, blank, until the links can be read —
 * by the htmlview grid reader, by an authorised recovery, or by a re-import
 * once our reader improves — and the external ladder stays shut for them.
 *
 * Pure: no IO, no clock, no network.
 */
import type { HyperlinkAvailability } from './sheetHyperlinks.pure.ts';

/**
 * The machine-readable condition. Behaviour keys on this and never on the
 * sentence below it, which is free to be reworded for tone.
 */
export const SOURCE_LINKS_UNAVAILABLE = 'google_sheets_source_links_unavailable';

export interface SourceAccessNotice {
  code: typeof SOURCE_LINKS_UNAVAILABLE;
  /** What the builder reads. Says all three things, in this order. */
  message: string;
  /** Which of the recoverable-from-public-source failures it was. */
  detail: { reason: HyperlinkAvailability };
}

/**
 * THE SENTENCE THE BUILDER READS, AND WHY IT IS NOT ONE SENTENCE.
 *
 * It must always say three things, because leaving any of them out sends
 * somebody to the wrong remedy: that some linked information could not be
 * reached, that the stock list imported anyway, and that image processing is
 * carrying on by itself.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. The single message blamed "linked files",
 * and that is not what happens. Measured on a live document, every documented
 * public representation was probed:
 *
 *     /export?format=xlsx    401      the only one carrying link targets
 *     /export?format=csv     401
 *     /pubhtml               401
 *     /gviz/tq   csv|json|html  200   zero anchors, zero file ids
 *     /htmlview, /preview       200   zero anchors, zero file ids
 *
 * The linked brochures may be perfectly reachable. It is the SPREADSHEET that
 * refuses to be exported, and only the export carries the addresses. Telling a
 * builder their files are inaccessible sends them to check the files.
 *
 * AND THERE IS A REMEDY THAT ASKS NOTHING OF THE DOCUMENT: the same
 * spreadsheet attached as an .xlsx file keeps its link targets, and this
 * product already accepts one. That is the rule this module was written to
 * protect — a builder must never be REQUIRED to open a document up for
 * optional metadata — so the only route offered is the one that requires
 * nothing of them, and the alternative is deliberately not mentioned at all.
 * A notice with no way forward is just a complaint; a notice that names a
 * permission change is the demand this exists to prevent.
 */
const IMPORTED_AND_CONTINUING =
  ' Your stock list imported successfully. Properties whose documents sit '
  + 'behind those links will hold their pictures until the links can be read '
  + '— a substitute image is never used in their place.';

const MESSAGE_BY_REASON: Record<string, string> = {
  /*
   * The document itself refused to be exported. Nothing about the links is
   * known — not even whether there are any — so the sentence says what was
   * actually observed and offers the route that needs no permission change.
   */
  unavailable_source_export:
    'This Google Sheet does not allow the file to be exported, and a '
    + "spreadsheet's link targets travel only in the exported file — so the "
    + 'brochures and plans linked from its cells could not be accessed. '
    + 'Attaching the .xlsx file to an upload keeps those links.',
  /*
   * Kept as its own reading: we DID get the file and could not make sense of
   * it, which is our problem rather than the document's, and it points at a
   * different remedy entirely.
   */
  unavailable_workbook_unreadable:
    'This Google Sheet was downloaded but its workbook could not be read, so '
    + 'the brochures and plans linked from its cells could not be accessed. '
    + 'Attaching the .xlsx file to an upload is the direct route to them.',
  unavailable_no_worksheet_match:
    'The tab this stock list came from could not be matched inside the '
    + 'workbook, so the brochures and plans linked from its cells could not be '
    + 'accessed — taking them from a different tab would attach the wrong '
    + 'documents.',
  unavailable_ambiguous_worksheet:
    'Two tabs in this workbook look equally like the one this stock list came '
    + 'from, so the brochures and plans linked from its cells could not be '
    + 'accessed — taking the wrong tab would attach the wrong documents.',
};

const FALLBACK_MESSAGE =
  'Some linked information in this Google Sheet could not be accessed, so a '
  + 'few builder-supplied documents may be unavailable.';

/**
 * Does this reading of a source warrant telling the builder?
 *
 * Only the three that are facts about ACCESS. `resolved` and `none_present`
 * are facts about the spreadsheet — the links were read, or the tab genuinely
 * has none — and there is nothing to report about either.
 */
export function sourceAccessNoticeFor(
  availability: HyperlinkAvailability | null | undefined,
): SourceAccessNotice | null {
  if (!availability) return null;
  if (availability === 'resolved' || availability === 'none_present') return null;
  const message = (MESSAGE_BY_REASON[availability] ?? FALLBACK_MESSAGE)
    + IMPORTED_AND_CONTINUING;
  return { code: SOURCE_LINKS_UNAVAILABLE, message, detail: { reason: availability } };
}

/**
 * Is this upload's recorded error the non-blocking kind?
 *
 * The portal needs to tell a source-access notice from a real failure, and the
 * status is what separates them: a failed upload has `status = 'failed'` and
 * imported nothing. This never sets that — an upload carrying this code has
 * its rows, and saying otherwise would make a builder re-upload a list that
 * is already in.
 */
export function isNonBlockingSourceNotice(code: string | null | undefined): boolean {
  return code === SOURCE_LINKS_UNAVAILABLE;
}
