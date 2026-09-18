/**
 * What Mission Control may say about a builder organisation, and in what shape.
 *
 * The operator console creates and edits organisations through
 * `builder-network-admin`. Three CHECK constraints on `builder_organisations`
 * decide whether a write survives, and two of them are easy to violate from a
 * form:
 *
 *   status_active_agree   (status = 'active') = is_active
 *   activation_stamp      status = 'active'    ⇒ activated_at IS NOT NULL
 *   suspension_stamp      status = 'suspended' ⇒ suspended_at IS NOT NULL
 *
 * So the lifecycle columns are NOT writable here at all. `status`,
 * `is_active`, `activated_at`, `suspended_at` and `suspension_reason` are
 * moved only by the verbs that own them — approve, suspend, reinstate,
 * close — each of which sets the whole consistent group. An edit form that
 * could also set `status` would be a second way to move a lifecycle, and the
 * two would disagree the first time one of them forgot a stamp.
 *
 * What is left is description: who the organisation is and how to reach it.
 * Everything is trimmed, bounded and normalised here rather than at the call
 * site, so create and update cannot drift apart.
 *
 * THE COLUMN RULES ARE ENFORCED HERE, NAMED. `builder_organisations` also
 * CHECKs the SHAPE of five description columns, and this module used to
 * enforce two of them:
 *
 *   org_type      NOT NULL, no default, one of ORG_TYPES
 *   abn           NULL or exactly 11 digits
 *   acn           NULL or exactly 9 digits
 *   postcode      NULL or exactly 4 digits
 *   state         NULL or one of AU_STATES
 *
 * Measured against the live schema before this was written: of eight
 * realistic console inputs, SIX were refused by Postgres rather than by this
 * module — a legal name with no type chosen (23502 on a NOT NULL column), a
 * three-digit ABN, a non-numeric ACN, `Victoria`, `vic` and a three-digit
 * postcode (23514). Each surfaced as a 500 and reached the operator as "The
 * organisation could not be saved", naming no field and suggesting no
 * remedy. A constraint the caller cannot read is a constraint the caller
 * cannot satisfy, so every rule the column holds is stated here and refused
 * with the field's own name.
 */

export const ORG_TYPES = ['developer', 'builder', 'builder_developer', 'sales_representative'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

/** The eight the column accepts. A state is refused, never corrected. */
export const AU_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'] as const;
export type AuState = (typeof AU_STATES)[number];

/** Columns this surface may write. Lifecycle columns are deliberately absent. */
export const DESCRIPTIVE_COLUMNS = [
  'legal_name', 'trading_name', 'org_type', 'abn', 'acn',
  'contact_email', 'contact_phone', 'website',
  'address_line1', 'address_line2', 'suburb', 'state', 'postcode', 'notes',
] as const;

const MAX = 200;
const MAX_NOTES = 2000;

export type OrganisationPatch = Partial<Record<(typeof DESCRIPTIVE_COLUMNS)[number], string | null>>;

export type OrganisationInputResult =
  | { readonly ok: true; readonly patch: OrganisationPatch }
  | { readonly ok: false; readonly error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Digits only, so "12 345 678 901" and "12345678901" are one ABN.
 *
 * `exactly` is the column's own length. An answer that is not that many
 * digits is REFUSED rather than stored: it used to be handed back unchanged
 * and rejected by Postgres two frames later, where the operator was told
 * nothing about which field was wrong.
 */
function digitsOfLength(
  value: unknown,
  exactly: number,
  field: string,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly error: string } {
  const raw = text(value);
  if (!raw) return { ok: true, value: null };
  const only = raw.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${exactly}}$`).test(only)) {
    return { ok: false, error: `${field}_must_be_${exactly}_digits` };
  }
  return { ok: true, value: only };
}

/**
 * Read a create or edit payload.
 *
 * `mode: 'create'` requires a legal name; `mode: 'update'` builds a patch from
 * whatever keys are PRESENT, so an edit form that sends one field changes one
 * field. A key present but empty clears that column — except the legal name,
 * which an organisation cannot be without.
 */
export function readOrganisationInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): OrganisationInputResult {
  const patch: OrganisationPatch = {};

  const legalName = text(body.legal_name);
  if (mode === 'create' && !legalName) {
    return { ok: false, error: 'a_legal_name_is_required' };
  }
  if ('legal_name' in body) {
    if (!legalName) return { ok: false, error: 'a_legal_name_is_required' };
    if (legalName.length > MAX) return { ok: false, error: 'legal_name_is_too_long' };
    patch.legal_name = legalName;
  }

  // The column is NOT NULL with no default, so an unchosen type is a refusal
  // here rather than a 23502 the operator reads as "could not be saved".
  const orgType = text(body.org_type);
  if (mode === 'create' && !orgType) {
    return { ok: false, error: 'an_organisation_type_is_required' };
  }
  if ('org_type' in body) {
    if (!orgType) return { ok: false, error: 'an_organisation_type_is_required' };
    if (!(ORG_TYPES as readonly string[]).includes(orgType)) {
      return { ok: false, error: 'org_type_is_not_recognised' };
    }
    patch.org_type = orgType;
  }

  if ('contact_email' in body) {
    const email = text(body.contact_email);
    if (email && !EMAIL.test(email)) return { ok: false, error: 'contact_email_is_not_an_email' };
    patch.contact_email = email ? email.toLowerCase() : null;
  }

  if ('abn' in body) {
    const abn = digitsOfLength(body.abn, 11, 'abn');
    if (!abn.ok) return { ok: false, error: abn.error };
    patch.abn = abn.value;
  }
  if ('acn' in body) {
    const acn = digitsOfLength(body.acn, 9, 'acn');
    if (!acn.ok) return { ok: false, error: acn.error };
    patch.acn = acn.value;
  }

  if ('postcode' in body) {
    const postcode = digitsOfLength(body.postcode, 4, 'postcode');
    if (!postcode.ok) return { ok: false, error: postcode.error };
    patch.postcode = postcode.value;
  }

  // Refused, never corrected: `vic` and `Victoria` are both plainly meant, and
  // upper-casing one while guessing at the other is how a console starts
  // deciding what an operator said.
  if ('state' in body) {
    const state = text(body.state);
    if (state && !(AU_STATES as readonly string[]).includes(state)) {
      return { ok: false, error: 'state_is_not_an_australian_state' };
    }
    patch.state = state;
  }

  for (const column of ['trading_name', 'contact_phone', 'website', 'address_line1', 'address_line2', 'suburb'] as const) {
    if (!(column in body)) continue;
    const value = text(body[column]);
    if (value && value.length > MAX) return { ok: false, error: `${column}_is_too_long` };
    patch[column] = value;
  }

  if ('notes' in body) {
    const notes = text(body.notes);
    if (notes && notes.length > MAX_NOTES) return { ok: false, error: 'notes_is_too_long' };
    patch.notes = notes;
  }

  if (mode === 'update' && Object.keys(patch).length === 0) {
    return { ok: false, error: 'nothing_to_update' };
  }
  return { ok: true, patch };
}
