import { describe, expect, it } from 'vitest';
import { scanStoredZip } from '../../../supabase/functions/_shared/builderStock/zipStream.pure';

/**
 * MEASURED 30 SEPTEMBER 2026. Dropbox serves a shared folder only as one zip —
 * 237 MB for Mairandi's, every entry stored — and ignores Range. The scanner
 * reads it as it arrives and keeps only what it is asked to.
 */
const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 255);
const text = (s: string) => new TextEncoder().encode(s);

function localHeader(name: string, opts: { descriptor?: boolean; size?: number; method?: number; zip64?: boolean }) {
  const nameBytes = text(name);
  const flags = opts.descriptor ? 8 : 0;
  return new Uint8Array([
    ...le(0x04034b50, 4), ...le(20, 2), ...le(flags, 2), ...le(opts.method ?? 0, 2), ...le(0, 4),
    ...le(0, 4), ...le(opts.descriptor ? 0 : (opts.size ?? 0), 4), ...le(opts.descriptor ? 0 : (opts.size ?? 0), 4),
    ...le(nameBytes.length, 2), ...le(0, 2), ...nameBytes,
  ]);
}
const descriptor = (size: number, zip64 = false) => new Uint8Array(zip64
  ? [...le(0x08074b50, 4), ...le(0, 4), ...le(size, 8), ...le(size, 8)]
  : [...le(0x08074b50, 4), ...le(0, 4), ...le(size, 4), ...le(size, 4)]);
const centralEnd = () => new Uint8Array([...le(0x02014b50, 4), ...new Array(42).fill(0)]);

function build(parts: Array<{ name: string; data?: Uint8Array; descriptor?: boolean; zip64?: boolean }>) {
  const out: Uint8Array[] = [];
  for (const part of parts) {
    const dir = part.name.endsWith('/');
    const data = part.data ?? new Uint8Array(0);
    out.push(localHeader(part.name, { descriptor: part.descriptor && !dir, size: data.length }));
    out.push(data);
    if (part.descriptor && !dir) out.push(descriptor(data.length, part.zip64));
  }
  out.push(centralEnd());
  const all = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of out) { all.set(c, at); at += c.length; }
  return all;
}

async function* chunked(bytes: Uint8Array, size: number) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

const options = (want: (n: string) => boolean) => ({
  want, maxEntryBytes: 1024 * 1024, maxKeptBytes: 4 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
});

// A "picture" that contains the descriptor signature and near-matching sizes in its own bytes.
const tricky = new Uint8Array([
  1, 2, 3, ...le(0x08074b50, 4), ...le(0, 4), ...le(7, 4), ...le(7, 4), 9, 9, 9, 9, 9,
]);
const photo = new Uint8Array(3000).map((_, i) => (i * 13 + 5) & 255);

