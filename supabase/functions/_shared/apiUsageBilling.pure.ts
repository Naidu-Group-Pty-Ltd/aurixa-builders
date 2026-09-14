/**
 * Which secret backs which service, and what one unit of it is.
 *
 * Mission Control forwards *our* vendor keys into every clone project it
 * provisions. It recharges a clone for calls made on a forwarded key, and
 * charges nothing for calls made on a key the clone supplied itself. The only
 * identifier that connects the three sides of that arrangement is the **secret
 * name** — the string this repo passes to `Deno.env.get`, that Mission Control's
 * `prime_secret_forwards` whitelists, and that `clone_backend_secrets` records
 * the ownership of.
 *
 * `api_usage_log.service_name` is not that string. It grew organically ('ghl',
 * 'lovable-ai' and 'lovable-ai-gateway' all exist in the wild) and it names a
 * vendor, not a credential — GOOGLE_MAPS_API_KEY and GOOGLE_API_KEY are the
 * same vendor and separate bills. This module is the translation, and it is
 * pure so it can be tested without a database or a network.
 *
 * No imports and no Deno globals: it is loaded both by an edge function and by
 * the repo's vitest suite.
 */

/** Must match Mission Control's `api_provider_rates.unit` CHECK constraint. */
export type UsageUnit =
  | "request"
  | "token"
  | "email"
  | "minute"
  | "document"
  | "page"
  | "render"
  | "verification"
  | "message"
  | "lookup";

export type ServiceBinding = {
  /** The `Deno.env.get` name whose key this call consumed. */
  secretName: string;
  unit: UsageUnit;
  /**
   * How to read the quantity off an `api_usage_log` row. Token-priced services
   * bill on `tokens_used`; everything else bills per call.
   */
  quantityFrom: "tokens" | "requests";
};

/**
 * service_name → the credential it spends.
 *
 * Keys are lowercased and stripped of separators before lookup, so 'lovable-ai',
 * 'lovable_ai' and 'LovableAI' all resolve. Aliases are listed explicitly
 * rather than guessed: a service that silently resolves to the wrong secret
 * bills the wrong tenant, which is worse than not billing at all.
 */
