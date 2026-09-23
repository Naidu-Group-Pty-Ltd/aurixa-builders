/**
 * BUILDER STOCK — READING TRACE: what a page shows beyond its text layer.
 *
 * Split from `stock-reading-trace.ts` so it can be run against a local file as
 * well as a stored one; see that script for the contract it runs under.
 */

const n1 = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : '?').padStart(6);
const quote = (text: string) => JSON.stringify(text);

/**
 * ===========================================================================
 * WHAT A PAGE SHOWS THAT ITS TEXT LAYER DOES NOT CARRY.
 * ===========================================================================
 *
 * MEASURED 23 SEPTEMBER 2026 on `Lot 101 - PICO - BROCHURE v002.pdf`: its
 * text layer, across all six pages, states no street, no suburb, no lot size
 * and no build size, while the builder reports that the page shows them — and
 * page 1's positioned runs are empty exactly where the same builder's other
 * template prints `Lot Size` and the house's schedule. A page can show text
 * that `getTextContent` never returns in three ways, and each needs a
 * different reader, so this names which one a document uses before anything
 * is built for it:
 *
 *   annotations      every annotation pdf.js reports, whatever its subtype —
 *                    the product reads only visible form-field WIDGETS, and a
 *                    brochure filled with a typewriter or Fill & Sign tool
 *                    carries FreeText annotations instead;
 *   operators        a census of what the page's content stream draws: text,
 *                    paths and pictures — text converted to outlines is paths;
 *   rendered + OCR   the page as a viewer draws it (poppler, annotations
 *                    included), recognised by the Tesseract CLI, line by line
 *                    with its position — what a person looking at the page
 *                    reads, whatever form the document stores it in.
 *
 * READ-ONLY, like everything here. The bytes reach the two command-line tools
 * through pipes and are never written to disk. A runner without them says so
 * and the rest of the trace is unaffected.
 */
