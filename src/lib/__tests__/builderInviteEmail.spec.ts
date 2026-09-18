/**
 * The invitation as a document, and the one rule its own header promises:
 * the literals in it are the resolved Builder Portal tokens, checked against
 * `tokens.css` rather than remembered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILDER_EMAIL_FONT,
  BUILDER_EMAIL_HEADING,
  BUILDER_EMAIL_MONO,
  BUILDER_EMAIL_PALETTE,
  escapeHtml,
  renderInviteEmailHtml,
  renderInviteEmailText,
  safeUrl,
} from '../../../supabase/functions/_shared/builderInviteEmail';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const BRAND = { companyName: 'Aurixa Builders Network', fromHeaderAdmin: 'x <a@b.com>' };
const CONTENT = {
  heading: 'You have been invited to lead Bright Homes',
  paragraphs: ['Hi Jane,', 'You have been invited.'],
  action: { label: 'Set your password', url: 'https://builders.example.com/builder/accept?t=abc' },
  footnote: 'This link expires in 72 hours.',
};

/** hsl(…) → #RRGGBB, so the token can be compared with the literal. */
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor(h / 60) % 6];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

describe('the palette is the portal’s, not an approximation of it', () => {
  const tokens = read('src/styles/tokens.css');
  // The `:root` (light) block alone — the email is composed on a light ground
  // because several mail clients invert a dark table wholesale.
  const root = tokens.slice(tokens.indexOf(':root'), tokens.indexOf('.dark'));
  const tokenHex = (name: string) => {
    const match = root.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
    if (!match) throw new Error(`token --${name} not found in :root`);
    return hslToHex(Number(match[1]), Number(match[2]), Number(match[3]));
  };

  it('matches tokens.css value for value', () => {
    for (const [key, token] of [
      ['primary', 'primary'],
      ['onPrimary', 'primary-foreground'],
      ['page', 'background'],
      ['card', 'card'],
      ['ink', 'foreground'],
      ['quiet', 'muted-foreground'],
      ['rule', 'border'],
      ['well', 'muted'],
    ] as const) {
      expect(BUILDER_EMAIL_PALETTE[key], `${key} ← --${token}`).toBe(tokenHex(token));
    }
  });

  it('leads with the type the portal leads with', () => {
    expect(root).toMatch(/--font-sans:\s*"Inter"/);
    expect(BUILDER_EMAIL_FONT.startsWith('Inter')).toBe(true);
    expect(BUILDER_EMAIL_MONO).toContain('ui-monospace');
  });

  it('sets headings in the serif the product sets every heading in', () => {
    // `base.css` puts `var(--font-heading)` on h1-h6 globally, so the
    // portal's headings are serif — a sans heading here would not be its
    // voice. Playfair never loads (nothing declares an @font-face), so the
    // browser and the mail client walk the same chain to Georgia.
    expect(read('src/styles/base.css')).toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-family:\s*var\(--font-heading\)/,
    );
    expect(root).toMatch(/--font-heading:\s*"Playfair Display"/);
    for (const face of ['Playfair Display', 'Georgia', 'serif']) {
      expect(BUILDER_EMAIL_HEADING, face).toContain(face);
    }
    // And the rendered h1 actually wears it.
    const html = renderInviteEmailHtml(CONTENT, BRAND);
    const h1 = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'));
    expect(h1).toContain('Georgia');
  });

  it('loads no webfont — a mail client strips @font-face and a link is a beacon', () => {
    // Judged on the CODE: the header explains this rule, and a scan of the
    // whole file would catch its own explanation.
    const source = read('supabase/functions/_shared/builderInviteEmail.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(source).not.toContain('fonts.googleapis.com');
    expect(source).not.toContain('@font-face');
    // And what it renders carries no remote reference of any kind.
    const html = renderInviteEmailHtml(CONTENT, BRAND);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/\bsrc\s*=/);
  });
});

