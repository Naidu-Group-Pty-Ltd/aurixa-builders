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
  MANUAL_STAT_SPECS, STATED_LOCATION_SPECS, STATED_STATES, describeManualStats, stockItemTitle,
  type BuilderStockItem, type ManualStatField, type StatedLocationField,
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
 *
 * ## And where the property is
 *
 * `Lot 101 - PICO - BROCHURE v002.pdf` names its lot and its estate and no
 * street, suburb, state or postcode — read on every page and in every picture
 * — so its card could be placed on no marketplace. The same dialog takes the
 * address, under the same three rules: the stock list's reading under each
 * part, an empty box gives the document its reading back, and the parts and
 * their rules come from `STATED_LOCATION_SPECS`, the module the server
 * validates with. See `statedLocation.pure.ts`.
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
        data-figures={reading.missing.length || reading.addressMissing ? 'outstanding' : 'stated'}
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

/**
 * The document's own reading of one part of the address. The same rule as the
 * figures: the row carries the builder's part where they stated one, and what
 * the document said underneath rides on `stated_*`.
 */
function placedByDocument(item: BuilderStockItem, field: StatedLocationField): string | null {
  const row = item as unknown as Record<string, unknown>;
  const raw = row[`stated_${field}`] !== undefined ? row[`stated_${field}`] : row[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value === '' ? null : value;
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
    // The address the same way: what the BUILDER stated, never the effective
    // value, or opening this box would turn the document's address into theirs.
    const placed = item.manual_location ?? {};
    for (const spec of STATED_LOCATION_SPECS) {
      seeded[spec.field] = placed[spec.field] ?? '';
    }
    return seeded;
  }, [item.manual_stats, item.manual_location]);

  /*
   * Seeded once, because this dialog is MOUNTED fresh each time it opens —
   * the button renders it only while `open`. An effect re-seeding on
   * `initial` would be a cascading render that can never fire usefully, and
   * would discard what a builder had typed if the list refetched underneath
   * them mid-edit.
   */
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const dirty = [...MANUAL_STAT_SPECS, ...STATED_LOCATION_SPECS]
    .some((spec) => draft[spec.field] !== initial[spec.field]);
  const edit = (field: string, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldError(null);
    const stats: Partial<Record<ManualStatField, number | null>> = {};
    for (const spec of MANUAL_STAT_SPECS) {
      const text = (draft[spec.field] ?? '').trim();
      // An empty box withdraws the correction; `0` is a figure and survives.
      stats[spec.field] = text === '' ? null : Number(text);
    }
    // Every part sent, a cleared one as `null`: that is a withdrawal, where a
    // part left out of the request would be read as "keep what is stored".
    const location: Partial<Record<StatedLocationField, string | null>> = {};
    for (const spec of STATED_LOCATION_SPECS) {
      const text = (draft[spec.field] ?? '').trim();
      location[spec.field] = text === '' ? null : text;
    }
    save.mutate({ stockItemId: item.id, stats, location }, {
      onSuccess: () => {
        toast({
          title: 'Schedule updated',
          description: `${title} now shows the details you supplied.`,
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
      {/*
        `overflow-y-auto`: with the address above the figures this form is nine
        rows tall, and the default above 640px is `sm:overflow-visible` inside
        an 85dvh ceiling — on a short laptop window the Save button would be
        painted below the screen with no way to scroll to it. Declaring an
        overflow withholds that default (`declaresOwnOverflow`).
      */}
      <DialogContent className="builder-stock-list-dialog sm:max-w-lg overflow-y-auto">
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
              Details entered here appear in the Command Centre and are retained when
              this stock list is uploaded again.
            </DialogDescription>
          </DialogHeader>

          {/*
            THE ADDRESS FIRST, because it is what names the property: a card
            nobody can place is missing more than a bedroom count. Each part is
            its own row with the stock list's reading under it, exactly as a
            figure is, so a builder can see that the brochure named no suburb
            rather than suspect the product lost one.
          */}
          <fieldset className="mt-4 grid gap-3">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Address
            </legend>
            {STATED_LOCATION_SPECS.map((spec) => {
              const document = placedByDocument(item, spec.field);
              const inputId = `place-${spec.field}-${item.id}`;
              const narrow = spec.field === 'state' || spec.field === 'postcode';
              return (
                <div
                  key={spec.field}
                  className={narrow
                    ? 'grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3'
                    : 'grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] items-center gap-3'}
                >
                  <div className="min-w-0">
                    <Label htmlFor={inputId}>{spec.label}</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {document === null ? 'Not specified' : `Stock list: ${document}`}
                    </p>
                  </div>
                  {spec.field === 'state' ? (
                    <select
                      id={inputId}
                      value={draft[spec.field] ?? ''}
                      onChange={(event) => edit(spec.field, event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">{document === null ? '—' : document}</option>
                      {STATED_STATES.map((state) => (
                        <option key={state} value={state}>{state}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={inputId}
                      type="text"
                      inputMode={spec.field === 'postcode' ? 'numeric' : 'text'}
                      autoComplete="off"
                      maxLength={spec.maxLength}
                      value={draft[spec.field] ?? ''}
                      placeholder={document ?? '—'}
                      onChange={(event) => edit(spec.field, event.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>

          <fieldset className="mt-5 grid gap-3">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Figures
            </legend>
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
                    onChange={(event) => edit(spec.field, event.target.value)}
                  />
                </div>
              );
            })}
          </fieldset>

          <p className="mt-3 text-xs text-muted-foreground">
            Leave a field empty to retain your stock list’s reading. Enter 0 where
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
