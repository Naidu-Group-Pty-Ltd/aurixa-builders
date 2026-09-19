/**
 * "READ AGAIN" IS TWO DIFFERENT ACTS, AND THE BUTTON HAS TO SAY WHICH.
 *
 * ## The defect this exists for
 *
 * One control sat on every source row, labelled "Read again", and it did one
 * of two genuinely different things depending on how the source had been
 * added:
 *
 *   * an UPLOADED FILE is re-read from the builder's own bytes, which have not
 *     changed and cannot — a parser correction reaching rows that already
 *     exist;
 *   * a LINKED sheet is fetched from the web again, so what it imports is
 *     whatever the builder has since typed into it.
 *
 * Until the re-fetch existed, the second one silently did the first: it
 * re-read the copy taken on the day, reported "47 updated", and imported none
 * of the builder's edits. The only route that did work was to delete the
 * source and add it back — which archives every property it supplies. Measured
 * on Mairandi Developers 18–19 September 2026: three deletes stamped
 * `archived: 47`, two of them followed within 25 seconds by the same address
 * being added again.
 *
 * The server side of that is closed. This is the other half: a builder cannot
 * choose between two acts they are not told apart, and "Read again" describes
 * neither of them well enough to choose. The label names the SOURCE of the
 * bytes, because that is the whole difference.
 *
 * ## The rules
 *
 * **One implementation, three call sites.** The visible label, the accessible
 * name and the confirmation are composed here, so a button cannot promise a
 * fetch while the toast reports a re-read. They were about to be three
 * literals in one file, which is how two of them come to disagree.
 *
 * **What the act is named is decided by the source, never by its status.**
 * `source_type` is written once when the source is added and never changes,
 * so the naming is a fact about the source for its whole life.
 *
 * **It never claims the import brought a change.** "Updated 47" is a count of
 * rows the import wrote, not of rows that differ, and a sentence promising
 * the builder their edits arrived is one this layer has no evidence for.
 *
 * Pure + deterministic + JSON-safe: no DOM, network, secrets or clocks.
 */

export interface RereadSubject {
  /** `'url'` for a linked source, anything else for an uploaded file. */
  source_type?: string | null;
}

export interface RereadNaming {
  /** Which act this is. `link` re-fetches; `file` re-reads stored bytes. */
  kind: 'link' | 'file';
  /** The button's visible text. */
  label: string;
  /** The accessible name, completed with the source's own label by the caller. */
  actionFor: (sourceLabel: string) => string;
  /** The heading of the confirmation once it has succeeded. */
  successTitle: string;
  /** The heading when it failed. */
  failureTitle: string;
  /**
   * What the reader should understand happened. Deliberately about where the
   * rows CAME FROM rather than about what changed.
   */
  detail: string;
}

export function rereadNaming(upload: RereadSubject | null | undefined): RereadNaming {
  const linked = String(upload?.source_type ?? '') === 'url';

  if (linked) {
    return {
      kind: 'link',
      label: 'Fetch the link again',
      actionFor: (sourceLabel) => `Fetch ${sourceLabel} from its link again`,
      successTitle: 'Link fetched again',
      failureTitle: 'That link could not be fetched again',
      detail:
        'Your stock list was read from its address just now, so anything you have '
        + 'changed there is in. Nothing was removed and no property lost its place.',
    };
  }

  return {
    kind: 'file',
    label: 'Read the file again',
    actionFor: (sourceLabel) => `Read ${sourceLabel} again`,
    successTitle: 'File read again',
    failureTitle: 'That file could not be read again',
    detail:
      'The file you uploaded was read again with the current readers. To import '
      + 'changes you have made since, add the updated file as a new stock list.',
  };
}

/**
 * The counts, said the same way for both acts.
 *
 * Separate from the naming because a caller may have no summary — a source
 * that imported nothing new still read successfully, and a sentence is owed
 * either way.
 */
export function describeRereadCounts(
  summary: { imported?: number | null; updated?: number | null } | null | undefined,
): string | null {
  if (!summary) return null;
  const imported = Number(summary.imported ?? 0) || 0;
  const updated = Number(summary.updated ?? 0) || 0;
  return `${imported} added, ${updated} updated.`;
}
