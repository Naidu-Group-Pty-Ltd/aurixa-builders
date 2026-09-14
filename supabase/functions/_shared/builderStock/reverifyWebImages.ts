/**
 * BUILDER STOCK — A VERDICT WRITTEN UNDER A WORSE IDENTITY IS NOT A VERDICT.
 *
 * `verifyWebImageIdentity` is asked once, at the moment a candidate is found,
 * against whatever the property knew about itself THEN. Nothing ever asked
 * again. So an identity that improves afterwards — a locality recovered from
 * the raw row, an estate name filled in, a design named — reaches every future
 * search and none of the results already in the table.
 *
 * Measured on one upload: 14 candidates refused `no_location_evidence` because
 * the property carried no suburb at the moment they were found. The suburb was
 * recovered minutes later by `repairStoredIdentity`, and those 14 images — the
 * builder's own renders of those exact lots — stayed `unverified` for ever
 * while the cards fell through to a Street View of the road.
 *
 * This asks again, from the rows as they now stand. Three rules keep it safe:
 *
 *   IT PROMOTES FREELY AND DEMOTES ONLY ON REFUSAL BY THE CURRENT AUTHORITY. A
 *   candidate the current rule accepts is promoted; one it REFUSES is taken
 *   back to unverified with the refusal written down — because the one time
 *   the rule moves in the refusing direction is precisely when a verified
 *   card may be another builder's house (see the note at the demotion).
 *
 *   IT SPENDS NOTHING. No search, no fetch, no model: the evidence a verdict
 *   needs (the page title, the image URL) was stored beside the candidate when
 *   it was found, precisely so the question could be re-asked for free.
 *
 *   IT DECIDES NOTHING NEW. The one authority is `verifyWebImageIdentity`,
 *   imported rather than re-implemented, so what a re-judgement accepts and
 *   what a fresh search accepts cannot become two different standards.
 */
import {
  verifyWebImageIdentity, type PropertyIdentity,
} from './webImageIdentity.pure.ts';
import { WEB_SEARCH_STAGE, WEB_VERIFIED_VERIFICATION } from './imagePriority.pure.ts';

/** A stored candidate, exactly as the search wrote it. */
interface StoredCandidate {
  id: string;
  source_reference: string | null;
  source_page_url: string | null;
  verification_status: string | null;
  source_detail: Record<string, unknown> | null;
}

export interface ReverifyOutcome {
  examined: number;
  promoted: number;
  /** Verified candidates the CURRENT rule refuses, taken back to unverified. */
  demoted: number;
}

/**
 * Re-ask the identity question for one property's stored web candidates.
 *
 * BEST EFFORT, ALWAYS. This improves the inputs a later step ranks; it is
 * never the work itself, so anything it cannot do leaves the property exactly
 * as it was. A client whose `from` is not a function — a narrower test double
 * — simply skips it.
 */
export async function reverifyStoredWebImages(
  db: any,
  itemId: string,
  identity: PropertyIdentity,
): Promise<ReverifyOutcome> {
  const outcome: ReverifyOutcome = { examined: 0, promoted: 0, demoted: 0 };
  if (typeof db?.from !== 'function') return outcome;

  try {
    const { data, error } = await db
      .from('builder_stock_item_images')
      .select('id, source_reference, source_page_url, verification_status, source_detail')
      .eq('stock_item_id', itemId)
      .eq('source_stage', WEB_SEARCH_STAGE);
    if (error) return outcome;

    for (const row of ((data ?? []) as StoredCandidate[])) {
      const reference = String(row.source_reference ?? '');
      // The stage's own bookkeeping rows carry no candidate to judge.
      if (!reference || !/^https?:\/\//i.test(reference)) continue;

      const detail = (row.source_detail ?? {}) as Record<string, unknown>;
      outcome.examined += 1;

      const verdict = verifyWebImageIdentity({
        imageUrl: reference,
        pageUrl: row.source_page_url,
        title: typeof detail.title === 'string' ? detail.title : null,
        snippet: typeof detail.snippet === 'string' ? detail.snippet : null,
      }, identity);

      /*
       * A VERDICT THE CURRENT RULE REFUSES IS TAKEN BACK — including one that
       * was accepted before.
       *
       * "It only ever promotes" was this module's founding rule, written
       * against blanking a card for no reason anyone can see. It survived
       * until the rule it defers to was wrong in the accepting direction:
       * Luxton's Lot 818 carried a verified render taken from a page titled
       * `lot-118-by-simonds-homes` — another lot, by another builder — passed
       * because the image FILE NAME said 818 and the old haystack merged it
       * with the page. `verifyWebImageIdentity` now reads the lot from the
       * page alone, but a promote-only re-judgement could never reach the one
       * card that rule change exists for.
       *
       * The founding fear is answered rather than dismissed: the demotion is
       * DETERMINISTIC (judged from the same stored evidence the acceptance
       * was), it happens only when the current authority refuses, and the
       * reason is written where an operator reads
       * (`identity_refused`). `chooseCardImage` then re-decides the pointer
       * from what remains, on the sweep that already does so — a wrong house
       * leaves the card, and that is a reason anyone can see.
       */
      if (!verdict.ok && row.verification_status === WEB_VERIFIED_VERIFICATION) {
        const { error: demoteError } = await db
          .from('builder_stock_item_images')
          .update({
            verification_status: 'unverified',
            source_detail: {
              ...detail,
              identity_matched: null,
              identity_refused: verdict.reason ?? 'refused',
              property_identity: null,
              identity_demoted_at: new Date().toISOString(),
            },
          })
          .eq('id', row.id);
        if (!demoteError) outcome.demoted += 1;
        continue;
      }
      if (row.verification_status === WEB_VERIFIED_VERIFICATION) continue;
      if (!verdict.ok) continue;

      const { error: writeError } = await db
        .from('builder_stock_item_images')
        .update({
          verification_status: WEB_VERIFIED_VERIFICATION,
          source_detail: {
            ...detail,
            identity_matched: verdict.matched,
            identity_refused: null,
            /*
             * The evidence `isVerifiedWebImage` requires before it will show a
             * row — the same shape the search path writes, so a promoted
             * candidate and a freshly verified one are indistinguishable.
             */
            property_identity: {
              matched: verdict.matched,
              verified_at: new Date().toISOString(),
              reverified: true,
            },
          },
        })
        .eq('id', row.id);
      if (!writeError) outcome.promoted += 1;
    }
  } catch {
    // Never fatal: the property keeps whatever picture it already had.
  }
  return outcome;
}
