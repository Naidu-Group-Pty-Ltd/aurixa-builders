/**
 * A first stock list is not held hostage by one bad row.
 *
 * MEASURED, 18 SEPTEMBER 2026. 47 properties imported, 46 earned a ready
 * builder-source photograph, and ONE — Lot 1037 Vanta 20 — carries a brochure
 * and a stage plan whose covers both name `Lot 1307 Fuchsia Street`, a SIBLING
 * property. That is a genuine builder-source deficiency: nothing in this
 * pipeline can fix it and nothing in this pipeline should pretend to. The
 * publication invariant is strict and correct, so the whole list stayed staged
 * and the builder's marketplace showed ZERO properties.
 *
 * Forty-six correct properties withheld to punish one incorrect one is the
 * wrong answer, and `20260919030000_first_publication_publishes_what_is_ready`
 * is the right one.
 *
 * WHAT THESE ASSERTIONS ARE FOR. The migration carries its own post-apply
 * proof — nine scenarios executed against real rows, rolled back, run by the
 * `baseline` job on every push — and that is the authority on BEHAVIOUR: it
 * was mutation-tested at 13 of 13, so no rule in it can be dropped without a
 * scenario failing. These pin the DECISIONS that execution cannot see: which
 * expression the mode is derived from, that the two promote steps ask the
 * same question, and that the readers downstream followed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const MIGRATION = "supabase/migrations/20260919030000_first_publication_publishes_what_is_ready.sql";
const CORRECTION = "supabase/migrations/20260919040000_a_replacement_is_one_with_a_live_list_to_protect.sql";
const PAGE = "src/pages/builder/BuilderStockList.tsx";
const SCALE = "scripts/db/stock-scale-proof.mjs";

describe("which upload may publish part of itself", () => {
  const sql = read(MIGRATION);

  it("asks whether anything this upload supersedes is LIVE", () => {
    /*
     * THIS ASSERTION REPLACES ITS OWN FIRST VERSION, and the reason is worth
     * keeping. The rule shipped as `array_length(replaces_upload_ids) = 0` —
     * "names no predecessor at all" — which is a PROXY for the question
     * atomic cutover answers: is there a live generation a partial promotion
     * would mix with?
     *
     * Measured against production an hour after it shipped, the proxy was
     * wrong in exactly the case the feature was built for. The builder had
     * two uploads: `2c412938` (09:26, supersedes nothing, NEVER published)
     * and `58010c95` (09:41, supersedes it, never published), with all 47
     * properties on the second — 46 with a ready builder-source primary and
     * one whose documents name a sibling property. They had re-imported
     * fifteen minutes in, long before the photographs finished. So the live
     * upload was a REPLACEMENT OF AN UPLOAD THAT NEVER WENT LIVE, the rule
     * did not fire, and the marketplace stayed at zero — the outcome the
     * whole migration exists to prevent.
     *
     * The corrected rule is the question itself.
     */
    const fix = read(CORRECTION);
    expect(fix).toContain("live.lifecycle_status = 'active'");
    expect(fix).toContain("live.upload_id = ANY(coalesce(u.replaces_upload_ids, '{}'))");
  });

  it("does not flip once its own partial publication makes rows live", () => {
    /*
     * THE TRAP THE FIRST VERSION WAS RIGHT ABOUT. "The organisation has no
     * live properties" is the obvious reading and it flips the moment a
     * partial publication makes rows active — the builder then fixes their
     * last property and publication refuses it, because the upload has
     * become a replacement of itself.
     *
     * The corrected rule reads the SUPERSEDED uploads' active counts, which
     * promoting this upload's own rows cannot change. Asserted by execution
     * in the migration (it publishes, then re-reads the mode); asserted here
     * as the structural fact that makes it true — the predicate is scoped to
     * superseded uploads and explicitly excludes this one.
     */
    const fix = read(CORRECTION);
    expect(fix).toContain("live.upload_id <> u.id");
    expect(fix).toContain("the mode flipped after its own partial publication");
    // And never the whole-organisation reading.
    expect(fix).not.toMatch(/first_publication[\s\S]{0,120}live\.organisation_id/);
  });

  it("leaves the strict all-or-nothing answer exactly as it was", () => {
    // `ready` is what every existing caller reads and what a REPLACEMENT
    // upload must still answer to. All four conditions, unchanged.
    for (const condition of [
      "c.total > 0",
      "AND c.open_work = 0",
      "AND c.failed_items = 0",
      "AND c.missing_primary = 0",
    ]) expect(sql).toContain(condition);
  });

  it("binds the truncation gates to BOTH answers", () => {
    // A list we could not fully read is not a list with some rows missing.
    // Both `ready` and `partial_ready` end on the same two gates.
    const gates = sql.split("AS ready,")[1] ?? "";
    expect(gates).toContain("g.assets_settled");
    expect(gates).toContain("g.manifest_ok");
    expect(sql).toMatch(/AND g\.assets_settled\s*\n\s*AND g\.manifest_ok\s*\n\s*AS partial_ready/);
  });

  it("waits for the work to finish before publishing part of a list", () => {
    // Publishing while rows are still climbing the ladder would make the
    // marketplace count creep for ten minutes — a list being watched rather
    // than a list going live.
    expect(sql).toMatch(/coalesce\(u\.first_publication, false\)\s*\n\s*AND c\.open_work = 0/);
  });
});

