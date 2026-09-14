import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  PORTAL_AGREEMENT_ACCEPTANCE_NOTICE,
  PORTAL_AGREEMENT_ACCEPT_LABEL,
  PORTAL_AGREEMENT_TITLE,
  PORTAL_TERMS_ACKNOWLEDGEMENTS,
  type PortalAcknowledgementKey,
  type PortalTermsVersion,
} from '@/lib/portalAgreement';

/**
 * The consent wall the Solicitor, Builder/Developer and Finance portals share.
 *
 * One agreement is presented to every partner organisation, so one component
 * presents it. Three copies of this markup would drift — a heading reworded
 * here, an acknowledgment reordered there — and the drift would be invisible
 * until someone compared two portals' acceptance records and found they had
 * agreed to different things under the same document name.
 *
 * The agreement is rendered from the stored Markdown and never restated in this
 * file. A wall carrying its own copy of the words would eventually disagree
 * with the version the acceptance is recorded against, and the acceptance
 * record would then name a document nobody read.
 *
 * The acknowledgments are not an interface gate. Each is a contractual
 * statement in its own right — authority to bind and the section 37A
 * arrangement among them — so which ones were asserted travels with the
 * acceptance and is recorded. Every portal's server requires all four
 * regardless of what this component sends.
 *
 * Page chrome stays with the caller: the Solicitor and Builder portals wrap
 * this in their own card, the Finance portal in its onboarding dialog. Only the
 * document, the acknowledgments, the notice and the button are shared, because
 * only those are the agreement.
 */
export function PortalAgreementConsent({
  terms,
  loading,
  busy,
  onAccept,
  scrollHeightClassName = 'h-80 md:h-[28rem]',
  footerNote,
  acknowledgements = PORTAL_TERMS_ACKNOWLEDGEMENTS,
  acceptanceNotice = PORTAL_AGREEMENT_ACCEPTANCE_NOTICE,
  fallbackTitle = PORTAL_AGREEMENT_TITLE,
  beforeAccept,
}: {
  terms: PortalTermsVersion | null;
  loading: boolean;
  busy: boolean;
  onAccept: (acknowledgements: PortalAcknowledgementKey[]) => void;
  /** Overridden by the Finance dialog, which has less vertical room. */
  scrollHeightClassName?: string;
  /** Rendered beside the version line; the portals use it for a security note. */
  footerNote?: ReactNode;
  /**
   * The statements to present, in the agreement's own order. Defaults to the
   * portal wording, so all three portals are unchanged. The link channel
   * passes its own — SAME KEYS, different words — because a partner with no
   * portal account cannot meaningfully acknowledge portal obligations.
   */
  acknowledgements?: ReadonlyArray<{ key: string; heading: string; statement: string }>;
  acceptanceNotice?: string;
  fallbackTitle?: string;
  /**
   * Rendered immediately above the notice and the accept button.
   *
   * A portal knows who is accepting — they are signed in. The link channel
   * does not, so it has to ask; and the place to ask is here, where the act
   * happens, rather than at the top of the page above a long document the
   * person then scrolls past and forgets.
   */
  beforeAccept?: ReactNode;
}) {
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});

  const acceptedKeys = useMemo(
    () => acknowledgements.filter((item) => acknowledged[item.key]).map((item) => item.key),
    [acknowledged, acknowledgements],
  );
  const canProceed = Boolean(terms) && acceptedKeys.length === acknowledgements.length && !busy;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold text-foreground">
              {terms?.title || fallbackTitle}
            </h2>
          </div>
          <span className="text-xs text-muted-foreground">Version {terms?.version || 'current'}</span>
        </div>

        <ScrollArea className={`rounded-xl border border-border bg-muted/20 p-4 ${scrollHeightClassName}`}>
          <div className="pr-4 text-sm leading-relaxed text-muted-foreground" aria-live="polite" aria-busy={loading}>
            {loading ? (
              <div className="space-y-2">
                <span className="sr-only">Loading the current terms…</span>
                <Skeleton className="h-4 w-2/3" aria-hidden />
                <Skeleton className="h-4 w-full" aria-hidden />
                <Skeleton className="h-4 w-11/12" aria-hidden />
                <Skeleton className="h-4 w-5/6" aria-hidden />
                <Skeleton className="h-4 w-full" aria-hidden />
              </div>
            ) : terms?.content_markdown ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={agreementMarkdownComponents}>
                {terms.content_markdown}
              </ReactMarkdown>
            ) : (
              'The current terms could not be loaded. Please refresh and try again.'
            )}
          </div>
        </ScrollArea>
      </div>

      <Separator />

      {/* Mandatory acknowledgments — presented in the order the agreement sets. */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Mandatory acknowledgments</h3>
        {acknowledgements.map((item, index) => (
          <div key={item.key} className="flex items-start gap-3">
            <Checkbox
              id={`acknowledge-${item.key}`}
              checked={Boolean(acknowledged[item.key])}
              onCheckedChange={(checked) =>
                setAcknowledged((prev) => ({ ...prev, [item.key]: checked === true }))
              }
              disabled={!terms || busy}
              className="mt-0.5"
            />
            <Label
              htmlFor={`acknowledge-${item.key}`}
              className="cursor-pointer text-sm leading-relaxed text-foreground"
            >
              <span className="font-semibold">{index + 1}. {item.heading}. </span>
              {item.statement}
            </Label>
          </div>
        ))}
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        {beforeAccept}
        <p className="text-sm leading-relaxed text-muted-foreground">
          {acceptanceNotice}
        </p>
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/60">
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
            <span>Your consent is recorded securely against version {terms?.version || 'current'}</span>
            {terms?.document_hash ? (
              <span className="font-mono">· document hash {terms.document_hash.slice(0, 12)}</span>
            ) : null}
            {footerNote}
          </div>
          <Button
            onClick={() => onAccept(acceptedKeys as PortalAcknowledgementKey[])}
            disabled={!canProceed}
            size="lg"
            className="w-full min-w-[200px] sm:w-auto"
          >
            {busy ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Recording acceptance…</>
            ) : (
              PORTAL_AGREEMENT_ACCEPT_LABEL
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The agreement is a legal instrument, so its structure has to survive the
 * render: numbered sections stay numbered, the conditional lists in sections 7
 * and 9 stay ordered, and nothing collapses into undifferentiated prose. Body
 * copy is `foreground` rather than `muted-foreground` — this is the document a
 * partner is being asked to be bound by, not supporting text.
 */
const agreementMarkdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mb-3 mt-6 text-base font-bold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mb-2 mt-6 text-sm font-semibold text-primary first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground">{children}</h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-3 leading-relaxed text-foreground">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 list-outside list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 list-outside list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="leading-relaxed text-foreground">{children}</li>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} className="underline underline-offset-2" rel="noreferrer noopener" target="_blank">{children}</a>
  ),
};
