/**
 * BUILDER STOCK — WHICH ELECTION LANE A DOCUMENT QUEUES IN.
 *
 * WHAT CHANGED AND WHY. Every `/v1/elect` request used to be routed to one
 * Durable Object named by a constant, so every election in the fleet queued
 * behind the one before it. The queue is not the problem and is NOT removed
 * here — each object below is still strictly serial, one document resident at
 * a time. What changes is that there are now `ELECTION_LANE_COUNT` of them, so
 * an import is not funnelled through a single door.
 *
 * THE KEY IS THE ELECTION'S OWN IDENTITY: the property label and the
 * document's address, both of which ALREADY cross the wire in
 * `x-election-context`. Nothing is added to the boundary contract for
 * sharding — no organisation id, no property id, no upload id, no row id. The
 * worker still cannot say which property row it is looking at, which is the
 * property `pdfElectionBoundary.pure.ts` exists to hold.
 *
 * WHY BOTH FIELDS, AND NOT EITHER ALONE.
 *
 *   `documentName` is not unique and is sometimes not even a name: the
 *   direct-file path in `packageImages.ts` passes the literal string
 *   `'the linked document'`, and `documentNameFromUrl` falls back to the same
 *   string for any URL it cannot read a filename out of. Sharding on it would
 *   put a large share of the fleet in one lane.
 *
 *   `url` is stable — checked, not assumed. Every path that builds it is a
 *   pure function of something the builder's own sheet says:
 *   `driveDownloadUrl(id)` is `uc?export=download&id=<id>` for a Drive file
 *   id, and `sharedLinkFileUrl(raw)` returns the builder's own link with at
 *   most Dropbox's published `dl=1` set. No signed URL, no expiring token, no
 *   timestamp reaches this field on any path. But it clusters: the live list
 *   has one folder shared by forty-four rows, so forty-four elections of
 *   forty-four different properties would share a lane.
 *
 * So the key is `label` + `url`, which is exactly what one election IS — this
 * document, read for this property. The same election always lands in the same
 * lane; two properties reading the same shared brochure do not.
 *
 * THE LANE NAME CARRIES ONLY A NUMBER — `builder-stock-pdf-election-0` and
 * `-1` at the count below. A name built from the key would put a customer's
 * property label into Cloudflare's object namespace, which is the boundary
 * rule restated as infrastructure metadata: the worker is not told which
 * property it is looking at, and neither is the platform.
 *
 * Pure: no IO, no clock, no crypto, no network. Synchronous on purpose — the
 * front door computes this per request and must stay cheap.
 */

/** The stem every lane name is built from. */
export const ELECTION_LANE_PREFIX = 'builder-stock-pdf-election';

/**
 * How many lanes the fleet has.
 *
 * TWO, AND THE CEILING IS MEMORY RATHER THAN APPETITE. Each lane is serial, so
 * this is the number of documents that may be resident across the fleet at
 * once — and `MAX_DOCUMENT_BYTES` admits 32 MB apiece.
 *
 * WHY TWO AND NOT MORE, ON THE FIRST ROLLOUT. The constant this replaces was
 * one lane, and the comment that justified it asserted that lanes share an
 * isolate's 128 MB — "a second lane would double the resident documents
 * without doubling the 128 MB an isolate gets". That claim is not settled:
 * Cloudflare documents 128 MB per isolate AND colocates Durable Objects,
 * without saying which applies to two objects of one class under load. It is
 * the same ambiguity `wrangler.toml` already records for the CPU limit, and
 * it is answered the same way — by measurement, not by reading.
 *
 * Two is the smallest number that makes the sharding real while leaving the
 * memory question cheap to be wrong about: if lanes do share 128 MB, two
 * resident documents is a materially smaller bet than four. Raising it is
 * this one constant, and everything that depends on it — the modulo, the
 * bound, the lane names, every test and the canary — is derived from it
 * rather than restated.
 */
export const ELECTION_LANE_COUNT = 2;

/** The object name for a lane. Only the number travels. */
export function electionLaneName(lane: number): string {
  const n = Number.isFinite(lane) ? Math.trunc(lane) : 0;
  const bounded = ((n % ELECTION_LANE_COUNT) + ELECTION_LANE_COUNT) % ELECTION_LANE_COUNT;
  return `${ELECTION_LANE_PREFIX}-${bounded}`;
}

/**
 * The value a lane is chosen from, or null when the request does not carry
 * one.
 *
 * A NEWLINE SEPARATES THE TWO FIELDS because a URL cannot contain a raw one —
 * it would be percent-encoded — so the pair cannot be spelled two ways. A
 * label that somehow contained a newline could in principle collide with
 * another pair, and the cost of that collision is that two elections share a
 * lane, which is the state every election was in before this existed.
 */
export function electionShardKey(
  context: { label?: unknown; url?: unknown } | null | undefined,
): string | null {
  if (!context || typeof context !== 'object') return null;
  const label = typeof context.label === 'string' ? context.label.trim() : '';
  const url = typeof context.url === 'string' ? context.url.trim() : '';
  if (!label && !url) return null;
  return `${label}\n${url}`;
}

/**
 * FNV-1a, 32-bit, over the key's UTF-16 code units, FINISHED WITH AN
 * AVALANCHE.
 *
 * A non-cryptographic hash is the right tool: this chooses a queue, it does
 * not protect anything, and `crypto.subtle` is asynchronous — an `await` in
 * the front door before the request is handed on is latency added to every
 * election to decide something a multiply and an xor already decide well.
 *
 * THE FINALISER IS NOT DECORATION, and the test that asserts the spread is
 * what found that out. FNV-1a's last operation is a multiply, and the low
 * bits of a product depend only on the low bits of its inputs — so its bottom
 * bits barely move for inputs that differ late, which is exactly what a run of
 * `Lot 700`, `Lot 701`, `Lot 702` is.
 *
 * MEASURED over forty consecutive lots, each with its own Drive file id:
 *
 *   raw FNV-1a  % 2 → [0, 40]          every one of them in ONE lane
 *   raw FNV-1a  % 4 → [0, 35, 0, 5]
 *   with fmix32 % 2 → [21, 19]
 *   with fmix32 % 4 → [8, 13, 13, 6]
 *
 * At two lanes the raw hash does not merely skew, it collapses: the sharding
 * would be inert and the second lane would never be addressed at all. So the
 * finaliser matters MORE at the count this ships on, not less.
 *
 * `fmix32` is MurmurHash3's finaliser, whose entire job is to push high-bit
 * entropy down into the low bits.
 */
function hashKey(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32 bits; `hash * 16777619` loses the
    // low bits to float precision and collapses the distribution.
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * The lane for a key, in `0 .. ELECTION_LANE_COUNT - 1`.
 *
 * LANE 0 IS ALSO THE ANSWER FOR NO KEY, and that is deliberate rather than a
 * default. A request whose context header is missing, malformed, or of a
 * protocol this worker does not speak is one the Durable Object already
 * refuses with its own 400 — routing must not grow a second opinion about a
 * request's validity, or the front door starts returning errors the lane used
 * to word. So an unreadable context is routed rather than rejected, and the
 * refusal stays exactly where it was.
 */
export function laneForShardKey(key: string | null | undefined): number {
  if (typeof key !== 'string' || !key) return 0;
  return hashKey(key) % ELECTION_LANE_COUNT;
}
