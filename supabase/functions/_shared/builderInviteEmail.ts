/**
 * The Builder Portal's own voice, in a mailbox.
 *
 * Every invitation this network sends used to be a paragraph of plain text.
 * That is not a deliverability decision — a plain part is required and this
 * module still sends one — it is simply all there was: no letterhead, no
 * brand, and a bare URL for the reader to trust.
 *
 * ── WHY THE COLOURS ARE LITERALS HERE, AND NOWHERE ELSE ────────────────────
 *
 * `builder-drafting.css` opens with "never write a colour": every value in
 * the portal resolves from the semantic tokens in `tokens.css`, so a tenant
 * who retunes `--primary` retunes the whole language, and `npm run
 * audit:style` fails a raw hex.
 *
 * An email cannot do that. A custom property is not resolvable in most mail
 * clients, `<style>` blocks are stripped by Gmail's web client, and there is
 * no stylesheet to cascade from — so a colour either arrives inline as a
 * literal or it does not arrive. These literals are therefore the RESOLVED
 * values of the same tokens, recorded once, in one module, with the token
 * they came from named beside each. `builderInviteEmail.spec.ts` reads
 * `src/styles/tokens.css` and fails when the two drift, which is the closest
 * an email can get to the rule the stylesheet keeps.
 *
 * The LIGHT ramp is used deliberately, and the reason is measured rather than
 * aesthetic. A mail client composes on its own surface and several invert a
 * dark table wholesale, so the portal's near-black card cannot be relied on —
 * but the deciding fact is contrast: the dark theme's `--primary` (#00A7B2)
 * under white button text is **2.93:1**, which fails AA outright, while the
 * light theme's (#007780) is 5.32:1. The light ramp is the one whose
 * `--primary-foreground` is actually white, so it is the pairing the tokens
 * were designed for. Every pair this module draws is checked by its spec.
 *
 * ── WHAT THIS MODULE MAY NOT DO ────────────────────────────────────────────
 *
 * It composes and sends. It does not decide WHO gets an email, mint a token,
 * or write a row — those belong to the operations that call it, so a send
 * that fails can never be mistaken for an invitation that was not issued.
 */

// @ts-ignore Deno-only import; not resolvable under Node type-checking.
import { meteredFetch } from './meteredFetch.ts';

/**
 * The resolved Builder Portal ramp. Each value is the `:root` token in
 * `src/styles/tokens.css` converted from HSL, named so the pairing is
 * checkable rather than remembered.
 */
export const BUILDER_EMAIL_PALETTE = {
  /** --primary: 184 100% 25% — the portal's signature teal. */
  primary: '#007780',
  /** --primary-foreground: 0 0% 100% */
  onPrimary: '#FFFFFF',
  /** --background: 220 14% 96% — the page the card sits on. */
  page: '#F3F4F6',
  /** --card: 0 0% 100% */
  card: '#FFFFFF',
  /** --foreground: 221 39% 11% */
  ink: '#111827',
  /** --muted-foreground: 220 9% 46% */
  quiet: '#6B7280',
  /** --border: 216 12% 84% */
  rule: '#D1D5DB',
  /** --muted: 216 16% 94% — the ground a quoted link sits on. */
  well: '#EDEFF2',
} as const;

/**
 * The portal's type, as a mail client can honour it.
 *
 * `--font-sans` leads with Inter and falls through a system stack. A webfont
 * is deliberately NOT loaded: `@font-face` is stripped or blocked in most
 * clients, and a link to one is a tracking beacon by another name. A reader
 * with Inter installed sees Inter; everyone else sees their system face,
 * which is what the token's own fallback chain already says to do.
 */
export const BUILDER_EMAIL_FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * `--font-heading`, which every `h1`–`h6` in the product already wears —
 * `base.css` sets `font-family: var(--font-heading)` on all six globally, so
 * the portal's own headings are SERIF and a sans heading here would not be
 * the portal's voice.
 *
 * Playfair Display is never loaded (no `@font-face` anywhere in the product
 * either, so a browser falls through the same chain a mail client will), and
 * Georgia is present on effectively every client — so a reader sees the serif
 * the token asks for rather than the sans they would have got by default.
 */
export const BUILDER_EMAIL_HEADING =
  "'Playfair Display', ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif";

/** --font-mono, for the one place a credential is quoted. */
export const BUILDER_EMAIL_MONO =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

/**
 * Text that will sit inside markup, made safe to sit there.
 *
 * Every interpolated value in this module goes through it. An organisation's
 * legal name is operator-entered and an inviter's name is self-entered, so
 * neither is markup however much it may look like it.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL safe to put in an `href`.
 *
 * Only http(s) survives. `javascript:` and `data:` are refused rather than
 * escaped, because an anchor is the one place in this document where a
 * scheme is executable.
 */
export function safeUrl(value: string): string | null {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return escapeHtml(raw);
}

export interface InviteEmailContent {
  /** The heading the reader sees first. */
  readonly heading: string;
  /** One or two sentences of body copy, plain text — escaped here. */
  readonly paragraphs: readonly string[];
  /** The one thing to do. Omitted for a notice that carries no act. */
  readonly action?: { readonly label: string; readonly url: string };
  /** Said under the button, e.g. when the link stops working. */
  readonly footnote?: string;
}

