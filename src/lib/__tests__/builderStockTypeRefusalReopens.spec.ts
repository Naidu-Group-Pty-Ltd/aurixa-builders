/**
 * A REFUSAL THAT RESTS ON TYPE THE READING NO LONGER SEES IS ASKED AGAIN —
 * AND NOTHING ELSE IS.
 *
 * Lot 54's clean facade render was refused by the repair stage for
 * `type_present` with `nothing_to_remove`: the strict pass had read its kerb
 * as a line of lettering. The reading is corrected (`STRICT_TYPE_READING` 2),
 * but a failure at the current `SANITIZATION_VERSION` settles a row, so the
 * corrected reading would never have been asked. A sanitization bump would
 * have asked it — and would also have expired every clearance in production
 * and reopened refusals the generative route can be handed. So exactly one
 * refusal reopens, and the rest of the records are pinned below as standing.
 */
import { describe, expect, it } from 'vitest';

import {
  CLEARANCE_KEY, DERIVATIVE_KEY, FAILURE_KEY, SANITIZATION_VERSION, sanitizationSettled,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import { STRICT_TYPE_READING } from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';

const SHA = 'a'.repeat(64);

function failure(fields: Record<string, unknown>) {
  return {
    [FAILURE_KEY]: {
      transformation: 'deterministic_overlay_reconstruction',
      sanitization_version: SANITIZATION_VERSION,
      original_image_id: 'img',
      original_sha256: SHA,
      reason: 'nothing_to_remove',
      detail: 'the graphic on this picture has no measurable extent to remove',
      model: null,
      failed_at: '2026-09-24T00:00:00.000Z',
      clearance_refusal: 'type_present',
      ...fields,
    },
  };
}

describe('the refusal the corrected reading can change', () => {
  it('is asked again when it was reached under an older reading', () => {
    // Every record written before the reading existed carries none.
    expect(sanitizationSettled(failure({}), SHA)).toBe(false);
    expect(sanitizationSettled(failure({ type_reading: 1 }), SHA)).toBe(false);
  });

  it('stands once the current reading has reached it', () => {
    expect(sanitizationSettled(failure({ type_reading: STRICT_TYPE_READING }), SHA)).toBe(true);
  });
});

describe('everything else stands exactly as it did', () => {
  it('keeps a refusal for anything other than type', () => {
    for (const clearance_refusal of [
      'faint_type_present', 'promotional_plate_present', 'removable_plate_present',
      'not_inspected', null,
    ]) {
      expect(sanitizationSettled(failure({ clearance_refusal }), SHA), String(clearance_refusal))
        .toBe(true);
    }
  });

  it('keeps a refusal the repair reached by trying to rebuild pixels', () => {
    // These are the answers a retry could hand to the generative route.
    for (const reason of [
      'background_too_detailed', 'too_much_to_rebuild', 'inpaint_unavailable',
      'inpaint_failed', 'uncoverable', 'validation_failed', 'still_annotated',
    ]) {
      expect(sanitizationSettled(failure({ reason }), SHA), reason).toBe(true);
    }
  });

  it('keeps every clearance and every derivative', () => {
    const clearance = {
      [CLEARANCE_KEY]: {
        sanitization_version: SANITIZATION_VERSION, original_image_id: 'img',
        original_sha256: SHA,
      },
    };
    const derivative = {
      [DERIVATIVE_KEY]: {
        sanitization_version: SANITIZATION_VERSION, original_image_id: 'img',
        original_sha256: SHA,
      },
    };
    expect(sanitizationSettled(clearance, SHA)).toBe(true);
    expect(sanitizationSettled(derivative, SHA)).toBe(true);
  });

  it('still reopens a record about other bytes, as it always did', () => {
    expect(sanitizationSettled(failure({ type_reading: STRICT_TYPE_READING }), 'b'.repeat(64)))
      .toBe(false);
  });

  it('did not move the sanitization version, so no clearance expired', () => {
    expect(SANITIZATION_VERSION).toBe(2);
  });
});