describe("the photograph rule", () => {
  const sql = read(MIGRATION);

  it("is stated once, and all three conditions are in it", () => {
    /*
     * It was written out in full in three places, and one of them decides
     * whether a property is on the marketplace. Three copies of one rule is
     * how two of them come to disagree.
     */
    const rule = sql.slice(
      sql.indexOf("FUNCTION public.builder_stock_photo_is_source_ready"),
      sql.indexOf("COMMENT ON FUNCTION public.builder_stock_photo_is_source_ready"),
    );
    expect(rule).toContain("im.source_stage        = 'uploaded_document'");
    expect(rule).toContain("im.verification_status = 'source_supplied'");
    expect(rule).toContain("im.processing_status   = 'ready'");
  });

  it("is what both promote steps ask, and they ask it identically", () => {
    /*
     * The late promotion is a SECOND promote step and therefore a second
     * chance to get the rule wrong. Two spellings of one question is how one
     * of them ends up laxer than the other.
     */
    const promotes = sql.match(
      /AND image_work_stage = 'settled'\s*\n\s*AND public\.builder_stock_photo_is_source_ready\(primary_image_id\)/g,
    ) ?? [];
    expect(promotes.length).toBe(2);
  });

  it("is what the progress reading counts, rather than its own copy", () => {
    const progress = sql.slice(
      sql.indexOf("FUNCTION public.builder_stock_image_progress"),
      sql.indexOf("COMMENT ON FUNCTION public.builder_stock_image_progress"),
    );
    expect(progress).toContain(
      "public.builder_stock_photo_is_source_ready(i.primary_image_id)",
    );
    // And no longer spells the three conditions out for itself.
    expect(progress).not.toContain("im.source_stage = 'uploaded_document'");
  });
});

describe("what a published-but-incomplete list still owes", () => {
  const sql = read(MIGRATION);
  const page = read(PAGE);

  it("keeps the reason on the upload while anything is held back", () => {
    // Clearing it — as the atomic path rightly does when it publishes
    // everything — would take away the only thing telling the builder a
    // property of theirs is not on the marketplace.
    expect(sql).toContain("still needs a photograph from you");
    expect(sql).toMatch(
      /image_failure_state = CASE WHEN v_withheld > 0 THEN image_failure_state ELSE 'none' END/,
    );
  });

  it("keeps the watchdog watching it", () => {
    /*
     * Its upload-level surfacing loop filtered on `published_at IS NULL`,
     * which was the same question as "is anything still owed" right up until
     * this migration. This loop is the only thing that pages a person when a
     * held-back property goes wrong later.
     */
    const watchdog = sql.slice(sql.indexOf("FUNCTION public.builder_stock_image_watchdog"));
    expect(watchdog).toContain("u.published_at IS NULL OR EXISTS (");
    expect(watchdog).toContain("i.upload_id = u.id AND i.lifecycle_status = 'staged'");
  });

  it("keeps the builder's own page showing it", () => {
    expect(page).toContain("owesAPhotograph");
    expect(page).toContain("const listIsLive = progressRecord?.published === true");
  });

  it("keeps the publish sweep reconsidering it", () => {
    /*
     * `publish_ready_builder_stock_uploads` looked only at unpublished
     * uploads, so the LATE promotion would have rested entirely on
     * `publishUploadIfReady` firing from the per-item path — and a builder
     * whose repaired property missed that one call would have waited for
     * ever with no second chance anywhere.
     */
    const sweep = sql.slice(sql.indexOf("FUNCTION public.publish_ready_builder_stock_uploads"));
    expect(sweep).toContain("u.published_at IS NULL OR EXISTS (");
  });
});

