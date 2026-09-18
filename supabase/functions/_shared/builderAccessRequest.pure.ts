/**
 * What a builder lead may say when they ask for access, and what the network
 * may do about it without a person in the loop.
 *
 * The pipeline is deliberately automatic: an application creates the
 * organisation and sends its owner an invitation, with no operator step in
 * between. That is the product decision. What follows are the four properties
 * that make an unattended, publicly-reachable pipeline safe to run, and each
 * is a property of the DESIGN rather than a check somebody remembers:
 *
 *  1. THE ORGANISATION IS BORN UNAPPROVED. Submitting creates it exactly as a
 *     self-serve registration does — `pending_activation`, `is_active:
 *     false` — so it appears nowhere in the marketplace and grants nothing.
 *     `approve_organisation` is still the only route to `active`, and it is
 *     still an operator's decision. Automation reaches the paperwork, never
 *     the vetting.
 *
 *  2. THE INVITATION ONLY EVER GOES TO THE ADDRESS ON THE APPLICATION. There
 *     is no field for a third party, so this cannot be pointed at somebody
 *     else's mailbox, and the wording is fixed — an applicant chooses the
 *     recipient and nothing else. That is what keeps it from being an open
 *     relay under the network's own verified sending domain.
 *
 *  3. ONE APPLICATION PER ADDRESS PER WINDOW. Without this, the same address
 *     could be applied for repeatedly and each attempt would send it mail.
 *     The window is read at submit rather than enforced by a unique index,
 *     because a second attempt is EVIDENCE — usually that the first
 *     invitation never arrived — and erasing it would hide exactly the
 *     failure an operator needs to see.
 *
 *  4. NOTHING IS OVERWRITTEN. An application that collides with an existing
 *     organisation is refused and recorded; it never edits the organisation
 *     it collided with. Otherwise anyone could rewrite a live builder's
 *     details by applying in their name.
 *
 * A CAPTCHA is the one control this module does NOT provide, because it needs
 * a site key and secret nobody has minted for this surface yet. Its absence
 * is why (3) is not optional.
 */

// @ts-ignore Deno-only import; not resolvable under Node type-checking.
import { ORG_TYPES } from './builderOrganisationInput.pure.ts';

/** How long one email address has to wait before applying again. */
export const APPLICATION_WINDOW_HOURS = 24;

const MAX = 200;
const MAX_MESSAGE = 2000;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface AccessRequestFields {
  readonly legal_name: string;
  readonly trading_name: string | null;
  readonly org_type: string | null;
  readonly abn: string | null;
  readonly acn: string | null;
  readonly contact_name: string;
  readonly contact_email: string;
  readonly contact_phone: string | null;
  readonly website: string | null;
  readonly suburb: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
  readonly message: string | null;
}

export type AccessRequestResult =
  | { readonly ok: true; readonly fields: AccessRequestFields }
  | { readonly ok: false; readonly error: string };

function text(value: unknown, limit = MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

/**
 * Read an application.
 *
 * Only four things are REQUIRED — who the business is, what kind it is, and
 * a person to write to. Everything else is description an operator can chase.
 * Asking a lead for an ACN and a postcode before they are allowed to express
 * interest is how an application form stops being answered; the two that are
 * mandatory are mandatory because the network's own columns are NOT NULL.
 *
 * The shape rules deliberately mirror the column CHECKs rather than
 * duplicating their wording — an ABN that is not eleven digits is refused
 * HERE, so it can never reach the table and come back as an unattributed
 * 500. That was measured: it is exactly what happened to an operator on
 * 18 Sep 2026.
 */
export function readAccessRequest(body: Record<string, unknown>): AccessRequestResult {
  const legalName = text(body.legal_name);
  if (!legalName) return { ok: false, error: 'a_legal_name_is_required' };

  const contactName = text(body.contact_name);
  if (!contactName) return { ok: false, error: 'a_contact_name_is_required' };

  const contactEmail = text(body.contact_email);
  if (!contactEmail || !EMAIL.test(contactEmail)) {
    return { ok: false, error: 'a_valid_email_is_required' };
  }

  const orgType = text(body.org_type);
  if (!orgType) return { ok: false, error: 'an_organisation_type_is_required' };
  if (!(ORG_TYPES as readonly string[]).includes(orgType)) {
    return { ok: false, error: 'org_type_is_not_recognised' };
  }

  const digits = (value: unknown, exactly: number, field: string) => {
    const raw = text(value);
    if (!raw) return { ok: true as const, value: null };
    const only = raw.replace(/[\s-]/g, '');
    if (!new RegExp(`^\\d{${exactly}}$`).test(only)) {
      return { ok: false as const, error: `${field}_must_be_${exactly}_digits` };
    }
    return { ok: true as const, value: only };
  };

  const abn = digits(body.abn, 11, 'abn');
  if (!abn.ok) return { ok: false, error: abn.error };
  const acn = digits(body.acn, 9, 'acn');
  if (!acn.ok) return { ok: false, error: acn.error };
  const postcode = digits(body.postcode, 4, 'postcode');
  if (!postcode.ok) return { ok: false, error: postcode.error };

  const state = text(body.state);
  if (state && !['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'].includes(state)) {
    return { ok: false, error: 'state_is_not_an_australian_state' };
  }

  return {
    ok: true,
    fields: {
      legal_name: legalName,
      trading_name: text(body.trading_name),
      org_type: orgType,
      abn: abn.value,
      acn: acn.value,
      contact_name: contactName,
      contact_email: contactEmail.toLowerCase(),
      contact_phone: text(body.contact_phone),
      website: text(body.website),
      suburb: text(body.suburb),
      state,
      postcode: postcode.value,
      message: text(body.message, MAX_MESSAGE),
    },
  };
}

/**
 * The organisation an accepted application creates.
 *
 * The contact details travel onto the organisation because they are the only
 * ones anybody has; `notes` records that a human did not type this, so an
 * operator reviewing the row knows where it came from without opening the
 * application. The lifecycle columns are deliberately absent — the caller
 * sets `pending_activation` / `is_active: false`, exactly as
 * `create_organisation` does.
 */
export function organisationFromRequest(
  fields: AccessRequestFields,
): Record<string, string | null> {
  return {
    legal_name: fields.legal_name,
    trading_name: fields.trading_name,
    org_type: fields.org_type,
    abn: fields.abn,
    acn: fields.acn,
    contact_email: fields.contact_email,
    contact_phone: fields.contact_phone,
    website: fields.website,
    suburb: fields.suburb,
    state: fields.state,
    postcode: fields.postcode,
    notes: `Created from a Builder Portal access request submitted by ${fields.contact_name}.`,
  };
}
