/**
 * BUILDER STOCK — IS THIS LINK THIS PROPERTY'S, OR THE ESTATE'S?
 *
 * ONE PICTURE, FORTY HOUSES. A builder files an estate masterplan once and
 * pastes its address into every row of the stock list. A row's own cell
 * pointing at an image is the builder handing over that property's
 * photograph — but only while the link is that row's ALONE. Shared, it names
 * no house, and `acceptLinkedImageBytes` refuses it as estate collateral.
 *
 * THE COUNT THAT DECIDED IT WAS ALWAYS ZERO. Measured on production upload
 * `58010c95` (18 September 2026), reproduced over the live sheet: the counting
 * pass was handed `raw.unmapped` off each row returned by `extractStockFile`,
 * and a raw extracted row has NO `unmapped` property at all — it is keyed by
 * the SOURCE'S OWN HEADERS (`Lot #`, `Estate`, `Brochure`). `unmapped` is a
 * field of the NORMALISED record. So the expression read `undefined` on all 48
 * rows, the map finished EMPTY, and `(counts.get(url) ?? 0) > 1` answered
 * false for every link on every row of every upload. The guard had never once
 * fired on this path.
 *
 * The second contributor was empty for its own reason:
 * `unmappedWithRecoveredLinks(null, storedRow)` returns `{}` unless the row
 * carries `recovered_link_columns`, which only the authorised link RECOVERY
 * writes — a sheet whose targets were merged from the htmlview grid at import
 * has its links in `unmapped` and no recovered columns, so every stored row
 * contributed nothing too.
 *
 * Correct count for that estate's masterplan, measured over the same rows
 * normalised: TEN. It was stored as `primary_property` on three properties at
 * once, byte-identical, and each was then refused by the marketplace measure
 * as an `annotated_marketing_tile` — leaving three properties with a stored
 * image, no primary, and a stock list held for all 47.
 *
 * SO THE COUNT IS TAKEN HERE, OVER RECORDS, AND NOWHERE ELSE. A caller may
 * hand over raw rows or normalised records in any mixture; this module
 * normalises what needs it and reads `unmapped` from the record either way.
 *
 * AND IT FAILS CLOSED. `linkIsExclusiveToRow` answers false — shared, refuse —
 * whenever the evidence is not complete enough to call a link exclusive: no
 * rows counted at all, or a row set that does not cover the upload. Treating
 * an unknown as exclusive is what puts one estate's picture on somebody's
 * house; treating it as shared costs a property its linked image and leaves
 * every other branch to run.
 *
 * Pure: no IO, no clock, no network.
 */
import { normaliseStockRow, type NormalisedStockRecord } from './normalise.pure.ts';
import { rowSourceBranches, unmappedWithRecoveredLinks } from './sourceBranches.pure.ts';

/** How much of the upload the counted rows actually cover. */
export interface BranchLinkCoverage {
  /** Rows whose links were counted. */
  counted: number;
  /** Rows the upload is known to hold, where the caller knows. */
  expected: number | null;
}

export interface BranchLinkCounts {
  counts: Map<string, number>;
  coverage: BranchLinkCoverage;
}

/**
 * A row's unmapped columns, whatever shape the row arrived in.
 *
 * A NORMALISED RECORD IS NEVER RE-NORMALISED. `normaliseStockRow` reads a row
 * keyed by the source's own headers; a record is keyed by this repository's
 * field names with `unmapped` as a nested object, so putting one through it
 * loses exactly the thing being counted. The record is recognised by carrying
 * an `unmapped` object of its own — which is also precisely the test the old
 * inline expression was accidentally making, except that it then gave up
 * rather than normalising.
 */
function unmappedOf(row: unknown): Record<string, string> | null {
  if (!row || typeof row !== 'object') return null;
  const asRecord = row as { unmapped?: unknown };
  if (asRecord.unmapped && typeof asRecord.unmapped === 'object') {
    return asRecord.unmapped as Record<string, string>;
  }
  const normalised = normaliseStockRow(row as Record<string, unknown>);
  return (normalised?.unmapped as Record<string, string> | undefined) ?? null;
}

