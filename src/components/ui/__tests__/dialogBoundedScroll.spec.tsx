/**
 * A bounded pop-up must never be told not to clip.
 *
 * The default dialog treatment sets `sm:max-h-[85dvh]` and used to set
 * `sm:overflow-visible` beside it — a bounded box instructed not to clip. Any
 * dialog whose content exceeded the bound painted straight through its own
 * bottom border with no scrollbar on either axis, so its footer buttons were
 * on screen and unreachable on a short laptop window. The Command Centre fixed
 * it on 19 Sep 2026; this portal carried the same default until 30 Sep, and
 * the confirmation dialogs carried it in both.
 *
 * Rendered rather than reasoned about: the composition is a `cn()` of
 * conditionals over a caller's own className, which is exactly the kind of
 * thing that reads correct and merges wrong.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dialog, DialogContent, DialogTitle } from '../dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
} from '../alert-dialog';

function classesFor(className?: string): string {
  const view = render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>Add picture</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  const classes = screen.getByRole('dialog').className;
  view.unmount();
  return classes;
}

describe('the default dialog treatment', () => {
  it('bounds the height and gives it somewhere to scroll', () => {
    const classes = classesFor();
    expect(classes).toContain('sm:max-h-[85dvh]');
    expect(classes).toContain('sm:overflow-y-auto');
    expect(classes).not.toContain('sm:overflow-visible');
  });

  it('agrees with the mobile sheet instead of contradicting it', () => {
    const classes = classesFor();
    expect(classes).toContain('max-h-[92dvh]');
    expect(classes).toContain('overflow-y-auto');
  });

  it('reaches a dialog that states only a width', () => {
    const classes = classesFor('max-w-3xl');
    expect(classes).toContain('max-w-3xl');
    expect(classes).toContain('sm:max-h-[85dvh]');
    expect(classes).toContain('sm:overflow-y-auto');
    expect(classes).not.toContain('sm:max-w-lg');
  });

  it('still lets a caller own the overflow, inner-scroller shapes included', () => {
    const classes = classesFor('flex max-h-[90vh] flex-col overflow-hidden');
    expect(classes).toContain('overflow-hidden');
    expect(classes).not.toContain('sm:overflow-y-auto');
    expect(classes).not.toContain('sm:max-h-[85dvh]');
  });

  it('never bounds a height without a way to reach what is past it', () => {
    for (const className of [undefined, 'max-w-3xl', 'sm:max-w-5xl', 'max-h-[90vh]', 'w-[95vw] max-w-3xl']) {
      const classes = classesFor(className);
      const bounded = /max-h-/.test(classes);
      const scrolls = /overflow-(?:y-)?(?:auto|scroll|hidden|clip)/.test(classes);
      expect(bounded && !scrolls, `bounded with no scroll: ${className}`).toBe(false);
    }
  });
});

describe('the confirmation dialog', () => {
  it('scrolls inside its own height at every width', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Remove this property?</AlertDialogTitle>
          <AlertDialogDescription>It leaves the marketplace.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const classes = screen.getByRole('alertdialog').className;
    expect(classes).toContain('sm:max-h-[85dvh]');
    expect(classes).toContain('sm:overflow-y-auto');
    expect(classes).not.toContain('sm:overflow-visible');
  });
});