const BINDINGS: Record<string, ServiceBinding> = {
  // ── AI, priced per token ──
  openai: { secretName: "OPENAI_API_KEY", unit: "token", quantityFrom: "tokens" },
  anthropic: { secretName: "ANTHROPIC_API_KEY", unit: "token", quantityFrom: "tokens" },
  claude: { secretName: "ANTHROPIC_API_KEY", unit: "token", quantityFrom: "tokens" },
  perplexity: { secretName: "PERPLEXITY_API_KEY", unit: "token", quantityFrom: "tokens" },
  openrouter: { secretName: "OPENROUTER_API_KEY", unit: "token", quantityFrom: "tokens" },
  gemini: { secretName: "GEMINI_API_KEY", unit: "token", quantityFrom: "tokens" },
  googleai: { secretName: "GOOGLE_API_KEY", unit: "token", quantityFrom: "tokens" },
  lovableai: { secretName: "LOVABLE_API_KEY", unit: "token", quantityFrom: "tokens" },
  lovableaigateway: { secretName: "LOVABLE_API_KEY", unit: "token", quantityFrom: "tokens" },
  lovable: { secretName: "LOVABLE_API_KEY", unit: "token", quantityFrom: "tokens" },
  // The commercial borrowing-capacity segment engine runs on the gateway.
  bcsegmentengine: { secretName: "LOVABLE_API_KEY", unit: "token", quantityFrom: "tokens" },

  // ── Email ──
  resend: { secretName: "RESEND_API_KEY", unit: "email", quantityFrom: "requests" },
  microsoftgraph: {
    secretName: "MICROSOFT_CLIENT_SECRET",
    unit: "request",
    quantityFrom: "requests",
  },
  outlook: { secretName: "MICROSOFT_CLIENT_SECRET", unit: "request", quantityFrom: "requests" },

  // ── Property data ──
  domain: { secretName: "DOMAIN_API_KEY", unit: "lookup", quantityFrom: "requests" },
  cotality: { secretName: "COTALITY_API_KEY", unit: "lookup", quantityFrom: "requests" },
  corelogic: { secretName: "COTALITY_API_KEY", unit: "lookup", quantityFrom: "requests" },
  airtable: { secretName: "AIRTABLE_TOKEN", unit: "request", quantityFrom: "requests" },
  firecrawl: { secretName: "FIRECRAWL_API_KEY", unit: "page", quantityFrom: "requests" },

  // ── Maps ──
  googlemaps: { secretName: "GOOGLE_MAPS_API_KEY", unit: "request", quantityFrom: "requests" },
  googleplaces: { secretName: "GOOGLE_MAPS_API_KEY", unit: "request", quantityFrom: "requests" },
  googlegeocoding: { secretName: "GOOGLE_MAPS_API_KEY", unit: "request", quantityFrom: "requests" },
  googlestreetview: {
    secretName: "GOOGLE_MAPS_API_KEY",
    unit: "request",
    quantityFrom: "requests",
  },

  // ── Voice ──
  vapi: { secretName: "VAPI_API_KEY", unit: "minute", quantityFrom: "requests" },

  // ── Documents and rendering ──
  gamma: { secretName: "GAMMA_API_KEY", unit: "document", quantityFrom: "requests" },
  api2pdf: { secretName: "API2PDF_API_KEY", unit: "render", quantityFrom: "requests" },
  weasyprint: { secretName: "WEASYPRINT_SERVICE_TOKEN", unit: "render", quantityFrom: "requests" },
  pdfparse: { secretName: "PDF_PARSE_SERVICE_TOKEN", unit: "document", quantityFrom: "requests" },
  // Ours like the two above: the Builder Stock overlay-inpaint worker — a
  // Cloudflare Worker in front of Workers AI on the workspace's own account.
  // The token is the workspace's own service secret, never a forwarded vendor
  // key, so Mission Control rates the usage at nothing — the binding exists so
  // the call is visible in the ledger rather than untracked.
  builderstockimageworker: {
    secretName: "BUILDER_STOCK_IMAGE_WORKER_TOKEN",
    unit: "render",
    quantityFrom: "requests",
  },
  // The same again for the Builder Stock PDF election worker — a Cloudflare
  // Worker running the shared `electFromPdfBytes` on the workspace's own
  // account, because that one unit exceeds an Edge Function's CPU ceiling. Its
  // token is the workspace's own service secret rather than a forwarded vendor
  // key, so Mission Control rates the usage at nothing; the binding exists so
  // the call is visible in the ledger rather than untracked.
  builderstockpdfworker: {
    secretName: "BUILDER_STOCK_PDF_WORKER_TOKEN",
    unit: "document",
    quantityFrom: "requests",
  },
  docusign: { secretName: "DOCUSIGN_INTEGRATION_KEY", unit: "document", quantityFrom: "requests" },

  // ── Compliance ──
  didit: { secretName: "DIDIT_API_KEY", unit: "request", quantityFrom: "requests" },
  aml: { secretName: "AML_VERIFICATION_SERVICE_TOKEN", unit: "verification", quantityFrom: "requests" },
  amlverification: {
    secretName: "AML_VERIFICATION_SERVICE_TOKEN",
    unit: "verification",
    quantityFrom: "requests",
  },

  // ── CRM and marketing ──
  ghl: { secretName: "GOHIGHLEVEL_API_KEY", unit: "request", quantityFrom: "requests" },
  gohighlevel: { secretName: "GOHIGHLEVEL_API_KEY", unit: "request", quantityFrom: "requests" },
  manychat: { secretName: "MANYCHAT_API_KEY", unit: "message", quantityFrom: "requests" },
  metaads: { secretName: "META_ADS_ACCESS_TOKEN", unit: "request", quantityFrom: "requests" },
  metaadsanalysis: {
    secretName: "META_ADS_ACCESS_TOKEN",
    unit: "request",
    quantityFrom: "requests",
  },
};

/**
 * Vendor hostname → the credential a request to it spends.
 *
 * This is what lets metering be added to a call site without the author having
 * to know, or remember, which secret backs the endpoint they are calling — the
 * URL already says. It is the difference between instrumenting 92 edge
 * functions by hand and changing `fetch(` to `meteredFetch(`.
 *
 * Matched on exact host or a dot-suffix, so `api.eu.resend.com` resolves the
 * same as `api.resend.com` but `notresend.com` never does. Longest match wins,
 * so a more specific host can override a broader one.
 *
 * Hosts absent here are not metered. That is deliberate: esm.sh, deno.land,
 * the ABS, the RBA and our own Supabase project cost nothing per call, and
 * metering them would bury the spend that matters in noise.
 */
