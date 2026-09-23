/**
 * Builder stock — READING THE FIGURES A DOCUMENT PRINTS ONLY AS PICTURES.
 *
 * The rule and the evidence are in `pdfFigures.pure.ts` (which insets are
 * asked, and when), `figureRaster.pure.ts` (how one is made readable) and
 * `areaSchedulePicture.pure.ts` (what it must prove before it is believed).
 * This is the IO, and it runs in exactly one place: an import SUCCESSOR, an
 * isolate that restored a hand-off and never opened the PDF — the rule
 * `documentRead.pure.ts` records, that an isolate which parsed a document
 * decodes none of its pictures, holds here as everywhere.
 *
 * NOTHING IS PARSED TO FIND A PICTURE. The hand-off carries each inset as the
 * byte offsets of its raw stream in the document, and the digest of those
 * bytes; the successor holds the same document (its hand-off is bound to the
 * document's own digest), slices the stream out and proves it is the one that
 * was recorded before anything is decoded. A JPEG stream is the JPEG; raw
 * samples are wrapped losslessly, by the same `pictureFromStream` the
 * photographs go through.
 *
 * NEVER THROWS, AND NEVER GUESSES. Every figure that says nothing says why,
 * and recognition that cannot run is `unavailable` rather than a refusal —
 * because "the engine was not there" is a statement about this deployment and
 * never about the document.
 */
import { pictureFromStream } from './pdfSourcePhoto.ts';
import { decodeFullRaster } from './sourceImageRaster.ts';
import { encodePng, sha256Hex } from './rasterPng.ts';
import { prepareForRecognition } from './figureRaster.pure.ts';
import { readPictureSchedule } from './areaSchedulePicture.pure.ts';
import { recogniseFigures } from './ocr/recogniseScan.ts';
import type { FigureVerdict, PdfFigure } from './pdfFigures.pure.ts';

export interface FiguresRead {
  verdict: FigureVerdict;
  /** How many figures reached recognition. */
  recognised: number;
  ms: number;
}

/** Read the figures handed over, in order, and say what they came to. */
export async function readFigures(
  documentBytes: Uint8Array,
  figures: readonly PdfFigure[],
  options: { deadlineAt?: number } = {},
): Promise<FiguresRead> {
  const startedAt = Date.now();
  const reasons: string[] = figures.map(() => 'unread');
  const prepared: Array<{ index: number; png: Uint8Array }> = [];

  for (let index = 0; index < figures.length; index++) {
    const figure = figures[index];
    try {
      if (figure.start < 0 || figure.end > documentBytes.length || figure.end <= figure.start) {
        reasons[index] = 'out_of_bounds';
        continue;
      }
      // The same bytes the reading isolate recorded, or nothing is decoded.
      const raw = documentBytes.slice(figure.start, figure.end);
      if (await sha256Hex(raw) !== figure.sha256) {
        reasons[index] = 'not_the_recorded_bytes';
        continue;
      }
      const picture = await pictureFromStream(documentBytes, figure);
      if (!picture) { reasons[index] = 'not_a_picture'; continue; }
      const raster = await decodeFullRaster(picture.bytes);
      if (!raster) { reasons[index] = 'undecodable'; continue; }
      const ready = prepareForRecognition(raster, figure.drawn?.width ?? null);
      const png = await encodePng(ready.pixels, {
        width: ready.width, height: ready.height, components: 1,
      });
      if (!png) { reasons[index] = 'unencodable'; continue; }
      prepared.push({ index, png });
    } catch {
      reasons[index] = 'undecodable';
    }
  }

  const recognition = await recogniseFigures(prepared, { deadlineAt: options.deadlineAt });
  if (!recognition.available) {
    return {
      verdict: { state: 'unavailable', reason: 'recognition_unavailable' },
      recognised: 0,
      ms: Date.now() - startedAt,
    };
  }

  /*
   * EVERY FIGURE IS READ BEFORE ANY IS BELIEVED, because a document that
   * prints two schedules with two different totals has told us two things,
   * and the one read first is not the true one for being first.
   */
  const readings: Array<{ index: number; value: string; area: number; provedBy: Array<'squares' | 'parts'> }> = [];
  for (const { index } of prepared) {
    const text = recognition.text.get(index);
    if (text === undefined) { reasons[index] = 'unrecognised'; continue; }
    const result = readPictureSchedule(text);
    if (!result.reading) { reasons[index] = result.refusal ?? 'unproved'; continue; }
    reasons[index] = 'read';
    readings.push({ index, ...result.reading });
  }

  const ms = Date.now() - startedAt;
  if (!readings.length) {
    return { verdict: { state: 'refused', reasons }, recognised: recognition.text.size, ms };
  }
  if (new Set(readings.map((reading) => reading.area)).size > 1) {
    return {
      verdict: { state: 'refused', reasons: reasons.map((reason) => (reason === 'read' ? 'disagrees' : reason)) },
      recognised: recognition.text.size,
      ms,
    };
  }
  const first = readings[0];
  const provedBy = [...new Set(readings.flatMap((reading) => reading.provedBy))]
    .sort() as Array<'squares' | 'parts'>;
  return {
    verdict: {
      state: 'read',
      buildingSizeSqm: first.value,
      provedBy,
      page: figures[first.index].page,
    },
    recognised: recognition.text.size,
    ms,
  };
}
