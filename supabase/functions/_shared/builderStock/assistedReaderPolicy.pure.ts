/**
 * ============================================================================
 * THE ASSISTED READER IS OPTIONAL, OFF, AND CANNOT DECIDE AN IMPORT.
 * ============================================================================
 *
 * WHAT THIS ENDS, MEASURED ON THIS DEPLOYMENT.
 *
 * `Lot 37 - Miami 190 - Property Package.pdf`, 21 September 2026, 13:55:30 →
 * 13:55:39. Seven pages. 3,962 characters of text extracted cleanly. The
 * deterministic reader ran. The import FAILED, zero properties, and the
 * builder was told their stock list could not be read — because
 * `openrouter/openai/gpt-5.6-luna` answered `402`: an account with no credit.
 *
 * `LOT 817 - ELARA 18 TEMPIO LIGHT - BROCHURE V002 (1).pdf` had failed the
 * same way at 07:37 that morning, `LOT 315 - ENZO 8.5 LUCA` the day before.
 * One vendor's billing state was the whole pathway for reading a builder's
 * brochure.
 *
 * THE ORDER WAS THE DEFECT, not the vendor. A deterministic reading that
 * stood down was treated as NO reading, the model was asked, and the
 * deterministic evidence was brought back only as a rescue if the model
 * failed. So a paid account sat between an ordinary brochure and the
 * marketplace, on the ordinary path, every time.
 *
 * THE RULE NOW. What the document itself states, read deterministically, IS
 * the import. The assisted reader is consulted only where that produced
 * nothing at all, only where an operator has explicitly switched it on, and
 * it can never change or block an import that the document already supports.
 *
 * OFF BY DEFAULT, AND THAT IS THE POINT. An unset variable means no model
 * call, no budget reservation, no vendor round trip and no wait — not a
 * degraded mode to be repaired by paying somebody. A deployment that wants
 * the assisted reader opts in by name.
 *
 * SCOPED TO STOCK INGESTION. This is read by the stock import path alone and
 * says nothing about any other model use in this product.
 *
 * Pure: no imports, no IO. The caller supplies the environment.
 */

/** The one name that turns it on. Anything else, including unset, is off. */
export const ASSISTED_READER_FLAG = 'BUILDER_STOCK_ASSISTED_READER';

/**
 * Is the optional assisted reader switched on for stock ingestion?
 *
 * Deliberately strict: exactly `on`, `true` or `1`, case-insensitively. A
 * typo, an empty string or a leftover `false` all read as OFF, because the
 * failure of reading a typo as ON is a vendor bill and a builder waiting,
 * and the failure of reading it as OFF is a deterministic import.
 */
export function assistedReaderEnabled(
  env: { get(name: string): string | undefined },
): boolean {
  const raw = (env.get(ASSISTED_READER_FLAG) ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

/**
 * Why no properties came out of a document, in terms of what was TRIED.
 *
 * `no_properties_found` is the honest outcome when the deterministic reader
 * read the document and it states no property this pipeline can identify.
 * That is a fact about the document. It must never be confused with a model
 * that was not called or that refused — which is what the old
 * `assisted_reader_refused` said about `Lot 37`, blaming an AI account for a
 * seven-page property package.
 */
export interface AssistedReaderDisposition {
  /** Was a model consulted at all? */
  consulted: boolean;
  /** Why not, where it was not. Stable, machine-readable, safe to log. */
  skipped: 'disabled' | 'deterministic_reading_stands' | null;
}

export function assistedReaderDisposition(input: {
  enabled: boolean;
  deterministicRows: number;
}): AssistedReaderDisposition {
  if (input.deterministicRows > 0) {
    return { consulted: false, skipped: 'deterministic_reading_stands' };
  }
  if (!input.enabled) return { consulted: false, skipped: 'disabled' };
  return { consulted: true, skipped: null };
}
