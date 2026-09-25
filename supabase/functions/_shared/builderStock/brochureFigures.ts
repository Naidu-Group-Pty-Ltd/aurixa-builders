/**
 * BUILDER STOCK — READ WHAT A BROCHURE STATES ABOUT ITS PROPERTY'S FIGURES.
 *
 * The half that PARSES the document, and nothing else. It runs where the
 * photograph election runs — in `builder-stock-pdf-worker`, which exists
 * because parsing a multi-megabyte brochure does not fit an Edge isolate's CPU
 * — and answers with evidence: the product's own deterministic reading of the
 * text, whether the document presents the property's design, and which
 * pictures might print the house's area schedule. Those pictures are chosen
 * here and NEVER DECODED here: recognising them is the Edge side's job, in an
 * isolate that parsed nothing (the rule is `documentRead.pure.ts`'s — an
 * isolate that parsed a PDF decodes none of its pictures).
 *
 * The reading is exactly the upload path's (`extract.ts`): `readPdfPageTexts`,
 * `readPdfTextLayout`, `readPdfDeterministicRows`, then `figuresToRead` and
 * `outlinesToRead` over what `discoverPdfSourceAssets` noted. What a figure
 * MEANS for a property is decided elsewhere, in `brochureFigures.pure.ts`.
 *
 * No database, no network, no model.
 */
import { readPdfPageTextResult } from './pdfText.ts';
import { readPdfTextLayout } from './pdfTextLayout.ts';
import { readPdfDeterministicRows } from './pdfDeterministicRows.pure.ts';
import { discoverPdfSourceAssets } from './pdfSourcePhoto.ts';
import { figuresToRead } from './pdfFigures.pure.ts';
import { outlinesToRead, outlinesWithinRecognitionBudget } from './pdfOutlineFigures.pure.ts';
import { findDesignCoverPages, resolveDesignCover } from './pdfPrimaryImage.pure.ts';
import type { BrochureFigureEvidence } from './brochureFigures.pure.ts';

/** The one thing about the property the reader is told: its design. */
export interface FigureReadContext {
  design?: string | null;
}

export type FigureEvidenceOutcome =
  | { ok: true; evidence: BrochureFigureEvidence }
  /** The document could not be read. A fact about the read, never about the property. */
  | { ok: false; reason: string; unreadable: true };

export async function readBrochureFigureEvidence(
  bytes: Uint8Array,
  context: FigureReadContext = {},
): Promise<FigureEvidenceOutcome> {
  const text = await readPdfPageTextResult(bytes);
  if (!text.ok) return { ok: false, reason: `text_unreadable:${text.reason}`.slice(0, 120), unreadable: true };
  if (!text.pages.length) return { ok: false, reason: 'no_pages', unreadable: true };
  const layout = await readPdfTextLayout(bytes);
  const reading = readPdfDeterministicRows({
    pageTexts: text.pages,
    positionedPages: layout.ok ? layout.pages : null,
  });
  const presentsDesign = !!resolveDesignCover(findDesignCoverPages(text.pages, context.design));

  // Which pictures could still state the floor area, chosen as the upload path
  // chooses them. Discovery notes offsets; nothing here decodes a picture.
  let figures: BrochureFigureEvidence['figures'] = [];
  let outlines: BrochureFigureEvidence['outlines'] = [];
  const statesFloorArea = reading.status === 'complete' && reading.rows.length === 1
    && reading.rows[0].building_size_sqm != null;
  if (!statesFloorArea) {
    try {
      const found = await discoverPdfSourceAssets(bytes);
      const inputs = {
        rows: reading.rows,
        pricePages: reading.diagnostics?.pricePages ?? [],
        disputedFields: reading.diagnostics?.disputedFields ?? [],
      };
      figures = figuresToRead({ figures: found.figures, ...inputs });
      outlines = outlinesWithinRecognitionBudget(figures.length,
        outlinesToRead({ outlines: found.outlines, ...inputs }));
    } catch {
      // A document whose pictures cannot be enumerated still has its text.
    }
  }

  return {
    ok: true,
    evidence: {
      reading: {
        status: reading.status,
        rows: reading.rows,
        reason: typeof reading.reason === 'string' ? reading.reason : null,
      },
      presentsDesign,
      figures,
      outlines,
    },
  };
}
