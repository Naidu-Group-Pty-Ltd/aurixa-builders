import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * FIGURES SET AS A SCHEDULE, NOT AS A GRID OF TILES.
 *
 * What replaces the `BuilderPortalStatCard` grids. Nine bordered boxes each
 * holding a single digit — plus nine icon chips and nine shadows — took more
 * height than the content under them and gave "Active projects" exactly the
 * same weight as "Unread notifications". One ruled block costs four cells
 * instead of four borders, and lets the figure itself be the loud thing.
 *
 * ## Every figure carries a baseline, and the type enforces it
 *
 * `baseline` is REQUIRED. A bare `0` reads as a broken page; `0` above
 * "Nothing waiting on you" reads as finished. The dashboard used to paper over
 * this with a footnote under the whole grid — "a zero means nothing you can
 * see, not necessarily nothing at all" — which is an apology for a number that
 * does not explain itself. Making the field mandatory means a caller cannot
 * add a figure without saying what to read it against.
 *
 * A unit is optional because some figures are already denominated ($742k), but
 * a bare count should carry one.
 *
 * Display only: it renders what it is handed. It does not fetch, count, derive
 * or interpret, and what a zero means is the caller's copy to write.
 */
export interface ScheduleFigure {
  key: string;
  /** Set in annotation type above the figure. */
  label: string;
  value: number | string;
  /** Trails the figure, quiet and small. `lots`, `by advisers`. */
  unit?: string;
  /**
   * What to read the figure against — a movement, a comparison, or a sentence
   * that makes a zero legible. Required; see the note above.
   */
  baseline: ReactNode;
  /** An existing route. Omit for a non-navigating cell. */
  to?: string;
}

export interface BuilderScheduleProps {
  figures: ScheduleFigure[];
  className?: string;
}

export function BuilderSchedule({ figures, className }: BuilderScheduleProps) {
  if (figures.length === 0) return null;

  return (
    <div
      className={cn(
        'bd-schedule',
        /* Three and four across from `md`; anything else stays two, which is
           the only column count that divides cleanly at every width.

           Eight is four across over two ruled rows — ONE schedule. The
           dashboard used to draw two four-across blocks stacked, which at
           1,920px is a 400px cell holding a single digit and a second border
           where a drawing would simply rule another row. */
        figures.length === 3 && 'bd-schedule-3',
        figures.length === 4 && 'bd-schedule-4',
        figures.length === 8 && 'bd-schedule-8',
        className,
      )}
    >
      {figures.map((figure) => {
        const body = (
          <>
            <p className="bd-annot">{figure.label}</p>
            <p className="bd-figure mt-2.5">
              {figure.value}
              {figure.unit ? <span className="bd-figure-unit">{figure.unit}</span> : null}
            </p>
            <p className="mt-2 text-[0.6875rem] tabular-nums text-muted-foreground">
              {figure.baseline}
            </p>
          </>
        );

        if (!figure.to) {
          return <div key={figure.key}>{body}</div>;
        }

        return (
          <div key={figure.key} className="focus-within:ring-2 focus-within:ring-ring">
            <Link to={figure.to} className="block focus:outline-none">
              {body}
            </Link>
          </div>
        );
      })}
    </div>
  );
}
