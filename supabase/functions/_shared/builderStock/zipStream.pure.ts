/**
 * BUILDER STOCK — READ A STORED ZIP AS IT ARRIVES, KEEPING ONLY WHAT IS WANTED.
 *
 * WHY THIS EXISTS. A Dropbox shared FOLDER has no address for a file inside it
 * that a logged-out client can use: the folder page is a script-rendered shell
 * (its 235 KB carries none of the 69 names it lists), a path under the link
 * answers the same shell, and the host ignores `Range`. The one thing it will
 * hand over is the whole folder as a zip — measured 30 September 2026 at
 * 237 MB for Mairandi's, in 3.5 to 7 seconds, every entry STORED (method 0).
 *
 * That is too big to hold and small enough to read once. So the zip is read as
 * a stream: each entry's local header names it before its bytes arrive, the
 * caller says whether it wants those bytes, and everything else is counted and
 * dropped. Memory is bounded by what was asked to be kept, never by the folder.
 *
 * WHAT IT WILL NOT DO. It reads STORED entries only — a deflated entry whose
 * size is unknown up front cannot be skipped without inflating it, and
 * inflating 237 MB is exactly the CPU spend this repository has been killed by.
 * Such a zip answers `unsupported` and the caller reports that, rather than
 * guessing.
 *
 * ENTRY END. An entry states its size in its local header, or (flag bit 3) in a
 * data descriptor AFTER the data. For the second kind the end is found by
 * looking for a descriptor whose stated size equals the number of bytes seen
 * since the data began — a signature match alone is not trusted, because a
 * picture's bytes can contain the four signature bytes. Both the 32-bit and
 * the zip64 descriptor are accepted.
 *
 * Pure: no IO of its own — it consumes any async iterable of chunks.
 */

export interface ZipEntry {
  /** The entry's full path inside the zip, `/`-separated. */
  name: string;
  isDirectory: boolean;
  /** Bytes of data. */
  size: number;
  /** Present only where `want` asked for the bytes and they fitted the budget. */
  data?: Uint8Array;
  /** Wanted, but larger than what the budget allows to keep. */
  tooLarge?: boolean;
}

export type ZipScan =
  | { ok: true; entries: ZipEntry[]; bytesRead: number }
  | { ok: false; reason: 'not_a_zip' | 'unsupported' | 'truncated' | 'too_large'; entries: ZipEntry[]; bytesRead: number };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_END = 0x06064b50;