describe("something still has to be running when the picture arrives", () => {
  const fn = read("supabase/functions/builder-portal-stock/index.ts");

  it("the builder's own act starts the work", () => {
    /*
     * `attachBuilderImage` requeues the property; it does not start a worker
     * and it does not keep the every-minute job ALIVE. That job unschedules
     * itself when nothing is outstanding, and a first publication makes
     * "nothing outstanding" reachable while a builder still has properties
     * to fix — so the picture would sit in the table with nothing looking at
     * it. The same "picture saved, card still blank" failure `suppliedDirectly`
     * closed, arriving by a different door.
     */
    const attach = fn.slice(
      fn.indexOf("if (operation === 'attach_builder_image')"),
      fn.indexOf("scope: 'property', properties: 1"),
    );
    expect(attach).toContain("builder_stock_kick_image_work");
    // And a failed kick never reports a loss that did not happen: the
    // picture IS stored and requeued.
    expect(attach).toContain("console.warn");
    expect(attach).not.toMatch(/kickError[\s\S]{0,160}return json\(\{ error/);
  });
});

describe("the scale proof asserts both halves of the split", () => {
  const scale = read(SCALE);

  it("a FIRST list of 49 ready and 1 failed publishes the 49", () => {
    expect(scale).toContain(
      "49 ready + 1 failed on a FIRST list publishes the 49 and holds the 1",
    );
    expect(scale).toContain("p.mode === 'first_publication'");
  });

  it("a REPLACEMENT with the same shape still publishes nothing", () => {
    /*
     * The value of the first half is only visible beside this one. Atomic
     * cutover exists because a partial promotion on a replacement leaves the
     * marketplace showing rows of the new generation beside rows of the old.
     */
    expect(scale).toContain(
      "49 ready + 1 failed on a REPLACEMENT still publishes nothing",
    );
    expect(scale).toContain("predecessorLive === n - 1");
  });
});

/**
 * A manifest row records what happened to its branch.
 *
 * MEASURED ON PRODUCTION, 19 September 2026. The live upload held 110
 * `pending` source assets and could not publish — a gate
 * `publication_blocked_reason` never mentions, so the upload advertised
 * "1 of 47 without a photo, 1 failed" while a second, unnamed condition
 * held it as well. Every one of those rows belonged to a property that had
 * SETTLED WITH A READY BUILDER-SOURCE PHOTOGRAPH, in two populations:
 *
 *   72  the branch was answered and the row never heard, because the verdict
 *       was written against whichever upload was current at the time and a
 *       replacement re-enumerates the same branches as fresh pending rows;
 *   38  the branch was never opened, because the property found its
 *       photograph in an earlier document and stopped.
 *
 * Between them, a stock list is permanently unpublishable once it has been
 * re-imported or once any property settles early — which is every list.
 * Nothing in this deployment had ever published.
 */
describe("the source manifest converges", () => {
  const RECONCILE = "supabase/migrations/20260919050000_a_manifest_row_records_what_happened_to_its_branch.sql";
  const sql = read(RECONCILE);

  it("gives a document nobody opened its own word, not a finding", () => {
    /*
     * NOT `no_image`, which asserts the document names no photograph — a
     * verdict nobody reached, about a document nobody read. Inventing a
     * finding we did not make is the failure this repository keeps paying
     * for, so the state is its own.
     */
    expect(sql).toContain("'not_required'::text");
    expect(sql).toContain("SET state = 'not_required'");
    expect(sql).toContain("so this one was not opened");
  });

  it("closes a document only where the property is settled AND photographed", () => {
    /*
     * This is what keeps the gate meaning something. A property still
     * climbing the ladder, one that failed, and one that settled blank all
     * keep their pending rows and keep blocking — the migration asserts all
     * three by execution.
     */
    const closing = sql.slice(sql.indexOf("SET state = 'not_required'"));
    expect(closing).toContain("i.image_work_stage = 'settled'");
    expect(closing).toContain("public.builder_stock_photo_is_source_ready(i.primary_image_id)");
  });

  it("adopts a verdict only for the SAME document of the SAME property", () => {
    // Matched on the property and the exact reference, so nothing is carried
    // between properties or between different documents of one property.
    expect(sql).toContain("AND a.stock_item_id = s.stock_item_id");
    expect(sql).toContain("AND a.reference = s.reference");
    // And never adopts a row that is itself unresolved.
    expect(sql).toContain("WHERE q.state <> 'pending'");
  });

  it("is run by the sweep that is about to read the answer", () => {
    /*
     * The rule being right is not the same as the rule running. A sweep that
     * stopped calling it would leave every other assertion passing while no
     * upload in production was ever reconciled, so the migration proves the
     * wiring by publishing through `publish_ready_builder_stock_uploads`.
     */
    const sweep = sql.slice(sql.indexOf("FUNCTION public.publish_ready_builder_stock_uploads"));
    expect(sweep).toContain("builder_stock_reconcile_source_manifest(v_upload.id)");
    expect(sweep).toContain("manifest_rows_reconciled");
    const reconcileAt = sweep.indexOf("builder_stock_reconcile_source_manifest");
    const publishAt = sweep.indexOf("publish_builder_stock_upload(v_upload.id)");
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(reconcileAt);
  });

  it("scopes every write to the upload it was asked about", () => {
    // It takes an upload id and is called per upload; one that quietly
    // repaired every upload in the table would be doing work nobody asked
    // for on lists nobody is publishing.
    const fn = sql.slice(
      sql.indexOf("FUNCTION public.builder_stock_reconcile_source_manifest"),
      sql.indexOf("COMMENT ON FUNCTION public.builder_stock_reconcile_source_manifest"),
    );
    expect((fn.match(/a\.upload_id = p_upload_id/g) ?? []).length).toBe(2);
  });
});