const HOST_SECRETS: Record<string, string> = {
  // ── Keyed on the vendor's own domain, so regional and versioned subdomains
  //    (api.eu.resend.com, api-uat.corelogic.asia) resolve without an entry each.
  //    Safe here because the whole domain belongs to one vendor and one bill.
  // AI
  "openai.com": "OPENAI_API_KEY",
  "anthropic.com": "ANTHROPIC_API_KEY",
  "perplexity.ai": "PERPLEXITY_API_KEY",
  "openrouter.ai": "OPENROUTER_API_KEY",
  // Email
  "resend.com": "RESEND_API_KEY",
  // Property data
  "domain.com.au": "DOMAIN_API_KEY",
  "corelogic.asia": "COTALITY_API_KEY",
  "cotality.com": "COTALITY_API_KEY",
  "airtable.com": "AIRTABLE_TOKEN",
  "firecrawl.dev": "FIRECRAWL_API_KEY",
  // Voice
  "vapi.ai": "VAPI_API_KEY",
  // Documents and rendering
  "gamma.app": "GAMMA_API_KEY",
  "api2pdf.com": "API2PDF_API_KEY",
  "docusign.net": "DOCUSIGN_INTEGRATION_KEY",
  "docusign.com": "DOCUSIGN_INTEGRATION_KEY",
  // CRM and marketing
  "leadconnectorhq.com": "GOHIGHLEVEL_API_KEY",
  "gohighlevel.com": "GOHIGHLEVEL_API_KEY",
  "manychat.com": "MANYCHAT_API_KEY",
  // Didit identity verification. The base URL is env-overridable
  // (DIDIT_API_BASE_URL), so the two call sites also name the credential
  // explicitly — this entry covers the default host and keeps host inference
  // honest for anything else that reaches it.
  "didit.me": "DIDIT_API_KEY",

  // ── Host-specific, because the parent domain is shared across products that
  //    are billed separately or not at all. `googleapis.com` alone would catch
  //    Cloud Storage; `microsoft.com` would catch everything Microsoft runs;
  //    `facebook.com` would catch the consumer site. Longest match wins, so
  //    these still beat any broader entry.
  "ai.gateway.lovable.dev": "LOVABLE_API_KEY",
  "generativelanguage.googleapis.com": "GEMINI_API_KEY",
  "maps.googleapis.com": "GOOGLE_MAPS_API_KEY",
  "places.googleapis.com": "GOOGLE_MAPS_API_KEY",
  "routes.googleapis.com": "GOOGLE_MAPS_API_KEY",
  "graph.microsoft.com": "MICROSOFT_CLIENT_SECRET",
  "login.microsoftonline.com": "MICROSOFT_CLIENT_SECRET",
  "graph.facebook.com": "META_ADS_ACCESS_TOKEN",
};

/**
 * Hosts we reach that are ours, or free, and must never be metered as vendor
 * spend. Listed rather than inferred so adding one is a decision on the record.
 */
const NEVER_METERED = [
  "esm.sh",
  "deno.land",
  "jsr.io",
  "supabase.co",
  "supabase.com",
  "w3.org",
  "openxmlformats.org",
  "purl.org",
  "data.gov.au",
  "abs.gov.au",
  "rba.gov.au",
  "bom.gov.au",
  "challenges.cloudflare.com",
  "npcservices.com.au",
  "lovable.app",
  "lovableproject.com",
];

function hostMatches(host: string, candidate: string): boolean {
  return host === candidate || host.endsWith(`.${candidate}`);
}

/**
 * Which credential a URL spends, or null when the host is not a metered vendor.
 *
 * Self-hosted sidecars (WeasyPrint, the PDF parser, the AML service) have no
 * fixed hostname — their URLs come from env — so they are resolved by the
 * caller passing an explicit secret name rather than guessed from the host.
 */
export function secretForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (NEVER_METERED.some((n) => hostMatches(host, n))) return null;

  let best: { secret: string; length: number } | null = null;
  for (const [candidate, secret] of Object.entries(HOST_SECRETS)) {
    if (!hostMatches(host, candidate)) continue;
    // Longest match wins so a specific host can override a broader suffix.
    if (!best || candidate.length > best.length) best = { secret, length: candidate.length };
  }
  return best?.secret ?? null;
}

