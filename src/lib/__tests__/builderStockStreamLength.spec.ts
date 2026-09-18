/**
 * ONE BYTE, AND THE TWO RUNTIMES DISAGREED ABOUT A BUILDER'S BROCHURE.
 *
 * THE DEFECT THIS PINS, measured 18 September 2026 on the first property
 * recovered through the corrected pipeline — Lot 801, Harlow, the live
 * brochure Drive serves as 7,203,619 bytes.
 *
 * `streamSlice` located a stream's end by finding `endstream` and then
 * walking backwards over every trailing `\n`/`\r` to undo the writer's
 * end-of-line marker. The marker is real — PDF 32000-1 §7.3.8.1 puts an EOL
 * between the data and `endstream` — but a Flate stream is BINARY, so its own
 * final byte is 0x0a or 0x0d about twice in every 256 streams and the walk
 * cannot tell the two apart. That document's object stream at byte 2440
 * declares `/Length 93`, its last compressed byte IS 0x0a, and 92 bytes were
 * handed to inflate.
 *
 * WHY ONE BYTE WAS NOT COSMETIC. Deno's `DecompressionStream` returns what it
 * decoded before the truncation — all 134 bytes. workerd's refuses the stream
 * outright (`Called close() on a decompression stream with incomplete data`).
 * So the SAME document, read by the SAME code, answered differently on the
 * two runtimes this election runs on — and production runs it on the worker:
 *
 *                                recovered objects   page order   election
 *   Deno (Supabase edge)               216           authoritative  recovered
 *   workerd (Cloudflare worker)        214           NOT            not_identified
 *
 * The two objects lost were 288 and 289, and object 288 is
 * `<</Count 6/Kids[289 0 R 763 0 R]/Type/Pages>>` — the document's own page
 * tree root, which is what `pageOrderIsAuthoritative` resolves the catalogue's
 * `/Pages` to. Without it no page may be read as a cover, so the property's
 * correctly decoded facade came back `role: unknown` and the election banked
 * `not_identified`: the builder's brochure recorded, permanently, as naming no
 * image for their property.
 *
 * The 93 bytes below are that stream, verbatim.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { objectStreamSlices, parseObjectStream }
  from '../../../supabase/functions/_shared/builderStock/pdfPageImages.pure';
import { recoverCompressedObjects }
  from '../../../supabase/functions/_shared/builderStock/pdfSourcePhoto';

const SHARED = 'supabase/functions/_shared/builderStock';
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The live Lot 801 object stream: `/Length 93`, final compressed byte 0x0a. */
const STREAM = Uint8Array.from(Buffer.from(
  'aN4ysrBQMFAwsrBUMDFVsLHRd84vzStRMNP3zkwpjgYJGygEKZibGYPoWP2QyoJU/YDE9NRiOzu4YhOoYksTqGIDKG0IpY0gmgMSi1KByo3ANgahmAUQYAADuiMK',
  'base64'));

/** What it inflates to, and the object every reader of this document needs. */
const PAGE_TREE_ROOT = '<</Count 6/Kids[289 0 R 763 0 R]/Type/Pages>>';

/**
 * The smallest document that carries that stream the way the real one does:
 * a `/Type/ObjStm` dictionary, the bytes, then the `\r\n` EOL and `endstream`.
 */
function documentAround(
  stream: Uint8Array,
  declaredLength: number | string = stream.length,
): Uint8Array {
  const head = `%PDF-1.7\n22587 0 obj\n<</Filter/FlateDecode/First 13`
    + `/Length ${declaredLength}/N 2/Type/ObjStm>>stream\n`;
  const tail = '\r\nendstream\nendobj\ntrailer<<>>\n%%EOF\n';
  const out = new Uint8Array(head.length + stream.length + tail.length);
  out.set(Uint8Array.from(Buffer.from(head, 'latin1')), 0);
  out.set(stream, head.length);
  out.set(Uint8Array.from(Buffer.from(tail, 'latin1')), head.length + stream.length);
  return out;
}

