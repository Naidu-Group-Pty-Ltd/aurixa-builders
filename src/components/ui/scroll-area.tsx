import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

/**
 * Audit items 44, 45 and 46 — a dialog that scrolls nothing.
 *
 * The Viewport asked for `h-full`. A percentage height resolves against the
 * parent's DEFINITE height, and a `ScrollArea` sized by `min-h-0 flex-1`
 * inside a dialog whose own height comes from `max-h-[90vh]` and its content
 * has no definite height to offer — so `h-full` computed to the content's own
 * height and `overflow: scroll` had nothing left to clip.
 *
 * Measured in Chromium against the compiled stylesheet, reproducing the
 * Forward dialog: the ScrollArea was correctly 514px, its Viewport computed
 * to 1640px, `scrollHeight === clientHeight`, and the message body box sat
 * 1,717px down a 700px window — which is the report's "the message body box
 * goes missing below", to the pixel.
 *
 * A flex column with `min-h-0 flex-1` takes percentage resolution out of the
 * path entirely; the same correction the Passport booklet needed for the same
 * reason. After: Viewport 514px, `scrollHeight` 1640, scrolls. A ScrollArea
 * that already had a definite height (`h-[480px]`, the common case) measures
 * identically before and after, and the scrollbar is unaffected because Radix
 * positions it absolutely rather than as a child in flow.
 */
interface ScrollAreaProps
  extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /**
   * This ScrollArea scrolls SIDEWAYS, and its content is meant to be wider
   * than the box.
   *
   * Off by default, because the component renders a vertical `<ScrollBar />`
   * and no horizontal one — so in every other ScrollArea, content wider than
   * the viewport is content nobody can reach. Four callers add their own
   * `<ScrollBar orientation="horizontal" />` for a kanban rail or a chip
   * strip; they pass this.
   */
  horizontal?: boolean
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, horizontal = false, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative flex flex-col overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      className={cn(
        "min-h-0 flex-1 w-full rounded-[inherit] [&>div]:!min-w-0 [&>div]:!w-full",
        // Audit 4 item 3 — the button you cannot reach.
        //
        // Radix wraps the Viewport's children in a div it styles
        // `display: table; min-width: 100%`, so that the content is measured
        // correctly and margins do not collapse through it. Under AUTOMATIC
        // table layout, though, `width` is a MINIMUM rather than a maximum:
        // an unshrinkable child makes the table wider than its container and
        // `width: 100%` — which `[&>div]:!w-full` above already sets, and
        // which is not enough on its own — does nothing to stop it. So a flex
        // row inside resolves `flex-1` against max-content, `truncate` finds
        // a box wide enough not to truncate, and anything after it is painted
        // outside the clip.
        //
        // Measured in Chromium at the reported width, on the Aurixa hub's
        // report list: viewport `clientWidth` 413 with `scrollWidth` 489, and
        // the Remove button laid out at x 413–495 — entirely past the
        // viewport's right edge of 430. That is the audit's three symptoms in
        // one number: the button clipped with one report, gone with several
        // (a longer filename widens the table further), and a scrollbar for
        // an axis that has none. After: `scrollWidth` 413, the row 413, the
        // filename truncating, the button inside with 11px to spare.
        //
        // `flow-root` rather than `block` keeps the one property
        // `display: table` was there for — it establishes a block formatting
        // context, so margins still cannot collapse through it.
        //
        // A ScrollArea whose content already fits measures identically before
        // and after; the only boxes this changes are the ones that were
        // already overflowing with no way to scroll.
        !horizontal && "[&>div]:!flow-root",
      )}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