export async function traceWhatTheTextLayerCannotSee(
  bytes: Uint8Array,
  pages: ReadonlySet<number>,
): Promise<void> {
  let reader: Record<string, unknown>;
  try {
    reader = await import('https://esm.sh/unpdf@0.12.1') as Record<string, unknown>;
  } catch (error) {
    console.log(`\n  --- beyond the text layer: pdf reader unavailable (${String(error).slice(0, 120)})`);
    return;
  }
  // deno-lint-ignore no-explicit-any
  const unpdf = reader as any;
  // deno-lint-ignore no-explicit-any
  let pdfjs: any = null;
  try { pdfjs = await unpdf.getResolvedPDFJS(); } catch { /* the census names its ops by number */ }
  const opName = new Map<number, string>();
  for (const [name, code] of Object.entries(pdfjs?.OPS ?? {})) opName.set(Number(code), name);
  // deno-lint-ignore no-explicit-any
  let pdf: any;
  try {
    pdf = await unpdf.getDocumentProxy(bytes.slice());
  } catch (error) {
    console.log(`\n  --- beyond the text layer: document unreadable (${String(error).slice(0, 120)})`);
    return;
  }
  for (const pageNumber of [...pages].sort((a, b) => a - b)) {
    if (pageNumber > (pdf.numPages ?? 0)) continue;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport?.({ scale: 1 });
    console.log(`\n  --- page ${pageNumber} · beyond the text layer`
      + (viewport ? ` · page ${n1(viewport.width).trim()} x ${n1(viewport.height).trim()} pt` : ''));

    // Annotations, every subtype.
    try {
      const annotations = await page.getAnnotations();
      console.log(`    annotations: ${Array.isArray(annotations) ? annotations.length : 0}`);
      for (const annotation of Array.isArray(annotations) ? annotations : []) {
        const rect = Array.isArray(annotation?.rect)
          ? annotation.rect.map((v: number) => Number(v).toFixed(1)).join(',') : '?';
        const text = Array.isArray(annotation?.textContent)
          ? annotation.textContent.join(' / ') : '';
        console.log(`      ${String(annotation?.subtype ?? '?')}`
          + `${annotation?.it ? ` it=${annotation.it}` : ''}`
          + `${annotation?.fieldType ? ` field=${annotation.fieldType}` : ''}`
          + `${annotation?.fieldName ? ` name=${quote(String(annotation.fieldName))}` : ''}`
          + `${annotation?.hidden ? ' HIDDEN' : ''}${annotation?.noView ? ' NOVIEW' : ''}`
          + ` rect=[${rect}]`
          + `${annotation?.fieldValue !== undefined ? ` value=${quote(String(annotation.fieldValue))}` : ''}`
          + `${annotation?.contentsObj?.str ? ` contents=${quote(String(annotation.contentsObj.str))}` : ''}`
          + `${text ? ` shows=${quote(text)}` : ''}`);
      }
    } catch (error) {
      console.log(`    annotations: unreadable (${String(error).slice(0, 120)})`);
    }

    // Operator census, and where each picture is painted.
    try {
      const list = await page.getOperatorList();
      const counts = new Map<string, number>();
      for (const fn of list.fnArray as number[]) {
        const name = opName.get(fn) ?? `op${fn}`;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      /*
       * THE PICTURES, WHERE THEY ARE DRAWN AND WHAT THEY SAY. The transform
       * is followed through save, restore, transform and form XObjects, so a
       * picture's box is the one a viewer draws it in; each is then decoded
       * by pdf.js and recognised on its own, which names which picture holds
       * which words.
       */
      const multiply = (m: number[], n: number[]) => [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
      ];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack: number[][] = [];
      const OPS = pdfjs?.OPS ?? {};
      let pictureIndex = 0;
      for (let at = 0; at < list.fnArray.length; at++) {
        const fn = list.fnArray[at];
        const args = list.argsArray[at];
        if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(ctm);
        if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
        if (fn === OPS.transform && Array.isArray(args)) ctm = multiply(ctm, args as number[]);
        if (fn === OPS.paintFormXObjectBegin && Array.isArray(args?.[0])) {
          ctm = multiply(ctm, args[0] as number[]);
        }
        if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject) continue;
        pictureIndex++;
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
          [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const box = `x ${n1(Math.min(...xs)).trim()}-${n1(Math.max(...xs)).trim()}`
          + ` y ${n1(Math.min(...ys)).trim()}-${n1(Math.max(...ys)).trim()}`;
        // deno-lint-ignore no-explicit-any
        let image: any = null;
        if (fn === OPS.paintImageXObject && typeof args?.[0] === 'string') {
          try {
            image = page.objs.has(args[0]) ? page.objs.get(args[0])
              : (page.commonObjs.has(args[0]) ? page.commonObjs.get(args[0]) : null);
          } catch { image = null; }
        } else if (fn === OPS.paintInlineImageXObject) {
          image = args?.[0] ?? null;
        }
        const size = image ? `${image.width}x${image.height} kind ${image.kind}` : 'undecoded';
        console.log(`    picture ${pictureIndex}: ${fn === OPS.paintInlineImageXObject ? 'inline' : String(args?.[0])}`
          + ` · ${size} · drawn ${box} (points from the bottom-left)`);
        const pnm = image?.data && image.width && image.height ? toPnm(image) : null;
        if (!pnm) continue;
        const said = await pipeThrough('tesseract', ['stdin', 'stdout', '--psm', '6'], pnm);
        const text = said ? new TextDecoder().decode(said).split('\n').map((l) => l.trim())
          .filter(Boolean) : [];
        console.log(`      says: ${text.length ? text.map(quote).join(' / ') : '(nothing recognised)'}`);
      }
      const interesting = ['showText', 'showSpacedText', 'nextLineShowText',
        'nextLineSetSpacingShowText', 'setFont', 'constructPath', 'fill', 'eoFill',
        'fillStroke', 'eoFillStroke', 'stroke', 'paintImageXObject', 'paintInlineImageXObject',
        'paintImageMaskXObject', 'paintFormXObjectBegin', 'beginMarkedContent',
        'beginMarkedContentProps', 'setTextRenderingMode'];
      console.log(`    operators: ${list.fnArray.length} · `
        + interesting.filter((name) => counts.has(name))
          .map((name) => `${name} ${counts.get(name)}`).join(' · '));
    } catch (error) {
      console.log(`    operators: unreadable (${String(error).slice(0, 120)})`);
    }

    // Rendered, and read the way a person reads it. No output root: a root of
    // `-` is a FILE named `-` to poppler, and only an absent one means stdout.
    const png = await pipeThrough('pdftoppm',
      ['-r', '150', '-f', String(pageNumber), '-l', String(pageNumber), '-png', '-'], bytes);
    if (!png) {
      console.log('    rendered + OCR: pdftoppm unavailable or failed on this page');
      continue;
    }
    const tsv = await pipeThrough('tesseract', ['stdin', 'stdout', '--psm', '3', 'tsv'], png);
    if (!tsv) {
      console.log('    rendered + OCR: tesseract unavailable or failed on this page');
      continue;
    }
    const lines = new Map<string, { top: number; left: number; words: string[]; conf: number[] }>();
    for (const row of new TextDecoder().decode(tsv).split('\n').slice(1)) {
      const cells = row.split('\t');
      if (cells.length < 12 || cells[0] !== '5') continue;
      const word = cells[11].trim();
      const conf = Number(cells[10]);
      if (!word) continue;
      const key = `${cells[2]}.${cells[3]}.${cells[4]}`;
      const line = lines.get(key)
        ?? { top: Number(cells[7]), left: Number(cells[6]), words: [], conf: [] };
      line.top = Math.min(line.top, Number(cells[7]));
      line.left = Math.min(line.left, Number(cells[6]));
      line.words.push(word);
      line.conf.push(conf);
      lines.set(key, line);
    }
    // 150 dpi: a point is 150/72 pixels. Printed in points from the TOP, so a
    // line reads against the positioned runs above by subtracting from the height.
    const toPt = (px: number) => px * 72 / 150;
    console.log(`    rendered + OCR (150 dpi, positions in points from the top-left):`);
    [...lines.values()].sort((a, b) => a.top - b.top || a.left - b.left).forEach((line) => {
      const mean = line.conf.reduce((sum, value) => sum + value, 0) / line.conf.length;
      console.log(`      top${n1(toPt(line.top))} left${n1(toPt(line.left))} conf${n1(mean)}  ${quote(line.words.join(' '))}`);
    });
  }
}

/**
 * A decoded picture as a PNM, which Tesseract reads without an encoder.
 * pdf.js hands back 1-bit (kind 1), RGB (kind 2) or RGBA (kind 3) pixels.
 */
// deno-lint-ignore no-explicit-any
function toPnm(image: any): Uint8Array | null {
  const { width, height, kind, data } = image as {
    width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray;
  };
  const header = (magic: string) => new TextEncoder().encode(`${magic}\n${width} ${height}\n255\n`);
  const rgb = new Uint8Array(width * height * 3);
  if (kind === 2 && data.length >= width * height * 3) {
    rgb.set(data.subarray(0, width * height * 3));
  } else if (kind === 3 && data.length >= width * height * 4) {
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      // Composite over white, so transparent text reads as it is drawn.
      const alpha = data[j + 3] / 255;
      rgb[i * 3] = data[j] * alpha + 255 * (1 - alpha);
      rgb[i * 3 + 1] = data[j + 1] * alpha + 255 * (1 - alpha);
      rgb[i * 3 + 2] = data[j + 2] * alpha + 255 * (1 - alpha);
    }
  } else if (kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const value = bit ? 255 : 0;
        rgb.set([value, value, value], (y * width + x) * 3);
      }
    }
  } else {
    return null;
  }
  const head = header('P6');
  const out = new Uint8Array(head.length + rgb.length);
  out.set(head);
  out.set(rgb, head.length);
  return out;
}

/** Run a command with `input` on its stdin; its stdout, or null. Nothing touches disk. */
async function pipeThrough(command: string, args: string[], input: Uint8Array): Promise<Uint8Array | null> {
  try {
    const child = new Deno.Command(command, {
      args, stdin: 'piped', stdout: 'piped', stderr: 'null',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
    const { code, stdout } = await child.output();
    return code === 0 && stdout.byteLength ? stdout : null;
  } catch {
    return null;
  }
}