describe('a stream is sliced by the length it declares, never by trimming newlines', () => {
  it('keeps a final 0x0a that is compressed data rather than the EOL marker', () => {
    expect(STREAM[STREAM.length - 1]).toBe(0x0a);

    const [slice] = objectStreamSlices(documentAround(STREAM));
    expect(slice).toBeTruthy();
    // 93, not the 92 the newline walk produced. This is the whole defect.
    expect(slice.end - slice.start).toBe(STREAM.length);
  });

  it('hands the whole stream to inflate, so the page tree survives', async () => {
    const recovered = await recoverCompressedObjects(documentAround(STREAM));
    expect(recovered.unreadStreams).toBe(0);
    expect(recovered.objects.get(288)).toBe(PAGE_TREE_ROOT);
    expect(recovered.objects.has(289)).toBe(true);
  });

  it('still trims the EOL where the data does not end in one', async () => {
    // The ordinary case — ~99% of streams — must be byte-identical to before.
    const plain = STREAM.slice(0, STREAM.length - 1);
    const [slice] = objectStreamSlices(documentAround(plain));
    expect(slice.end - slice.start).toBe(plain.length);
  });

  it('falls back to the scan where `/Length` disagrees with the document', () => {
    // A damaged dictionary is not an instruction. `/Length 9999` cannot be
    // reconciled with where `endstream` actually is, so the scan decides
    // exactly as it always did — and the walk's 92 bytes are what it gives.
    const [slice] = objectStreamSlices(documentAround(STREAM, 9999));
    expect(slice.end - slice.start).toBe(STREAM.length - 1);
  });

  it('never reads an indirect `/Length 12 0 R` as a length of twelve', () => {
    const [slice] = objectStreamSlices(documentAround(STREAM, '12 0 R'));
    // Indirect: no number to trust, so the scan decides. Never 12.
    expect(slice.end - slice.start).not.toBe(12);
    expect(slice.end - slice.start).toBe(STREAM.length - 1);
  });
});

describe('a stream we could not read is counted, never swallowed', () => {
  it('reports the object streams that failed to inflate', async () => {
    const damaged = Uint8Array.from(Buffer.from('x'.repeat(40), 'latin1'));
    const recovered = await recoverCompressedObjects(documentAround(damaged));
    expect(recovered.unreadStreams).toBe(1);
    // And it still contributes nothing rather than failing the document.
    expect(recovered.objects.size).toBe(0);
  });

  it('reports none where every stream was read', async () => {
    const recovered = await recoverCompressedObjects(documentAround(STREAM));
    expect(recovered.unreadStreams).toBe(0);
  });
});

/**
 * THE OTHER HALF, AND THE ONE THAT HAS TO SURVIVE THE NEXT DAMAGED DOCUMENT.
 *
 * The slice fix makes that one brochure read on both runtimes. It does not
 * make every future document read. When a page tree cannot be reached because
 * a stream of ours went unread, the missing page order is a fact about OUR
 * reading, and banking `not_identified` on it says the builder supplied
 * nothing — the same class of error as the two this incident already cost.
 */
describe('a page tree we could not decompress is never a document verdict', () => {
  const election = read(`${SHARED}/pdfElection.ts`)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('answers `unreachable` where page order failed on a stream we could not read', () => {
    const guard = 'selection.coverPages.length\n      && !selection.pageOrderAuthoritative\n'
      + '      && selection.objectStreamsUnread > 0';
    expect(election).toContain(guard);
    expect(election.slice(election.indexOf(guard), election.indexOf(guard) + 260))
      .toContain("status: 'unreachable'");
  });

  it('keeps the verdict for a document whose every stream WAS read', () => {
    // `objectStreamsUnread > 0` is the whole condition: a catalogue that names
    // no page tree, with nothing unread, is the document speaking and stays
    // banked. Asserted as the shape of the guard rather than its absence.
    expect(election).toContain('selection.objectStreamsUnread > 0');
    expect(election).toContain("status: 'not_identified'");
  });

  it('the selection carries the count, so the election is not guessing', () => {
    const photo = read(`${SHARED}/pdfSourcePhoto.ts`);
    expect(photo).toContain('objectStreamsUnread: number');
    expect(photo).toContain('objectStreamsUnread: found.objectStreamsUnread');
    expect(photo).toContain('objectStreamsUnread: recovered.unreadStreams');
  });
});
