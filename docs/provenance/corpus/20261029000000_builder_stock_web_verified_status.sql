-- Builder Stock — the column refused the only value that makes a web image
-- displayable, so no web photograph has ever reached a card.
--
--
-- WHAT THE CONSTRAINT SAID.
--
--   CHECK (verification_status IN ('source_supplied','location_derived','unverified'))
--
-- and `imagePriority.pure.ts` has, since web verification was introduced:
--
--   export const WEB_VERIFIED_VERIFICATION = 'property_identity_verified';
--
-- The comment beside that constant explains exactly why it is a new value —
-- "DELIBERATELY NOT `verified`, and not any value already in the table",
-- because every historical row is `unverified` and a reused value would make
-- the rule retroactive. That reasoning is right. The column was simply never
-- widened to accept it.
--
-- So `isVerifiedWebImage` requires a state the database rejects. Every write
-- of it — from the search path when a candidate passes its identity check, and
-- from `reverifyStoredWebImages` when a stored candidate is re-judged — is
-- refused by Postgres with a constraint violation.
--
--
-- WHAT IT COST, MEASURED.
--
-- 439 `internet_search` rows in production. Every one `unverified`. Not one
-- has ever been shown. The builder's own photograph of the exact property —
-- found, downloaded, stored, and correctly identified — could not be recorded
-- as identified, so `chooseAndStorePrimaryImage` passed over it and the card
-- fell through to a Street View of the road outside the estate.
--
-- That is the last of the four reasons the wrong picture was on the screen,
-- and it is the one that made the other three invisible: with this in place,
-- fixing the veto ordering and re-judging stale verdicts changes nothing that
-- anybody can see.
--
--
-- THE VALUE IS ADDED, NOT SUBSTITUTED. The three existing states keep their
-- exact meanings and every stored row keeps its own, so nothing is rewritten
-- and nothing becomes displayable that was not already judged displayable.
-- This widens what may be RECORDED; `isVerifiedWebImage` remains the only
-- thing that decides what may be SHOWN, and it is untouched.

ALTER TABLE public.builder_stock_item_images
  DROP CONSTRAINT IF EXISTS builder_stock_item_images_verification_status_check;

ALTER TABLE public.builder_stock_item_images
  ADD CONSTRAINT builder_stock_item_images_verification_status_check
  CHECK (verification_status = ANY (ARRAY[
    'source_supplied'::text,
    'location_derived'::text,
    'unverified'::text,
    -- The state a web result reaches by passing `verifyWebImageIdentity`, and
    -- the only one `isVerifiedWebImage` will display. Named in
    -- `imagePriority.pure.ts` as WEB_VERIFIED_VERIFICATION.
    'property_identity_verified'::text
  ]));


-- ── And look again at every property this silently cost ─────────────────────
/*
 * The stored candidates are unchanged and still carry the evidence a verdict
 * needs, so `reverifyStoredWebImages` can now record what it could not record
 * before — without a search, a fetch or a model call, because it re-judges the
 * rows already in the table.
 *
 * It runs on a CLAIM, and a settled property is never claimed, so the ladder
 * generation is what hands them back. A property whose candidate now verifies
 * answers `none` at the fallback stage before either paid rung is considered,
 * so promotion costs nothing at all.
 */
UPDATE public.builder_stock_settlement_target
   SET image_ladder_generation_at = now(),
       updated_at = now();

DO $rearm$
BEGIN
  PERFORM public.ensure_builder_stock_settlement_scheduled();
END;
$rearm$;
