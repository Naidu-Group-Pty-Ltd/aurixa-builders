-- The end state of every object the six out-of-band migrations of 20 Sep 2026
-- touched, in a form that can be compared across two databases.
--
-- Run identically against production and against a database rebuilt from this
-- repository; the two outputs must be equal line for line. Role names are
-- reduced to what matters for security — which of PUBLIC, anon, authenticated
-- and service_role may do what — because the owner and grantor differ between a
-- hosted project and a local rebuild without that meaning anything.
WITH
fns AS (
  SELECT p.oid, p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'ai\_budget\_%'
),
fn_acl AS (
  SELECT f.proname, f.args,
         string_agg(
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END || ':' || a.privilege_type,
           ',' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END, a.privilege_type
         ) FILTER (WHERE a.grantee = 0 OR r.rolname IN ('anon','authenticated','service_role')) AS acl
    FROM fns f
    JOIN pg_proc p ON p.oid = f.oid
    LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   GROUP BY f.proname, f.args
),
tbls AS (
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('ai_spend_budgets','ai_spend_reservations')
),
tbl_acl AS (
  SELECT t.relname,
         string_agg(
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END || ':' || a.privilege_type,
           ',' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END, a.privilege_type
         ) FILTER (WHERE a.grantee = 0 OR r.rolname IN ('anon','authenticated','service_role')) AS acl
    FROM tbls t
    JOIN pg_class c ON c.oid = t.oid
    LEFT JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a ON true
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   GROUP BY t.relname
)
SELECT line FROM (
  -- 1. Function bodies, hashed and in full length, plus the security posture.
  SELECT 'fn ' || f.proname || '(' || f.args || ') md5=' || md5(pg_get_functiondef(f.oid))
         || ' secdef=' || p.prosecdef || ' config=' || coalesce(array_to_string(p.proconfig, ';'), '')
         || ' volatile=' || p.provolatile::text AS line
    FROM fns f JOIN pg_proc p ON p.oid = f.oid
  UNION ALL
  SELECT 'fn-acl ' || proname || '(' || args || ') ' || coalesce(acl, '<none>') FROM fn_acl
  -- 2. Tables: every column, its type, nullability and default, in order.
  UNION ALL
  SELECT 'col ' || t.relname || '.' || a.attnum || ' ' || a.attname || ' '
         || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
         || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    FROM tbls t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  UNION ALL
  SELECT 'con ' || t.relname || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid)
    FROM tbls t JOIN pg_constraint c ON c.conrelid = t.oid
  UNION ALL
  SELECT 'idx ' || t.relname || ' ' || pg_get_indexdef(i.indexrelid)
    FROM tbls t JOIN pg_index i ON i.indrelid = t.oid
  UNION ALL
  SELECT 'rls ' || c.relname || ' enabled=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity
    FROM tbls t JOIN pg_class c ON c.oid = t.oid
  UNION ALL
  SELECT 'tbl-acl ' || relname || ' ' || coalesce(acl, '<none>') FROM tbl_acl
  UNION ALL
  SELECT 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',')
         || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '')
    FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('ai_spend_budgets','ai_spend_reservations')
  UNION ALL
  SELECT 'trg ' || c.relname || ' ' || tg.tgname
    FROM tbls c JOIN pg_trigger tg ON tg.tgrelid = c.oid AND NOT tg.tgisinternal
  -- 3. The one configuration row four of the six wrote.
  UNION ALL
  SELECT 'row agent_model_assignments builder_stock_extraction route=' || route || ' model=' || model_id
         || ' fallback=' || fallback_chain::text || ' temperature=' || temperature
         || ' max_tokens=' || max_tokens || ' active=' || is_active
         || ' category=' || coalesce(agent_category, '') || ' label=' || coalesce(agent_label, '')
         || ' description_md5=' || md5(coalesce(agent_description, ''))
    FROM public.agent_model_assignments WHERE agent_key = 'builder_stock_extraction'
) x
ORDER BY line;