/** The unit a secret is metered in, for callers that only know the secret. */
export function unitForSecret(secretName: string): UsageUnit {
  for (const binding of Object.values(BINDINGS)) {
    if (binding.secretName === secretName) return binding.unit;
  }
  return "request";
}

/** True when this secret is priced per token rather than per call. */
export function isTokenPriced(secretName: string): boolean {
  for (const binding of Object.values(BINDINGS)) {
    if (binding.secretName === secretName) return binding.quantityFrom === "tokens";
  }
  return false;
}

/** Every vendor host this repo knows how to attribute. */
export function meteredHosts(): string[] {
  return Object.keys(HOST_SECRETS).sort();
}

/**
 * A stable `service_name` for a secret, for callers that resolved the
 * credential first (a metered fetch knows the host, not the historical label).
 * Round-trips through `resolveServiceBinding`, so a name this returns is always
 * one the forwarder can map back.
 */
export function serviceNameForSecret(secretName: string): string {
  for (const [service, binding] of Object.entries(BINDINGS)) {
    if (binding.secretName === secretName) return service;
  }
  return secretName.toLowerCase();
}

/** 'Lovable-AI Gateway' → 'lovableaigateway'. */
export function normalizeServiceName(service: string): string {
  return (service ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a logged service to the credential it spent.
 *
 * Returns null for anything unrecognised. The caller must not guess: an
 * unmapped service is reported to Mission Control with no secret name at all,
 * where it lands as `rate_missing` on the operator dashboard and gets a row in
 * the catalog, rather than being charged against whichever key looked closest.
 */
export function resolveServiceBinding(service: string): ServiceBinding | null {
  return BINDINGS[normalizeServiceName(service)] ?? null;
}

/** Every secret this repo can currently attribute usage to. */
export function knownBillableSecrets(): string[] {
  return Array.from(new Set(Object.values(BINDINGS).map((b) => b.secretName))).sort();
}

export type UsageLogRow = {
  id: string;
  service_name: string;
  endpoint?: string | null;
  tokens_used?: number | null;
  request_count?: number | null;
  model_used?: string | null;
  status?: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

export type ReportableEvent = {
  secret_name: string;
  quantity: number;
  idempotency_key: string;
  model: string | null;
  feature: string | null;
  status: "success" | "error";
  occurred_at: string;
  metadata: Record<string, unknown>;
};

/**
 * Turn one `api_usage_log` row into the event Mission Control meters.
 *
 * The row id is the idempotency key. That is not a convenience — the forwarder
 * runs on a cron and retries, and a re-sent batch must be recognised as the
 * same calls rather than metered twice. A row id is stable, unique, and already
 * the thing we mark as forwarded.
 *
 * Returns null when the row cannot be attributed to a credential, or when a
 * token-priced call reported zero tokens (nothing was consumed, so there is
 * nothing to charge and a zero-quantity event would only add noise).
 */
export function toReportableEvent(row: UsageLogRow): ReportableEvent | null {
  const binding = resolveServiceBinding(row.service_name);
  if (!binding) return null;

  // An explicit secret name in metadata wins over the map: it lets a call site
  // that knows exactly which credential it used say so, and it is how a new
  // vendor gets metered before this file learns about it.
  const declared = row.metadata?.secret_name;
  const secretName = typeof declared === "string" && /^[A-Z_][A-Z0-9_]*$/.test(declared)
    ? declared
    : binding.secretName;

  // A per-call vendor usually consumes one unit per row, but not always: one
  // Resend request can send 50 emails and one Vapi call can run 12 minutes.
  // `metadata.request_count` lets the call site say so; the column itself
  // defaults to 1 and `logApiUsage` has no parameter for it.
  const declaredCount = Number(row.metadata?.request_count);
  const quantity =
    binding.quantityFrom === "tokens"
      ? Number(row.tokens_used ?? 0)
      : Number.isFinite(declaredCount) && declaredCount > 0
        ? declaredCount
        : Math.max(Number(row.request_count ?? 1), 1);

  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  return {
    secret_name: secretName,
    quantity,
    idempotency_key: row.id,
    model: row.model_used ?? null,
    feature: row.endpoint ?? null,
    status: row.status === "error" ? "error" : "success",
    occurred_at: row.created_at,
    metadata: {
      ...(row.metadata ?? {}),
      service_name: row.service_name,
      unit: binding.unit,
    },
  };
}
