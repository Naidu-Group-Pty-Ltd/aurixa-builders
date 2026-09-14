/**
 * THE FIGURES A BUILDER STATES THEMSELVES.
 *
 * A stock list does not always say how many bedrooms a house has, and the
 * extraction is right to leave the field empty rather than invent one. This is
 * the other half of that rule: the builder, who knows their own product, can
 * state it.
 *
 * ## What sent this here
 *
 * `LOT 324 - NEX 20 - V002.pdf` imported with bedrooms, bathrooms, car spaces
 * and home size all null, and the Stock List drew four em dashes. The
 * extraction had not failed — it had REFUSED. Measured on the prime, 54 of 57
 * PDF-sourced properties carry bed/bath/car, and all three that do not are the
 * same shape: `Lot 323 "NEX 20, Dual Key layout (Urban Nest Duo)"`, `Lot 324
 * "Dual key layout."`, and one more. A dual-key home is two self-contained
 * dwellings under one roof, so the brochure states two sets of figures, and
 * the model obeyed its first rule rather than collapsing them into one number.
 * An earlier spreadsheet of the same lot said `4 bed / 3 bath` — a single
 * reading of a two-dwelling property, which is the answer that is actually
 * questionable.
 *
 * No parser change could fix that. The document genuinely does not carry one
 * bedroom count, and the only party who can say what should appear on the card
 * is the builder.
 *
 * ## Four rules
 *
 * **AN OVERRIDE LIVES WHERE A RE-IMPORT CANNOT REACH IT.** This is the one
 * that makes the feature real rather than decorative. `writablePatch` in
 * `importStock.ts` names `bedrooms`, `bathrooms`, `car_spaces`,
 * `building_size_sqm` and `land_size_sqm`, and writes each whenever the file
 * states anything at all — so a figure typed into those columns survives a
 * silent file and is destroyed by the next one that speaks. The builder's
 * deliberate correction would lose to the document it was correcting, exactly
 * the way a repaired image used to lose to a re-upload (#2347). So the stated
 * figures live in `manual_stats`, a column that patch does not name, and the
 * overlay happens on READ.
 *
 * **IT IS A CORRECTION, NOT A REPLACEMENT RECORD.** Each field stands alone
 * and is absent when unstated, so clearing one returns that field to whatever
 * the document says. Nothing here ever writes over `bedrooms` and the rest:
 * the extraction stays exactly as it arrived, which is what makes this
 * reversible and what lets the dialog show a builder the reading they are
 * about to disagree with.
 *
 * **ZERO IS A VALUE.** A studio has no bedroom and a townhouse may have no car
 * space, so `0` is a statement and must round-trip. The importer's own `set()`
 * treats `''` as absent and this must not inherit that: absence is the key
 * being missing, never a falsy value.
 *
 * **HALF A BATHROOM IS REAL AND HALF A BEDROOM IS NOT.** Australian listings
 * count a powder room as 0.5, so bathrooms admit halves; rooms, car spaces and
 * square metres are whole numbers.
 */

/** A figure a builder may state. */
export type ManualStatField =
  | 'bedrooms'
  | 'bathrooms'
  | 'car_spaces'
  | 'building_size_sqm'
  | 'land_size_sqm';

export interface ManualStatSpec {
  readonly field: ManualStatField;
  /** What the builder is asked for. The schedule's own wording. */
  readonly label: string;
  /**
   * The same field inside a SENTENCE, where a bare column heading reads wrong:
   * a schedule row is headed `Home`, but "home is not specified" is not
   * English. Defaults to the lowercased label where the two agree.
   */
  readonly prose?: string;
  /** Printed after the figure, where it has a unit. */
  readonly unit: string | null;
  readonly min: number;
  readonly max: number;
  /** `0.5` admits a powder room; `1` is a whole count. */
  readonly step: number;
}

/**
 * The five facts the Stock List's schedule draws, and nothing else.
 *
 * PRICE IS DELIBERATELY ABSENT. It is the offer rather than a description of
 * the product: it reaches a client as a number they may act on, it is already
 * stated by every document this pipeline reads (57 of 57 PDF-sourced rows and
 * 923 of 957 spreadsheet rows carry one), and the builder changes it by
 * re-issuing their stock list, which is the record of what they are offering.
 * The configuration is the part a document can be silent about.
 */
export const MANUAL_STAT_SPECS: readonly ManualStatSpec[] = [
  { field: 'bedrooms', label: 'Bedrooms', unit: null, min: 0, max: 99, step: 1 },
  { field: 'bathrooms', label: 'Bathrooms', unit: null, min: 0, max: 99, step: 0.5 },
  { field: 'car_spaces', label: 'Car spaces', unit: null, min: 0, max: 99, step: 1 },
  { field: 'building_size_sqm', label: 'Home', prose: 'home size', unit: 'm²', min: 1, max: 100000, step: 1 },
  { field: 'land_size_sqm', label: 'Land', prose: 'land size', unit: 'm²', min: 1, max: 1000000, step: 1 },
] as const;

export const MANUAL_STAT_FIELDS: readonly ManualStatField[] =
  MANUAL_STAT_SPECS.map((spec) => spec.field);

const SPEC_BY_FIELD = new Map<string, ManualStatSpec>(
  MANUAL_STAT_SPECS.map((spec) => [spec.field, spec]),
);

