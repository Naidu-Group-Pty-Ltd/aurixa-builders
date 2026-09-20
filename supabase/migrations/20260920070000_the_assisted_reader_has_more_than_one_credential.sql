-- ============================================================================
-- The assisted stock reader is CONFIGURED, and its chain crosses credentials.
-- ============================================================================
--
-- `builder_stock_extraction` is the agent key every model-assisted stock
-- import goes through — a PDF brochure, a Word document, a photographed
-- schedule, any source whose rows the deterministic readers cannot see. It is
-- the ONLY consumer of `llmRouter` in this deployment.
--
-- It had never been configured anywhere. `agent_model_assignments` held ZERO
-- rows on this project (measured 20 September 2026), no migration in this
-- repository has ever seeded that key, and `20260915130000` says so on
-- purpose: "No seed rows: llmRouter's documented legacy fallback applies while
-- the table is empty, and assignments are an operator decision."
--
-- What that left is the router's compiled-in legacy pair:
--
--     gateway / google/gemini-3-flash-preview
--     gateway / google/gemini-2.5-flash
--
-- Both real, both in active use on the prime — and BOTH ON ONE ROUTE, so both
-- spend one credential, `LOVABLE_API_KEY`. A chain whose every step fails for
-- the same reason is not a fallback chain; it is one attempt written twice.
-- On 20 September 2026 three brochure uploads failed in about five seconds
-- each — far too fast for a provider to have been asked anything — with
-- `[llmRouter] All 2 models failed for agent_key=builder_stock_extraction`,
-- and the builder was told their brochure needed column headings.
--
-- So the chain crosses CREDENTIALS, not just model names:
--
--   primary     gateway     google/gemini-2.5-flash        LOVABLE_API_KEY
--   fallback 1  gateway     google/gemini-3-flash-preview  LOVABLE_API_KEY
--   fallback 2  native      gpt-4o-mini                    OPENAI_API_KEY
--
-- The first two are the legacy pair with the proven model leading (the prime
-- used `gemini-2.5-flash` six hours before this deployment's failure); the
-- third is the one that matters, because it is reached by a different key. A
-- missing, rotated or refused gateway credential now costs a fallback step
-- instead of the whole feature. All three support the tool call this agent
-- requires, which is not optional: `record_stock_items` is how the answer is
-- structured, and a model that cannot call it is a model that cannot serve
-- this agent at all.
--
-- Two things this deliberately does NOT do.
--
-- It does not overrule an operator. `ON CONFLICT DO NOTHING` fills an ABSENT
-- key and never rewrites one somebody has decided about — the rule
-- `market-updates-ingest` already answers to for its canonical registry, and
-- the reason the Model Hub remains the place this is changed.
--
-- It carries no credential. Which key each route spends is resolved at call
-- time from the deployment's environment; this row names routes and models,
-- which are configuration and not secrets.
--
-- NOTE FOR A CLONE: a row a migration INSERTs does not travel with a
-- provisioned copy of this schema, so this must be applied to each deployment
-- rather than assumed present because the ledger lists it. That is the same
-- gap `CLONE_PROVISIONING_GAPS.md` records, and it is why this is written to
-- be safely re-runnable.
-- ============================================================================

INSERT INTO public.agent_model_assignments (
  agent_key,
  agent_label,
  agent_category,
  agent_description,
  route,
  model_id,
  fallback_chain,
  temperature,
  max_tokens,
  is_active
)
VALUES (
  'builder_stock_extraction',
  'Builder stock extraction',
  'builder_portal',
  'Reads properties out of stock lists the deterministic parsers cannot: PDF '
    || 'brochures, Word documents, photographed schedules. Must support tool '
    || 'calling — the answer is returned through record_stock_items.',
  'gateway',
  'google/gemini-2.5-flash',
  '[{"route": "gateway", "model_id": "google/gemini-3-flash-preview"},
     {"route": "native",  "model_id": "gpt-4o-mini"}]'::jsonb,
  0,
  8000,
  true
)
ON CONFLICT (agent_key) DO NOTHING;
