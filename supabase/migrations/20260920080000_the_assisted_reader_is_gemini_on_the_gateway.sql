-- ============================================================================
-- The assisted stock reader is Gemini on the gateway, and nothing else.
-- ============================================================================
--
-- `20260920070000` seeded `builder_stock_extraction` with a chain that crossed
-- CREDENTIALS — two gateway Gemini models followed by `native/gpt-4o-mini` —
-- on the reasoning that a chain whose every step spends one credential is one
-- attempt written twice.
--
-- The retry that followed answered the question that reasoning was built on,
-- and answered it differently than expected. All THREE steps came back
-- `provider_not_configured`:
--
--   gateway/google/gemini-2.5-flash       : unconfigured
--   gateway/google/gemini-3-flash-preview : unconfigured
--   native/gpt-4o-mini                    : unconfigured
--
-- So the OpenAI step bought nothing. It was reached, it was tried, and it was
-- as unconfigured as the two before it — this deployment holds neither vendor
-- key. Route diversity cannot rescue a deployment with no credentials at all;
-- only setting one can, and that is configuration rather than code.
--
-- Builder Stock has always read its brochures with Gemini through the gateway.
-- `modelExtract.ts` has named `builder_stock_extraction` since it was written,
-- and the router's own compiled-in default for it is the two Gemini models
-- below. That is the path this feature is defined by, and adding a second
-- vendor to it was a diagnostic step rather than a decision anybody took about
-- the product. It is withdrawn here.
--
-- WHAT IS LEFT is exactly the original intent, now stated explicitly rather
-- than inherited from a compiled-in default:
--
--   primary     gateway  google/gemini-2.5-flash        LOVABLE_API_KEY
--   fallback    gateway  google/gemini-3-flash-preview  LOVABLE_API_KEY
--
-- The row is KEPT rather than deleted, for three reasons that outlive this
-- change. It is visible and editable in the Model Hub, where a compiled-in
-- default is not. It survives a future change to the router's defaults. And
-- `recordAssignmentFailure` writes `last_error` by `agent_key`, so without a
-- row that write matches nothing — which is precisely why the original
-- failure went undiagnosed for as long as it did. That field is what proved
-- the credential finding above.
--
-- SCOPED TO UNDO OUR OWN SEED, NEVER AN OPERATOR'S CHOICE. The `WHERE` clause
-- matches only a chain that still carries the exact entry `20260920070000`
-- wrote. An operator who has since chosen their own chain — including one that
-- deliberately names another vendor — is left alone, which is the same rule
-- `ON CONFLICT DO NOTHING` applied on the way in.
--
-- No credential is named or carried here. Which key the gateway route spends
-- is resolved at call time from the deployment's environment.
-- ============================================================================

UPDATE public.agent_model_assignments
   SET fallback_chain = '[{"route": "gateway", "model_id": "google/gemini-3-flash-preview"}]'::jsonb,
       updated_at     = now()
 WHERE agent_key = 'builder_stock_extraction'
   AND fallback_chain @> '[{"route": "native", "model_id": "gpt-4o-mini"}]'::jsonb;
