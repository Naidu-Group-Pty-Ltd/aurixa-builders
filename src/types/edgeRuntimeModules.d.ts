/**
 * The specifiers the app's typechecker meets but never compiles.
 *
 * WHY THIS FILE EXISTS. Specs under `src/` import shared modules from
 * `supabase/functions/_shared` on purpose — that is how a rule the edge
 * enforces gets tested by a Node runner instead of only in a deploy. tsc
 * follows those imports, and three of them name things only another runtime
 * has: Deno's remote URL specifiers, its `npm:` specifiers, and the Workers
 * runtime's `cloudflare:workers`.
 *
 * DECLARED, NEVER SHIMMED. Nothing here supplies an implementation, and
 * nothing here is bundled: the app's Vite build never reaches any of these,
 * `vitest.config.ts` resolves the `npm:` ones at test time, and `build.mjs`
 * resolves the unpdf URL for the Worker. This file exists so that a real type
 * error in a shared module still surfaces, rather than the whole typecheck
 * dying at the first specifier tsc cannot resolve.
 *
 * The shapes are deliberately loose. A hand-written signature for a
 * third-party API is a second opinion about it, and the narrower of the two
 * wins for the wrong reasons — `pdfText.ts` says exactly this about why it
 * infers unpdf's types rather than restating them.
 */

declare module 'https://esm.sh/unpdf@0.12.1' {
  export function getDocumentProxy(data: Uint8Array): Promise<any>;
  export function extractText(
    pdf: any, options?: { mergePages?: boolean },
  ): Promise<{ text: string | string[]; totalPages?: number }>;
  const unpdf: Record<string, unknown>;
  export default unpdf;
}

declare module 'https://esm.sh/xlsx@0.18.5' {
  const xlsx: any;
  export default xlsx;
  export const read: any;
  export const utils: any;
}

/**
 * Reached for the first time by `builderStockPendingUpload.spec.ts`, which
 * imports `settleItemImages` to prove which upload the source stage settles.
 * That module reaches `extract.ts` through the source repair, and `extract.ts`
 * opens zips for the DOCX/ODF/XLSX readers.
 */
declare module 'https://esm.sh/jszip@3.10.1' {
  const jszip: any;
  export default jszip;
  export const loadAsync: any;
}

declare module 'npm:@supabase/supabase-js@2.55.0' {
  export function createClient(url: string, key: string, options?: any): any;
}

/**
 * The Workers runtime base class, as much of it as the PDF worker uses.
 *
 * `fetch` is declared because the object overrides it; anything beyond these
 * two constructor arguments is deliberately absent, so a worker that started
 * relying on more would fail here rather than in production.
 */
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: any, env: Env);
    readonly ctx: any;
    readonly env: Env;
    fetch(request: Request): Promise<Response>;
  }
}

/** Cloudflare's binding type, used only in the worker's `Env`. */
declare type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/**
 * Deno's environment reader. Shared edge modules read secrets through it and
 * guard every use, which is why importing one into a Node test is safe; the
 * declaration is what lets tsc agree.
 */
declare const Deno: {
  env: { get(name: string): string | undefined };
};
