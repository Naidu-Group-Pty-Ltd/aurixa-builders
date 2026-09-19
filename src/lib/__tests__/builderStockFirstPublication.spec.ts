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
const PAGE = "src/pages/builder/BuilderStockList.tsx";
const SCALE = "scripts/db/stock-scale-proof.mjs";

describe("which upload may publish part of itself", () => {
  const sql = read(MIGRATION);

  it("reads the mode off what the upload SUPERSEDES, never off live rows", () => {
    /*
     * THE TRAP THIS AVOIDS. "The organisation has no live properties" is the
     * obvious reading of "first upload" and it FLIPS the moment the first
     * partial publication makes rows active — so the builder fixes their last
     * property, it settles ready, and publication refuses it because the
     * upload has become a replacement of itself.
     *
     * `replaces_upload_ids` is written once at import and never changes, so
     * the mode is a fact about the upload for its whole life.
     */
    expect(sql).toContain(
      "coalesce(array_length(u.replaces_upload_ids, 1), 0) = 0 AS first_publication",
    );
    // Nothing anywhere derives the mode from how much is currently live.
    expect(sql).not.toMatch(/first_publication[\s\S]{0,200}lifecycle_status\s*=\s*'active'/);
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
