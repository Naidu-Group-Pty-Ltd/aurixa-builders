import { type FormEvent, useMemo, useState } from 'react';
import { Loader2, PencilRuler } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useSetBuilderStockManualStats } from '@/lib/builderStockQueries';
import { AU_LOCALE } from '@/lib/aml/displayDate';
import {
  MANUAL_STAT_SPECS, describeManualStats, stockItemTitle,
  type BuilderStockItem, type ManualStatField,
} from '@/lib/builderStock';

/**
 * STATING THE FIGURES A STOCK LIST DID NOT.
 *
 * `LOT 324 - NEX 20 - V002.pdf` imported with bedrooms, bathrooms, car spaces
 * and home size empty, and the Stock List drew four em dashes. The extraction
 * had not failed — it had refused: a dual-key home is two self-contained
 * dwellings, the brochure states two sets of figures, and the model obeyed its
 * first rule rather than inventing a single number. Measured on the prime, all
 * three PDF-sourced properties missing these figures are that same shape.
 *
 * No parser reads a fact a document does not carry. The builder does.
 *
 * ## Three rules this surface keeps
 *
 * **IT SHOWS WHAT THE DOCUMENT SAID.** Every field carries the stock list's
 * own reading underneath it, so a builder can see what they are disagreeing
 * with before they type over it — and can see, on a field that is empty, that
 * the document was silent rather than that the product lost the number.
 *
 * **AN EMPTY BOX IS NOT A ZERO.** Clearing a field withdraws the correction
 * and gives the document its reading back; typing `0` states that there is no
 * bedroom, which is a real answer for a studio and for a townhouse with no
 * car space. The two must never collapse, so the form holds text and the
 * distinction survives all the way to the column's own constraint.
 *
 * **THE SERVER'S RULES ARE THE ONES RENDERED.** Bounds, step and label all
 * come from `MANUAL_STAT_SPECS`, the module the edge function validates
 * against, so what a builder is asked for and what is accepted cannot drift
 * into two standards.
 */
