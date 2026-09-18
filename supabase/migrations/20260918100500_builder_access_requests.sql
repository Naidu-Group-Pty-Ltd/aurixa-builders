-- A builder asking for access, and what the network did about it.
--
-- Until now an organisation reached the network two ways: an operator typed
-- it into the Mission Control console, or a builder self-registered. Neither
-- serves a LEAD — somebody who has heard of the network and wants in, whose
-- details nobody has yet. This table is that application, and it is kept
-- whatever happens next.
--
-- WHY THE RECORD OUTLIVES THE ORGANISATION IT CREATES. The application is
-- automated: submitting it creates the organisation (unapproved) and sends
-- the owner their invitation. So the row is the only place that records what
-- was CLAIMED, by whom, from where, and what the network made of it — and it
-- is kept when the organisation is refused, when it collides with one that
-- already exists, and when it is later closed. An automated pipeline with no
-- record of its inputs cannot be audited after the fact.
--
-- `organisation_id` is deliberately nullable and deliberately NOT a cascade:
-- a refused application names no organisation, and closing an organisation
-- must never destroy the evidence of how it came to exist.

create table if not exists public.builder_access_requests (
  id uuid primary key default gen_random_uuid(),

  -- What they claimed. Held verbatim as submitted, so the record shows what
  -- the applicant wrote rather than what the network normalised it to.
  legal_name text not null,
  trading_name text,
  org_type text,
  abn text,
  acn text,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  website text,
  suburb text,
  state text,
  postcode text,
  message text,

  -- What the network made of it.
  --   received   — recorded, nothing attempted yet
  --   provisioned— organisation created and the owner invited
  --   attached   — the applicant already had an account; ownership granted
  --   refused    — a rule refused it; `outcome_detail` says which
  status text not null default 'received',
  outcome_detail text,
  organisation_id uuid references public.builder_organisations(id) on delete set null,
  builder_user_id uuid references public.builder_portal_users(id) on delete set null,
  invite_sent boolean not null default false,

  -- Where it came from. The address is the edge's own reading and never a
  -- client-supplied header — the same rule `authRateLimit` answers to.
  source_ip text,
  user_agent text,

  -- `builder_touch_row` writes BOTH `updated_at` and `row_version`, so a
  -- table wearing that trigger must carry both or every update raises
  -- 42703. Server-owned: a client may never set it.
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint builder_access_requests_status_check
    check (status = any (array['received', 'provisioned', 'attached', 'refused'])),
  constraint builder_access_requests_legal_name_check
    check (btrim(legal_name) <> ''),
  constraint builder_access_requests_contact_email_check
    check (contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- An outcome that is not 'received' has to say what happened. A pipeline
  -- that records a decision without its reason is one nobody can review.
  constraint builder_access_requests_outcome_reasoned
    check (status = 'received' or outcome_detail is not null)
);

-- The console reads newest-first, and the throttle below reads by email.
create index if not exists builder_access_requests_created_idx
  on public.builder_access_requests (created_at desc);
create index if not exists builder_access_requests_email_idx
  on public.builder_access_requests (lower(btrim(contact_email)), created_at desc);
create index if not exists builder_access_requests_status_idx
  on public.builder_access_requests (status, created_at desc);

-- Deliberately NO unique index on contact_email or abn. A duplicate
-- application is a fact worth keeping — the second attempt is exactly the
-- evidence that the first one did not reach anybody — and the throttle that
-- stops it becoming a mail relay is a time window read at submit, not a
-- constraint that would erase the attempt.

comment on table public.builder_access_requests is
  'A builder lead''s application for Builder Portal access. Kept whatever the outcome: it is the only record of what was claimed and what the automated pipeline did with it.';

alter table public.builder_access_requests enable row level security;

-- No policy is declared, so nothing but the service role reads or writes it.
-- Applications carry a contact name, address and phone number for a business
-- that has not yet been vetted; the console reaches them through
-- `builder-network-admin`, which is federation-gated, and nothing in any
-- portal has a reason to see them at all.

drop trigger if exists trg_builder_access_requests_touch on public.builder_access_requests;
create trigger trg_builder_access_requests_touch
  before update on public.builder_access_requests
  for each row execute function public.builder_touch_row();