/**
 * How many of this upload's rows carry each link.
 *
 * `storedRows` are laid over the parsed ones the way the branch derivation
 * does it — a Google Sheet's targets can live only on the stored row — and a
 * row counted from both sides is counted ONCE, because the question is how
 * many PROPERTIES a link serves.
 */
export function countBranchLinkRows(input: {
  /** Rows as parsed, as normalised records, or a mixture. */
  rows?: ReadonlyArray<Record<string, unknown> | NormalisedStockRecord> | null;
  /** Each property's stored row, keyed by item id. */
  storedRowByItem?: ReadonlyMap<string, Record<string, unknown>> | null;
  /** What the upload is known to hold, where the caller knows it. */
  expectedRows?: number | null;
}): BranchLinkCounts {
  /*
   * THE TWO PASSES ARE MERGED BY MAXIMUM, NEVER SUMMED.
   *
   * The parsed rows and the stored rows describe the SAME properties — the
   * stored half exists because a Google Sheet's targets can live only there —
   * so adding them counts every property twice and would report an estate
   * masterplan on twenty rows of a forty-seven row list. The question is how
   * many PROPERTIES carry a link, so each side is counted on its own and the
   * larger reading wins: neither double-counts, and a link only one side can
   * see is still seen.
   */
  const tally = (rows: Iterable<unknown>) => {
    const counts = new Map<string, number>();
    let counted = 0;
    for (const row of rows) {
      const unmapped = unmappedOf(row);
      if (!unmapped) continue;
      counted += 1;
      const seen = new Set<string>();
      for (const branch of rowSourceBranches(unmapped)) {
        if (seen.has(branch.url)) continue;
        seen.add(branch.url);
        counts.set(branch.url, (counts.get(branch.url) ?? 0) + 1);
      }
    }
    return { counts, counted };
  };

  const parsed = tally(input.rows ?? []);

  /*
   * THE STORED ROWS, AS A ROW EACH — not as recovered columns alone.
   *
   * This pass used to call `unmappedWithRecoveredLinks(null, storedRow)`,
   * which starts from `{}` and adds only the columns a link RECOVERY named.
   * For every source whose links were read at import it returned `{}`, so the
   * stored half of the count was empty too. The row's own `unmapped` is the
   * base now and the recovered columns are laid over it, which is the same
   * rule the branch derivation itself applies.
   */
  const storedTally = tally(
    [...(input.storedRowByItem?.values() ?? [])].map((storedRow) => ({
      unmapped: unmappedWithRecoveredLinks(unmappedOf(storedRow), storedRow),
    })),
  );

  const counts = new Map(parsed.counts);
  for (const [url, n] of storedTally.counts) {
    counts.set(url, Math.max(counts.get(url) ?? 0, n));
  }

  return {
    counts,
    coverage: {
      counted: Math.max(parsed.counted, storedTally.counted),
      expected: input.expectedRows ?? null,
    },
  };
}

/**
 * May this link be treated as this one property's own?
 *
 * FALSE IS THE SAFE ANSWER and it is the default. A link is exclusive only
 * where the evidence is complete enough to say so AND exactly one row carries
 * it. Every other reading — nothing counted, a row set smaller than the upload
 * is known to hold, a URL the count never saw — is `shared`, because the
 * failure this prevents is one estate's picture published as a house.
 */
export function linkIsExclusiveToRow(input: BranchLinkCounts, url: string): boolean {
  const { counts, coverage } = input;
  if (coverage.counted <= 0) return false;
  if (coverage.expected !== null && coverage.counted < coverage.expected) return false;
  const seen = counts.get(url);
  // A link the count never saw is a link the evidence does not cover.
  if (seen === undefined || seen <= 0) return false;
  return seen === 1;
}

/** The inverse, in the wording the package recovery takes. */
export function linkSharedWithOtherRows(input: BranchLinkCounts, url: string): boolean {
  return !linkIsExclusiveToRow(input, url);
}
