import { cn } from '@/lib/utils';

/**
 * A LOT'S POSITION, DRAWN AS A DIMENSION LINE.
 *
 * The Builder portal's signature component, and the reason the redesign
 * exists. Construction is an ordered sequence — land registers, a slab goes
 * down, a frame goes up, lock-up, fixing, handover — and a builder reads a
 * dimension line without thinking: extension lines, tick terminators, and an
 * annotated extent between two stations.
 *
 * That is exactly the shape of the question this answers: *where is this lot,
 * and how long has it been there.* A progress bar can carry the first half and
 * throws the second away; a dimension line is built to carry both.
 *
 * ## Four rules
 *
 * **IT NEVER GUESSES A POSITION.** `currentIndex` is nullable on purpose. A
 * record that does not say which stage a lot is at draws the whole extent in
 * the pending weight and says so in the note — it does not default to the
 * first station, which would state a fact the data does not hold. An
 * out-of-range index is treated as absent rather than clamped, because a clamp
 * invents a position too.
 *
 * **IDENTITY IS THE LABEL, NEVER THE COLOUR.** Every station is named under
 * its own tick. Line weight and fill mark *progress*, so the rail stays
 * readable in greyscale, under any colour vision, and for a tenant whose
 * white-label primary lands anywhere on the wheel.
 *
 * **THE LINE WORK SCALES; THE TYPE DOES NOT.** This was an SVG first, inside a
 * 620-unit viewBox, and a viewBox scales its contents — so on a wide sheet the
 * drawing rendered at 2.8× and the station labels came out at 22px, swamping
 * the line they annotate. Laid out in HTML, each station takes a percentage
 * along the track while its label keeps a real CSS size at every width.
 *
 * **IT DRAWS; IT DOES NOT DECIDE.** No stage is derived here, no duration
 * computed, no ordering inferred. What a stage means, and whether a lot is
 * late, is the caller's to say.
 */
export interface DimensionStage {
  /** Stable key — a stage identifier from the caller's own vocabulary. */
  key: string;
  /** What the station is called under its tick. Kept short; several of them
   *  share the width. */
  label: string;
  /**
   * The drawn form, where `label` is too long to sit under a tick beside its
   * neighbours. The DRAWING takes this; the spoken description always takes
   * `label`, so shortening can never rename a station — and by convention a
   * short form is a prefix of the full one.
   */
  short?: string;
}

export interface DimensionRailProps {
  stages: DimensionStage[];
  /**
   * Which station the lot stands at, zero-based — or `null` where the record
   * does not say.
   */
  currentIndex: number | null;
  /** A short extent over the current station, e.g. `8 days`. */
  annotation?: string | null;
  /** One line of drawing notes under the rail. */
  note?: string | null;
  /** Card-sized: no marker, no note, tighter labels. */
  dense?: boolean;
  className?: string;
}

export function DimensionRail({
  stages,
  currentIndex,
  annotation,
  note,
  dense = false,
  className,
}: DimensionRailProps) {
  if (stages.length === 0) return null;

  const hasPosition =
    currentIndex !== null && currentIndex >= 0 && currentIndex < stages.length;
  const current = hasPosition ? (currentIndex as number) : -1;

  /** Where a station sits along the extent, as a percentage. */
  const at = (i: number) => (stages.length > 1 ? (i / (stages.length - 1)) * 100 : 50);

  /*
   * The spoken version. A screen reader gets the sentence rather than a row of
   * disconnected station names — and where there is no position it gets the
   * same honest answer the drawing gives.
   */
  const spoken = hasPosition
    ? `Stage ${current + 1} of ${stages.length}: ${stages[current].label}.`
      + (annotation ? ` ${annotation} at this stage.` : '')
    : `Stage not recorded. ${stages.length} stages, from ${stages[0].label} `
      + `to ${stages[stages.length - 1].label}.`;

  /*
   * The end labels anchor inward so neither runs off the sheet; everything
   * between is centred on its own tick.
   */
  const labelStyle = (i: number) => {
    if (i === 0) return { left: 0 };
    if (i === stages.length - 1) return { right: 0 };
    return { left: `${at(i)}%`, transform: 'translateX(-50%)' };
  };

  /*
   * `bd-rail` is what BOUNDS the extent, and it replaces the `w-full` this
   * root used to carry. A dimension line run across a 1,550px sheet reads
   * as a row of unrelated points rather than one measured span — found by
   * rendering it, not by reading it — so the class sets a max-width as well
   * as the full width. A dense rail lives in a table cell already narrower
   * than that bound, so it costs those nothing.
   */
  return (
    <div className={cn('bd-rail', className)} role="img" aria-label={spoken}>
      {/* Section marker and extent, above the station it measures to. */}
      {!dense && hasPosition && annotation ? (
        <div className="relative h-7">
          <div className="bd-rail-marker" style={{ left: `${at(current)}%` }}>
            <span className="bd-annot text-foreground" style={{ letterSpacing: '0.16em' }}>
              {annotation}
            </span>
            <span className="bd-rail-caret" aria-hidden />
          </div>
        </div>
      ) : null}

      <div className="bd-rail-track">
        <span className="bd-rail-line" aria-hidden />
        {hasPosition && current > 0 ? (
          <span
            className="bd-rail-done"
            style={{ width: `${at(current)}%` }}
            aria-hidden
          />
        ) : null}
        {stages.map((stage, i) => (
          <span
            key={`ext-${stage.key}`}
            className="bd-rail-ext"
            style={{ left: `${at(i)}%` }}
            aria-hidden
          />
        ))}
        {stages.map((stage, i) => (
          <span
            key={`tick-${stage.key}`}
            className={cn('bd-rail-tick', hasPosition && i <= current && 'bd-rail-tick-reached')}
            style={{ left: `${at(i)}%` }}
            aria-hidden
          />
        ))}
        {hasPosition ? (
          <span className="bd-rail-dot" style={{ left: `${at(current)}%` }} aria-hidden />
        ) : null}
      </div>

      <div className={cn('bd-rail-labels', dense ? 'mt-1' : 'mt-1.5')}>
        {stages.map((stage, i) => {
          /*
           * DENSE DRAWS THREE STATIONS, NOT ALL OF THEM.
           *
           * A dense rail lives in a table cell. Seven names across ~500px is
           * ~70px each, and "Practical completion" alone is twice that — so
           * every row of a build list overlapped its own labels. The ends
           * carry the extent and the current station carries the answer;
           * the ticks still mark every station, so nothing is removed from
           * the drawing, only from the annotation.
           */
          const drawn = !dense || i === 0 || i === stages.length - 1 || i === current;
          if (!drawn) return null;

          return (
            <span
              key={`lbl-${stage.key}`}
              className={cn(
                'bd-rail-label bd-annot',
                hasPosition && i === current && 'font-bold text-foreground',
              )}
              style={labelStyle(i)}
            >
              {stage.short ?? stage.label}
            </span>
          );
        })}
      </div>

      {/* Drawing notes. Where the position is unknown this carries the reason,
          so the absence is stated rather than inferred from a rail with no
          marker on it. */}
      {!dense && (note || !hasPosition) ? (
        <p className="bd-annot mt-3">{note ?? 'Stage not recorded for this lot'}</p>
      ) : null}
    </div>
  );
}
