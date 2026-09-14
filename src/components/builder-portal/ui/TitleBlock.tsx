import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * THE PANEL A DRAWING SHEET CARRIES IN ITS CORNER.
 *
 * Lot and plan number, design, areas, revision — the facts that identify the
 * thing being looked at, keyed so they can be read without a legend. It
 * replaces the rows of unlabelled grey text that metadata defaults to, where
 * `174 / 153 m²` sits beside `PS840221` and the reader has to work out which
 * is which.
 *
 * Display only. Every cell is a value the caller already holds.
 *
 * ## An absent fact is named, not dashed
 *
 * A title block's cells are fixed positions, so an empty one cannot simply be
 * dropped without the grid lying about which key a value belongs to. A `null`
 * value therefore renders as "Not recorded" in annotation type — which says
 * the record is silent, where a dash reads as a value somebody entered.
 */
export interface TitleBlockCell {
  key: string;
  /** The key, set in annotation type. Two or three words. */
  label: string;
  /** The fact. `null` where the record does not hold one. */
  value: ReactNode | null;
}

export interface TitleBlockProps {
  cells: TitleBlockCell[];
  /** Four across from the `sm` breakpoint; otherwise two. */
  wide?: boolean;
  className?: string;
}

export function TitleBlock({ cells, wide = true, className }: TitleBlockProps) {
  if (cells.length === 0) return null;

  return (
    <dl className={cn('bd-titleblock', wide && 'bd-titleblock-4', className)}>
      {cells.map((cell) => {
        const empty = cell.value === null || cell.value === undefined || cell.value === '';
        return (
          <div key={cell.key}>
            <dt className="bd-annot">{cell.label}</dt>
            <dd
              className={cn(
                'mt-0.5 truncate text-[0.8125rem] font-semibold tracking-tight tabular-nums',
                empty ? 'bd-annot font-normal tracking-[0.2em]' : 'text-foreground',
              )}
            >
              {empty ? 'Not recorded' : cell.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
