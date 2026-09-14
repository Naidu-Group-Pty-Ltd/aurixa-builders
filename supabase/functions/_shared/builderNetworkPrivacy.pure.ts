/**
 * The privacy contract on everything that crosses a workspace connection —
 * both directions (extraction plan §6, forbidden sets as in rev 1).
 *
 * THROW, NEVER FILTER. The clone's cross-portal worker earned this rule: a
 * filter that strips a forbidden field ships the rest of a payload somebody
 * composed WRONG, and the composition bug survives because delivery
 * succeeds. A throw dead-letters the event, raises a critical operational
 * event, and makes the composer fix the projection.
 *
 * The sets, by family:
 *  * client PII — a clone's client NEVER crosses as a person; the network
 *    carries (connection_id, remote_client_ref, remote_client_label) and
 *    the ref is a stored RANDOM uuid precisely so nothing about the person
 *    travels (E2).
 *  * internal notes and staff identity — operator-side working material.
 *  * other connections' identity — one workspace must never learn another's
 *    existence from a payload.
 *  * cost/margin — a builder's commercials are not the workspace's.
 *  * AML — compliance content never leaves the clone, in either direction.
 *
 * Matching is by KEY at any depth. Exact names catch the known columns;
 * the fragment rules catch the renamed cousin (`clientEmail`,
 * `internal_note`, `margin_pct`) because a privacy contract that pins exact
 * spellings is one refactor from silent.
 */

export const FORBIDDEN_EXACT_KEYS: readonly string[] = [
  // Client PII (E2: refs travel, people do not)
  'client_id', 'client_name', 'client_email', 'client_phone', 'client_address',
  'client_dob', 'date_of_birth', 'tfn', 'abn_holder_name',
  // Operator-side material
  'internal_notes', 'internal_note', 'selected_by_user_id', 'staff_id',
  'created_by', 'updated_by', 'assigned_user_id',
  // Other connections' identity
  'other_connection_id', 'connection_ids', 'workspace_ids',
  // Commercials
  'cost_price', 'cost', 'margin', 'markup', 'wholesale_price',
  // AML never crosses
  'aml_case_id', 'screening_result', 'risk_rating',
] as const;

/** Case-insensitive fragments that mark a key forbidden wherever they appear. */
export const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  'client_email', 'client_phone', 'client_name',
  'internal_note', 'margin', 'aml_', 'smr', 'suspic', 'austrac',
] as const;

function keyIsForbidden(key: string): boolean {
  // camelCase is de-camelled before matching, so `clientEmail` and
  // `internalNote` are the same key as their snake_case columns — a privacy
  // contract that pins one spelling is one refactor from silent.
  const k = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if ((FORBIDDEN_EXACT_KEYS as readonly string[]).includes(k)) return true;
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

/** Every offending path in the payload, depth-first, dotted. */
export function forbiddenPathsIn(payload: unknown, prefix = ''): string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const paths: string[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => {
      paths.push(...forbiddenPathsIn(entry, `${prefix}[${index}]`));
    });
    return paths;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (keyIsForbidden(key)) {
      paths.push(path);
      continue; // the subtree is condemned with its key
    }
    paths.push(...forbiddenPathsIn(value, path));
  }
  return paths;
}

export class BuilderNetworkPrivacyViolation extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(`builder_network_privacy_contract_failed: ${paths.join(', ')}`);
    this.name = 'BuilderNetworkPrivacyViolation';
    this.paths = paths;
  }
}

/**
 * The gate every crossing payload goes through, outbound AND inbound.
 * Throws with the full path list; returns the payload untouched when clean,
 * so a call site cannot accidentally adopt a filtered copy.
 */
export function assertPayloadCrossesClean<T>(payload: T): T {
  const paths = forbiddenPathsIn(payload);
  if (paths.length) throw new BuilderNetworkPrivacyViolation(paths);
  return payload;
}