export function BuilderStockFiguresButton({
  item, className,
}: {
  item: BuilderStockItem;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const reading = describeManualStats(item);

  return (
    <>
      <button
        type="button"
        className={className ?? 'bd-spec-note-action'}
        /*
         * PROMINENCE TRACKS WHAT IS OWED.
         *
         * This control is the ONLY way to fill the em dashes in the schedule
         * above it, and it first shipped as 144x15px of 10px annotation type
         * with no border, no ground and no padding — measured, not guessed. It
         * read as a footnote to a footnote: on the reported property it sat
         * further from the dashes it repairs than the sentence explaining them
         * did. "Quiet, and never a button" was the wrong call for the one act
         * the surface exists to offer.
         *
         * So a property with a figure MISSING gets a filled control, and one
         * where nothing is owed gets an outlined one. Both are unmistakably
         * controls; only the first competes for attention, because only the
         * first is asking for anything. A single loud treatment would put a
         * solid block on every card down a sheet of properties that are
         * already complete.
         */
        data-figures={reading.missing.length ? 'outstanding' : 'stated'}
        onClick={() => setOpen(true)}
      >
        <PencilRuler className="h-3 w-3" aria-hidden />
        <span>{reading.action}</span>
        <span className="sr-only"> for {stockItemTitle(item)}</span>
      </button>
      {/* Mounted only while open: a dialog per property on a sheet of them is
          a form state per property held for a page nobody has opened. */}
      {open ? (
        <BuilderStockFiguresDialog item={item} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** The document's own reading of one field, for the line under its box. */
function statedByDocument(item: BuilderStockItem, field: ManualStatField): number | null {
  /*
   * The value the EXTRACTION produced, which is not what the row now carries:
   * the server has already laid the builder's figures over it, and keeps what
   * the document said on `stated_*`. Where nothing was overridden the two are
   * the same, so the row's own value is the document's.
   */
  const overridden = (item as unknown as Record<string, unknown>)[`stated_${field}`];
  const raw = overridden !== undefined
    ? overridden
    : (item as unknown as Record<string, unknown>)[field];
  const value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  return value !== null && Number.isFinite(value) ? value : null;
}

function BuilderStockFiguresDialog({
  item, onClose,
}: {
  item: BuilderStockItem;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const save = useSetBuilderStockManualStats();
  const title = stockItemTitle(item);

  /*
   * Seeded from what the builder previously stated, NOT from the effective
   * value. Seeding from the effective value would silently promote every
   * figure the document supplied into a manual override the first time
   * anybody opened this box — the whole stock list would become hand-entered
   * and stop tracking the builder's own file.
   */
  const initial = useMemo(() => {
    const stated = item.manual_stats?.values ?? {};
    const seeded: Record<string, string> = {};
    for (const spec of MANUAL_STAT_SPECS) {
      const value = stated[spec.field];
      seeded[spec.field] = value === undefined || value === null ? '' : String(value);
    }
    return seeded;
  }, [item.manual_stats]);

  /*
   * Seeded once, because this dialog is MOUNTED fresh each time it opens —
   * the button renders it only while `open`. An effect re-seeding on
   * `initial` would be a cascading render that can never fire usefully, and
   * would discard what a builder had typed if the list refetched underneath
   * them mid-edit.
   */
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const dirty = MANUAL_STAT_SPECS.some((spec) => draft[spec.field] !== initial[spec.field]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldError(null);
    const stats: Partial<Record<ManualStatField, number | null>> = {};
    for (const spec of MANUAL_STAT_SPECS) {
      const text = (draft[spec.field] ?? '').trim();
      // An empty box withdraws the correction; `0` is a figure and survives.
      stats[spec.field] = text === '' ? null : Number(text);
    }
    save.mutate({ stockItemId: item.id, stats }, {
      onSuccess: () => {
        toast({
          title: 'Schedule updated',
          description: `${title} now shows the figures you supplied.`,
        });
        onClose();
      },
      onError: (error) => {
        /*
         * The server REFUSES an out-of-range figure rather than clamping it,
         * so its message names the field and is worth showing verbatim rather
         * than replaced with "something went wrong".
         */
        const message = (error as Error).message || 'The schedule could not be saved.';
        setFieldError(message);
        toast({ title: 'Schedule not saved', description: message, variant: 'destructive' });
      },
    });
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="builder-stock-list-dialog sm:max-w-lg">
        {/*
          `noValidate`: THE SERVER IS THE ONE AUTHORITY ON A FIGURE.
          The min/max/step attributes stay — they drive the number spinner and
          a phone's numeric keyboard — but without this the browser silently
          refuses to submit an out-of-range value and shows a native bubble
          nobody here wrote. Two validators is how one of them comes to say
          something the other does not, and it made the server's own refusal
          unreachable from this form.
        */}
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Schedule — {title}</DialogTitle>
            <DialogDescription>
              Figures entered here appear in the Command Centre and are retained when
              this stock list is uploaded again.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid gap-3">
            {MANUAL_STAT_SPECS.map((spec) => {
              const document = statedByDocument(item, spec.field);
              const inputId = `figure-${spec.field}-${item.id}`;
              return (
                <div key={spec.field} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3">
                  <div className="min-w-0">
                    <Label htmlFor={inputId}>
                      {spec.label}{spec.unit ? ` (${spec.unit})` : ''}
                    </Label>
                    {/*
                      WHAT THE DOCUMENT SAID, under every field. A builder
                      disagreeing with their own stock list should be able to
                      see the reading they are replacing, and a builder looking
                      at an empty field should be able to tell "the file did not
                      say" from "this product lost it".
                    */}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {document === null
                        ? 'Not specified'
                        : `Stock list: ${document.toLocaleString(AU_LOCALE)}${spec.unit ? ` ${spec.unit}` : ''}`}
                    </p>
                  </div>
                  <Input
                    id={inputId}
                    type="number"
                    inputMode="decimal"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={draft[spec.field] ?? ''}
                    placeholder={document === null ? '—' : String(document)}
                    onChange={(event) => setDraft((current) => ({
                      ...current, [spec.field]: event.target.value,
                    }))}
                  />
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Leave a field empty to retain your stock list’s figure. Enter 0 where
            there are none.
          </p>
          {fieldError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">{fieldError}</p>
          ) : null}

          <DialogFooter className="mt-5">
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !dirty}>
              {save.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />Saving…</>
              ) : 'Save schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
