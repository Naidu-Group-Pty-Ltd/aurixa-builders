/**
 * WHAT A PROPERTY'S OWN DOCUMENTS SAID, DRAWN SO A BUILDER READS IT.
 *
 * Two kinds of note sit under a property's picture, and they ask for
 * different things:
 *
 *   • A brochure that names ANOTHER property (`identity_mismatch`) — the one
 *     finding a builder can fix in a minute, so it leads, as a warning with
 *     both identities side by side and the step to take.
 *   • Every other link the reader opened and took no photograph from — a
 *     masterplan, a plan of subdivision, a document with no photograph in it.
 *     Nothing is wrong with these; they explain why the picture did not come
 *     from them. They are grouped under ONE heading that says so.
 *
 * WHY THIS WAS REDRAWN. Both were 11px muted prose under a small status chip —
 * the same weight as a caption — and a builder reported that nobody noticed
 * them. The words are unchanged (they are the server's, recorded when the
 * document was read); what changed is that each kind now has a surface, a
 * heading, an icon and body copy at the portal's 12px reading size.
 *
 * Nothing here decides anything. The class arrives from the server as a code
 * and the sentence is drawn as written.
 */
import { AlertTriangle, FileText, Info } from 'lucide-react';

import type { BuilderStockItem } from '@/lib/builderStock';
import { BrochureImageChoice } from '@/components/builder-portal/BrochureConfirmation';
import {
  STOCK_DOCUMENT_MISMATCH_COPY,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';

type Note = NonNullable<BuilderStockItem['source_document_notes']>[number];

/** A mismatch the page can draw: the class, and what the page said instead. */
export function isDrawableMismatch(note: Note): boolean {
  return note.finding === 'identity_mismatch' && !!note.states;
}

/** The heading over the explanatory notes. UI copy, not a finding. */
export const STOCK_DOCUMENT_NOTES_HEADING = 'Why these links gave no photo';

export function DocumentMismatchCallout({
  item, note, listingIdentity,
}: {
  item: BuilderStockItem;
  note: Note;
  listingIdentity: string;
}) {
  return (
    <section
      className="w-full rounded-md border border-warning/50 border-l-4 border-l-warning bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground/85"
      aria-label={STOCK_DOCUMENT_MISMATCH_COPY.heading}
    >
      <h4 className="flex items-start gap-1.5 font-sans text-[13px] font-semibold leading-snug text-foreground">
        <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span>{STOCK_DOCUMENT_MISMATCH_COPY.heading}</span>
      </h4>
      <p className="mt-1.5">{STOCK_DOCUMENT_MISMATCH_COPY.body}</p>
      {/*
        Each pair wraps as a unit: side by side where the plate is wide, the
        value under its label where it is not — a two-column grid broke the
        brochure's quote into single syllables at phone width.
      */}
      <dl className="mt-2 space-y-1 rounded border border-border/60 bg-background/40 px-2.5 py-2">
        {listingIdentity ? (
          <div className="flex flex-wrap items-baseline gap-x-3">
            <dt className="w-32 shrink-0 text-muted-foreground">{STOCK_DOCUMENT_MISMATCH_COPY.listingLabel}</dt>
            <dd className="min-w-[10rem] flex-1 font-semibold text-foreground">{listingIdentity}</dd>
          </div>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="w-32 shrink-0 text-muted-foreground">{STOCK_DOCUMENT_MISMATCH_COPY.documentLabel}</dt>
          <dd className="min-w-[10rem] flex-1 font-semibold text-foreground">
            {note.states}
            {note.quote ? (
              <span className="font-normal text-muted-foreground">
                {` \u2014 \u201c${note.quote}\u201d`}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      <p className="mt-2 font-medium text-foreground">{STOCK_DOCUMENT_MISMATCH_COPY.action}</p>
      <p className="mt-1 flex items-center gap-1 text-muted-foreground">
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{note.document}</span>
      </p>
      <BrochureImageChoice item={item} note={note} listingIdentity={listingIdentity} />
    </section>
  );
}

/**
 * The links that were read and took no photograph, under one heading. Each
 * keeps its own reason, as recorded.
 */
export function DocumentNotesPanel({ notes }: { notes: readonly Note[] }) {
  if (!notes.length) return null;
  return (
    <section
      className="w-full rounded-md border border-border/70 border-l-4 border-l-info bg-info/5 px-3 py-2.5"
      aria-label={STOCK_DOCUMENT_NOTES_HEADING}
    >
      <h4 className="flex items-center gap-1.5 font-sans text-[13px] font-semibold leading-snug text-foreground">
        <Info className="h-4 w-4 shrink-0 text-info" aria-hidden />
        <span>{STOCK_DOCUMENT_NOTES_HEADING}</span>
        <span
          className="ml-auto rounded-full border border-border/70 bg-background/50 px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground"
          aria-label={`${notes.length} ${notes.length === 1 ? 'link' : 'links'}`}
        >
          {notes.length}
        </span>
      </h4>
      <ul className="mt-2 divide-y divide-border/50">
        {notes.map((note) => (
          <li key={`${note.document}-${note.detail}`} className="flex min-w-0 gap-2 py-2 first:pt-0 last:pb-0">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-medium text-foreground">{note.document}</p>
              <p className="text-foreground/75">{note.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
