/**
 * Global token-event bus. Edge functions surface token outcomes via
 * `tokensUsed` (in JSON body) or a 402 `insufficient_funds` payload.
 * Callers don't need to handle these directly — `invokeSecureFunction`
 * forwards them to listeners mounted globally (see TokenEventsListener).
 */

export interface TokensUsedDetail {
  tokensUsed: number;
  durationMs?: number;
  functionName: string;
  label?: string;
}

export interface OutOfTokensDetail {
  available: number;
  requested: number;
  functionName: string;
  label?: string;
}

const TOKENS_USED_EVENT = "mc:tokens-used";
const OUT_OF_TOKENS_EVENT = "mc:out-of-tokens";

export function emitTokensUsed(detail: TokensUsedDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<TokensUsedDetail>(TOKENS_USED_EVENT, { detail }));
  } catch { /* SSR / no-op */ }
}

export function emitOutOfTokens(detail: OutOfTokensDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<OutOfTokensDetail>(OUT_OF_TOKENS_EVENT, { detail }));
  } catch { /* SSR / no-op */ }
}

export function onTokensUsed(handler: (d: TokensUsedDetail) => void): () => void {
  const wrap = (e: Event) => handler((e as CustomEvent<TokensUsedDetail>).detail);
  window.addEventListener(TOKENS_USED_EVENT, wrap);
  return () => window.removeEventListener(TOKENS_USED_EVENT, wrap);
}

export function onOutOfTokens(handler: (d: OutOfTokensDetail) => void): () => void {
  const wrap = (e: Event) => handler((e as CustomEvent<OutOfTokensDetail>).detail);
  window.addEventListener(OUT_OF_TOKENS_EVENT, wrap);
  return () => window.removeEventListener(OUT_OF_TOKENS_EVENT, wrap);
}

/** Function names that we treat as metered report generators. */
const REPORT_GENERATOR_FUNCTIONS = new Set([
  "generate-investment-report",
  "generate-bulk-reports",
  "generate-market-intelligence-report",
  "generate-portfolio-analysis",
  "generate-chart-analysis",
  "regenerate-report-qualitative",
]);

export function isReportGenerator(functionName: string): boolean {
  return REPORT_GENERATOR_FUNCTIONS.has(functionName);
}