export interface ScanOptions {
  /** Decide from the entry's path whether its bytes are wanted. */
  want: (name: string) => boolean;
  /** The most bytes any one kept entry may hold. */
  maxEntryBytes: number;
  /** The most bytes all kept entries together may hold. */
  maxKeptBytes: number;
  /** Refuse a zip that reads past this many bytes. */
  maxTotalBytes: number;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 2 ** 32;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Where a data descriptor for `consumed` bytes of data begins in `buffer`, and how long it is. */
function findDescriptor(
  buffer: Uint8Array,
  consumedBefore: number,
): { at: number; length: number; size: number } | null {
  let from = 0;
  for (;;) {
    const i = buffer.indexOf(0x50, from);
    if (i < 0 || i + 4 > buffer.length) return null;
    from = i + 1;
    if (!(buffer[i + 1] === 0x4b && buffer[i + 2] === 0x07 && buffer[i + 3] === 0x08)) continue;
    const size = consumedBefore + i;
    // 32-bit: sig, crc, csize, usize.
    if (i + 16 <= buffer.length && u32(buffer, i + 8) === size && u32(buffer, i + 12) === size) {
      return { at: i, length: 16, size };
    }
    // zip64: sig, crc, csize(8), usize(8).
    if (i + 24 <= buffer.length && u64(buffer, i + 8) === size && u64(buffer, i + 16) === size) {
      return { at: i, length: 24, size };
    }
    // A signature whose sizes do not agree is data. Keep looking — but if the
    // buffer ends before the sizes could be read, wait for more bytes.
    if (i + 24 > buffer.length) return null;
  }
}

/** Bytes to hold back between chunks so a descriptor split across two is still found. */
const HOLD_BACK = 24;

export async function scanStoredZip(
  chunks: AsyncIterable<Uint8Array>,
  options: ScanOptions,
): Promise<ZipScan> {
  const entries: ZipEntry[] = [];
  let pending: Uint8Array = new Uint8Array(0);
  let bytesRead = 0;
  let keptBytes = 0;

  type State =
    | { mode: 'header' }
    | { mode: 'known'; entry: ZipEntry; remaining: number; keep: Uint8Array[] | null }
    | {
      mode: 'scan'; entry: ZipEntry; consumed: number; keep: Uint8Array[] | null;
    }
    | { mode: 'done' };
  let state: State = { mode: 'header' };
  // Asked through a function so the compiler does not narrow `state` across the loop.
  const isDone = () => (state as State).mode === 'done';

  const fail = (reason: 'not_a_zip' | 'unsupported' | 'truncated' | 'too_large'): ZipScan =>
    ({ ok: false, reason, entries, bytesRead });

  const finishEntry = (entry: ZipEntry, keep: Uint8Array[] | null, size: number) => {
    entry.size = size;
    if (keep) {
      const data = new Uint8Array(keep.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of keep) { data.set(c, at); at += c.length; }
      entry.data = data;
      keptBytes += data.length;
    }
    entries.push(entry);
  };

  const beginKeep = (entry: ZipEntry, declared: number | null): Uint8Array[] | null => {
    if (!options.want(entry.name)) return null;
    if (declared !== null && (declared > options.maxEntryBytes || keptBytes + declared > options.maxKeptBytes)) {
      entry.tooLarge = true;
      return null;
    }
    return [];
  };

  const take = (keep: Uint8Array[] | null, entry: ZipEntry, part: Uint8Array, held: number): Uint8Array[] | null => {
    if (!keep) return null;
    if (held + part.length > options.maxEntryBytes || keptBytes + held + part.length > options.maxKeptBytes) {
      entry.tooLarge = true;
      return null;
    }
    // Copied only here: a dropped entry's bytes are never duplicated.
    keep.push(part.slice());
    return keep;
  };

  let heldForEntry = 0;
  let errorReason: 'not_a_zip' | 'unsupported' = 'unsupported';

  const step = (): 'more' | 'again' | 'done' | 'error' => {
    if (state.mode === 'header') {
      if (pending.length < 4) return 'more';
      const sig = u32(pending, 0);
      if (sig === CENTRAL || sig === END || sig === ZIP64_END) { state = { mode: 'done' }; return 'done'; }
      if (sig !== LOCAL) { errorReason = 'not_a_zip'; return 'error'; }
      if (pending.length < 30) return 'more';
      const flags = u16(pending, 6);
      const method = u16(pending, 8);
      const nameLength = u16(pending, 26);
      const extraLength = u16(pending, 28);
      if (pending.length < 30 + nameLength + extraLength) return 'more';
      let csize = u32(pending, 18);
      let usize = u32(pending, 22);
      const name = new TextDecoder('utf-8', { fatal: false })
        .decode(pending.subarray(30, 30 + nameLength));
      const extra = pending.subarray(30 + nameLength, 30 + nameLength + extraLength);
      // zip64 extended sizes, where the header says to look for them.
      if (csize === 0xffffffff || usize === 0xffffffff) {
        for (let at = 0; at + 4 <= extra.length;) {
          const id = u16(extra, at);
          const size = u16(extra, at + 2);
          if (id === 0x0001) {
            let field = at + 4;
            if (usize === 0xffffffff && field + 8 <= at + 4 + size) { usize = u64(extra, field); field += 8; }
            if (csize === 0xffffffff && field + 8 <= at + 4 + size) { csize = u64(extra, field); }
            break;
          }
          at += 4 + size;
        }
      }
      pending = pending.subarray(30 + nameLength + extraLength);
      const isDirectory = name.endsWith('/');
      const entry: ZipEntry = { name, isDirectory, size: 0 };
      const hasDescriptor = (flags & 8) !== 0;

      if (isDirectory) {
        if (hasDescriptor && csize === 0) {
          // A directory carrying a descriptor: its (empty) descriptor follows.
          state = { mode: 'scan', entry, consumed: 0, keep: null };
          return 'again';
        }
        entries.push(entry);
        return 'again';
      }
      if (method !== 0) {
        // Deflated: skippable only if its compressed size is known.
        if (hasDescriptor && csize === 0) return 'error';
        state = { mode: 'known', entry, remaining: csize, keep: null };
        heldForEntry = 0;
        entry.size = usize;
        return 'again';
      }
      if (hasDescriptor && csize === 0) {
        state = { mode: 'scan', entry, consumed: 0, keep: beginKeep(entry, null) };
        heldForEntry = 0;
        return 'again';
      }
      entry.size = csize;
      state = { mode: 'known', entry, remaining: csize, keep: beginKeep(entry, csize) };
      heldForEntry = 0;
      return 'again';
    }

    if (state.mode === 'known') {
      if (state.remaining === 0) {
        finishEntry(state.entry, state.keep, state.entry.size);
        // A known-size entry may still be followed by a descriptor if flag 3 was set with sizes present.
        state = { mode: 'header' };
        return 'again';
      }
      if (!pending.length) return 'more';
      const n = Math.min(state.remaining, pending.length);
      const part = pending.subarray(0, n);
      state.keep = take(state.keep, state.entry, part, heldForEntry);
      if (state.keep) heldForEntry += n;
      state.remaining -= n;
      pending = pending.subarray(n);
      if (state.remaining === 0) {
        const entry = state.entry;
        finishEntry(entry, state.keep, entry.size);
        state = { mode: 'header' };
      }
      return 'again';
    }

    if (state.mode === 'scan') {
      const found = findDescriptor(pending, state.consumed);
      if (found) {
        const part = pending.subarray(0, found.at);
        state.keep = take(state.keep, state.entry, part, heldForEntry);
        if (state.keep) heldForEntry += part.length;
        finishEntry(state.entry, state.keep, found.size);
        pending = pending.subarray(found.at + found.length);
        state = { mode: 'header' };
        return 'again';
      }
      // No descriptor yet: release everything but the tail that might hold half of one.
      const releasable = pending.length - HOLD_BACK;
      if (releasable > 0) {
        const part = pending.subarray(0, releasable);
        state.keep = take(state.keep, state.entry, part, heldForEntry);
        if (state.keep) heldForEntry += releasable;
        state.consumed += releasable;
        pending = pending.subarray(releasable);
      }
      return 'more';
    }
    return 'done';
  };

  for await (const chunk of chunks) {
    bytesRead += chunk.length;
    if (bytesRead > options.maxTotalBytes) return fail('too_large');
    pending = concat(pending, chunk);
    if (bytesRead === chunk.length && pending.length >= 4 && u32(pending, 0) !== LOCAL) {
      return fail('not_a_zip');
    }
    for (;;) {
      const next = step();
      if (next === 'again') continue;
      if (next === 'error') return fail(errorReason);
      break;
    }
    if (isDone()) return { ok: true, entries, bytesRead };
  }
  if (isDone()) return { ok: true, entries, bytesRead };
  return fail('truncated');
}
