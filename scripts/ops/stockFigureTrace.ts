/**
 * BUILDER STOCK — READING TRACE: THE FIGURES A PAGE PRINTS ONLY AS PICTURES.
 *
 * Part of `stock-reading-trace.ts`, and read-only like it. It runs the
 * product's own path for a picture that may state a figure the text does not
 * (`pdfFigures.pure.ts`) over the stored bytes, and prints each step, so a
 * question about a real brochure is answered by the real brochure rather than
 * by a reconstruction of it:
 *
 *   the insets discovery noted    `discoverPdfSourceAssets` → `figures`
 *   which the import would read   `figuresToRead`, from the reading's own rows,
 *                                 price pages and disputes
 *   what recognition read         each chosen inset, sliced, proved against its
 *                                 digest, made readable (`figureRaster.pure.ts`)
 *                                 and recognised by the product's engine — the
 *                                 text printed, and what the schedule reader
 *                                 made of it
 *   the verdict                   `readFigures`, exactly as the successor calls it
 *
 * WRITES NOTHING, and the document's bytes and pixels never leave the process:
 * only recognised text, words and numbers are printed.
 */
import { discoverPdfSourceAssets, pictureFromStream } from '../../supabase/functions/_shared/builderStock/pdfSourcePhoto.ts';
import { figuresToRead } from '../../supabase/functions/_shared/builderStock/pdfFigures.pure.ts';
import { decodeFullRaster } from '../../supabase/functions/_shared/builderStock/sourceImageRaster.ts';
import { prepareForRecognition } from '../../supabase/functions/_shared/builderStock/figureRaster.pure.ts';
import { encodePng } from '../../supabase/functions/_shared/builderStock/rasterPng.ts';
import { recogniseFigures } from '../../supabase/functions/_shared/builderStock/ocr/recogniseScan.ts';
import { readPictureSchedule } from '../../supabase/functions/_shared/builderStock/areaSchedulePicture.pure.ts';
import { readFigures } from '../../supabase/functions/_shared/builderStock/readFigures.ts';

/**
 * The product's language model and engine, from this checkout, where the
 * recogniser looks for an already-fetched copy first (`languageData.ts`,
 * `ocr/engine.ts`). The deploy ships these same files to the project's
 * storage, so they are what production reads with — and the engine checks
 * the engine's digest either way.
 */
async function provideLanguageModel(): Promise<void> {
  for (const [dir, file] of [['/tmp/ocr-lang', 'eng.traineddata.gz'], ['/tmp/ocr-engine', 'tesseract-core-simd-lstm.wasm']]) {
    const target = `${dir}/${file}`;
    if (await Deno.stat(target).then((s) => s.isFile).catch(() => false)) continue;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.copyFile(new URL(`../../assets/ocr/${file}`, import.meta.url), target);
  }
}

export async function traceFigures(
  bytes: Uint8Array,
  reading: { rows: Array<Record<string, unknown>>; diagnostics: { pricePages?: number[]; disputedFields?: string[] } },
): Promise<void> {
  console.log('\n  --- figures a page prints only as pictures');
  try {
    await provideLanguageModel();
    const found = await discoverPdfSourceAssets(bytes);
    console.log(`    insets noted: ${found.figures.length}`);
    for (const figure of found.figures) {
      console.log(`      page ${figure.page} · ${figure.width}x${figure.height} · ${figure.flate ? 'flate' : 'dct'}`
        + ` · drawn ${figure.drawn ? `${figure.drawn.width.toFixed(1)}x${figure.drawn.height.toFixed(1)}pt` : '?'}`
        + ` · object ${figure.objectNumber}`);
    }
    const chosen = figuresToRead({
      figures: found.figures,
      rows: reading.rows,
      pricePages: reading.diagnostics.pricePages ?? [],
      disputedFields: reading.diagnostics.disputedFields ?? [],
    });
    console.log(`    price pages ${JSON.stringify(reading.diagnostics.pricePages ?? [])} · rows ${reading.rows.length}`
      + ` · building size stated ${reading.rows.length === 1 && reading.rows[0].building_size_sqm != null}`
      + ` · chosen ${chosen.length}`);

    // Each step, so a refusal can be traced to the step that made it.
    for (const [index, figure] of chosen.entries()) {
      const picture = await pictureFromStream(bytes, figure);
      const raster = picture ? await decodeFullRaster(picture.bytes) : null;
      if (!raster) { console.log(`    [${index}] undecodable`); continue; }
      const ready = prepareForRecognition(raster, figure.drawn?.width ?? null);
      const png = await encodePng(ready.pixels, { width: ready.width, height: ready.height, components: 1 });
      if (!png) { console.log(`    [${index}] unencodable`); continue; }
      const recognised = await recogniseFigures([{ index, png }]);
      const text = recognised.text.get(index) ?? '';
      const result = readPictureSchedule(text);
      console.log(`    [${index}] ${raster.width}x${raster.height} enlarged x${ready.scale.toFixed(2)}`
        + ` to ${ready.width}x${ready.height} · recognition ${recognised.available ? `${recognised.ms} ms` : 'UNAVAILABLE'}`);
      for (const line of text.split('\n').filter((l) => l.trim())) console.log(`        | ${line}`);
      console.log(`        rows ${JSON.stringify(result.rows.map((row) => [row.label, row.written, row.squares]))}`);
      console.log(`        ${result.reading ? `READ ${result.reading.value} proved by ${result.reading.provedBy.join('+')}` : `refused: ${result.refusal}`}`);
    }

    const verdict = await readFigures(bytes, chosen);
    console.log(`    verdict ${JSON.stringify(verdict.verdict)} · recognised ${verdict.recognised} · ${verdict.ms} ms`);
  } catch (error) {
    console.log(`    figure trace failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }
}
