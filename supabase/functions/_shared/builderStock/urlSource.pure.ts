/**
 * Builder stock lists — the URL a builder pastes.
 *
 * Pure policy about the *shape* of a source URL: which schemes exist at all,
 * what the history row is labelled with, and whether the link is a Notion one.
 *
 * WHERE THE REAL SSRF CONTROL LIVES: not here. Host resolution and the
 * private/reserved-address test are `_shared/ssrfGuard.ts`, which is
 * already unit-tested and used by the existing link importer — this module
 * refuses the schemes that never reach a fetch at all, and `fetchSource.ts`
 * applies the guard to the original URL and to every redirect hop.
 *
 * No imports, no IO, no clock: loaded by the edge function under Deno and by
 * vitest under `src/`.
 */

/** Only these two ever reach a fetch. Everything else is refused by name. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Schemes named explicitly so the refusal is a sentence a builder can act on
 * rather than "invalid URL". `new URL()` accepts all of them happily.
 */
const NAMED_REFUSALS: Record<string, string> = {
  'file:': 'A file:// path is on a computer, not on the web. Upload the file instead.',
  'ftp:': 'FTP links cannot be read. Use an https:// link or upload the file.',
  'ftps:': 'FTP links cannot be read. Use an https:// link or upload the file.',
  'data:': 'A data: URL is not a web page. Upload the file instead.',
  'javascript:': 'That is not a web address.',
  'blob:': 'A blob: URL only exists inside your own browser. Upload the file instead.',
  'about:': 'That is not a web address.',
  'chrome:': 'That is not a web address.',
  'ws:': 'That is not a web page.',
  'wss:': 'That is not a web page.',
  'gopher:': 'That is not a web page.',
  'ldap:': 'That is not a web page.',
  'dict:': 'That is not a web page.',
  'sftp:': 'That is not a web page.',
  'ssh:': 'That is not a web page.',
  'mailto:': 'That is an email address, not a stock list.',
  'tel:': 'That is a phone number, not a stock list.',
};

export interface NormalisedSourceUrl {
  ok: true;
  /** Scheme, host and path only — credentials and fragment removed. */
  url: string;
  host: string;
  isNotion: boolean;
}

export interface RejectedSourceUrl {
  ok: false;
  /** Safe to show the builder verbatim. */
  reason: string;
  code: string;
}

/**
 * Turn what the builder typed into a URL we are willing to attempt.
 *
 * Rejects by scheme, strips embedded credentials (`https://user:pass@host` is
 * a classic way to make a hostile URL look like a familiar one) and drops the
 * fragment, which a server never sends anyway.
 */
export function normaliseStockSourceUrl(raw: unknown): NormalisedSourceUrl | RejectedSourceUrl {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, code: 'url_required', reason: 'Enter the address of the stock list.' };
  if (text.length > 2000) {
    return { ok: false, code: 'url_too_long', reason: 'That address is too long to be a stock list link.' };
  }

  // A bare "example.com/stock.csv" is what people paste. Assume https rather
  // than refusing — but only when it carries no scheme at all, so a hostile
  // scheme can never be smuggled past by omission.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, code: 'url_invalid', reason: 'That does not look like a web address.' };
  }

  const protocol = url.protocol.toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      code: 'url_scheme_not_allowed',
      reason: NAMED_REFUSALS[protocol] ?? 'Only http:// and https:// addresses can be read.',
    };
  }

  if (!url.hostname) {
    return { ok: false, code: 'url_invalid', reason: 'That address has no website in it.' };
  }

  // Credentials in the URL are never forwarded and never stored.
  url.username = '';
  url.password = '';
  url.hash = '';

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return { ok: true, url: url.toString(), host, isNotion: isNotionHost(host) };
}

/** Notion's public surfaces. `notion.site` is the published-page domain. */
export function isNotionHost(host: string): boolean {
  const clean = host.toLowerCase();
  return clean === 'notion.so' || clean.endsWith('.notion.so')
    || clean === 'notion.site' || clean.endsWith('.notion.site')
    || clean === 'notion.com' || clean.endsWith('.notion.com');
}

export function isNotionUrl(rawUrl: string): boolean {
  try {
    return isNotionHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * What the history row is called.
 *
 * A page title when the fetch found one, otherwise a shortened URL — host plus
 * the last meaningful path segment. A builder recognises
 * "acme-homes.com/…/march-stock-list" where they would not recognise a
 * 300-character signed download link.
 */
export function stockSourceDisplayName(
  rawUrl: string,
  title?: string | null,
  maxLength = 90,
): string {
  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (cleanTitle) return cleanTitle.slice(0, maxLength);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return String(rawUrl).slice(0, maxLength);
  }

  const host = url.hostname.replace(/^www\./i, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
  if (!last) return host.slice(0, maxLength);

  const shortened = segments.length > 1 ? `${host}/…/${last}` : `${host}/${last}`;
  return shortened.length <= maxLength ? shortened : `${shortened.slice(0, maxLength - 1)}…`;
}

/**
 * A filename for the snapshot object.
 *
 * The stored copy is what makes a URL import auditable after the page changes,
 * so it needs a name — derived from the URL, with an extension that matches
 * what was actually downloaded rather than what the link claimed.
 */
export function snapshotFileName(rawUrl: string, extension: string): string {
  let stem = 'stock-list';
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
    // Only a PATH segment carries an extension worth replacing. Stripping one
    // from the hostname turns `acme.example` into `acme`.
    const base = last ? last.replace(/\.[A-Za-z0-9]{1,8}$/, '') : url.hostname;
    stem = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
      || 'stock-list';
  } catch {
    /* keep the default */
  }
  const cleanExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
  return cleanExtension ? `${stem}.${cleanExtension}` : stem;
}

/**
 * The message a builder sees when a Notion page cannot be read.
 *
 * Named here so the URL path and the extraction path cannot word it
 * differently — it is the one refusal a builder can actually fix themselves.
 */
export const NOTION_NOT_PUBLIC_MESSAGE =
  'This Notion page is not publicly accessible. Share it publicly or upload/export the stock list instead.';

/**
 * The message for a Notion page we COULD read and could not get a stock list
 * out of.
 *
 * These two are different findings and must never share wording. The message
 * above accuses the builder's sharing settings; this one does not, because a
 * reachable page that yielded no rows is evidence about the CONTENT and none
 * at all about who may see it.
 */
export const NOTION_NO_PROPERTIES_MESSAGE =
  'No properties could be read from this Notion page. Check that it lists one property per row, '
  + 'or upload/export the stock list instead.';