/** WCAG relative luminance, so the ramp is judged rather than trusted. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const parts = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = parts.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('every pairing it draws is legible', () => {
  const c = BUILDER_EMAIL_PALETTE;

  it('meets AA on all five', () => {
    for (const [label, fg, bg] of [
      ['button text', c.onPrimary, c.primary],
      ['body ink', c.ink, c.card],
      ['wordmark', c.primary, c.card],
      ['quiet text', c.quiet, c.card],
      ['quoted URL', c.ink, c.well],
    ] as const) {
      expect(contrast(fg, bg), `${label} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is why the light ramp is used and not the portal’s own dark one', () => {
    // The header's claim, checked: the dark theme's primary under white
    // button text fails AA, which is what decided the ground.
    const tokens = read('src/styles/tokens.css');
    const dark = tokens.slice(tokens.indexOf('.dark'));
    expect(dark).toMatch(/--primary:\s*184\s+100%\s+35%/);
    expect(contrast('#FFFFFF', '#00A7B2')).toBeLessThan(4.5);
    expect(contrast(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the document a mail client can actually draw', () => {
  const html = renderInviteEmailHtml(CONTENT, BRAND);

  it('carries its styles inline and declares no stylesheet', () => {
    // Gmail's web client discards a head stylesheet; Outlook lays out tables.
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).toContain('<table role="presentation"');
  });

  it('paints the portal’s signature on it', () => {
    expect(html).toContain(BUILDER_EMAIL_PALETTE.primary);
    expect(html).toContain(BUILDER_EMAIL_FONT);
  });

  it('quotes the address as text as well as drawing a button', () => {
    // A button is an anchor a client may decline to render, and a reader who
    // sees no button must still be able to reach the link.
    const occurrences = html.split(CONTENT.action.url).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/copy this address into your browser/i);
  });

  it('sends words beside the markup', () => {
    const text = renderInviteEmailText(CONTENT, BRAND);
    expect(text).toContain(CONTENT.heading);
    expect(text).toContain(CONTENT.action.url);
    expect(text).not.toContain('<');
  });

  it('draws no action when there is none to take', () => {
    const notice = renderInviteEmailHtml(
      { heading: 'You now have access', paragraphs: ['Hi Jane,'] },
      BRAND,
    );
    expect(notice).not.toContain('copy this address');
    expect(notice).not.toContain('<a href');
  });
});

describe('nothing a person typed becomes markup', () => {
  it('escapes an organisation name that looks like a tag', () => {
    const html = renderInviteEmailHtml(
      {
        heading: 'Welcome to <script>alert(1)</script>',
        paragraphs: ['Hi "Jane" <b>&</b>,'],
      },
      { companyName: '<img src=x onerror=1>', fromHeaderAdmin: 'a@b.com' },
    );
    // The payloads survive as TEXT — `&lt;img ... onerror=1&gt;` still spells
    // "onerror=", and that is the point: it is escaped, so no parser ever
    // sees a tag. Assert that no INJECTED tag exists rather than that the
    // characters are gone.
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    // Every tag in the document is one this module wrote.
    const tags = new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()));
    expect([...tags].sort()).toEqual(
      ['!doctype', 'a', 'body', 'h1', 'head', 'html', 'meta', 'p', 'table', 'td', 'title', 'tr'].filter((t) => tags.has(t)),
    );
  });

  it('refuses a scheme an anchor would execute', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', '', '  ']) {
      expect(safeUrl(bad), bad).toBeNull();
    }
    expect(safeUrl('https://ok.example.com/a?b=c')).toBe('https://ok.example.com/a?b=c');
  });

  it('drops an action whose URL was refused rather than drawing a dead button', () => {
    const html = renderInviteEmailHtml(
      { heading: 'x', paragraphs: [], action: { label: 'Go', url: 'javascript:alert(1)' } },
      BRAND,
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('>Go<');
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('there is one send path', () => {
  it('names api.resend.com in exactly one module', () => {
    // Three call sites composed their own body before this; one of them
    // reported `email_sent: !!resendApiKey`, which is a key being set rather
    // than a message being delivered.
    for (const f of [
      'supabase/functions/builder-portal-invite/index.ts',
      'supabase/functions/builder-network-admin/index.ts',
    ]) {
      expect(read(f), f).not.toContain('api.resend.com');
    }
    expect(read('supabase/functions/_shared/builderInviteEmail.ts')).toContain('api.resend.com');
  });

  it('says which kind of failure it was', () => {
    const source = read('supabase/functions/_shared/builderInviteEmail.ts');
    for (const reason of ['not_configured', 'refused', 'unreachable']) {
      expect(source, reason).toContain(reason);
    }
  });

  it('never throws, because the act it accompanies has already happened', () => {
    const source = read('supabase/functions/_shared/builderInviteEmail.ts');
    const fn = source.slice(source.indexOf('export async function sendBuilderEmail'));
    expect(fn).toContain('catch');
    expect(fn).not.toMatch(/\bthrow\b/);
  });
});
