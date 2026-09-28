/**
 * The Deno half of doc 68's delivery rules: hold an answer to its floor, run
 * work after the answer, send each invitation email in its turn, and read the
 * deployment's one delivery reading. The rules and their reasons are in
 * `builderEmailDelivery.pure.ts`; this module only carries them out.
 *
 * Nothing here logs an address or a message body. A refused send is already
 * logged, redacted, by `sendBuilderEmail`.
 */
import {
  answerDelayMs,
  deliveryCheckState,
  deliveryHealthView,
  readSendSlot,
  DELIVERY_CHECK_LEASE_SECONDS,
  DELIVERY_CHECK_RECIPIENT_DEFAULT,
  DELIVERY_CHECK_STALE_AFTER_SECONDS,
  EMAIL_SEND_MAX_WAIT_MS,
  EMAIL_SEND_SPACING_MS,
  type DeliveryHealthView,
} from './builderEmailDelivery.pure.ts';
import {
  builderEmailConfigured,
  sendBuilderEmail,
  type BuilderEmailBrand,
  type InviteEmailContent,
  type InviteEmailOutcome,
} from './builderInviteEmail.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until the answer's floor has passed (doc 68 §1). */
export async function holdAnswer(receivedAtMs: number): Promise<void> {
  const delay = answerDelayMs(receivedAtMs, Date.now());
  if (delay > 0) await sleep(delay);
}

interface EdgeRuntimeLike {
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Run work after the answer has gone. The platform keeps the worker alive for
 * a promise handed to `EdgeRuntime.waitUntil`; where there is none (local
 * tooling) the promise simply runs on. A failure is logged and never thrown —
 * there is nobody left to throw it to.
 */
export function afterAnswer(work: Promise<unknown>, label: string): void {
  const guarded = work.catch((error) => {
    console.error(`[builderEmailDelivery] ${label} failed after the answer`,
      error instanceof Error ? error.message : String(error));
  });
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(guarded);
  } else {
    console.warn(`[builderEmailDelivery] EdgeRuntime.waitUntil is unavailable; ${label} runs unattended`);
  }
}

export type PacedEmailOutcome = InviteEmailOutcome | { readonly sent: false; readonly reason: 'paced_out' };

/** This isolate's own spacing, used only when the database pacer cannot be asked. */
let localNextSlotMs = 0;

function takeLocalSlot(): { readonly kind: 'wait'; readonly ms: number } | { readonly kind: 'paced_out' } {
  const now = Date.now();
  const start = Math.max(now, localNextSlotMs);
  if (start - now > EMAIL_SEND_MAX_WAIT_MS) return { kind: 'paced_out' };
  localNextSlotMs = start + EMAIL_SEND_SPACING_MS;
  return { kind: 'wait', ms: start - now };
}

/**
 * SEND ONE EMAIL IN ITS TURN (doc 68 §2).
 *
 * The slot is reserved in the database, under one lock, so the spacing holds
 * across every isolate this deployment runs. A pacer that cannot be asked is
 * met with this isolate's own spacing rather than with none — the shape every
 * limiter here degrades to. A full queue sends nothing and says so; the
 * invitation stays waiting, and inviting the address again re-sends it.
 */
export async function sendPacedBuilderEmail(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: {
    readonly to: string;
    readonly subject: string;
    readonly content: InviteEmailContent;
    readonly brand: BuilderEmailBrand;
    readonly category: string;
  },
): Promise<PacedEmailOutcome> {
  let reservation: { data: unknown; error: unknown };
  try {
    reservation = await supabase.rpc('builder_reserve_email_send_slot', {
      _spacing_ms: EMAIL_SEND_SPACING_MS,
      _max_wait_ms: EMAIL_SEND_MAX_WAIT_MS,
    });
  } catch (error) {
    reservation = { data: null, error };
  }
  const read = readSendSlot(reservation);
  if (read.kind === 'unpaced') {
    console.warn('[builderEmailDelivery] the send pacer could not be asked; spacing this isolate alone',
      { category: args.category });
  }
  const slot = read.kind === 'unpaced' ? takeLocalSlot() : read;
  if (slot.kind !== 'wait') {
    console.warn('[builderEmailDelivery] the send queue is full; this email was not sent', { category: args.category });
    return { sent: false, reason: 'paced_out' };
  }
  if (slot.ms > 0) await sleep(slot.ms);
  return await sendBuilderEmail(args);
}

/**
 * THE DEPLOYMENT'S ONE DELIVERY READING (doc 68 §3).
 *
 * Read from the database, and — once it is stale — refreshed by exactly one
 * request, after its answer, by sending a check to a sink that belongs to
 * nobody. Nothing here reads an invitation, an address or the activity log.
 */
export async function readDeliveryHealth(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  loadBrand: () => Promise<BuilderEmailBrand>,
): Promise<DeliveryHealthView> {
  const configured = builderEmailConfigured();
  if (!configured) return deliveryHealthView({ configured, reading: null });

  const { data, error } = await supabase.rpc('builder_email_delivery_reading');
  if (error) console.error('[builderEmailDelivery] the delivery reading could not be read', error.message);
  const row = !error && Array.isArray(data) ? data[0] ?? null : null;

  const { data: claimed, error: claimError } = await supabase.rpc('builder_claim_email_delivery_check', {
    _stale_after_seconds: DELIVERY_CHECK_STALE_AFTER_SECONDS,
    _lease_seconds: DELIVERY_CHECK_LEASE_SECONDS,
  });
  if (claimError) console.error('[builderEmailDelivery] the delivery check could not be claimed', claimError.message);
  if (!claimError && claimed === true) afterAnswer(runDeliveryCheck(supabase, loadBrand), 'delivery check');

  return deliveryHealthView({
    configured,
    reading: row
      ? {
        state: typeof row.state === 'string' ? row.state : null,
        checked_at: typeof row.checked_at === 'string' ? row.checked_at : null,
        backlog_ms: typeof row.backlog_ms === 'number' ? row.backlog_ms : null,
      }
      : null,
  });
}

async function runDeliveryCheck(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  loadBrand: () => Promise<BuilderEmailBrand>,
): Promise<void> {
  const brand = await loadBrand();
  // @ts-ignore Deno-only global.
  const recipient = Deno.env.get('BUILDER_EMAIL_DELIVERY_CHECK_RECIPIENT') || DELIVERY_CHECK_RECIPIENT_DEFAULT;
  const outcome = await sendPacedBuilderEmail(supabase, {
    to: recipient,
    subject: `${brand.companyName} Builder Portal delivery check`,
    brand,
    category: 'builder_delivery_check',
    content: {
      heading: 'Delivery check',
      paragraphs: ['This message checks that the Builder Portal can send email. No action is needed.'],
    },
  });
  const { error } = await supabase.rpc('builder_record_email_delivery_check', { _state: deliveryCheckState(outcome) });
  if (error) console.error('[builderEmailDelivery] the delivery check could not be recorded', error.message);
}
