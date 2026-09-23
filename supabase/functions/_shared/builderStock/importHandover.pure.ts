/**
 * Builder stock — WHAT AN IMPORT HANDS TO THE ISOLATE THAT ATTACHES ITS PICTURES.
 *
 * ===========================================================================
 * WHY THE IMPORT CROSSES HERE.
 * ===========================================================================
 *
 * An isolate that parses a PDF decodes none of its pictures
 * (`documentRead.pure.ts` has the production measurement: `LOT 550 - ENZO 8.5
 * MODERN- BROCHURE V002.pdf` killed on `process_upload`, on its recovery and
 * on "Read again", each time after the reader had finished, inside the decode
 * that decides the pictures' roles).
 *
 * The first answer to that sent the pictures to the image settler and did
 * not attach them here at all. The acceptance gate refused it on its first
 * run: ten single-property brochures with no photograph on the card. The
 * settler's source repair re-reads a stored brochure without the evidence the
 * importer reads it with — the organisation's own name, the document's own
 * name — so the property it reads is not the property the import wrote, it
 * matches none of them (`stored 0, matched 0`, on all 151 of its attempts),
 * and the pictures land against nobody. For a brochure, the importer's attach
 * is the only one that attributes a picture. It has to run; it cannot run
 * where the document was parsed.
 *
 * So THE IMPORT ITSELF crosses. It reads the document and decides it — the
 * rows it will write, the strategy, the completed fields, the diagnosis —
 * exactly as it always has, writes the read and the decision down, and hands
 * on through the continuation `continue_import` already is. The successor
 * restores both and runs the one tail every import runs: the same
 * `importStockRecords`, the same `attachDocumentMedia`, with the same inputs.
 * Nothing is re-decided on the far side, so which reading a builder gets
 * cannot depend on where the CPU ran out.
 *
 * ===========================================================================
 * WHAT TRAVELS.
 * ===========================================================================
 *
 * Everything the tail of an import reads and nothing else. The pictures and
 * the page texts travel as the document read (`documentRead.pure.ts`, purpose
 * `import`); this is the rest — the DECISION — and it rides in that read's
 * manifest so the two can never describe different attempts.
 *
 * A TOKEN BINDS IT TO ONE ATTEMPT. The token is minted when the decision is
 * written and recorded in the import's checkpoint; a successor takes only the
 * decision its checkpoint names. A fresh attempt drops the token
 * (`freshAttempt`), so a decision a previous attempt left behind can never be
 * written on today's request.
 *
 * Pure: no IO, no clock.
 */
import type { RowLinkDiscovery } from './suppliedEvidence.pure.ts';

/** The shape's own version, so a successor can refuse one it does not know. */
export const IMPORT_HANDOVER_VERSION = 1;

/**
 * The decision an import made from its read, as the tail consumes it.
 *
 * Each field is named for the value `runImport.ts` reads at the same point,
 * and none of them is re-derived by the successor.
 */
export interface ImportDecision {
  /** The strategy the document was read by, as recorded on the row. */
  strategy: string;
  /** The rows the import writes — after the provisional and completed readings. */
  rows: Array<Record<string, unknown>>;
  /** Fields a model completed, named. Empty wherever no model was consulted. */
  completedFields: string[];
  /** What the bytes were detected as. */
  detectedMime: string | null;
  /** How the file was classified — which decides the no-properties sentence. */
  classificationKind: string;
  /** The link layer's reading, stamped onto every row. */
  linkDiscovery: RowLinkDiscovery;
  /** The extractor's own warnings. */
  warnings: string[];
  /** Why the document's images were never decompressed, where they were not. */
  imageryDeferred: unknown | null;
  /** The deterministic reader's safe-to-log diagnosis. */
  deterministicReading: unknown | null;
  /** How many provisional rows the reader had when it stood down. A count only. */
  deterministicProvisionalCount: number;
  /** The reader's unaccounted and ignored lines, for the internal diagnosis. */
  deterministicUnaccounted: string[] | null;
  deterministicIgnored: string[] | null;
  deterministicPlacement: string[] | null;
}

/** The whole of what rides in an `import` read's manifest. */
export interface ImportHandover {
  v: number;
  /** Names this hand-off; recorded in the checkpoint that may take it. */
  token: string;
  decision: ImportDecision;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value as string[] : null;

/** Compose what the manifest carries. */
export function composeImportHandover(token: string, decision: ImportDecision): ImportHandover {
  return { v: IMPORT_HANDOVER_VERSION, token, decision };
}

/**
 * The decision a stored hand-off carries for THIS token, or null.
 *
 * Null for: nothing stored, a shape this build does not know, and — the one
 * that matters — a hand-off minted for a different attempt. Every field is
 * checked for the type the tail reads, because the tail was written for the
 * values an extraction produces and a successor must hand it nothing else.
 */
export function readImportHandover(
  stored: unknown, token: string | null | undefined,
): ImportDecision | null {
  if (!token || !stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const handover = stored as Partial<ImportHandover>;
  if (handover.v !== IMPORT_HANDOVER_VERSION) return null;
  if (handover.token !== token) return null;
  const decision = handover.decision as Partial<ImportDecision> | undefined;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null;
  if (typeof decision.strategy !== 'string' || !decision.strategy) return null;
  if (!Array.isArray(decision.rows)
    || !decision.rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return null;
  }
  const completedFields = strings(decision.completedFields);
  const warnings = strings(decision.warnings);
  if (!completedFields || !warnings) return null;
  if (decision.detectedMime !== null && typeof decision.detectedMime !== 'string') return null;
  if (typeof decision.classificationKind !== 'string' || !decision.classificationKind) return null;
  const link = decision.linkDiscovery as RowLinkDiscovery | undefined;
  if (!link || typeof link !== 'object' || typeof link.state !== 'string') return null;
  const provisional = Number(decision.deterministicProvisionalCount);
  if (!Number.isInteger(provisional) || provisional < 0) return null;
  const optionalLines = (value: unknown): string[] | null | undefined =>
    value === null || value === undefined ? null : (strings(value) ?? undefined);
  const unaccounted = optionalLines(decision.deterministicUnaccounted);
  const ignored = optionalLines(decision.deterministicIgnored);
  const placement = optionalLines(decision.deterministicPlacement);
  if (unaccounted === undefined || ignored === undefined || placement === undefined) return null;
  return {
    strategy: decision.strategy,
    rows: decision.rows as Array<Record<string, unknown>>,
    completedFields,
    detectedMime: decision.detectedMime ?? null,
    classificationKind: decision.classificationKind,
    linkDiscovery: link,
    warnings,
    imageryDeferred: decision.imageryDeferred ?? null,
    deterministicReading: decision.deterministicReading ?? null,
    deterministicProvisionalCount: provisional,
    deterministicUnaccounted: unaccounted,
    deterministicIgnored: ignored,
    deterministicPlacement: placement,
  };
}
