import {
  CONSTRUCTION_STAGE_KEY_LABELS,
  CONSTRUCTION_STATUS_LABELS,
  type BuilderConstructionStage,
  type BuilderConstructionStageKey,
  type BuilderConstructionStatus,
} from '@/lib/builderConstruction';
import type { DimensionStage } from '@/components/builder-portal/ui/DimensionRail';

/**
 * CONSTRUCTION, PROJECTED ONTO A DIMENSION LINE.
 *
 * `DimensionRail` draws an ordered extent and a position on it. This is the
 * one module that decides what that extent IS for a build, and where a build
 * stands on it — so the detail page, the list and anything added later cannot
 * come to different answers about the same case.
 *
 * ## Three rules
 *
 * **OFF-SEQUENCE IS NOT A POSITION.** `on_hold` and `cancelled` are real
 * statuses and they are not points on the line — a paused build is somewhere
 * on the extent, but the status does not say where. They resolve to `null`,
 * which the rail renders as the whole extent in the pending weight with the
 * absence stated. Placing them at an index would be inventing a fact, and
 * placing them at the end would say a cancelled build had completed.
 *
 * **THE CASE'S OWN STAGES OUTRANK THE CATALOGUE.** Where a build carries
 * `construction_stages` rows, the extent is built from those, in their own
 * `sequence_number` order — because a builder may not run every stage, and a
 * rail that shows stations the build does not have measures somebody else's
 * job. The fixed key order is only the fallback ordering when two rows share
 * a sequence number.
 *
 * **A SHORT LABEL IS A PREFIX OF THE FULL ONE.** The rail draws `short`, the
 * screen reader is given `label`. Keeping the short form a prefix means the
 * two can never name different things — asserted by a test rather than
 * trusted.
 */

/**
 * The catalogue order. `other` is deliberately absent: a stage that declares
 * no place in the sequence cannot be given one, and including it would put an
 * arbitrary station between two real ones.
 */
export const CONSTRUCTION_STAGE_SEQUENCE: readonly BuilderConstructionStageKey[] = [
  'site_preparation',
  'base',
  'frame',
  'lockup',
  'fixing',
  'practical_completion',
  'handover',
] as const;

/**
 * Drawn forms, for the stations that do not fit under a tick. Each is a
 * prefix of `CONSTRUCTION_STAGE_KEY_LABELS[key]`; see the rule above.
 */
export const CONSTRUCTION_STAGE_SHORT_LABELS: Partial<
  Record<BuilderConstructionStageKey, string>
> = {
  site_preparation: 'Site prep',
  practical_completion: 'Practical',
};

/**
 * The ordered case statuses. `on_hold` and `cancelled` are NOT here — that is
 * the whole point; see `railIndexFromStatus`.
 */
export const CONSTRUCTION_STATUS_SEQUENCE: readonly BuilderConstructionStatus[] = [
  'not_started',
  'site_preparation',
  'under_construction',
  'practical_completion',
  'handover',
  'completed',
] as const;

/** The stations for a build that carries its own stage rows. */
export function railStationsFromStages(
  stages: readonly BuilderConstructionStage[],
): DimensionStage[] {
  return stages
    .filter((stage) => stage.stage_key !== 'other')
    .slice()
    .sort((a, b) => {
      if (a.sequence_number !== b.sequence_number) {
        return a.sequence_number - b.sequence_number;
      }
      return (
        CONSTRUCTION_STAGE_SEQUENCE.indexOf(a.stage_key) -
        CONSTRUCTION_STAGE_SEQUENCE.indexOf(b.stage_key)
      );
    })
    .map((stage) => ({
      key: stage.id,
      label: CONSTRUCTION_STAGE_KEY_LABELS[stage.stage_key],
      short: CONSTRUCTION_STAGE_SHORT_LABELS[stage.stage_key],
    }));
}

/**
 * Where the build stands, over the stations `railStationsFromStages` built.
 *
 * The stage in progress is the position. Where none is in progress the last
 * COMPLETE stage is, because a build that has finished lock-up and not begun
 * fixing stands at lock-up. Where neither exists there is no position — a
 * build whose every stage is `not_started` has not started, and saying it
 * stands at the first station would claim work that has not happened.
 */
export function railIndexFromStages(
  stages: readonly BuilderConstructionStage[],
): number | null {
  const ordered = railStationsFromStages(stages);
  if (ordered.length === 0) return null;

  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const statusAt = (i: number) => byId.get(ordered[i].key)?.status;

  for (let i = 0; i < ordered.length; i += 1) {
    if (statusAt(i) === 'in_progress') return i;
  }
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (statusAt(i) === 'complete') return i;
  }
  return null;
}

/** The stations for a build with no stage rows — its lifecycle statuses. */
export function railStationsFromStatuses(): DimensionStage[] {
  return CONSTRUCTION_STATUS_SEQUENCE.map((status) => ({
    key: status,
    label: CONSTRUCTION_STATUS_LABELS[status],
  }));
}

/**
 * Where a build stands on the status line — or `null` where the status is not
 * a point on it. See the off-sequence rule at the top of this file.
 */
export function railIndexFromStatus(status: string | null | undefined): number | null {
  if (!status) return null;
  const at = CONSTRUCTION_STATUS_SEQUENCE.indexOf(status as BuilderConstructionStatus);
  return at === -1 ? null : at;
}

/**
 * How long the build has stood at a station, for the annotated extent over
 * the current mark.
 *
 * `now` is a PARAMETER rather than a `Date.now()` call, for two reasons: a
 * clock read during render is impure and can produce a different answer on a
 * re-render nothing asked for, and a function that takes its own clock can be
 * tested without one.
 *
 * Absent rather than estimated: a stage that was never dated, or dated in the
 * future, carries no annotation instead of a guessed one.
 */
export function stageDwellAnnotation(
  actualStartDate: string | null | undefined,
  now: number,
): string | null {
  if (!actualStartDate) return null;
  const started = new Date(actualStartDate);
  if (Number.isNaN(started.getTime())) return null;
  const days = Math.floor((now - started.getTime()) / 86_400_000);
  if (days < 0) return null;
  return days === 0 ? 'Today' : `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Whether a status is a recognised one that simply has no place on the line. */
export function isOffSequenceStatus(status: string | null | undefined): boolean {
  return status === 'on_hold' || status === 'cancelled';
}

/**
 * The note under a rail. It states what the drawing cannot: that a paused or
 * cancelled build is somewhere on the extent and the record does not say
 * where, rather than leaving an unmarked line to be read as "nothing has
 * happened".
 */
export function railNoteForStatus(status: string | null | undefined): string | null {
  if (status === 'on_hold') return 'On hold — the stage it paused at is not recorded';
  if (status === 'cancelled') return 'Cancelled — no stage is current';
  return null;
}