/** What one builder stated, and when. */
export interface ManualStats {
  /** Only the fields actually stated. A missing key means the document stands. */
  values: Partial<Record<ManualStatField, number>>;
  recorded_at: string | null;
  recorded_by: string | null;
}

export interface ManualStatsParse {
  /** Null where the builder cleared every field — the whole override goes. */
  stats: ManualStats | null;
  /** One per rejected field, in field order, addressed to the builder. */
  errors: Array<{ field: ManualStatField; message: string }>;
}

/**
 * Read whatever a client sent into a stored override.
 *
 * Accepts a number or a string, because a form sends text. An empty string,
 * null or an absent key all mean "this field is not stated" and remove it —
 * which is how a builder takes a correction back. A value that is not a
 * number, or is outside its range, is REFUSED rather than clamped: silently
 * turning 3000 bedrooms into 99 records a figure nobody typed.
 */
export function parseManualStats(
  input: unknown,
  context: { recordedAt: string; recordedBy: string | null },
): ManualStatsParse {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const values: Partial<Record<ManualStatField, number>> = {};
  const errors: ManualStatsParse['errors'] = [];

  for (const spec of MANUAL_STAT_SPECS) {
    const raw = source[spec.field];
    // Absent, cleared, or blank — the document's reading stands.
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      continue;
    }
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(value)) {
      errors.push({ field: spec.field, message: `${spec.label} must be a number.` });
      continue;
    }
    if (value < spec.min || value > spec.max) {
      errors.push({
        field: spec.field,
        message: `${spec.label} must be between ${spec.min} and ${spec.max}.`,
      });
      continue;
    }
    // A half bathroom is a powder room; half a bedroom is a typing slip.
    const units = value / spec.step;
    if (Math.abs(units - Math.round(units)) > 1e-9) {
      errors.push({
        field: spec.field,
        message: spec.step === 1
          ? `${spec.label} must be a whole number.`
          : `${spec.label} must be a whole number or a half.`,
      });
      continue;
    }
    values[spec.field] = value;
  }

  if (errors.length) return { stats: null, errors };
  // Every field cleared is a withdrawal of the whole override, not an empty one.
  if (!Object.keys(values).length) return { stats: null, errors: [] };
  return {
    stats: { values, recorded_at: context.recordedAt, recorded_by: context.recordedBy },
    errors: [],
  };
}

/**
 * Read a stored override back, ignoring anything that is not a stated figure.
 *
 * Defensive because this is JSONB: a column can hold whatever an older version
 * of this code, or a hand-run statement, put there. A key that is not one of
 * the five, or whose value is not a finite number, is dropped rather than
 * trusted — the alternative is an arbitrary string reaching a card as a
 * bedroom count.
 */
export function readManualStats(stored: unknown): ManualStats | null {
  if (!stored || typeof stored !== 'object') return null;
  const row = stored as Record<string, unknown>;
  const rawValues = (row.values && typeof row.values === 'object' ? row.values : {}) as Record<string, unknown>;
  const values: Partial<Record<ManualStatField, number>> = {};
  for (const spec of MANUAL_STAT_SPECS) {
    const value = rawValues[spec.field];
    const numeric = typeof value === 'number' ? value : Number(value);
    // `0` is a statement, so the guard is finiteness and never truthiness.
    if (value === null || value === undefined || value === '' || !Number.isFinite(numeric)) continue;
    if (numeric < spec.min || numeric > spec.max) continue;
    values[spec.field] = numeric;
  }
  if (!Object.keys(values).length) return null;
  return {
    values,
    recorded_at: typeof row.recorded_at === 'string' ? row.recorded_at : null,
    recorded_by: typeof row.recorded_by === 'string' ? row.recorded_by : null,
  };
}

/** A projected stock row, in the only shape this module needs to know about. */
type StatRow = Record<string, unknown> & { manual_stats?: unknown };

/**
 * Lay a builder's stated figures over what the document said.
 *
 * THE OVERLAY HAPPENS ON READ, in the ONE place both audiences pass through,
 * so a card, the Command Centre marketplace, a geocoder and a generated report
 * all see the same property. Every consumer merging for itself is how two
 * screens come to disagree about one house.
 *
 * The document's own reading is not destroyed and not hidden: it stays in the
 * `bedrooms` column and in `source_row`, and this returns `stated_*` beside
 * the effective value so a surface can show the builder what they overrode.
 */
export function applyManualStats<T extends StatRow>(row: T): T {
  const manual = readManualStats(row.manual_stats);
  if (!manual) return { ...row, manual_stats: null } as T;
  const next: StatRow = { ...row, manual_stats: manual };
  for (const field of MANUAL_STAT_FIELDS) {
    const value = manual.values[field];
    if (value === undefined) continue;
    next[`stated_${field}`] = row[field] ?? null;
    next[field] = value;
  }
  return next as T;
}

/** Apply to a list. The shape both read paths actually call. */
export function applyManualStatsToAll<T extends StatRow>(rows: T[]): T[] {
  return rows.map(applyManualStats);
}

/**
 * Which of the five a builder stated on this row.
 *
 * Used by a surface to mark a figure as entered rather than read — a builder
 * looking at their own stock has to be able to tell the two apart, or they
 * cannot tell whether their stock list is being read correctly.
 */
export function manualStatFields(row: StatRow): ManualStatField[] {
  const manual = readManualStats(row.manual_stats);
  if (!manual) return [];
  return MANUAL_STAT_FIELDS.filter((field) => manual.values[field] !== undefined);
}
