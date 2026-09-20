-- ============================================================================
-- Builder Stock's assisted reader moves to OpenRouter.
-- ============================================================================
--
--   primary   openrouter  openai/gpt-5.6-luna          OPENROUTER_API_KEY
--   fallback  openrouter  google/gemini-3.8-flash      OPENROUTER_API_KEY
--
-- WHY THIS IS A ROW AND NOT AN INTEGRATION. `llmRouter` has supported the
-- `openrouter` route since the repository's first commit — `callOpenRouter`
-- posts the same OpenAI-shaped body, forwards `tools`, `tool_choice` and
-- `response_format`, and `llmUsageBinding` already maps the route to
-- `OPENROUTER_API_KEY` for metering. Nothing new is being wired; the
-- assignment simply names a route the architecture was already built for.
--
-- WHY OPENROUTER AND NOT THE GATEWAY. Lovable's gateway bills in CREDITS that
-- are shared with app-build and cloud usage on a subscription, and routing a
-- workload through one's own provider key there is enterprise-only — so a
-- per-document cost cannot be computed, and the US$10 ceiling this ships
-- beside could not be measured against anything. OpenRouter adds no markup to
-- provider token rates, publishes them per token, and reports the real cost of
-- every request in `usage.cost`, which is what `ai_budget_settle` reconciles
-- against.
--
-- WHY LUNA LEADS. At $0.20/$1.20 per million it is the cheapest model in the
-- candidate set that is not a Lite tier, and it carries what this workload
-- actually needs: image and PDF input, native tool calling, and structured
-- output against a JSON schema. Gemini 2.5 Flash Lite is half the price and
-- the entire saving across five thousand documents is about $3.60 — less than
-- one wrong price on one property is worth.
--
-- WHY GEMINI 3.8 FLASH IS THE FALLBACK AND NOT A SECOND OPENAI MODEL. A
-- fallback earns its place by failing DIFFERENTLY: another family, another
-- tokeniser, another set of refusal behaviours. It is the most expensive
-- candidate at $0.75/$3.75 and that does not matter, because it is reached
-- only when the primary has already failed — at a 5% fallback rate it costs
-- about 24 cents per five thousand properties. Its introductory rate doubles
-- on 1 January 2027; `aiBudget.pure.ts` carries the rate a hold is sized from
-- and names that date.
--
-- NO THIRD MODEL, AND NO GATEWAY ANYWHERE IN THE CHAIN. `builderStockOpenRouter.spec.ts`
-- asserts both.
--
-- This UPDATE is scoped to the row this repository seeded and to the gateway
-- chain it is replacing, so an operator who has since chosen their own models
-- is left alone — the same rule `ON CONFLICT DO NOTHING` applied when the row
-- was first written. The INSERT covers a deployment that never had the row.
-- ============================================================================

INSERT INTO public.agent_model_assignments (
  agent_key, agent_label, agent_category, agent_description,
  route, model_id, fallback_chain, temperature, max_tokens, is_active
)
VALUES (
  'builder_stock_extraction',
  'Builder stock extraction',
  'builder_portal',
  'Reads properties out of stock lists the deterministic parsers cannot: PDF '
    || 'brochures, Word documents, photographed schedules. Must support tool '
    || 'calling — the answer is returned through record_stock_items. Capped at '
    || 'US$10 per calendar month by ai_budget_reserve.',
  'openrouter',
  'openai/gpt-5.6-luna',
  '[{"route": "openrouter", "model_id": "google/gemini-3.8-flash"}]'::jsonb,
  0,
  8000,
  true
)
ON CONFLICT (agent_key) DO UPDATE
   SET route          = EXCLUDED.route,
       model_id       = EXCLUDED.model_id,
       fallback_chain = EXCLUDED.fallback_chain,
       temperature    = EXCLUDED.temperature,
       max_tokens     = EXCLUDED.max_tokens,
       is_active      = true,
       agent_description = EXCLUDED.agent_description,
       updated_at     = now()
 WHERE public.agent_model_assignments.route = 'gateway';
