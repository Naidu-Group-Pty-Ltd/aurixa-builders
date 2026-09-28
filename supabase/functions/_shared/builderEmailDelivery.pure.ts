/**
 * WHEN AN INVITATION IS ANSWERED, WHEN ITS EMAIL LEAVES, AND WHAT AN
 * ADMINISTRATOR MAY BE TOLD ABOUT DELIVERY (doc 68).
 *
 * Three findings doc 67 §3 left open, and one rule each.
 *
 *  1. **The answer takes the same time whatever the address is.** Only some
 *     kinds of address sent an email before answering, so a revoked account
 *     answered ~450 ms sooner than every other kind (measured in production).
 *     Every email now leaves AFTER the answer, and the answer waits for a fixed
 *     floor that clears the work done before it, so the time an answer takes
 *     is the floor for every kind.
 *
 *  2. **A burst cannot hammer the shared mail provider.** The ceiling is 40 an
 *     hour per person and 100 per organisation, and all of it could be spent in
 *     one second against a provider that admits 2 requests a second per team,
 *     shared by every send this deployment makes. Each invitation email waits
 *     for its own slot, reserved in the database under one lock, so
 *     invitations leave at most one a second deployment-wide however many
 *     isolates are sending; a slot further away than the edge worker can wait
 *     is refused rather than queued without end, and the invitation stays
 *     waiting for a re-send.
 *
 *  3. **A delivery signal that names no address and no message.** Whether an
 *     email left is recorded per invitation where only an operator reads it.
 *     What an administrator sees is one reading for the whole deployment,
 *     taken by sending a check to a sink that belongs to nobody, on a clock —
 *     never from a real invitation and never because one send failed, since
 *     either would let a reading say "your invitation to that address failed".
 *
 * Pure: the rules are tested without a network or a database.
 */

/** How long every invitation answer takes, at least. Measured work before it is ~150–500 ms. */
export const INVITE_ANSWER_FLOOR_MS = 1500;

/** How long to wait before answering, given when the request arrived. */
export function answerDelayMs(receivedAtMs: number, nowMs: number, floorMs = INVITE_ANSWER_FLOOR_MS): number {
  return Math.max(0, receivedAtMs + floorMs - nowMs);
}

/**
 * One invitation email a second, deployment-wide: half the provider's
 * per-team ceiling, leaving the other half to every other send.
 */
export const EMAIL_SEND_SPACING_MS = 1000;

/**
 * The longest a queued send waits for its slot. It waits inside the edge
 * worker that answered, which the platform keeps alive for 150 s on the
 * smallest plan, so this stays well inside that with the send itself after it.
 */
export const EMAIL_SEND_MAX_WAIT_MS = 90_000;

/**
 * How many of ONE organisation's invitation emails may wait for a slot at once.
 * The independent review measured the queue without it: an organisation with
 * three administrators could burst ~91 sends into a 90-slot queue and delay —
 * or drop as paced out — every other tenant's invitations. Past this, only
 * that organisation's own sends are refused; everyone else still gets a slot,
 * at most this many seconds behind it.
 */
export const EMAIL_SEND_MAX_QUEUED_PER_ORGANISATION = 20;

export type SendSlot =
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'paced_out' }
  | { readonly kind: 'unpaced' };

/**
 * What the reservation said. A number is how long to wait; NULL is a full
 * queue (nothing was reserved); an error — or an answer this reader cannot
 * understand — is a pacer that could not be asked, which the sender meets with
 * its own per-isolate spacing rather than with no spacing at all.
 */
export function readSendSlot(result: { readonly data: unknown; readonly error: unknown }): SendSlot {
  if (result.error) return { kind: 'unpaced' };
  if (result.data === null) return { kind: 'paced_out' };
  if (typeof result.data === 'number' && Number.isFinite(result.data) && result.data >= 0) {
    return { kind: 'wait', ms: Math.ceil(result.data) };
  }
  return { kind: 'unpaced' };
}

/** A reading older than this is checked again, by whichever request asks first. */
export const DELIVERY_CHECK_STALE_AFTER_SECONDS = 1800;

/** How long one checker holds the check before another may take it over. */
export const DELIVERY_CHECK_LEASE_SECONDS = 120;

/** A send queue at least this long is reported as delayed. */
export const DELIVERY_BACKLOG_DELAYED_MS = 30_000;

/**
 * Where the check is sent: the provider's own delivery sink, which accepts and
 * discards. It belongs to nobody, so its outcome is a fact about the deployment
 * and never about a person. An operator may point it elsewhere with
 * `BUILDER_EMAIL_DELIVERY_CHECK_RECIPIENT`.
 */
export const DELIVERY_CHECK_RECIPIENT_DEFAULT = 'delivered@resend.dev';

export type DeliveryCheckState = 'operational' | 'degraded';

/**
 * What one check found: a send that left is operational, a send the provider
 * refused or could not be reached for is degraded — and a check that never left
 * the queue found out nothing about the provider, so it records no reading
 * (null) rather than calling delivery broken for half an hour because
 * somebody else's burst filled the queue.
 */
export function deliveryCheckState(
  outcome: { readonly sent: boolean; readonly reason?: string },
): DeliveryCheckState | null {
  if (outcome.sent) return 'operational';
  return outcome.reason === 'paced_out' ? null : 'degraded';
}

export type DeliveryHealthState = 'operational' | 'degraded' | 'delayed' | 'not_configured' | 'unknown';

export interface DeliveryHealthView {
  readonly state: DeliveryHealthState;
  readonly checked_at: string | null;
}

/**
 * THE ONLY THING AN ADMINISTRATOR IS TOLD ABOUT DELIVERY.
 *
 * Its inputs are whether this deployment has a mail provider at all, and the
 * deployment's one reading — the last check and how long the send queue is.
 * There is no parameter through which an address, an invitation or a message
 * could arrive, and a spec holds it to that.
 *
 * A failing check outranks a long queue: "not sending" is the more useful
 * thing to know, and the remedy (send again later) is the same.
 */
export function deliveryHealthView(input: {
  readonly configured: boolean;
  readonly reading: {
    readonly state: string | null;
    readonly checked_at: string | null;
    readonly backlog_ms: number | null;
  } | null;
}): DeliveryHealthView {
  if (!input.configured) return { state: 'not_configured', checked_at: null };
  const reading = input.reading;
  const checkedAt = reading?.checked_at ?? null;
  if (reading?.state === 'degraded') return { state: 'degraded', checked_at: checkedAt };
  if ((reading?.backlog_ms ?? 0) >= DELIVERY_BACKLOG_DELAYED_MS) return { state: 'delayed', checked_at: checkedAt };
  if (reading?.state === 'operational') return { state: 'operational', checked_at: checkedAt };
  return { state: 'unknown', checked_at: checkedAt };
}
