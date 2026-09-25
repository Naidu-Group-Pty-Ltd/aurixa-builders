/**
 * "USE BROCHURE IMAGE" — A BUILDER SAYS A BROCHURE IS THEIRS, AND CAN UNSAY IT.
 *
 * "Brochure details don't match this property" refuses a brochure whose image
 * page states another lot, and it is right to: a cover naming another lot is
 * how another house reaches a client's card. It is also sometimes wrong about
 * the builder's own brochure — Lot 1037 · Vanta 20's cover mistypes its lot as
 * "Lot 1307" — and only the person holding the sheet can tell which.
 *
 * So the builder is offered one choice, BESIDE the explanation rather than
 * instead of it, behind a confirmation that names both identities. Where
 * another listing already shows this brochure's photograph (`in_use_by`) the
 * choice is still offered — the owner's rule is that a builder who wants the
 * photograph in the brochure they linked may use it — and that listing is
 * named beside the button and again in the dialog, so nobody puts one house
 * on two cards without being told. Where the page did not know — a read that
 * failed, a listing that took the photograph since — the server names it
 * (`in_use_unacknowledged`), the dialog stays open saying so, and the next
 * press confirms knowing. A transposition is said as a possibility, never a
 * conclusion.
 *
 * Every word is `STOCK_BROCHURE_CONFIRMATION_COPY`, the same copy the server's
 * refusals are written beside, and nothing here decides anything the server
 * does not check again: the link and the lot are sent back exactly as shown.
 */
import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { AU_LOCALE } from '@/lib/aml/displayDate';
import type { BuilderStockItem, StockBrochureConfirmation } from '@/lib/builderStock';
import { useConfirmBrochureImage, useUndoBrochureImage } from '@/lib/builderStockQueries';
import {
  STOCK_BROCHURE_CONFIRMATION_COPY as COPY,
} from '../../../supabase/functions/_shared/builderStock/imageProgress.pure';
import {
  confirmedLotOf, lotsShareDigits,
} from '../../../supabase/functions/_shared/builderStock/brochureConfirmation.pure';

type Note = NonNullable<BuilderStockItem['source_document_notes']>[number];
type ListingReference = NonNullable<Note['in_use_by']>;

/** The listing an `in_use_unacknowledged` refusal names, if that is what this is. */
function unacknowledgedInUse(error: unknown): ListingReference | null {
  const failure = error as { code?: unknown; body?: { in_use_by?: unknown } } | null;
  if (failure?.code !== 'in_use_unacknowledged') return null;
  const named = failure.body?.in_use_by as Partial<ListingReference> | undefined;
  return named?.stock_item_id && named.identity
    ? { stock_item_id: String(named.stock_item_id), identity: String(named.identity) }
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Please try again shortly.';
}

/**
 * The choice on one mismatch: the button and its confirmation, with the
 * listing that already shows this brochure's photograph named where there is
 * one.
 */