describe('scanStoredZip', () => {
  const zip = build([
    { name: 'lot 5/' },
    { name: 'lot 5/facade.jpg', data: photo, descriptor: true },
    { name: 'lot 5/notes.txt', data: text('hello world') },
    { name: 'lot 6/other.jpg', data: photo, descriptor: true, zip64: true },
    { name: 'lot 6/tricky.bin', data: tricky, descriptor: true },
    { name: 'lot 6/big.pdf', data: new Uint8Array(2 * 1024 * 1024), descriptor: true },
  ]);

  for (const size of [1, 7, 64, 4096, zip.length]) {
    it(`finds every entry and keeps only what was asked for (chunks of ${size})`, async () => {
      const scan = await scanStoredZip(chunked(zip, size), options((n) => n.startsWith('lot 5/') || n.endsWith('tricky.bin') || n.endsWith('big.pdf')));
      expect(scan.ok).toBe(true);
      const byName = new Map(scan.entries.map((e) => [e.name, e]));
      expect([...byName.keys()]).toEqual([
        'lot 5/', 'lot 5/facade.jpg', 'lot 5/notes.txt', 'lot 6/other.jpg', 'lot 6/tricky.bin', 'lot 6/big.pdf',
      ]);
      expect(byName.get('lot 5/')!.isDirectory).toBe(true);
      expect([...byName.get('lot 5/facade.jpg')!.data!]).toEqual([...photo]);
      expect(byName.get('lot 5/facade.jpg')!.size).toBe(photo.length);
      expect(new TextDecoder().decode(byName.get('lot 5/notes.txt')!.data!)).toBe('hello world');
      // Not asked for: sized, never kept (this one carries a zip64 descriptor).
      expect(byName.get('lot 6/other.jpg')!.data).toBeUndefined();
      expect(byName.get('lot 6/other.jpg')!.size).toBe(photo.length);
      // The signature inside a picture is not the end of the picture.
      expect([...byName.get('lot 6/tricky.bin')!.data!]).toEqual([...tricky]);
      // Wanted but over the per-entry budget: named, sized, not kept.
      expect(byName.get('lot 6/big.pdf')!.tooLarge).toBe(true);
      expect(byName.get('lot 6/big.pdf')!.data).toBeUndefined();
      expect(byName.get('lot 6/big.pdf')!.size).toBe(2 * 1024 * 1024);
    });
  }

  it('says so when it is not a zip, is cut short, or is too big', async () => {
    const notZip = await scanStoredZip(chunked(text('<html>a page</html>'), 5), options(() => true));
    expect(notZip).toMatchObject({ ok: false, reason: 'not_a_zip' });
    const cut = await scanStoredZip(chunked(zip.subarray(0, 4000), 512), options(() => false));
    expect(cut).toMatchObject({ ok: false, reason: 'truncated' });
    const big = await scanStoredZip(chunked(zip, 512), { ...options(() => false), maxTotalBytes: 1000 });
    expect(big).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('refuses a deflated entry whose size it cannot know', async () => {
    const out = build([{ name: 'a.txt', data: text('x'), descriptor: true }]);
    out[8] = 8; // method: deflate
    const scan = await scanStoredZip(chunked(out, 64), options(() => false));
    expect(scan).toMatchObject({ ok: false, reason: 'unsupported' });
  });
});

describe('a Dropbox shared folder, read through the package reader', () => {
  const FOLDER = 'https://www.dropbox.com/scl/fo/abc123/AAkey?rlkey=k&st=s&dl=0';
  const jpeg = (seed: number) => new Uint8Array(4000).map((_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : (i * seed + 3) & 255));

  async function recover(label: string, hints: string[], parts: Parameters<typeof build>[0]) {
    const { recoverPackageImage } = await import('../../../supabase/functions/_shared/builderStock/packageImages');
    const zip = build(parts);
    return await recoverPackageImage(
      { packageUrl: FOLDER, label, identityHints: hints, linkSharedWithOtherRows: false },
      { streamFolder: () => chunked(zip, 1500) });
  }

  const folder = [
    { name: 'Lot 1639 Foo Street Sunbury Redstone/' },
    { name: 'Lot 1639 Foo Street Sunbury Redstone/Facade 01.jpg', data: jpeg(7), descriptor: true },
    { name: 'Lot 1639 Foo Street Sunbury Redstone/Aerial Photo.jpg', data: jpeg(9), descriptor: true },
    { name: 'Lot 1640 Bar Street Sunbury Redstone/' },
    { name: 'Lot 1640 Bar Street Sunbury Redstone/Facade 01.jpg', data: jpeg(11), descriptor: true },
    { name: 'Lot 16390 Baz Street Sunbury Redstone/Facade 01.jpg', data: jpeg(13), descriptor: true },
  ];

  it('takes the facade filed under the lot, and never another lot’s', async () => {
    const outcome = await recover('Lot 1639 Sunbury VIC · Alba 28 Display Home', ['Redstone Estate Sunbury VIC'], folder);
    expect(outcome.status).toBe('recovered_photograph');
    if (outcome.status !== 'recovered_photograph') return;
    expect([...outcome.photograph.bytes]).toEqual([...jpeg(7)]);
    expect(outcome.photograph.contentType).toBe('image/jpeg');
    expect(outcome.photograph.fileName).toBe('Facade 01.jpg');
    expect(outcome.photograph.folderPath).toEqual(['Lot 1639 Foo Street Sunbury Redstone']);
    expect(outcome.photograph.role.evidenceLevel).toBe(3);
  });

  it('declines when two folders name the property, rather than choosing', async () => {
    const outcome = await recover('Lot 1639 Sunbury VIC · Alba 28', [], [
      ...folder,
      { name: 'Lot 1639 Another Estate Sunbury/Facade.jpg', data: jpeg(5), descriptor: true },
    ]);
    expect(outcome.status).toBe('not_identified');
  });

  it('never takes a picture that calls itself an aerial or a plan', async () => {
    const outcome = await recover('Lot 1639 Sunbury VIC · Alba 28', [], [
      { name: 'Lot 1639 Foo Street/Aerial Photo.jpg', data: jpeg(3), descriptor: true },
      { name: 'Lot 1639 Foo Street/Site Plan.png', data: jpeg(4), descriptor: true },
    ]);
    expect(outcome.status).toBe('not_identified');
  });

  it('finds a display home with no lot by its design AND its estate together', async () => {
    const parts = [
      { name: 'Lot 4522 Mira 22 Monarch Estate Deanside/Facade.jpg', data: jpeg(17), descriptor: true },
      { name: 'Lot 4600 Mira 22 Other Estate Truganina/Facade.jpg', data: jpeg(19), descriptor: true },
    ];
    const outcome = await recover('Deanside VIC · Mira 22 Display Home', ['Monarch Estate Deanside VIC'], parts);
    expect(outcome.status).toBe('recovered_photograph');
    if (outcome.status === 'recovered_photograph') expect([...outcome.photograph.bytes]).toEqual([...jpeg(17)]);
    // The design alone, with no estate to corroborate it, names nothing.
    const alone = await recover('Deanside VIC · Mira 22 Display Home', [], parts);
    expect(alone.status).toBe('not_identified');
  });

  it('says a page that is not a zip is not a folder we can read', async () => {
    const { recoverPackageImage } = await import('../../../supabase/functions/_shared/builderStock/packageImages');
    const outcome = await recoverPackageImage(
      { packageUrl: FOLDER, label: 'Lot 1 X VIC', linkSharedWithOtherRows: false },
      { streamFolder: () => chunked(text('<html>a viewer</html>'), 8) });
    expect(outcome.status).toBe('not_identified');
  });
});