export interface BuilderEmailBrand {
  readonly companyName: string;
  readonly fromHeaderAdmin: string;
}

/**
 * Compose the document.
 *
 * Tables, inline styles and no `<style>` block: Outlook lays out with
 * tables, Gmail's web client discards a head stylesheet, and between them
 * that rules out every more modern arrangement. The card is 100% wide up to
 * 560px so a phone gets the full measure and a desktop does not get a
 * 1200px line.
 */
export function renderInviteEmailHtml(
  content: InviteEmailContent,
  brand: BuilderEmailBrand,
): string {
  const c = BUILDER_EMAIL_PALETTE;
  const company = escapeHtml(brand.companyName);
  const href = content.action ? safeUrl(content.action.url) : null;

  const body = content.paragraphs
    .map(
      (line) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${c.ink};">${escapeHtml(line)}</p>`,
    )
    .join('');

  // The button AND the address beneath it. A button is an anchor a client may
  // decline to render, and a reader who cannot see one has no way to reach
  // the link at all — so the URL is always quoted as text as well.
  const action =
    content.action && href
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
           <tr><td style="border-radius:6px;background-color:${c.primary};">
             <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${BUILDER_EMAIL_FONT};font-size:15px;font-weight:600;color:${c.onPrimary};text-decoration:none;border-radius:6px;">${escapeHtml(content.action.label)}</a>
           </td></tr>
         </table>
         <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${c.quiet};">If the button does not open, copy this address into your browser:</p>
         <p style="margin:6px 0 0;padding:10px 12px;background-color:${c.well};border:1px solid ${c.rule};border-radius:4px;font-family:${BUILDER_EMAIL_MONO};font-size:12px;line-height:1.5;color:${c.ink};word-break:break-all;">${href}</p>`
      : '';

  const footnote = content.footnote
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${c.quiet};">${escapeHtml(content.footnote)}</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>
<body style="margin:0;padding:0;background-color:${c.page};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${c.page};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:${c.card};border:1px solid ${c.rule};border-radius:8px;font-family:${BUILDER_EMAIL_FONT};">
        <!-- The rule under the wordmark is the drafting sheet's own heavy
             line weight, which is what makes this read as the portal. -->
        <tr><td style="padding:28px 32px 0;border-top:3px solid ${c.primary};border-radius:8px 8px 0 0;">
          <p style="margin:0 0 4px;font-family:${BUILDER_EMAIL_MONO};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${c.primary};">${company}</p>
          <h1 style="margin:0 0 20px;font-family:${BUILDER_EMAIL_HEADING};font-size:23px;line-height:1.3;font-weight:600;color:${c.ink};">${escapeHtml(content.heading)}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 28px;">${body}${action}${footnote}</td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid ${c.rule};">
          <p style="margin:0;font-size:11px;line-height:1.5;color:${c.quiet};">Sent by ${company}. If you were not expecting this, no action is needed and you can ignore it.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** The same document as words, for a client that will not draw the other. */
export function renderInviteEmailText(content: InviteEmailContent, brand: BuilderEmailBrand): string {
  const lines = [brand.companyName.toUpperCase(), '', content.heading, '', ...content.paragraphs];
  if (content.action) lines.push('', `${content.action.label}: ${content.action.url}`);
  if (content.footnote) lines.push('', content.footnote);
  return lines.join('\n');
}

export type InviteEmailOutcome =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: 'not_configured' | 'refused' | 'unreachable' };

/**
 * Hand it to Resend.
 *
 * NEVER throws and never returns a bare boolean: the caller has already
 * minted a credential or granted access by the time this runs, so a send
 * that failed must not unwind the act — but "we could not send it" and "no
 * mail is configured here" are different sentences to an operator holding a
 * link they may need to pass on by hand.
 */
export async function sendBuilderEmail(args: {
  readonly to: string;
  readonly subject: string;
  readonly content: InviteEmailContent;
  readonly brand: BuilderEmailBrand;
  readonly category: string;
}): Promise<InviteEmailOutcome> {
  // @ts-ignore Deno-only global.
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    console.warn('[builderInviteEmail] RESEND_API_KEY unset — nothing was sent');
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const response = await meteredFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: args.brand.fromHeaderAdmin,
        to: [args.to],
        subject: args.subject,
        html: renderInviteEmailHtml(args.content, args.brand),
        text: renderInviteEmailText(args.content, args.brand),
        tags: [{ name: 'category', value: args.category }],
      }),
    });
    if (!response.ok) {
      // Resend's own refusal — an unverified sender domain is the one this
      // deployment hits most, and it is a configuration fault rather than a
      // network one.
      console.error('[builderInviteEmail] Resend refused the send', response.status);
      return { sent: false, reason: 'refused' };
    }
    return { sent: true };
  } catch (error) {
    console.error('[builderInviteEmail] send failed', error);
    return { sent: false, reason: 'unreachable' };
  }
}