export function BrochureImageChoice({
  item,
  note,
  listingIdentity,
}: {
  item: BuilderStockItem;
  note: Note;
  listingIdentity: string;
}) {
  const { toast } = useToast();
  const confirm = useConfirmBrochureImage();
  const [open, setOpen] = useState(false);
  // A listing the server named at the act that the page had not shown.
  const [namedAtAct, setNamedAtAct] = useState<ListingReference | null>(null);

  if (!note.confirmable || !note.document_key || !note.states) return null;
  const inUse = namedAtAct ?? note.in_use_by ?? null;
  const inUseBy = inUse?.identity ?? null;

  const statedLot = confirmedLotOf(note.states);
  const transposed = lotsShareDigits(String(item.lot_number ?? '').trim(), statedLot);
  const listing = listingIdentity || 'this property';

  return (
    <>
      {inUseBy ? <p className="mt-1 text-foreground/80">{COPY.inUse(inUseBy)}</p> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-1.5 h-7 px-2 text-[11px]"
        onClick={() => setOpen(true)}
      >
        {COPY.action}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!confirm.isPending) setOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{COPY.dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{COPY.dialogBody(note.states, listing)}</p>
                {inUseBy ? <p>{COPY.inUseDialog(inUseBy)}</p> : null}
                {transposed ? <p>{COPY.transposed}</p> : null}
                {!inUseBy && note.stated_lot_listing?.identity ? (
                  <p>{COPY.statedLotListing(note.stated_lot_listing.identity)}</p>
                ) : null}
                <p>{COPY.checks}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirm.isPending}>{COPY.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirm.isPending}
              onClick={(event) => {
                event.preventDefault();
                confirm.mutate(
                  {
                    stockItemId: item.id, documentKey: note.document_key!, states: note.states!,
                    acknowledgedInUse: inUse?.stock_item_id ?? null,
                  },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setNamedAtAct(null);
                      toast({
                        title: COPY.confirmedToastTitle,
                        description: COPY.confirmedToastBody(listing),
                      });
                    },
                    onError: (error) => {
                      const named = unacknowledgedInUse(error);
                      if (named) {
                        // Not a failure: the builder is told, here, and decides.
                        setNamedAtAct(named);
                        return;
                      }
                      setOpen(false);
                      toast({
                        title: 'The brochure image could not be used',
                        description: errorMessage(error),
                        variant: 'destructive',
                      });
                    },
                  },
                );
              }}
            >
              {confirm.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {COPY.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function confirmedOn(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(AU_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What became of the confirmation, in the builder's words. Applied says nothing more. */
function stateLine(confirmation: StockBrochureConfirmation): string | null {
  if (confirmation.state === 'pending') return COPY.pending;
  if (confirmation.state === 'unreadable') return COPY.unreadable;
  if (confirmation.state === 'unlinked') return COPY.unlinked;
  if (confirmation.state === 'not_applied') {
    return confirmation.detail ? `${COPY.notApplied} ${confirmation.detail}` : COPY.notApplied;
  }
  return null;
}

/**
 * The brochures the builder confirmed, each with who confirmed it, what became
 * of it, and the undo. Drawn whether or not the card has a picture: a confirmed
 * brochure usually IS the picture, and the undo has to stay in reach.
 */
export function BrochureConfirmations({ item }: { item: BuilderStockItem }) {
  const confirmations = item.brochure_confirmations ?? [];
  if (!confirmations.length) return null;
  return (
    <ul className="w-full space-y-1 text-[11px] leading-snug text-muted-foreground">
      {confirmations.map((confirmation) => (
        <BrochureConfirmationLine key={confirmation.id} item={item} confirmation={confirmation} />
      ))}
    </ul>
  );
}

function BrochureConfirmationLine({
  item,
  confirmation,
}: {
  item: BuilderStockItem;
  confirmation: StockBrochureConfirmation;
}) {
  const { toast } = useToast();
  const undo = useUndoBrochureImage();
  const [open, setOpen] = useState(false);
  const line = stateLine(confirmation);

  return (
    <li className="min-w-0 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
      <p className="flex items-start gap-1 text-foreground">
        <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <span>{COPY.confirmedBy(confirmation.confirmed_by, confirmedOn(confirmation.confirmed_at))}</span>
      </p>
      {line ? <p className="mt-0.5">{line}</p> : null}
      <p className="mt-0.5 text-muted-foreground/80">
        {confirmation.document}
        {confirmation.states ? ` — ${confirmation.states}` : ''}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1 h-6 px-1.5 text-[11px]"
        onClick={() => setOpen(true)}
      >
        {COPY.undo}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!undo.isPending) setOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{COPY.undoTitle}</AlertDialogTitle>
            <AlertDialogDescription>{COPY.undoBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={undo.isPending}>{COPY.undoKeep}</AlertDialogCancel>
            <AlertDialogAction
              disabled={undo.isPending}
              onClick={(event) => {
                event.preventDefault();
                undo.mutate(
                  { stockItemId: item.id, confirmationId: confirmation.id },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      toast({ title: COPY.undoneToastTitle, description: COPY.undoneToastBody });
                    },
                    onError: (error) => {
                      setOpen(false);
                      toast({
                        title: 'The confirmation could not be undone',
                        description: errorMessage(error),
                        variant: 'destructive',
                      });
                    },
                  },
                );
              }}
            >
              {undo.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : null}
              {COPY.undoConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
